import { EventEmitter } from "events";
import { ServiceInjector } from "./ServiceInjector";
import { emit } from "../sockets";
import { db, g, s } from "../db";
import { l, err } from "../logging";
import { getUser, SATS } from "../utils";

export interface PaymentEvent {
  type: string;
  payment?: any;
  details?: any;
}

export class PaymentEventHandler extends EventEmitter {
  private userIdMap = new Map<string, string>(); // maps SDK instance to userId
  
  constructor(private injector: ServiceInjector) {
    super();
  }

  public setUserId(sdkInstance: any, userId: string) {
    this.userIdMap.set(sdkInstance, userId);
  }

  public async handlePaymentEvent(userId: string, event: PaymentEvent) {
    const { type, payment } = event;
    l(`Payment event ${type} for user ${userId}`);

    try {
      switch(type) {
        case "paymentSucceeded":
          await this.handleSuccessfulPayment(userId, payment);
          break;
          
        case "paymentPending":
          await this.handlePendingPayment(userId, payment);
          break;
          
        case "paymentFailed":
          await this.handleFailedPayment(userId, payment);
          break;
          
        case "paymentRefundable":
          await this.handleRefundablePayment(userId, payment);
          break;
          
        case "paymentRefunded":
          await this.handleRefundedPayment(userId, payment);
          break;
          
        case "paymentRefundPending":
          await this.handleRefundPendingPayment(userId, payment);
          break;
          
        case "paymentWaitingConfirmation":
          await this.handleWaitingConfirmationPayment(userId, payment);
          break;
          
        case "paymentWaitingFeeAcceptance":
          await this.handleWaitingFeeAcceptancePayment(userId, payment);
          break;
      }
    } catch (error) {
      err(`Error handling payment event ${type}:`, error.message);
    }
  }

