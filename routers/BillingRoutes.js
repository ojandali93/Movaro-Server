/* eslint-disable no-console */
import express from "express";
import Stripe from "stripe";
import { supabase } from "../utils/supabase.js";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const MOBILE_API_VERSION = "2024-06-20";

// Map your base plan tiers to Stripe Price IDs (change to yours)
const TIER_PRICE_REF = {
  starter:    { priceId: "price_1Rxd4fFb5QGtuTxnswOezQOy" },
  growth:     { priceId: "price_1Rxd71Fb5QGtuTxncCI3eESn" },
  pro:        { priceId: "price_1Rxd7aFb5QGtuTxngC037A0a" },
  premium:    { priceId: "price_1Rxd8HFb5QGtuTxn3soBEWl7" },
  enterprise: { priceId: "price_1Rxd8wFb5QGtuTxnm0iQqR11" },
};

const jerr = (res, code, msg, detail) => res.status(code).json({ ok:false, error:msg, detail: String(detail||"") });
const ok = (res, payload) => res.json({ ok:true, ...payload });

async function loadBusinessRow(businessId) {
  const { data, error } = await supabase
    .from("Business")
    .select("id, stripe_customer_id")
    .eq("id", businessId)
    .single();
  if (error || !data) throw new Error("Business not found");
  return data;
}

// --- create/reuse Stripe customer at signup ---
router.post("/customers", async (req, res) => {
  try {
    const { name, email, businessId, phone, metadata, forceNew = false } = req.body || {};
    if (!email) {
      return res.status(400).json({ ok: false, error: "Missing email" });
    }

    let customer = null;

    // Try re-use by email unless forceNew is true
    if (!forceNew) {
      try {
        const found = await stripe.customers.list({ email, limit: 1 });
        if (found.data[0]) customer = found.data[0];
      } catch (e) {
        // non-fatal
        console.warn("Stripe customers.list warning:", e?.message || e);
      }
    }

    // Create if not found
    if (!customer) {
      customer = await stripe.customers.create({
        email,
        name,
        ...(phone ? { phone } : {}),
        metadata: {
          ...(metadata || {}),
          ...(businessId ? { businessId: String(businessId) } : {}),
        },
      });
    } else if (name || phone || metadata) {
      // Light “freshen” of fields if changed
      const toUpdate = {};
      if (name && customer.name !== name) toUpdate.name = name;
      if (phone && customer.phone !== phone) toUpdate.phone = phone;
      if (metadata && typeof metadata === "object") {
        toUpdate.metadata = { ...(customer.metadata || {}), ...metadata };
      }
      if (Object.keys(toUpdate).length > 0) {
        customer = await stripe.customers.update(customer.id, toUpdate);
      }
    }

    // Optionally map to Business.stripe_customer_id
    let savedToBusiness = false;
    if (businessId) {
      try {
        const { error } = await supabase
          .from("Business")
          .update({ stripe_customer_id: customer.id, updated_at: new Date() })
          .eq("id", businessId);
        if (!error) savedToBusiness = true;
      } catch (e) {
        console.warn("Business update warning:", e?.message || e);
      }
    }

    // Clean payload
    const clean = (c) => ({
      id: c.id,
      name: c.name || null,
      email: c.email || null,
      phone: c.phone || null,
      address: c.address || null,
      metadata: c.metadata || {},
      created: c.created ? new Date(c.created * 1000) : null,
    });

    return res.json({
      ok: true,
      customerId: customer.id,
      customer: clean(customer),
      savedToBusiness,
    });
  } catch (err) {
    console.error("customers error:", err);
    return res.status(500).json({ ok: false, error: "customers failed", detail: String(err?.message || err) });
  }
});


