import { getConfig } from "./config-loader";
import api from "./api";
import { db, g, ga, s, safeDb } from "./db";
import { generate } from "./invoices";
import { err, l, warn } from "./logging";
// import { handleZap } from "./nostr"; // Nostr disabled
import { notify } from "./notifications"; // nwcNotify removed
import {
  SATS,
  btc,
  fail,
  fmt,
  formatReceipt,
  getInvoice,
  getPayment,
  getUser,
  link,
  sats,
  sleep,
  t,
} from "./utils";
import { callWebhook } from "./webhooks";
// import rpc - Browser handles wallet
import { bech32 } from "bech32";
import got from "got";
import { v4 } from "uuid";

import { PaymentType } from "./types";

// Bitcoin and Liquid RPC removed - browser handles wallet
// const bc = rpc(config.bitcoin);
// const lq = rpc(config.liquid);
const LIQUID_BTC_ASSET_ID = "6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d"; // L-BTC asset ID
const { URL } = process.env;

const dust = 547;

export const debit = async ({
  aid = undefined,
  hash,
  amount,
  fee = 0,
  memo = undefined,
  user,
  type = PaymentType.internal,
  rate = undefined,
}) => {
  amount = parseInt(amount);

  const whitelisted = await safeDb.sIsMember(
    "whitelist",
    user?.username?.toLowerCase().trim(),
  );

  const blacklisted = await safeDb.sIsMember(
    "blacklist",
    user?.username?.toLowerCase().trim(),
  );

  const serverLimit = parseInt(await g(`${type}:limit`)) || 10000000; // Default high limit
  const userLimit = parseInt(await g("limit")) || 10000000; // Default high limit
  const frozen =
    (await g("hardfreeze")) ||
    ((await g("freeze")) && type !== PaymentType.internal);

  if (frozen || (amount > userLimit && !whitelisted) || amount > serverLimit) {
    warn(
      "Blocking",
      user.username,
      amount,
      hash,
      user.id,
      type,
      frozen,
      userLimit,
      serverLimit,
    );
    fail("Problem sending payment");
  }

  let ref;
  const { id: uid, currency } = user;

  const rates = await g("rates");
  if (!rate) rate = rates[currency];

  const invoice = await getInvoice(hash);
  let iid;

  if (invoice) {
    if (invoice.received >= amount && invoice.type !== PaymentType.bolt12)
      fail("Invoice already paid");
    ({ id: iid } = invoice);

    ref = invoice.uid;

    const equivalentRate =
      invoice.rate * (rates[currency] / rates[invoice.currency]);

    if (Math.abs(invoice.rate / rates[invoice.currency] - 1) < 0.01) {
      rate = equivalentRate;
    } else {
      warn("rate slipped", hash, invoice.rate, equivalentRate);
    }
  }

  const tip = parseInt(invoice?.tip) || null;
  if (tip < 0) fail("Invalid tip");

  if (!amount || amount < 0) fail("Amount must be greater than zero");

  let creditType = type;
  if (creditType === PaymentType.bolt12) creditType = PaymentType.lightning;
  let ourfee: any = [
    PaymentType.bitcoin,
    PaymentType.liquid,
    PaymentType.lightning,
  ].includes(type)
    ? Math.round((amount + fee + tip) * getConfig().fee[creditType])
    : 0;

  if (aid && aid !== uid) ourfee = 0;
  const frozenBalance =
    !blacklisted || whitelisted ? 0 : await ga(`balance:${uid}`);

  ourfee = await db.debit(
    `balance:${aid || uid}`,
    `credit:${creditType}:${aid !== uid ? 0 : uid}`,
    t(user).insufficientFunds,
    amount || 0,
    tip || 0,
    fee || 0,
    ourfee || 0,
    frozenBalance || 0,
  );

  if (ourfee.err) fail(ourfee.err);

  const id = v4();
  const p = {
    id,
    aid,
    amount: -amount,
    fee,
    hash,
    hex: undefined,
    ourfee,
    memo,
    iid,
    uid,
    confirmed: true,
    rate,
    currency,
    type,
    ref,
    tip,
    created: Date.now(),
  };

  // Only store payment records for internal fund transfers (not Breez SDK payments)
  // Lightning/Bitcoin/Liquid payments are tracked by Breez SDK client-side
  if (type === PaymentType.internal || type === PaymentType.fund) {
    await s(`payment:${id}`, p);
  }

  l(user.username, "sent", type, amount);

  return p;
};

