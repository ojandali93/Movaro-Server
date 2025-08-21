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
router.post("/payment-sheet", async (req, res) => {
  try {
    const { businessId, email, name } = req.body || {};
    if (!businessId || !email) return jerr(res, 400, "Missing businessId/email");

    const biz = await loadBusinessRow(businessId);

    // Ensure Stripe customer exists (reuse by email, or create)
    let customerId = biz.stripe_customer_id || null;
    if (!customerId) {
      const found = await stripe.customers.list({ email, limit: 1 });
      let customer = found.data[0];
      if (customer) {
        if (name && customer.name !== name) {
          customer = await stripe.customers.update(customer.id, { name });
        }
      } else {
        customer = await stripe.customers.create({
          email, name, metadata: { businessId: String(businessId) },
        });
      }
      customerId = customer.id;
      // Save mapping to Business
      await supabase.from("Business").update({
        stripe_customer_id: customerId, updated_at: new Date(),
      }).eq("id", businessId);
    }

    // Check for card
    const cust = await stripe.customers.retrieve(customerId);
    const defaultPM = cust?.invoice_settings?.default_payment_method || null;
    let hasDefaultPaymentMethod = !!defaultPM;
    if (!hasDefaultPaymentMethod) {
      const pms = await stripe.paymentMethods.list({ customer: customerId, type: "card" });
      hasDefaultPaymentMethod = pms.data.length > 0;
    }

    if (hasDefaultPaymentMethod) {
      return ok(res, {
        hasStripeCustomer: true,
        hasDefaultPaymentMethod: true,
        customerId,
        ephemeralKey: null,
        setupIntentClientSecret: null,
        merchantCountryCode: "US",
      });
    }

    // Need card → return PaymentSheet pieces
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: MOBILE_API_VERSION }
    );
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: "off_session",
    });

    return ok(res, {
      hasStripeCustomer: true,
      hasDefaultPaymentMethod: false,
      customerId,
      ephemeralKey: ephemeralKey.secret,
      setupIntentClientSecret: setupIntent.client_secret,
      merchantCountryCode: "US",
    });
  } catch (e) {
    console.error("payment-sheet error", e);
    return jerr(res, 500, "payment-sheet failed", e);
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