  private async handleSuccessfulPayment(userId: string, payment: any) {
    const paymentId = payment?.id || payment?.swapId || payment?.txId || payment?.paymentHash || payment?.bolt11 || `payment_${Date.now()}`;
    l(`Payment succeeded for user ${userId}: ${paymentId}`);
    
    // Get user account
    const user = await getUser(userId);
    if (!user) {
      err(`User ${userId} not found`);
      return;
    }

    // Check if this is an incoming payment
    const isIncoming = payment?.paymentType === "receive" || payment?.amountSat > 0;
    
    if (isIncoming && paymentId) {
      // Create payment record
      const paymentRecord = {
        id: paymentId,
        hash: payment?.paymentHash || paymentId,
        amount: Math.abs(payment?.amountSat || 0),
        fee: payment?.feesSat || 0,
        created: payment?.timestamp || Date.now(),
        type: payment?.paymentType || "lightning",
        status: "complete",
        memo: payment?.description || "",
        uid: userId,
        aid: user.id,
        preimage: payment?.preimage || null
      };

      // Store payment
      await s(`payment:${paymentRecord.id}`, paymentRecord);
      
      // Add to user's payment list
      await db.lPush(`${userId}:payments`, paymentRecord.id);
      
      // Update user balance
      const balanceKey = `balance:${userId}`;
      const currentBalance = parseInt(await g(balanceKey) || "0");
      const newBalance = currentBalance + paymentRecord.amount - paymentRecord.fee;
      await s(balanceKey, newBalance);
      
      l(`Updated balance for ${userId}: ${currentBalance} -> ${newBalance}`);
      
      // Try to find matching invoice by payment hash, bolt11, or description
      let matchedInvoice = null;
      const paymentHash = payment?.paymentHash || payment?.payment_hash || payment?.id;
      const bolt11 = payment?.bolt11 || payment?.invoice || payment?.destination;
      const description = payment?.description || payment?.memo || "";
      
      l(`Looking for invoice match - paymentHash: ${paymentHash}, bolt11: ${bolt11?.substring(0, 30)}...`);
      
      // Try direct lookups first for performance
      let invoiceId = null;
      
      // Try by payment hash
      if (paymentHash) {
        invoiceId = await g(`invoice:paymenthash:${paymentHash}`);
        if (invoiceId) l(`Found invoice by payment hash: ${invoiceId}`);
      }
      
      // Try by bolt11
      if (!invoiceId && bolt11) {
        invoiceId = await g(`invoice:bolt11:${bolt11}`);
        if (invoiceId) {
          l(`Found invoice by bolt11: ${invoiceId}`);
        } else {
          // Also try direct hash lookup
          invoiceId = await g(`invoice:${bolt11}`);
          if (invoiceId) l(`Found invoice by direct hash: ${invoiceId}`);
        }
      }
      
      // If we found an invoice ID, get the full invoice
      if (invoiceId) {
        matchedInvoice = await g(`invoice:${invoiceId}`);
        if (matchedInvoice) {
          // Parse if it's a JSON string
          if (typeof matchedInvoice === 'string') {
            try {
              matchedInvoice = JSON.parse(matchedInvoice);
            } catch (e) {
              err(`Failed to parse invoice JSON: ${e.message}`);
            }
          }
          
          if (matchedInvoice && matchedInvoice.id) {
            // Found matching invoice - update it
            matchedInvoice.confirmed = true;
            matchedInvoice.paid = true;
            matchedInvoice.paidAt = Date.now();
            matchedInvoice.payment = paymentRecord;
            matchedInvoice.received = paymentRecord.amount;
            await s(`invoice:${invoiceId}`, matchedInvoice);
            l(`Matched payment to invoice ${invoiceId}`);
          } else {
            l(`Warning: Invoice found but has no id: ${JSON.stringify(matchedInvoice).substring(0, 100)}`);
            matchedInvoice = null;
          }
        }
      } else {
        l(`No invoice match found for payment`);
      }
      
      // Fallback: Search all invoices by description if no direct match
      if (!matchedInvoice && description) {
        const userInvoiceIds = await db.lRange(`${userId}:invoices`, 0, -1);
        for (const invId of userInvoiceIds) {
          const invoice = await g(`invoice:${invId}`);
          if (invoice && invoice.memo === description && !invoice.paid) {
            matchedInvoice = invoice;
            matchedInvoice.confirmed = true;
            matchedInvoice.paid = true;
            matchedInvoice.paidAt = Date.now();
            matchedInvoice.payment = paymentRecord;
            matchedInvoice.received = paymentRecord.amount;
            await s(`invoice:${invId}`, matchedInvoice);
            l(`Matched payment to invoice ${invId} by description`);
            break;
          }
        }
      }
      
      // Always emit payment received for UI notification
      emit(userId, "paymentReceived", {
        payment: paymentRecord,
        invoice: matchedInvoice,
        newBalance,
        amountSat: paymentRecord.amount
      });
      
      // Also emit to the user's account ID if different
      if (user.id !== userId) {
        emit(user.id, "paymentReceived", {
          payment: paymentRecord,
          invoice: matchedInvoice,
          newBalance,
          amountSat: paymentRecord.amount
        });
      }
      
      // If we matched an invoice, emit specific invoice paid event
      if (matchedInvoice && matchedInvoice.id) {
        emit(userId, "invoicePaid", {
          invoiceId: matchedInvoice.id,
          amountSat: paymentRecord.amount,
          payment: paymentRecord
        });
        
        if (user.id !== userId) {
          emit(user.id, "invoicePaid", {
            invoiceId: matchedInvoice.id,
            amountSat: paymentRecord.amount,
            payment: paymentRecord
          });
        }
      }
      
      // Also emit generic payment event for backward compatibility
      emit(userId, "payment", paymentRecord);
      if (user.id !== userId) {
        emit(user.id, "payment", paymentRecord);
      }
      
      // Emit balance update
      emit(userId, "balanceUpdated", { 
        balanceSat: newBalance 
      });
      if (user.id !== userId) {
        emit(user.id, "balanceUpdated", { 
          balanceSat: newBalance 
        });
      }
      
      l(`Emitted payment events for incoming payment ${paymentRecord.id}`);
    }
  }

  private async handlePendingPayment(userId: string, payment: any) {
    const paymentId = payment?.id || payment?.swapId || payment?.txId || payment?.paymentHash || payment?.bolt11;
    l(`Payment pending for user ${userId}: ${paymentId}`);
    
    const paymentRecord = {
      id: paymentId,
      status: "pending",
      amount: payment?.amountSat || 0,
      timestamp: Date.now()
    };
    
    // Emit pending payment event
    emit(userId, "paymentPending", paymentRecord);
    
    // Get user and emit to account ID as well
    const user = await getUser(userId);
    if (user && user.id !== userId) {
      emit(user.id, "paymentPending", paymentRecord);
    }
  }

  private async handleFailedPayment(userId: string, payment: any) {
    const paymentId = payment?.id || payment?.swapId || payment?.txId || payment?.paymentHash || payment?.bolt11;
    l(`Payment failed for user ${userId}: ${paymentId}`);
    
    const paymentRecord = {
      id: paymentId,
      status: "failed",
      error: payment?.error || "Payment failed",
      timestamp: Date.now()
    };
    
    // Emit failed payment event
    emit(userId, "paymentFailed", paymentRecord);
    
    // Get user and emit to account ID as well
    const user = await getUser(userId);
    if (user && user.id !== userId) {
      emit(user.id, "paymentFailed", paymentRecord);
    }
  }