export const credit = async ({
  hash,
  amount,
  memo = "",
  ref = "",
  type = PaymentType.internal,
  aid = undefined,
  payment_hash = undefined,
}) => {
  amount = parseInt(amount) || 0;

  let inv;
  if (type === PaymentType.bolt12) {
    // TODO: Implement in browser
    // const { invoices } = await ln.listinvoices({ invstring: hash });
    // const { local_offer_id } = invoices[0];
    // inv = await getInvoice(local_offer_id);
    inv = await getInvoice(hash);
  } else {
    inv = await getInvoice(hash);
  }

  if (!inv) {
    await safeDb.sAdd("missing", ref.split(":")[0]);
    return;
  }

  let { path, tip } = inv;
  tip = parseInt(tip) || 0;

  if (!memo) ({ memo } = inv);
  if (memo && memo.length > 5000) fail("memo too long");
  if (amount < 0 || tip < 0) fail("Invalid amount");
  if (type === PaymentType.internal) amount += tip;

  const user = await getUser(inv.uid);
  const { id: uid, currency } = user;

  const rates = await g("rates");
  let rate = rates[currency];

  if (!rate) await sleep(1000);
  rate = rates[currency];

  const equivalentRate = inv.rate * (rates[currency] / rates[inv.currency]);

  if (Math.abs(inv.rate / rates[inv.currency] - 1) < 0.01) {
    rate = equivalentRate;
  } else {
    // warn("rate slipped", hash, invoice.rate, equivalentRate);
  }

  const id = v4();
  const p = {
    aid,
    id,
    iid: inv.id,
    hash,
    amount: amount - tip,
    path,
    uid,
    rate,
    currency,
    memo,
    payment_hash,
    ref,
    tip,
    type,
    confirmed: true,
    created: Date.now(),
    items: undefined,
  };

  if ([PaymentType.bitcoin, PaymentType.liquid].includes(type))
    inv.pending += amount;
  else {
    inv.received += amount;
    inv.preimage = ref;
    inv.settled = Date.now();
  }

  let balanceKey = "balance";
  if ([PaymentType.bitcoin, PaymentType.liquid].includes(type)) {
    const [txid, vout] = ref.split(":").slice(-2);
    p.confirmed = false;
    balanceKey = "pending";
  }

  const m = await db.multi();

  let creditType = type;
  if (creditType === PaymentType.bolt12) creditType = PaymentType.lightning;
  if (
    [PaymentType.bitcoin, PaymentType.liquid, PaymentType.lightning].includes(
      creditType,
    )
  )
    m.incrBy(
      `credit:${creditType}:${uid}`,
      Math.round(amount * getConfig().fee[creditType]),
    );

  // Only store payment records for internal/fund transfers (not Breez SDK payments)
  // Lightning/Bitcoin/Liquid payments are tracked by Breez SDK client-side
  if (type === PaymentType.internal || type === PaymentType.fund) {
    m.set(`payment:${p.id}`, JSON.stringify(p))
      .lPush(`${aid || uid}:payments`, p.id);
  }

  m.set(`invoice:${inv.id}`, JSON.stringify(inv))
    .incrBy(`${balanceKey}:${aid || uid}`, amount)
    .set(`${aid || uid}:payments:last`, p.created)
    .exec();

  if (inv.items?.length) {
    formatReceipt(inv.items, inv.currency);
    p.items = inv.items;
  }

  await completePayment(inv, p, user);

  return p;
};