/** COMBINED: ensure customer, check card, return PaymentSheet bits if needed */
// /billing/payment-sheet  (combined: ensure customer + card check + cache snapshot)
router.post("/payment-sheet", async (req, res) => {
  try {
    const {
      businessId,
      email,
      name,
      customerId: customerIdIn,  // optional
      userId,                    // optional -> Profile.id
      tier,                      // optional -> e.g. 'starter'
      billingMode = "monthly",   // optional; default monthly
      paymentAmountCents,        // optional; number (cents)
      paymentAmount,             // optional; number (dollars) if you prefer
      totalDrivers,              // optional
      totalStops,                // optional
      driversLeft,               // optional
      stopsLeft,                 // optional
      createIfMissing = true,    // ensure Stripe customer exists
    } = req.body || {};

    if (!businessId || !email) {
      return res.status(400).json({ ok: false, error: "Missing businessId/email" });
    }

    // ---------- 1) Load business row ----------
    const { data: biz, error: bizErr } = await supabase
      .from("Business")
      .select("id, stripe_customer_id")
      .eq("id", businessId)
      .single();

    if (bizErr || !biz) {
      return res.status(404).json({ ok: false, error: "Business not found" });
    }

    // ---------- 2) Ensure/retrieve Stripe customer ----------
    let customerId = customerIdIn || biz.stripe_customer_id || null;
    let createdNew = false;

    if (!customerId && createIfMissing) {
      // Try to reuse by email first
      let customer = null;
      try {
        const found = await stripe.customers.list({ email, limit: 1 });
        if (found.data[0]) {
          customer = found.data[0];
          // lightly freshen name
          if (name && customer.name !== name) {
            customer = await stripe.customers.update(customer.id, { name });
          }
        }
      } catch (e) {
        // non-fatal
        console.warn("Stripe customers.list warn:", e?.message || e);
      }

      if (!customer) {
        const idemKey = safeIdemKey(["cust", businessId, email]);
        customer = await stripe.customers.create(
          { email, name, metadata: { businessId: String(businessId) } },
          { idempotencyKey: idemKey }
        );
        createdNew = true;
      }

      customerId = customer.id;

      // Persist mapping to Business (idempotent)
      try {
        await supabase
          .from("Business")
          .update({ stripe_customer_id: customerId, updated_at: new Date() })
          .eq("id", businessId);
      } catch (e) {
        console.warn("Business mapping update warn:", e?.message || e);
      }
    }

    if (!customerId) {
      return res.status(409).json({ ok: false, error: "missing_customer" });
    }

    // ---------- 3) Check for default payment method ----------
    const cust = await stripe.customers.retrieve(customerId);
    // @ts-ignore (plain JS)
    const defaultPM = cust?.invoice_settings?.default_payment_method || null;

    let hasDefaultPaymentMethod = !!defaultPM;
    if (!hasDefaultPaymentMethod) {
      const pms = await stripe.paymentMethods.list({ customer: customerId, type: "card" });
      hasDefaultPaymentMethod = (pms.data || []).length > 0;
    }

    // ---------- 4) Prepare PaymentSheet pieces if needed ----------
    let epkSecret = null;
    let siSecret = null;
    if (!hasDefaultPaymentMethod) {
      const epk = await stripe.ephemeralKeys.create(
        { customer: customerId },
        { apiVersion: MOBILE_API_VERSION }
      );
      const si = await stripe.setupIntents.create({
        customer: customerId,
        usage: "off_session",
      });
      epkSecret = epk.secret;
      siSecret = si.client_secret;
    }

    // ---------- 5) Cache a "subscription snapshot" row in Subscriptions ----------
    // Keep this non-blocking: if it fails we still return success to the client.
    const amountCents = Number.isFinite(paymentAmountCents)
      ? Math.round(Number(paymentAmountCents))
      : Number.isFinite(paymentAmount)
      ? Math.round(Number(paymentAmount) * 100)
      : null;

    const asInt = (v) =>
      v === undefined || v === null || Number.isNaN(Number(v)) ? null : Math.max(0, Math.floor(Number(v)));

    const snapshot = {
      business_id: businessId,
      user_id: userId ?? null,
      stripe_customer_id: customerId,
      stripe_subscription_id: null, // not created yet
      tier: tier || null,
      billing_mode: billingMode || null,
      payment_amount_cents: amountCents,
      currency: "usd",
      total_drivers: asInt(totalDrivers),
      drivers_left: asInt(driversLeft ?? totalDrivers),
      total_stops: asInt(totalStops),
      stops_left: asInt(stopsLeft ?? totalStops),
      status: hasDefaultPaymentMethod ? "has_pm" : "pending_pm",
      last_payment_at: null,
      current_period_start: null,
      current_period_end: null,
      cancel_at_period_end: false,
      canceled_at: null,
      default_payment_method_id: defaultPM || null,
      latest_invoice_id: null,
      metadata: {
        source: "payment-sheet",
        createdNewCustomer: !!createdNew,
      },
      updated_at: new Date(),
      // created_at is default now()
    };

    try {
      await supabase.from("Subscriptions").insert(snapshot);
    } catch (dbErr) {
      // Not fatal—log and continue. You can tighten this later.
      console.warn("Subscriptions snapshot insert warn:", dbErr?.message || dbErr);
    }

    // ---------- 6) Respond (always JSON) ----------
    return res.json({
      ok: true,
      hasStripeCustomer: true,
      hasDefaultPaymentMethod,
      customerId,
      ephemeralKey: epkSecret,                // null if has card
      setupIntentClientSecret: siSecret,      // null if has card
      merchantCountryCode: "US",
      createdNew,
    });
  } catch (err) {
    console.error("payment-sheet error:", err);
    // Always JSON to prevent “Unexpected <” on the client
    return res.status(500).json({
      ok: false,
      error: "payment-sheet failed",
      detail: String(err?.message || err),
    });
  }
});