  private async handleInvoicePaid(userId: string, payment: any) {
    l(`Invoice paid for user ${userId}: ${payment.bolt11 || payment.id}`);
    
    const invoiceId = payment.paymentHash || payment.id;
    
    const invoiceKey = `invoice:${invoiceId}`;
    const invoice = await g(invoiceKey);
    if (invoice) {
      invoice.status = "paid";
      invoice.paidAt = Date.now();
      await s(invoiceKey, invoice);
    }
    
    await this.handleSuccessfulPayment(userId, payment);
    
    emit(userId, "invoicePaid", {
      invoiceId,
      payment,
      timestamp: Date.now()
    });
    
    const user = await getUser(userId);
    if (user && user.id !== userId) {
      emit(user.id, "invoicePaid", {
        invoiceId,
        payment,
        timestamp: Date.now()
      });
    }
  }
  
  private async handleRefundablePayment(userId: string, payment: any) {
    const paymentId = payment?.id || payment?.swapId || payment?.txId || payment?.paymentHash || `refund_${Date.now()}`;
    l(`Payment refundable for user ${userId}: ${paymentId}`);
    
    const paymentRecord = {
      id: paymentId,
      status: "refundable",
      swapId: payment?.swapId || null,
      amount: payment?.amountSat || 0,
      timestamp: Date.now()
    };
    
    emit(userId, "paymentRefundable", paymentRecord);
    
    const user = await getUser(userId);
    if (user && user.id !== userId) {
      emit(user.id, "paymentRefundable", paymentRecord);
    }
  }
  
  private async handleRefundedPayment(userId: string, payment: any) {
    const paymentId = payment?.id || payment?.swapId || payment?.txId || payment?.paymentHash || `refunded_${Date.now()}`;
    l(`Payment refunded for user ${userId}: ${paymentId}`);
    
    const paymentRecord = {
      id: paymentId,
      status: "refunded",
      amount: payment?.amountSat || 0,
      refundTxId: payment?.refundTxId || null,
      timestamp: Date.now()
    };
    
    await s(`payment:${paymentRecord.id}`, paymentRecord);
    
    emit(userId, "paymentRefunded", paymentRecord);
    
    const user = await getUser(userId);
    if (user && user.id !== userId) {
      emit(user.id, "paymentRefunded", paymentRecord);
    }
  }
  
  private async handleRefundPendingPayment(userId: string, payment: any) {
    const paymentId = payment?.id || payment?.swapId || payment?.txId || payment?.paymentHash || `refund_pending_${Date.now()}`;
    l(`Refund pending for user ${userId}: ${paymentId}`);
    
    const paymentRecord = {
      id: paymentId,
      status: "refund_pending",
      amount: payment?.amountSat || 0,
      timestamp: Date.now()
    };
    
    emit(userId, "paymentRefundPending", paymentRecord);
    
    const user = await getUser(userId);
    if (user && user.id !== userId) {
      emit(user.id, "paymentRefundPending", paymentRecord);
    }
  }
  
  private async handleWaitingConfirmationPayment(userId: string, payment: any) {
    const paymentId = payment?.id || payment?.swapId || payment?.txId || payment?.paymentHash || `waiting_${Date.now()}`;
    l(`Payment waiting confirmation for user ${userId}: ${paymentId}`);
    
    const paymentRecord = {
      id: paymentId,
      status: "waiting_confirmation",
      amount: payment?.amountSat || 0,
      confirmations: payment?.confirmations || 0,
      requiredConfirmations: payment?.requiredConfirmations || 1,
      timestamp: Date.now()
    };
    
    emit(userId, "paymentWaitingConfirmation", paymentRecord);
    
    const user = await getUser(userId);
    if (user && user.id !== userId) {
      emit(user.id, "paymentWaitingConfirmation", paymentRecord);
    }
  }
  
  private async handleWaitingFeeAcceptancePayment(userId: string, payment: any) {
    const paymentId = payment?.id || payment?.swapId || payment?.txId || payment?.paymentHash || `fee_waiting_${Date.now()}`;
    l(`Payment waiting fee acceptance for user ${userId}: ${paymentId}`);
    
    const paymentRecord = {
      id: paymentId,
      status: "waiting_fee_acceptance",
      amount: payment?.amountSat || 0,
      feeAmount: payment?.feeAmount || 0,
      timestamp: Date.now()
    };
    
    emit(userId, "paymentWaitingFeeAcceptance", paymentRecord);
    
    const user = await getUser(userId);
    if (user && user.id !== userId) {
      emit(user.id, "paymentWaitingFeeAcceptance", paymentRecord);
    }
  }
}