export const completePayment = async (inv, p, user) => {
  const { id, autowithdraw, threshold, reserve, destination, username } = user;
  let withdrawal;
  if (p.confirmed) {
    if (autowithdraw) {
      try {
        const to = destination.trim();
        const balance = await g(`balance:${id}`);
        const amount = balance - reserve;
        if (balance > threshold) {
          l("initiating autowithdrawal", amount, to, balance, threshold);
          const w = await pay({ amount, to, user });
          withdrawal = {
            amount: fmt(-w.amount),
            link: link(w.id),
          };
        }
      } catch (e) {
        console.log(e);
        withdrawal = { failed: true };
        warn(username, "autowithdraw failed", e.message);
      }
    }
  }

  // nwcNotify(p); // NWC disabled
  notify(p, user, withdrawal);
  l(username, "received", p.type, p.amount);
  callWebhook(inv, p);
};

const pay = async ({ aid = undefined, amount, to, user }) => {
  if (!aid) aid = user.id;
  amount = parseInt(amount) || 0;
  let lnurl;
  let pr;
  if (to.includes("@") && to.includes(".")) {
    const [name, domain] = to.split("@");
    if (URL.includes(domain)) to = name;
    lnurl = `https://${domain}/.well-known/lnurlp/${name}`;
  } else if (to.startsWith("lnurl")) {
    lnurl = Buffer.from(
      bech32.fromWords(bech32.decode(to, 20000).words),
    ).toString();
  }

  const recipient = await getUser(to);
  if (recipient)
    return sendInternal({
      amount,
      recipient,
      sender: user,
    });

  const fee = Math.max(5, Math.round(amount * 0.02));
  if (lnurl) {
    amount -= fee;
    const { callback } = (await got(lnurl).json()) as any;
    ({ pr } = (await got(`${callback}?amount=${amount * 1000}`).json()) as any);
  } else if (to.startsWith("ln")) {
    amount -= fee;
    pr = to;
  }

  return pr
    ? await sendLightning({ user, pr, amount, fee })
    : await sendOnchain({ aid, amount, address: to, user, subtract: true });
};

export const decode = async (hex) => {
  let type;
  let tx;
  // TODO: Implement raw transaction decoding with Breez SDK if needed
  // For now, we can't decode raw transactions without a node
  try {
    // tx = await bc.decodeRawTransaction(hex);
    // type = PaymentType.bitcoin;
    fail("Raw transaction decoding not available without Bitcoin node");
  } catch (e) {
    try {
      // tx = await lq.decodeRawTransaction(hex);
      // type = PaymentType.liquid;
      fail("Raw transaction decoding not available without Liquid node");
    } catch (e) {
      err("invalid hex", hex);
      fail("unrecognized tx");
    }
  }

  return { tx, type };
};

const inflight = {};
export const sendOnchain = async (params) => {
  let { aid, amount, address, user, rate } = params;
  if (!aid) aid = user.id;

  try {
    
    fail("Onchain payments now handled by browser SDK");
    
    // Determine payment type based on address
    const type = await getAddressType(address, user?.id);
    
    // Send payment via Breez SDK
    let result = null;
    if (type === PaymentType.bitcoin) {
      // Browser SDK handles bitcoin payments
      result = null;
    } else if (type === PaymentType.liquid) {
      // Browser SDK handles liquid payments
      result = null;
    } else {
      fail("Unsupported address type");
    }

    // Create payment record
    const p = await debit({
      aid,
      hash: result.txId,
      amount: parseInt(amount),
      fee: result.feesSat || 0,
      rate,
      user,
      type,
    });

    return p;
  } catch (e) {
    throw e;
  }
};

export const sendKeysend = async ({
  hash,
  amount,
  pubkey,
  fee = undefined,
  memo = undefined,
  user,
  extratlvs = undefined,
}) => {
  fee = Math.max(parseInt(fee || amount * 0.005), 5);

  let p = await g(`payment:${hash}`);
  if (p) fail("duplicate keysend");

  p = await debit({
    hash,
    amount,
    fee,
    memo,
    user,
    type: PaymentType.lightning,
  });

  // TODO: Implement in browser
  // const r = await ln.keysend({
  //   destination: pubkey,
  //   amount_msat: amount * 1000,
  //   maxfee: fee * 1000,
  //   retry_for: 10,
  //   extratlvs,
  // });

  // if (r.status !== "complete") reverse(p);
  const r = { status: "failed" };
  reverse(p);

  return r;
};