/** SIMPLE SUBSCRIBE: base plan only (no add-ons yet) */
router.post("/subscribe", async (req, res) => {
  try {
    const { businessId, plan } = req.body || {};
    if (!businessId || !plan?.tierId) return jerr(res, 400, "Missing businessId/plan");

    const biz = await loadBusinessRow(businessId);
    if (!biz.stripe_customer_id) return jerr(res, 409, "missing_customer");

    // Make sure a card exists
    const cust = await stripe.customers.retrieve(biz.stripe_customer_id);
    const hasPM = !!cust?.invoice_settings?.default_payment_method
      || (await stripe.paymentMethods.list({ customer: biz.stripe_customer_id, type: "card" })).data.length > 0;

    if (!hasPM) {
      return ok(res, { requiresPaymentMethod: true, message: "Collect a card first with PaymentSheet." });
    }

    // Use a mapped price, or ad-hoc cents if provided
    let items = [];
    if (Number.isFinite(plan.baseAmountCents)) {
      const price = await stripe.prices.create({
        unit_amount: Math.round(Number(plan.baseAmountCents)),
        currency: "usd",
        recurring: { interval: "month" },
        product_data: { name: `Movaro ${plan.tierId} (base)` },
      });
      items.push({ price: price.id, quantity: 1 });
    } else {
      const mapped = TIER_PRICE_REF[plan.tierId]?.priceId;
      if (!mapped) return jerr(res, 400, `Unknown tierId: ${plan.tierId}`);
      items.push({ price: mapped, quantity: 1 });
    }

    const subscription = await stripe.subscriptions.create({
      customer: biz.stripe_customer_id,
      items,
      payment_settings: { save_default_payment_method: "on_subscription" },
      payment_behavior: "default_incomplete",
      proration_behavior: "create_prorations",
      metadata: { businessId: String(businessId), tierId: plan.tierId },
      expand: ["latest_invoice.payment_intent"],
    });

    const latestInvoice = subscription.latest_invoice;
    const paymentIntentSecret = typeof latestInvoice === "object"
      ? latestInvoice?.payment_intent?.client_secret
      : null;

    return ok(res, {
      subscriptionId: subscription.id,
      status: subscription.status,
      paymentIntentClientSecret: paymentIntentSecret || null,
    });
  } catch (e) {
    console.error("subscribe error", e);
    return jerr(res, 500, "subscribe failed", e);
  }
});

export default router;
