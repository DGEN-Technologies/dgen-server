import { getConfig } from "./config-loader";
import { db, g, s } from "./db";
// import { request } from "./ecash"; // Ecash disabled
import { emit } from "./sockets";
import { SATS, bip21, fail, getUser } from "./utils";
import { v4 } from "uuid";
import { l as logger } from "./logging";

import { PaymentType } from "./types";

// Bitcoin and Liquid RPC removed
// const bc = rpc(config.bitcoin);
// const lq = rpc(config.liquid);

export const generate = async ({ invoice, user }) => {
  let {
    address_type,
    bolt11,
    aid,
    currency,
    expiry,
    fiat,
    tip,
    amount,
    items = [],
    own,
    rate,
    request_id,
    memo,
    memoPrompt,
    prompt,
    type = PaymentType.lightning,
    webhook,
    secret,
  } = invoice;

  amount = parseInt(amount || 0);
  tip = tip == null ? null : parseInt(tip);

  if (user) user = await getUser(user.username);
  if (!user) fail("user not provided");
  if (typeof prompt === "undefined") prompt = user.prompt;

  // Account handling
  let account = null;
  if (aid) {
    account = await g(`account:${aid}`);
  }
  if (!account) {
    account = await g(`account:${user.id}`);
  }
  
  // If still no account, create a virtual account
  if (!account) {
    // For Bitcoin/Lightning/Liquid/USDt, handled in browser
    if (type === PaymentType.bitcoin || type === PaymentType.lightning || type === PaymentType.liquid || type === PaymentType.bolt12 || type === PaymentType.usdt) {
      account = {
        id: `wallet-${user.id}`,
        type: type,
        name: type === PaymentType.lightning ? "Lightning" : 
              type === PaymentType.bitcoin ? "Bitcoin" : 
              type === PaymentType.usdt ? "Tether USD" : "Liquid"
      };
      aid = account.id;
    } else {
      fail("account not found and cannot create virtual account for this payment type");
    }
  } else {
    aid = account.id;
  }

  const rates = await g("rates");
  if (!currency) currency = user.currency;
  if (!rate) rate = rates[currency];
  if (fiat) amount = Math.round((SATS * fiat) / rate);
  if (amount < 0) fail("invalid amount");
  if (tip < 0) fail("invalid tip");
  if (rate < 0) fail("invalid rate");
  if (memo && memo.length > 5000) fail("memo too long");

  const id = v4();

  let hash;
  let text;
  let path;
  let paymentHash;

  if (type === PaymentType.lightning) {
    // Lightning invoices generated in browser
    fail("Lightning invoices must be generated in the browser.");
  } else if (type === PaymentType.bolt12) {
    // BOLT12 offers generated in browser
    fail("BOLT12 offers must be generated in the browser.");
  } else if (type === PaymentType.bitcoin) {
    // Bitcoin addresses generated in browser
    fail("Bitcoin addresses must be generated in the browser.");
  } else if (type === PaymentType.liquid) {
    // Liquid addresses generated in browser
    fail("Liquid addresses must be generated in the browser.");
  } else if (type === PaymentType.usdt) {
    // USDt addresses generated in browser
    fail("USDt addresses must be generated in the browser.");
  } else if (type === PaymentType.internal) {
    hash = id;
  // } else if (type === PaymentType.ecash) { // Ecash disabled
  //   hash = id;
  //   text = request(id, amount, memo);
  } else {
    fail(`unrecognized type ${type}`);
  }

  invoice = {
    amount,
    aid,
    address_type,
    created: Date.now(),
    currency,
    hash,
    expiry,
    id,
    items,
    memo,
    rate,
    paymentHash,
    pending: 0,
    received: 0,
    request_id,
    memoPrompt,
    own,
    path,
    prompt,
    secret,
    text,
    tip,
    type,
    uid: user.id,
    webhook,
  };

  // Store invoice metadata for dgen-specific tracking only
  // Lightning/Bitcoin/Liquid invoices generated and tracked by browser SDK
  await s(`invoice:${id}`, invoice);
  await db.lPush(`${aid}:invoices`, id);
  await db.lPush(`${user.id}:invoices`, id);

  if (request_id) {
    const request = await g(`request:${request_id}`);
    if (request) {
      const { invoice_id: prev } = request;
      request.invoice_id = id;
      await s(`request:${request_id}`, request);

      if (!prev) emit(request.requester_id, "invoice", invoice);
    }
  }

  return invoice;
};