export const sendLightning = async ({
  user,
  pr,
  amount,
  fee = undefined,
  memo = undefined,
}) => {
  console.log(`[TRACE] sendLightning called: amount=${amount}, pr=${pr?.substring(0, 50)}...`);
  
  
  
  try {
    // Browser SDK handles lightning payments
    const result = null;
    
    // Return payment record in expected format
    return result ? result.payment : null;
  } catch (error) {
    console.error(`[TRACE] Payment failed:`, error);
    throw error;
  }
  
  // OLD CODE BELOW - keeping for reference but not executing
  return;
  let p;

  if (typeof amount !== "undefined") {
    amount = parseInt(amount);
    console.log(`[TRACE] Parsed amount: ${amount}`);
    if (amount < 0 || amount > SATS || Number.isNaN(amount)) {
      warn("invalid amount", amount);
      fail("Invalid amount");
    }
  }
  
  // Ensure the user's SDK session is active before attempting payment
  console.log(`[TRACE] Ensuring user session for user ${user.id}`);
  const { ensureUserSession } = await import("./wallet/sessionRestore");
  const sessionRestored = await ensureUserSession(user.id);
  console.log(`[TRACE] Session restored: ${sessionRestored}`);

  // TODO: Implement in browser
  // let { type, invoice_amount_msat, amount_msat, invoice_node_id, payee } =
  //   await ln.decode(pr);
  // if (type.includes("bolt12")) {
  //   amount_msat = invoice_amount_msat;
  //   payee = invoice_node_id;
  // }

  // let minfee = 2;
  // const { channels } = await ln.listpeerchannels();
  // if (channels.some((c) => c.peer_id === payee)) minfee = 0;

  // More generous fee calculation for better routing success
  if (!fee) {
    if (amount < 50) {
      // For very small amounts (< 50 sats), use fixed fee
      fee = 10; // Small fixed fee
    } else if (amount < 100) {
      // For small amounts (50-100 sats), use percentage but cap it
      fee = Math.min(20, Math.round(amount * 0.2)); // 20% max 20 sats
    } else if (amount < 1000) {
      // For medium amounts (100-1000 sats), use moderate percentage
      fee = Math.max(10, Math.round(amount * 0.05)); // 5% or 10 sats minimum
    } else if (amount > 10000) {
      // For large payments, use small percentage
      fee = Math.max(50, Math.round(amount * 0.005)); // 0.5% or 50 sats minimum
    } else {
      // Default for normal amounts
      fee = Math.max(20, Math.round(amount * 0.01)); // 1% or 20 sats default
    }
  } else {
    fee = Math.max(parseInt(fee), 5); // User-specified fee, minimum 5 sats
  }
  
  if (fee < 0) fail("Fee cannot be negative");

  // TODO: Implement in browser
  // const { pays } = await ln.listpays(pr);
  // if (pays.find((p) => p.status === "complete"))
  //   fail("Invoice has already been paid");

  // if (pays.find((p) => p.status === "pending"))
  //   fail("Payment is already underway");
  
  const amount_msat = amount * 1000;

  // Skip the problematic debit call for now and go straight to payment
  // We'll handle accounting after the payment succeeds
  const tempPaymentId = v4();
  p = {
    id: tempPaymentId,
    amount: -(amount || 0),
    fee: fee || 0,
    hash: pr,
    memo,
    uid: user.id,
    type: PaymentType.lightning,
    created: Date.now(),
    status: "pending"
  };

  await safeDb.sAdd("pending", pr);

  l("paying lightning invoice", pr.substr(-8), amount, fee);
  console.log(`[DEBUG] Attempting Lightning payment: amount=${amount}, fee=${fee}, invoice=${pr.substring(0, 50)}...`);

  try {
    console.log(`[TRACE] Parsing invoice with parseInput`);
    const parsed = await parseInput(pr, user?.id);
    console.log(`[TRACE] Parse result:`, parsed);
    if (!parsed) fail("Invalid payment request")
    
    const destination = pr.replace(/\s/g, "").toLowerCase();
    const isLnAddress = destination.includes("@");
    
    if (isLnAddress && !amount) {
      fail("Amount required for Lightning address");
    }
    
    // Validate amount - this will throw with a specific error message if invalid
    if (amount) {
      try {
        await validateAmount(amount, false);
      } catch (validationError) {
        // Pass through the specific validation error message
        fail(validationError.message);
      }
    }
    
    let result;
    if (isLnAddress) {
      result = await payLightningAddress(destination, amount, memo, user.id);
    } else {
      // Very generous max fee limits to ensure routing success
      // For 100 sat payments, we need to allow high fees
      const maxFeeSat = amount <= 100 
        ? amount // Allow up to 100% fees for 100 sats or less
        : amount < 500
          ? Math.round(amount * 0.5) // Up to 50% for small amounts
          : amount < 1000 
            ? Math.round(amount * 0.2) // Up to 20% for medium payments
            : Math.max(100, Math.round(amount * 0.05)); // Up to 5% for larger payments
        
      l(`Attempting Lightning payment: amount=${amount} sats, maxFee=${maxFeeSat} sats`);
      console.log(`[DEBUG] Calling sendPayment with: amount=${amount}, maxFee=${maxFeeSat}, userId=${user.id}`);
      result = await sendPayment(destination, amount, memo, null, maxFeeSat, user.id);
    }
    
    console.log(`[DEBUG] Payment result:`, result);
    if (result && result.payment) {
      // Payment succeeded, now handle accounting
      try {
        // Deduct from user balance
        const actualAmount = result.payment.amountSat || amount;
        const actualFee = result.payment.feesSat || fee || 0;
        
        // Update payment record
        p.amount = -actualAmount;
        p.fee = actualFee;
        p.preimage = result.payment.preimage;
        p.completed = Date.now();
        p.status = "complete";
        
        // Save payment record
        await s(`payment:${p.id}`, p);
        await db.lPush(`${user.id}:payments`, p.id);
        
        // Update user balance
        await db.incrBy(`balance:${user.id}`, -(actualAmount + actualFee));
        
        await safeDb.sRem("pending", pr);
      } catch (accountingErr) {
        console.error("[ERROR] Failed to update accounting after successful payment:", accountingErr);
        // Payment succeeded even if accounting fails
      }
    } else {
      throw new Error("Payment failed");
    }
  } catch (e) {
    console.error(`[DEBUG] Payment failed with error:`, e);
    console.error(`[DEBUG] Error message:`, e.message);
    console.error(`[DEBUG] Error stack:`, e.stack);
    err("failed to pay", pr.substr(-8), e.message);
    
    // Clean up pending status
    await safeDb.sRem("pending", pr);
    
    // Don't call reverse() since we didn't debit yet
    throw e;
  }

  return p;
};

