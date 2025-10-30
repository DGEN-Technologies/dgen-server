import { db, g, s } from "../lib/db";
import { generate } from "../lib/invoices";
import { err } from "../lib/logging";
import { bail, fail, fields, getInvoice, getUser } from "../lib/utils";

export default {
  async get(req, res) {
    try {
      const {
        params: { id },
      } = req;
      if (id === "undefined") fail("invalid id");
      const invoice = await getInvoice(id);

      if (invoice) {
        invoice.secret = undefined;
        invoice.user = await getUser(invoice.uid, fields);

        invoice.items ||= [];
      }
      if (invoice) res.send(invoice);
      else fail("invoice not found");
    } catch (e) {
      bail(res, e.message);
    }
  },

  async create(req, res) {
    let { body, user } = req;
    let { invoice } = body;

    // Ensure we have a user - either from auth or from body
    if (body.user) {
      user = body.user;
    } else if (!user && req.user) {
      user = req.user;
    }
    
    if (!user) {
      return bail(res, "user not provided");
    }
    
    // Ensure invoice object exists
    if (!invoice) {
      // If invoice is not provided, check if body contains invoice properties directly
      if (body.amount || body.type) {
        invoice = {
          amount: body.amount,
          type: body.type,
          memo: body.memo || body.description || "",
          expiry: body.expiry
        };
      } else {
        return bail(res, "invoice data not provided");
      }
    }
    
    // Set ownership flag
    if (req.user && req.user.username === user.username) {
      invoice.own = true;
    } else {
      invoice.own = false;
    }

    try {
      const result = await generate({ invoice, user });
      res.send(result);
    } catch (e) {
      err(
        "problem generating invoice",
        req.user?.username,
        body.user?.username,
        e.message,
      );
      bail(res, e.message);
    }
  },

  async update(req, res) {
    try {
      const { id } = req.params;
      const { body } = req;
      if (!body.invoice?.tip || body.invoice.tip < 0) fail("Invalid tip");

      const invoice = await g(`invoice:${id}`);
      invoice.tip = body.invoice.tip;
      await s(`invoice:${id}`, invoice);

      res.send(invoice);
    } catch (e) {
      bail(res, e.message);
    }
  },

  async list(req, res) {
    const { id } = req.user;
    let invoices = await db.lRange(`${id}:invoices`, 0, -1);
    invoices = await Promise.all(invoices.map((i) => getInvoice(i)));
    res.send(invoices);
  },
};
