import { g, s } from "./db";
import { err, warn, l } from "./logging";
// import { handleZap } from "./nostr"; // Nostr disabled
import { credit } from "./payments";
import { emit } from "./sockets";
import { PaymentType } from "./types";
import { getInvoice, getPayment, getUser } from "./utils";

const processedPayments = new Set();

async function processIncomingPayment(event) {
  const { details } = event;
  if (!details || !details.payment) return;
  
  const payment = details.payment;
  const { id, paymentHash, preimage, amountSat, bolt11 } = payment;
  
  if (processedPayments.has(id)) return;
  processedPayments.add(id);
  
  if (processedPayments.size > 1000) {
    const oldestEntries = Array.from(processedPayments).slice(0, 100);
    oldestEntries.forEach(entry => processedPayments.delete(entry));
  }
  
  try {
    const invoice = await getInvoice(bolt11);
    if (!invoice) {
      warn("received payment with no invoice", bolt11);
      return;
    }
    
    const existing = await getPayment(bolt11);
    if (existing) {
      warn("payment already processed", bolt11);
      return;
    }
    
    const received = Number(amountSat);
    
    if (invoice?.memo) {
      try {
        // const parsed = JSON.parse(description || "{}");
        // if (parsed.kind === 9734) {
        //   const { pubkey } = await getUser(invoice.uid);
        //   handleZap({ payment_preimage: preimage, bolt11, description }, pubkey).catch(console.log);
        // } // Nostr disabled
      } catch (e) {}
    }
    
    const p = await credit({
      hash: bolt11,
      amount: received,
      memo: invoice.memo,
      ref: preimage,
      type: PaymentType.lightning,
      payment_hash: paymentHash,
    });
    
    if (p && invoice.uid) {
      const user = await getUser(invoice.uid);
      if (user) emit(user.id, "payment", p);
    }
    
    l("processed incoming payment", bolt11.substr(-8), received);
  } catch (e) {
    err("problem processing incoming payment", e.message);
  }
}

export async function startPaymentMonitoring() {
  // Payment monitoring handled by browser SDK
  l("Payment monitoring delegated to browser SDK");
}

export async function stopPaymentMonitoring() {
  // Payment monitoring handled by browser SDK
  l("Payment monitoring stopped");
}

async function syncMissedPayments() {
  try {
    // const lastSync = await g("wallet:last_sync") || 0;
    const now = Math.floor(Date.now() / 1000);
    
    // const payments = await listPayments({
    //   fromTimestamp: lastSync,
    //   toTimestamp: now,
    // });
    const payments = []; // TODO: Implement in browser
    
    for (const payment of payments) {
      if (payment.direction === "receive" && payment.status === "succeeded") {
        const existing = await getPayment(payment.bolt11);
        if (!existing) {
          await processIncomingPayment({
            type: "paymentSucceeded",
            details: { payment }
          });
        }
      }
    }
    
    await s("wallet:last_sync", now);
  } catch (e) {
    err("failed to sync missed payments", e.message);
  }
}

// TODO: Implement in browser
/*
export const fixBolt12 = async (_, res) => {
  for await (const k of db.scanIterator({ MATCH: "payment:*" })) {
    const p = await g(k);
    if (p.type === "bolt12") {
      console.log(k);
      const { invoices } = await ln.listinvoices({ invstring: p.hash });
      const { local_offer_id } = invoices[0];
      const oid = await g(`payment:${local_offer_id}`);
      const op = await g(`payment:${oid}`);
      if (op) {
        db.del(`payment:${oid}`);
        db.del(`payment:${local_offer_id}`);
        db.decrBy(`balance:${op.uid}`, op.amount);
      }
    }
  }

  res.send({});
};
*/