export const sendInternal = async ({
  amount,
  invoice = undefined,
  memo = undefined,
  recipient,
  sender,
}) => {
  if (!invoice)
    invoice = await generate({
      invoice: { amount, type: "lightning" },
      user: recipient,
    });

  const { hash } = invoice;
  const p = await debit({ hash, amount, memo, user: sender });
  await credit({ hash, amount, memo, ref: sender.id });

  // if (invoice.memo?.includes("9734")) { // Nostr zaps disabled
  //   // TODO: Implement in browser
  //   // const { invoices } = await ln.listinvoices({ invstring: hash });
  //   // const inv = invoices[0];
  //   // inv.payment_preimage = p.id;
  //   // inv.paid_at = Math.floor(Date.now() / 1000);
  //   // handleZap(inv, sender.pubkey).catch(console.log);
  //   const inv = { payment_preimage: p.id, paid_at: Math.floor(Date.now() / 1000) };
  //   handleZap(inv, sender.pubkey).catch(console.log);
  // }

  return p;
};

const getAddressType = async (a, userId = null) => {
  // Use Breez SDK to determine address type
  try {
    const parsed = await parseInput(a, userId);
    if (parsed && parsed.type === "bitcoinAddress") {
      return PaymentType.bitcoin;
    } else if (parsed && parsed.type === "liquidAddress") {
      return PaymentType.liquid;
    }
  } catch (e) {
    // Fallback: simple pattern matching
    if (a.startsWith("bc1") || a.startsWith("tb1") || a.startsWith("bcrt1")) {
      return PaymentType.bitcoin;
    } else if (a.startsWith("ex1") || a.startsWith("tex1") || a.startsWith("ert1")) {
      return PaymentType.liquid;
    } else {
      fail("unrecognized address");
    }
  }
};

