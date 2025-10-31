import config from "../config";
import { requirePin } from "../lib/auth";
import { db, g, s } from "../lib/db";
import { generate } from "../lib/invoices";
import { err, l, warn } from "../lib/logging";
import mqtt from "../lib/mqtt";
import { getUserPayments, refreshUserState } from "../lib/state/hooks";
import { PaymentType as PaymentTypeEnum, PaymentState, ListPaymentsRequest } from "../lib/payments/PaymentTracker";
import {
  credit,
  debit,
  sendInternal,
  sendLightning,
} from "../lib/payments";
import { emit } from "../lib/sockets";
import { PaymentType } from "../lib/types";
import {
  SATS,
  bail,
  fail,
  fields,
  getInvoice,
  getPayment,
  getUser,
  sats,
} from "../lib/utils";
// RPC removed - using Breez SDK for all payments
import got from "got";
// import { v4 } from "uuid"; // Unused

export default {
  async info(req, res) {
    try {
      const { user } = req;
      if (!user) {
        return res.code(401).send({ error: "Unauthorized" });
      }

      // Wallet info is managed entirely by Breez SDK client-side
      // This endpoint is kept for compatibility but doesn't cache server-side
      // The UI fetches wallet info directly from the browser SDK
      res.send({
        error: "Wallet info is managed by browser SDK",
        message: "Use Breez SDK client-side for real-time wallet data"
      });
    } catch (e) {
      res.send({ error: e.message });
    }
  },

  async create(req, res) {
    const { body, user } = req;

    let { amount, hash, fee, fund, memo, payreq } = body;
    const balance = await g(`balance:${user.id}`);

    try {
      if (typeof amount !== "undefined") {
        amount = parseInt(amount);
        if (amount < 0 || amount > SATS || Number.isNaN(amount))
          fail("Invalid amount");
      }

      await requirePin({ body, user });

      let p;

      const invoice = await getInvoice(payreq || hash);
      const recipient = invoice ? await getUser(invoice.uid) : undefined;
      if (payreq) {
        if (invoice && recipient.username !== "mint") {
          if (invoice.aid === user.id) fail("Cannot send to self");
          hash = payreq;
          if (!amount) ({ amount } = invoice);
        } else {
          console.log(`[TRACE] Calling sendLightning from payments route: amount=${amount}, fee=${fee}`);
          p = await sendLightning({ user, pr: payreq, amount, fee, memo });
        }
      }

      if (!p) {
        if (hash) {
          p = await sendInternal({
            invoice,
            amount,
            memo,
            recipient,
            sender: user,
          });
        } else if (fund) {
          p = await debit({
            hash,
            amount,
            memo: fund,
            user,
            type: PaymentType.fund,
          });
          await db.incrBy(`fund:${fund}`, amount);
          await db.lPush(`fund:${fund}:payments`, p.id);
          l("funded fund", fund);
        }
      }

      // Refresh state after payment
      try {
        await refreshUserState(user.id);
      } catch (stateError) {
        // Log but don't fail the request
        console.warn("Failed to refresh state after payment:", stateError.message);
      }
      
      res.send(p);
    } catch (e) {
      warn(user.username, "payment failed", amount, balance, hash, payreq);
      err(e.message);
      bail(res, e.message);
    }
  },

  async forceSync(req, res) {
    res.send({ success: false, message: "Handled by browser SDK" });
  },

  async list(req, res) {
    const paymentCache = getPaymentCache();
    
    let {
      user: { id },
      query: { aid, start, end, limit, offset, type, status, search },
    } = req;
    if (!aid || aid === "undefined") aid = id;

    // If aid is the same as the user id, allow access (user's main account)
    // Otherwise check if user has access to the account
    if (aid !== id) {
      const index = await db.lPos(`${id}:accounts`, aid);
      if (index === null) fail("unauthorized");
    }

    limit = parseInt(limit) || 100;
    offset = parseInt(offset) || 0;

    const walletData = await db.hGetAll(`wallet:${id}`) || {};
    const isWalletInitialized = walletData.initialized === "true";

    if (!isWalletInitialized) {
      return res.send({ payments: [], count: 0, incoming: {}, outgoing: {} });
    }

    // Try to get payments from state management first
    let statePayments = null;
    try {
      const request: ListPaymentsRequest = {
        offset,
        limit,
        filters: {
          fromTimestamp: start ? parseInt(start) : undefined,
          toTimestamp: end ? parseInt(end) : undefined,
          searchText: search
        },
        sortOrder: "desc"
      };
      
      if (type) {
        const types = Array.isArray(type) ? type : [type];
        request.filters.types = types.map(t => {
          switch(t) {
            case "lightning": return PaymentTypeEnum.Lightning;
            case "bitcoin": return PaymentTypeEnum.Bitcoin;
            case "liquid": return PaymentTypeEnum.Liquid;
            case "send": return PaymentTypeEnum.Send;
            case "receive": return PaymentTypeEnum.Receive;
            default: return PaymentTypeEnum.Lightning;
          }
        });
      }
      
      if (status) {
        const statuses = Array.isArray(status) ? status : [status];
        request.filters.status = statuses.map(s => {
          switch(s) {
            case "pending": return PaymentState.Pending;
            case "complete": return PaymentState.Complete;
            case "failed": return PaymentState.Failed;
            default: return PaymentState.Complete;
          }
        });
      }
      
      const paymentsFromState = await getUserPayments(id, request);
      
      if (paymentsFromState && paymentsFromState.length > 0) {
        // Convert state payments to expected format
        statePayments = paymentsFromState.map(p => ({
          id: p.id,
          hash: p.paymentHash || p.txId || p.id,
          amount: Number(p.amountSat),
          fee: Number(p.feesSat),
          created: p.createdAt,
          type: p.paymentType === PaymentTypeEnum.Lightning ? PaymentType.lightning : 
                p.paymentType === PaymentTypeEnum.Bitcoin ? PaymentType.bitcoin :
                p.paymentType === PaymentTypeEnum.Liquid ? PaymentType.liquid : PaymentType.internal,
          status: p.status,
          memo: p.description,
          uid: id,
          aid: aid || id,
          preimage: p.preimage
        }));
      }
    } catch (e) {
      // State management not available, continue with regular flow
    }

    // Fall back to existing implementation if state not available
    let payments;
    if (statePayments) {
      payments = statePayments;
    } else {
      const range = !limit || start || end ? -1 : limit - 1;
      // Only store internal/fund payments in Redis - SDK handles wallet payments
      payments = (await db.lRange(`${aid || id}:payments`, 0, range)) || [];

      payments = (
        await Promise.all(
          payments.map(async (pid) => {
            const p = await g(`payment:${pid}`);
            if (!p) {
              warn("user", id, "missing payment", pid);
              await db.lRem(`${aid || id}:payments`, 0, pid);
              return p;
            }
            if (p.created < start || p.created > end) return;
            if (p.type === PaymentType.internal || p.type === PaymentType.fund)
              p.with = await getUser(p.ref || p.uid, fields);
            return p;
          }),
        )
      )
        .filter((p) => p)
        .sort((a, b) => b.created - a.created);
    }

    const fn = (a, b) => ({
      ...a,
      [b.currency]: {
        tips: (a[b.currency] ? a[b.currency].tips : 0) + (b.tip || 0),
        fiatTips: (
          parseFloat(a[b.currency] ? a[b.currency].fiatTips : 0) +
          ((b.tip || 0) * b.rate) / SATS
        ).toFixed(2),
        sats:
          (a[b.currency] ? a[b.currency].sats : 0) +
          (b.amount || 0) +
          (b.tip || 0) -
          (b.fee || 0) -
          (b.ourfee || 0),
        fiat: (
          parseFloat(a[b.currency] ? a[b.currency].fiat : 0) +
          (((b.amount || 0) +
            ((b.amount > 0 ? b.tip : -b.tip) || 0) -
            (b.fee || 0) -
            (b.ourfee || 0)) *
            b.rate) /
            SATS
        ).toFixed(2),
      },
    });

    const incoming = payments.filter((p: any) => p.amount > 0).reduce(fn, {});
    const outgoing = payments.filter((p: any) => p.amount < 0).reduce(fn, {});

    const { length: count } = payments;
    if (limit) payments = payments.slice(offset, offset + limit);

    res.send({ payments, count, incoming, outgoing });
  },

  async get(req, res) {
    try {
      const {
        params: { hash },
      } = req;

      // Get payment from database - only internal/fund payments are stored server-side
      // SDK payments (Lightning/Bitcoin/Liquid) are tracked client-side via Breez SDK
      let p = await getPayment(hash);

      if (p?.type === PaymentType.internal || p?.type === PaymentType.fund) {
        p.with = await getUser(p.ref || p.uid, fields);
      }

      res.send(p || null);
    } catch (e) {
      console.log(e);
      err("failed to get payment", e.message);
      bail(res, e.message);
    }
  },

  async search(req, res) {
    const {
      user: { id },
      query: { q, limit }
    } = req;
    
    try {
      const searchLimit = parseInt(limit) || 20;
      const payments = await getUserPayments(id, {
        filters: { searchText: q },
        limit: searchLimit,
        sortOrder: "desc"
      });
      
      const formattedPayments = payments.map(p => ({
        id: p.id,
        hash: p.paymentHash || p.txId || p.id,
        amount: Number(p.amountSat),
        fee: Number(p.feesSat),
        created: p.createdAt,
        type: p.paymentType,
        status: p.status,
        memo: p.description,
        destination: p.destination
      }));
      
      res.send({ payments: formattedPayments, count: formattedPayments.length });
    } catch (e) {
      err("Search failed", e.message);
      bail(res, e.message);
    }
  },
  
  async paginated(req, res) {
    const {
      user: { id },
      query: { page, pageSize }
    } = req;
    
    try {
      const currentPage = parseInt(page) || 1;
      const size = parseInt(pageSize) || 20;
      const offset = (currentPage - 1) * size;
      
      const payments = await getUserPayments(id, {
        offset,
        limit: size + 1,
        sortOrder: "desc"
      });
      
      const hasMore = payments.length > size;
      if (hasMore) {
        payments.pop();
      }
      
      const formattedPayments = payments.map(p => ({
        id: p.id,
        hash: p.paymentHash || p.txId || p.id,
        amount: Number(p.amountSat),
        fee: Number(p.feesSat),
        created: p.createdAt,
        type: p.paymentType,
        status: p.status,
        memo: p.description
      }));
      
      res.send({
        payments: formattedPayments,
        page: currentPage,
        pageSize: size,
        hasMore,
        total: formattedPayments.length
      });
    } catch (e) {
      err("Pagination failed", e.message);
      bail(res, e.message);
    }
  },
  
  async retry(req, res) {
    const {
      user: { id },
      params: { paymentId }
    } = req;
    
    try {
      const { getPaymentsCubit } = await import("../lib/state/StateManager");
      const paymentsCubit = getPaymentsCubit();
      const payment = await paymentsCubit.retryFailedPayment(id, paymentId);
      
      res.send({
        success: true,
        payment: {
          id: payment.id,
          status: payment.status,
          amount: Number(payment.amountSat)
        }
      });
    } catch (e) {
      err("Retry failed", e.message);
      bail(res, e.message);
    }
  },

  async parse(req, res) {
    const {
      body: { payreq },
      user,
    } = req;
    try {
      // If this is a BOLT12 offer that already has metadata from fetchinvoice
      if (payreq && payreq.startsWith && payreq.startsWith("lno1")) {
        // Parse the offer
        const parsed = await parseInput(payreq, user?.id);
        
        if (parsed && (parsed.offer || parsed.type === 'bolt12Offer')) {
          let amount = 0;
          let alias = parsed.offer?.description || "BOLT12 offer";
          let hasFixedAmount = false;
          
          // Check for fixed amount in BOLT12 offer
          // If minAmount exists and no maxAmount (or they're equal), it's a fixed amount
          if (parsed.offer?.minAmount?.amountMsat) {
            const minMsat = Number(parsed.offer.minAmount.amountMsat);
            const minSats = Math.ceil(minMsat / 1000);
            
            // If there's no max amount or min equals max, it's fixed
            if (!parsed.offer?.maxAmount || 
                (parsed.offer.maxAmount?.amountMsat && 
                 Number(parsed.offer.maxAmount.amountMsat) === minMsat)) {
              amount = minSats;
              hasFixedAmount = true;
            } else if (!req.body.amount) {
              // No fixed amount but has minimum, show the minimum as default
              amount = minSats;
            }
          }
          
          // Override with user-provided amount if not fixed
          if (req.body.amount && !hasFixedAmount) {
            amount = parseInt(req.body.amount);
          }
          
          let ourfee = Math.round(amount * config.fee[PaymentType.lightning]);
          const credit = await g(`credit:lightning:${user.id}`);
          const covered = Math.min(credit, ourfee) || 0;
          ourfee -= covered;
          
          return res.send({ 
            alias, 
            amount, 
            ourfee,
            payreq, // Return the offer as payreq for UI compatibility
            isBolt12: true,
            hasFixedAmount // Tell UI whether amount can be changed
          });
        }
      }
      
      const parsed = await parseInput(payreq, user?.id);

      if (!parsed) {
        fail("Invalid payment request");
      }

      let amount = 0;
      let alias = "";

      if (parsed.invoice) {
        if (parsed.invoice.amountMsat) {
          amount = Math.round(Number(parsed.invoice.amountMsat) / 1000);
        }
        alias = parsed.invoice.description || "Lightning payment";
      } else if (parsed.lnUrlPay) {
        if (parsed.lnUrlPay.minSendable) {
          amount = Math.round(Number(parsed.lnUrlPay.minSendable) / 1000);
        }
        alias = parsed.lnUrlPay.metadata || "LNURL payment";
      } else if (parsed.lnAddress) {
        alias = parsed.lnAddress.address || "Lightning address";
      } else if (parsed.offer || parsed.type === 'bolt12Offer') {
        // Handle BOLT12 offers
        if (parsed.offer?.minAmount?.amountMsat) {
          amount = Math.round(Number(parsed.offer.minAmount.amountMsat) / 1000);
        }
        alias = parsed.offer?.description || "BOLT12 offer";
      }

      let ourfee = Math.round(amount * config.fee[PaymentType.lightning]);
      const credit = await g(`credit:lightning:${user.id}`);
      const covered = Math.min(credit, ourfee) || 0;
      ourfee -= covered;

      res.send({ alias, amount, ourfee, payreq });
    } catch (e) {
      console.log(e);
      err("problem parsing", e.message);
      bail(res, e.message);
    }
  },

  async fund(req, res) {
    const {
      params: { id },
    } = req;
    const amount = await g(`fund:${id}`);
    if (typeof amount === "undefined" || amount === null)
      return bail(res, "fund not found");
    let payments = (await db.lRange(`fund:${id}:payments`, 0, -1)) || [];
    payments = await Promise.all(payments.map((hash) => g(`payment:${hash}`)));

    await Promise.all(
      payments.map(async (p: any) => (p.user = await getUser(p.uid, fields))),
    );

    payments = payments.filter((p) => p);

    const authorization = await g(`authorization:${id}`);
    res.send({ amount, authorization: authorization?.amount, payments });
  },

  // async withdraw(req, res) {
  //   const {
  //     params: { name },
  //   } = req;
  //   const { user } = req;
  //   const balance = await g(`fund:${name}`);
  //   const managers = await db.sMembers(`fund:${name}:managers`);
  //   if (managers.length && !managers.includes(user.id)) fail("Unauthorized");
  //   res.send({
  //     tag: "withdrawRequest",
  //     callback: `${URL}/api/lnurlw`,
  //     k1: name,
  //     defaultDescription: `Withdraw from DGEN Wallet fund ${name}`,
  //     minWithdrawable: balance > 0 ? 1000 : 0,
  //     maxWithdrawable: balance * 1000,
  //   });
  // },

  async authorize(req, res) {
    const { id: uid } = req.user;
    const { id, fiat, currency, amount } = req.body;

    const managers = await db.sMembers(`fund:${id}:managers`);
    const managersArray = Array.isArray(managers) ? managers : Array.from(managers);
    if (managersArray.length && !managersArray.includes(uid)) fail("Unauthorized");

    const authorization = {
      uid,
      currency,
      fiat,
      amount,
    };

    await s(`authorization:${id}`, authorization);
    res.send({});
  },

  async take(req, res) {
    let {
      body: { id, amount, invoice: iid },
      user,
    } = req;
    try {
      amount = parseInt(amount);
      if (amount < 0) fail("Invalid amount");

      const rates = await g("rates");

      if (!iid) {
        const inv = await generate({
          invoice: { amount, type: "lightning" },
          user,
        });
        iid = inv.id;
      }

      const authorization = await g(`authorization:${id}`);
      if (authorization && !authorization.claimed) {
        const { currency, fiat } = authorization;
        amount = Math.min(amount, sats(fiat / rates[currency]));

        const sender = await getUser(authorization.uid);
        authorization.claimed = true;
        await s(`authorization:${id}`, authorization);

        const { hash } = await generate({
          invoice: { amount, type: "lightning" },
          user: sender,
        });

        const { id: pid } = await debit({
          hash,
          amount,
          memo: id,
          user: sender,
          type: PaymentType.fund,
        });

        await db.incrBy(`fund:${id}`, amount);
        await db.lPush(`fund:${id}:payments`, pid);
        l("funded fund", id);
      }

      const managers = await db.sMembers(`fund:${id}:managers`);
      const managersArray2 = Array.isArray(managers) ? managers : Array.from(managers);
      if (managersArray2.length && !managersArray2.includes(user.id)) fail("Unauthorized");

      const result: any = await db.debit(
        `fund:${id}`,
        "",
        "Insufficient funds",
        amount,
        0,
        0,
        0,
        0,
      );
      if (result.err) fail(result.err);

      const payment = await credit({
        aid: user.id,
        hash: iid,
        amount,
        memo: id,
        ref: id,
        type: PaymentType.fund,
      });

      await db.lPush(`fund:${id}:payments`, payment.id);

      res.send(payment);
    } catch (e) {
      warn("problem withdrawing from fund", user.username, e.message);
      bail(res, e.message);
    }
  },

  async managers(req, res) {
    const { name } = req.params;

    const ids = await db.sMembers(`fund:${name}:managers`);
    const idsArray = Array.isArray(ids) ? ids : Array.from(ids);

    const managers = await Promise.all(
      idsArray.map(async (id) => await getUser(id, fields)),
    );

    res.send(managers);
  },

  async addManager(req, res) {
    const { id, username } = req.body;
    const { user } = req;

    const k = `fund:${id}:managers`;

    let managers = await db.sMembers(k);
    const managersArray3 = Array.isArray(managers) ? managers : Array.from(managers);
    if (managersArray3.length) {
      if (!managersArray3.includes(user.id)) fail("Unauthorized");
    } else {
      await db.sAdd(k, user.id);
    }

    const u = await getUser(username, fields);
    if (!u) fail("User not found");
    const { id: uid } = u;

    await db.sAdd(k, uid);

    const ids = await db.sMembers(k);
    const idsArray2 = Array.isArray(ids) ? ids : Array.from(ids);
    const managersArray4 = Array.isArray(managers) ? managers : Array.from(managers);
    if (!managersArray4.length)
      managers = await Promise.all(
        idsArray2.map(async (id) => await getUser(id, fields)),
      );

    res.send(managers);
  },

  async deleteManager(req, res) {
    try {
      const { name } = req.params;
      const { id: uid } = req.body;
      const { user } = req;

      const k = `fund:${name}:managers`;
      let managers = await db.sMembers(k);

      const managersArray5 = Array.isArray(managers) ? managers : Array.from(managers);
      if (managersArray5.length) {
        if (!managersArray5.includes(user.id)) fail("Unauthorized");
      }

      await db.sRem(k, uid);

      const ids = await db.sMembers(k);
      const idsArray3 = Array.isArray(ids) ? ids : Array.from(ids);
      managers = await Promise.all(
        idsArray3.map(async (id) => await getUser(id, fields)),
      );

      res.send(managers);
    } catch (e) {}
  },

  async confirm(req, res) {
    const {
      body: { txid },
    } = req;

    try {
      // Transaction confirmation is handled automatically by Breez SDK
      // This endpoint is kept for compatibility but doesn't need to do anything
      // The SDK handles all transaction monitoring and confirmation
      
      const p = await getPayment(txid);
      if (p) {
        // Payment exists, SDK will handle confirmation
        emit(p.uid, "payment", p);
      }
      
      res.send({});
    } catch (e) {
      console.log(e);
      warn(`problem processing ${txid}`);
      bail(res, e.message);
    }
  },

  async fee(req, res) {
    const { body, user } = req;
    try {
      const { amount, address, feeRate } = body;
      
      console.log(`Fee estimation request: amount=${amount}, address=${address}, feeRate=${feeRate}, user=${user.id}`);
      
      
      
      // Ensure user session is active
      // Browser SDK handles sessions
      
      // Prepare the transaction using Breez SDK
      // Browser SDK handles transaction preparation
      const prepared = { totalFeesSat: 0, claimFeesSat: 0, limits: null, prepareResponse: null };
      
      // Return fee structure that UI expects
      res.send({
        fees: {
          fastestFee: 10,
          halfHourFee: 8,
          hourFee: 5,
          economyFee: 2,
          minimumFee: 1
        },
        fee: prepared.totalFeesSat,
        claimFee: prepared.claimFeesSat,
        totalFee: prepared.totalFeesSat,
        feeRate: feeRate || 8,
        ourfee: 0,
        subtract: false,
        hex: "", // Not needed with Breez SDK
        inputs: [], // Not needed with Breez SDK
        limits: prepared.limits,
        prepareResponse: prepared.prepareResponse
      });
      
      /*
      
      
      // Ensure user session is active
      // Browser SDK handles sessions
      
      // Prepare the transaction using Breez SDK
      // Browser SDK handles transaction preparation
      const prepared = { totalFeesSat: 0, claimFeesSat: 0, limits: null, prepareResponse: null };
      
      // Return fee structure that UI expects
      res.send({
        fees: {
          fastestFee: 10,
          halfHourFee: 8,
          hourFee: 5,
          economyFee: 2,
          minimumFee: 1
        },
        fee: prepared.totalFeesSat,
        claimFee: prepared.claimFeesSat,
        totalFee: prepared.totalFeesSat,
        feeRate: feeRate || 8,
        ourfee: 0,
        subtract: false,
        hex: "", // Not needed with Breez SDK
        inputs: [], // Not needed with Breez SDK
        limits: prepared.limits,
        prepareResponse: prepared.prepareResponse
      });
      */
    } catch (e) {
      console.error("Fee estimation error:", e);
      console.error("Full error stack:", e.stack);
      console.error("Error details:", JSON.stringify(e, null, 2));
      warn(
        "problem estimating fee",
        e.message,
        user.username,
        body.amount,
        body.address,
      );
      let msg = e.message || e.toString() || "Unknown error";
      if (msg.includes("500")) msg = "Service temporarily unavailable";
      bail(res, `Failed to prepare transaction: ${msg}`);
    }
  },

  async send(req, res) {
    const { body, user } = req;
    try {
      await requirePin({ body, user });
      
      // Use Breez SDK for Bitcoin mainchain payments
      const { address, amount, feeRate } = body;
      
      if (!address || !amount) {
        throw new Error("Address and amount are required");
      }
      
      // Import Breez SDK functions
      
      
      // Browser SDK handles bitcoin sending
      const result = null;
      
      // Use placeholder IDs since browser SDK handles this
      const paymentId = `payment_${Date.now()}`;
      const txId = null;
      
      // Create a payment record for consistency with existing system
      const p = await debit({
        hash: paymentId, // Use payment ID as primary identifier
        amount: parseInt(amount),
        fee: 0,
        user,
        type: PaymentType.bitcoin,
      });
      
      // If we have a txId, also save it as an alias
      if (txId && txId !== paymentId) {
        await s(`payment:${txId}`, p.id);
      }

      // Refresh state after payment
      try {
        await refreshUserState(user.id);
      } catch (stateError) {
        console.warn("Failed to refresh state after send:", stateError.message);
      }

      res.send({
        ...p,
        txid: result.txId,
        payment: result.payment
      });
    } catch (e) {
      warn(user.username, "Bitcoin payment failed", e.message);
      res.code(500).send({ error: e.message });
    }
  },

  async freeze(req, res) {
    const {
      body: { secret },
    } = req;
    try {
      if (secret !== config.adminpass) fail("unauthorized");
      await s("freeze", true);
      res.send("ok");
    } catch (e) {
      console.log(e);
      bail(res, e.message);
    }
  },

  async print(req, res) {
    const {
      body: { id },
      user,
    } = req;
    try {
      const p = await g(`payment:${id}`);
      if (p.uid !== user.id) fail("unauthorized");
      emit(user.id, "payment", p);

      const { username } = user;

      mqtt.publish(
        username,
        `pay:${p.amount}:${p.tip}:${p.rate}:${p.created}:${p.id}`,
      );

      res.send({ ok: true });
    } catch (e) {
      bail(res, e.message);
    }
  },

  async lnaddress(req, res) {
    let {
      params: { lnaddress, amount, fee = 5000 },
      body,
      user,
    } = req;
    try {
      lnaddress = decodeURIComponent(lnaddress);
      await requirePin({ body, user });

      const [username, domain] = lnaddress.split("@");
      const { minSendable, maxSendable, callback, metadata } = (await got(
        `https://${domain}/.well-known/lnurlp/${username}`,
      ).json()) as any;

      const memo = metadata["text/plain"] || "";
      if (amount * 1000 < minSendable || amount * 1000 > maxSendable)
        fail("amount out of range");

      const r: any = await got(`${callback}?amount=${amount * 1000}`).json();
      if (r.reason) fail(r.reason);
      const { pr } = r;

      const p = await sendLightning({ user, pr, amount, fee, memo });

      res.send(p);
    } catch (e) {
      console.log(e);
      bail(res, e.message);
    }
  },

  async gateway(req, res) {
    const {
      body: { short_channel_id, webhook },
    } = req;

    await s(short_channel_id, webhook);
    res.send({ ok: true });
  },

  async replace(req, res) {
    const {
      body: { id },
      user,
    } = req;
    try {
      const p = await g(`payment:${id}`);
      if (!p) fail("Payment not found");
      if (p.uid !== user.id) fail("unauthorized");

      // RBF (Replace-By-Fee) is not directly supported in Breez SDK
      // The SDK handles fee management automatically
      // This endpoint is kept for compatibility but returns unsupported
      
      warn("RBF not supported with Breez SDK", user.username, id);
      bail(res, "Fee replacement not supported with current wallet implementation");
    } catch (e) {
      err("failed to bump payment", id, e.message);
      bail(res, e.message);
    }
  },

  async internal(req, res) {
    const {
      body: { username, amount },
      user: sender,
    } = req;

    const recipient = await getUser(username);
    res.send(await sendInternal({ amount, sender, recipient }));
  },

  async decode(req, res) {
    const { bolt11 } = req.params;
    const { user } = req;
    try {
      const parsed = await parseInput(bolt11, user?.id);

      if (!parsed) {
        bail(res, "Invalid payment request");
        return;
      }

      let decodedInfo = {
        type: "unknown",
        valid: true,
        amount_msat: 0,
        description: "",
        payment_hash: "",
        created_at: 0,
        expiry: 0,
      };

      if (parsed.invoice) {
        decodedInfo = {
          type: "bolt11",
          valid: true,
          amount_msat: Number(parsed.invoice.amountMsat) || 0,
          description: parsed.invoice.description || "",
          payment_hash: parsed.invoice.paymentHash || "",
          created_at: Math.floor(Number(parsed.invoice.timestamp) || 0),
          expiry: Number(parsed.invoice.expiry) || 0,
        };
      } else if (parsed.offer) {
        decodedInfo = {
          type: "bolt12",
          valid: true,
          amount_msat: 0,
          description: parsed.offer.description || "",
          payment_hash: "",
          created_at: 0,
          expiry: 0,
        };
      } else if (parsed.lnUrlPay) {
        decodedInfo = {
          type: "lnurl",
          valid: true,
          amount_msat: Number(parsed.lnUrlPay.minSendable) || 0,
          description: parsed.lnUrlPay.metadata || "",
          payment_hash: "",
          created_at: 0,
          expiry: 0,
        };
      }

      res.send(decodedInfo);
    } catch (e) {
      bail(res, e.message);
    }
  },

  async fetchinvoice(req, res) {
    const { amount, offer } = req.body;
    const { user } = req;
    try {
      // Parse the offer to verify it's valid
      const parsed = await parseInput(offer, user?.id);

      if (!parsed) {
        // If the SDK can't parse it, it might be an invalid or testnet offer
        console.warn("SDK cannot parse BOLT12 offer, may be invalid or testnet:", offer.substring(0, 50));
        bail(res, "Invalid or unsupported BOLT12 offer. Please ensure this is a valid mainnet offer.");
        return;
      }

      if (!parsed.offer && parsed.type !== 'bolt12Offer') {
        bail(res, "Not a BOLT12 offer");
        return;
      }

      // For BOLT12 offers, the Breez SDK handles invoice fetching internally
      // during prepareSendPayment. We return the offer with proper metadata
      // so the UI can proceed with payment
      
      // Return the offer as the "invoice" with metadata
      // The actual invoice fetching happens in sendLightning when we call prepareSendPayment
      const response = {
        invoice: offer, // Return the offer itself
        payreq: offer,  // UI expects payreq field
        type: "bolt12_offer",
        valid: true,
        alias: parsed.offer?.description || "BOLT12 offer",
        description: parsed.offer?.description || "",
        amount: amount || (parsed.offer?.minAmount ? Math.ceil(Number(parsed.offer.minAmount.amountMsat) / 1000) : 0),
        amount_msat: amount ? amount * 1000 : (parsed.offer?.minAmount?.amountMsat || 0),
        offer_id: parsed.offer?.offerId || "",
        // Important: mark this as BOLT12 so the parse endpoint knows how to handle it
        isBolt12Offer: true,
        ourfee: 0 // Fee will be calculated during actual payment
      };

      res.send(response);
    } catch (e) {
      console.error("fetchinvoice error:", e);
      // Provide more helpful error message for BOLT12 issues
      if (e.message?.includes("Unrecognized input type")) {
        bail(res, "This BOLT12 offer is not recognized. It may be invalid or from a testnet/different network.");
      } else {
        bail(res, e.message);
      }
    }
  },

  async auth(_, res) {
    res.send({ received: true });
  },

  async order(_, res) {
    res.send({ received: true });
  },

  async reconcile(req, res) {
    try {
      const { user } = req;
      const { userId } = req.body;
      
      if (!user) {
        return res.code(401).send({ error: "Unauthorized" });
      }

      const { getPaymentsCubit } = await import("../lib/state/StateManager");
      const paymentsCubit = getPaymentsCubit();
      
      const result = await paymentsCubit.triggerReconciliation(userId);
      
      res.send({
        success: true,
        processedUsers: result.processedUsers,
        discrepancies: result.discrepancies,
        timestamp: Date.now()
      });
    } catch (error) {
      err("Admin reconciliation failed:", error.message);
      res.code(500).send({ error: "Reconciliation failed" });
    }
  },

  async adminRefund(req, res) {
    try {
      const { user } = req;
      const { swapAddress, refundAddress, feeRateSatPerVbyte } = req.body;
      
      if (!user) {
        return res.code(401).send({ error: "Unauthorized" });
      }

      if (!swapAddress || !refundAddress) {
        return res.code(400).send({ 
          error: "Both swapAddress and refundAddress are required" 
        });
      }

      const { ServiceInjector } = await import("../lib/services/ServiceInjector");
      const injector = ServiceInjector.getInstance();
      const swapRefundManager = injector.getSwapRefundManager();
      
      if (!swapRefundManager) {
        return res.code(500).send({ 
          error: "Refund functionality not available" 
        });
      }

      const result = await swapRefundManager.adminForceRefund(
        swapAddress,
        refundAddress,
        feeRateSatPerVbyte
      );

      if (result.success) {
        await s(`admin_refund:${Date.now()}`, {
          adminId: user.id,
          swapAddress,
          refundAddress,
          txId: result.txId,
          timestamp: Date.now()
        });
      }

      res.send(result);
    } catch (error) {
      err("Admin refund failed:", error.message);
      res.code(500).send({ error: "Admin refund failed" });
    }
  },
};