export const build = async ({
  aid,
  amount,
  address,
  feeRate,
  subtract,
  user,
}) => {
  const type = await getAddressType(address, user?.id);
  if (!aid) aid = user.id;
  
  amount = parseInt(amount);
  if (amount < 0) fail("invalid amount");

  // Get fee estimates from mempool API or use defaults
  const fees: any =
    type === PaymentType.liquid
      ? { fastestFee: 0.1, halfHourFee: 0.1, hourFee: 0.1 }
      : await fetch(`${api[type]}/fees/recommended`).then((r) => r.json()).catch(() => ({
          fastestFee: 10,
          halfHourFee: 8,
          hourFee: 5,
          economyFee: 2,
          minimumFee: 1
        }));

  fees.hourFee = fees.halfHourFee;
  fees.halfHourFee = fees.fastestFee;

  if (type === PaymentType.bitcoin) {
    fees.fastestFee = Math.round(fees.fastestFee * 1.1);
    if (fees.fastestFee === fees.halfHourFee) fees.fastestFee++;
    if (fees.hourFee === fees.halfHourFee) fees.hourFee--;
  }

  if (!feeRate) {
    feeRate = fees.halfHourFee;
  }

  if (feeRate < fees.hourFee) fail("fee rate too low");

  
  
  let prepared = { totalFeesSat: 0 }; // Browser SDK handles preparation
  if (type === PaymentType.bitcoin) {
    // Browser SDK handles bitcoin preparation
    prepared = { totalFeesSat: 0 };
  } else if (type === PaymentType.liquid) {
    // Browser SDK handles liquid preparation
    prepared = { totalFeesSat: 0 };
  } else {
    fail("Unsupported address type");
  }

  const balance = await g(`balance:${aid}`);
  let ourfee = Math.round(amount * getConfig().fee[type]);
  const credit = await g(`credit:${type}:${aid}`);
  const covered = Math.min(credit, ourfee);
  ourfee -= covered;

  if (aid && aid !== user.id) ourfee = 0;
  if (subtract || amount + prepared.totalFeesSat + ourfee > balance) {
    subtract = true;
    if (amount <= prepared.totalFeesSat + ourfee + dust) {
      fail(
        `insufficient funds ⚡️${balance} of ⚡️${amount + prepared.totalFeesSat + ourfee + dust}`,
      );
    }
  }

  return { 
    feeRate, 
    ourfee, 
    fee: prepared.totalFeesSat, 
    fees, 
    hex: "", // Not needed with Breez SDK
    inputs: [], // Not needed with Breez SDK
    subtract,
    prepareResponse: prepared.prepareResponse,
    limits: prepared.limits
  };
};

export const catchUp = async () => {
  try {
  } catch (e) {
    err("problem syncing", e.message);
  }

  setTimeout(catchUp, 10000);
};

export const reconcile = async (account, initial = false) => {
  try {
    const { id, uid } = account;
    const user = await getUser(uid);
    
    
    const walletInfo = null;
    
    if (!walletInfo) {
      warn("Wallet not initialized for reconciliation");
      return;
    }
    
    const total = Number(walletInfo.balanceSat) || 0;
    const { balanceAdjustment: memo } = t(user);
    const balance = await g(`balance:${id}`);
    const amount = Math.abs(total - balance);
    const hash = v4();

    if (total > balance) {
      const inv = {
        memo,
        type: PaymentType.reconcile,
        hash,
        amount,
        uid,
        aid: id,
      };
      await s(`invoice:${hash}`, inv);
      await credit({
        hash,
        amount,
        type: PaymentType.reconcile,
        aid: id,
      });
    } else if (total < balance) {
      await debit({
        aid: id,
        amount,
        hash: v4(),
        memo,
        user,
        type: PaymentType.reconcile,
      });
    }
  } catch (e) {
    console.log(e);
    warn("problem reconciling", e.message, account);
  }
};

export const check = async () => {
  const config = getConfig();
  if (config.url.includes("dev")) return;
  try {
    const payments = await safeDb.sMembers("pending");

    for (const pr of payments) {
      const p = await getPayment(pr);
      if (!p || Date.now() - p.created < 10000) continue;
      
      // TODO: Implement in browser
      // const { pays } = await ln.listpays(pr);

      // const failed = !pays.length || pays.every((p) => p.status === "failed");
      // const completed = pays.find((p) => p.status === "complete");

      try {
        // TODO: Implement Breez SDK payment completion/failure logic
        // if (completed) await finalize(completed, p);
        // else if (failed) await reverse(p);
        if (Date.now() - p.created > 600000) { // 10 minutes timeout
          await reverse(p);
        }
      } catch (e) {
        err("failed to finalize", p.id, e.message);
      }
    }
  } catch (e) {
    err("payment check failed", e.message);
  }

  setTimeout(check, 2000);
};

const finalize = async (r, p) => {
  let { preimage } = r;
  if (!preimage) preimage = r.payment_preimage;
  if (!preimage) fail("missing preimage");

  await safeDb.sRem("pending", p.hash);
  l("payment completed", p.id, r.payment_preimage);
  // nwcNotify(p); // NWC disabled

  const maxfee = p.fee;
  // TODO: Implement in browser
  // const { amount_msat } = await ln.decode(p.hash);
  // p.fee = Math.round((r.amount_sent_msat - amount_msat) / 1000);
  p.fee = Math.round((r.amount_sent_msat || 0) / 1000) || p.fee;
  p.ref = preimage;

  if (!(await g(`payment:${p.id}`)).ref) {
    await s(`payment:${p.id}`, p);

    l("refunding fee", maxfee, p.fee, maxfee - p.fee, p.ref);
    await db.incrBy(`balance:${p.uid}`, maxfee - p.fee);
  }

  return p;
};

const reverse = async (p) => {
  await sleep(Math.floor(Math.random() * (1500 - 500 + 1)) + 500);

  const total = Math.abs(p.amount) + p.fee + p.ourfee;
  const ourfee = p.ourfee || 0;
  const credit = Math.round(total * getConfig().fee[PaymentType.lightning]) - ourfee;

  l("reversing", p.id, p.amount, p.fee, total, ourfee, credit);

  await db.reverse(
    `payment:${p.id}`,
    `balance:${p.uid}`,
    `credit:${PaymentType.lightning}:${p.uid}`,
    `payment:${p.hash}`,
    `${p.uid}:payments`,
    p.id,
    total,
    credit,
    p.hash,
  );

  warn("reversed", p.id);
};

const freezeCheck = async () => {
  try {
    
    
    const lnbalance = 10000000;
    const bcbalance = 10000000;
    const lqbalance = 10000000;
    const usdtBalance = 0;
    
    // Get configured thresholds for each payment type
    const lnthreshold = await g("lightning:threshold") || 0;
    const bcthreshold = await g("bitcoin:threshold") || 0;
    const lqthreshold = await g("liquid:threshold") || 0;

    // Set limits based on available balance minus threshold
    // For development/production without node backend, set high limits
    await s("lightning:limit", Math.max(lnbalance - lnthreshold, 10000000));
    await s("bitcoin:limit", Math.max(bcbalance - bcthreshold, 10000000));
    await s("liquid:limit", Math.max(lqbalance - lqthreshold, 10000000));

    // Additional payment types use Lightning limits
    await s("fund:limit", Math.max(lnbalance - lnthreshold, 0));
    await s("ecash:limit", Math.max(lnbalance - lnthreshold, 0));
    await s("bolt12:limit", Math.max(lnbalance - lnthreshold, 0));
    
    // Store USDt balance separately if needed
    if (usdtBalance > 0) {
      await s("usdt:balance", usdtBalance);
    }
  } catch (e) {
    // Ignore errors - this runs in background and sessions may not be ready yet
  }

  setTimeout(freezeCheck, 10000);
};
// Delay initial check to allow sessions to load
setTimeout(freezeCheck, 5000);
