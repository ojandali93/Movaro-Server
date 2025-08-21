/* eslint-disable no-console */
import express from "express";
import Stripe from "stripe";
import { supabase } from "../utils/supabase.js";
import crypto from "crypto";


const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const MOBILE_API_VERSION = "2024-06-20";

function safeIdemKey(parts) {
  const joined = parts.map(p => (p == null ? "" : String(p))).join(":");
  return joined.replace(/[^\w.\-:]/g, "_").slice(0, 200);
}

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
    const { businessId, userId, plan } = req.body || {};
    if (!businessId || !plan?.tierId) {
      return res.status(400).json({ error: "Missing businessId/plan" });
    }

    // 1) Load business & ensure Stripe customer
    const biz = await loadBusinessRow(businessId);
    if (!biz.stripe_customer_id) {
      return res.status(409).json({ error: "missing_customer" });
    }

    // 2) Ensure we have a default PM
    const cust = await stripe.customers.retrieve(biz.stripe_customer_id);
    let defaultPM = cust?.invoice_settings?.default_payment_method || null;
    if (!defaultPM) {
      const pms = await stripe.paymentMethods.list({
        customer: biz.stripe_customer_id,
        type: "card",
      });
      if (pms.data[0]) {
        await stripe.customers.update(biz.stripe_customer_id, {
          invoice_settings: { default_payment_method: pms.data[0].id },
        });
        defaultPM = pms.data[0].id;
      }
    }
    if (!defaultPM) {
      return res.status(200).json({
        requiresPaymentMethod: true,
        message: "Collect a card first with PaymentSheet.",
      });
    }

    // 3) Build subscription items (base + add-ons)
    const items = [];

    // Base: use mapped price or ad-hoc cents
    if (Number.isFinite(plan.baseAmountCents)) {
      const basePrice = await stripe.prices.create({
        unit_amount: Math.round(Number(plan.baseAmountCents)),
        currency: "usd",
        recurring: { interval: "month" },
        product_data: { name: `Movaro ${plan.tierId} (base)` },
      });
      items.push({ price: basePrice.id, quantity: 1 });
    } else {
      const mapped = TIER_PRICE_REF[plan.tierId]?.priceId;
      if (!mapped) return res.status(400).json({ error: `Unknown tierId: ${plan.tierId}` });
      items.push({ price: mapped, quantity: 1 });
    }

    // Add-ons
    const addonsArr = Array.isArray(plan.addons) ? plan.addons : [];
    const normalizedAddons = [];
    for (const a of addonsArr) {
      const kind = String(a?.kind || "").toLowerCase();
      if (!["driver", "stops100"].includes(kind)) continue;
      const quantity = Math.max(0, Math.floor(Number(a?.quantity || 0)));
      if (!quantity) continue;
      const unitCents = Math.max(0, Math.round(Number(a?.unitCents || 0)));

      const price = await stripe.prices.create({
        unit_amount: unitCents,
        currency: "usd",
        recurring: { interval: "month" },
        product_data: {
          name: kind === "driver" ? "Movaro Driver Add-on" : "Movaro Stops Add-on (per 100)",
          metadata: { kind, tierId: plan.tierId, businessId: String(businessId) },
        },
        metadata: { kind, tierId: plan.tierId, businessId: String(businessId) },
      });

      items.push({ price: price.id, quantity });
      normalizedAddons.push({ kind, quantity, unitCents, priceId: price.id });
    }

    const idemKey = safeIdemKey([
      "sub",
      businessId,
      plan.tierId,
      plan.billingMode || "monthly",
      Number(plan.baseAmountCents) || 0,
      ...normalizedAddons.flatMap(a => [a.kind, a.unitCents, a.quantity]),
    ]);

    // 4) Create subscription (default_incomplete so we must confirm the PI)
    const subscription = await stripe.subscriptions.create(
      {
        customer: biz.stripe_customer_id,
        items,
        payment_settings: { save_default_payment_method: "on_subscription" },
        payment_behavior: "default_incomplete",
        collection_method: "charge_automatically",
        proration_behavior: "create_prorations",
        metadata: {
          businessId: String(businessId),
          userId: userId ? String(userId) : "",
          tierId: plan.tierId,
          billingMode: plan.billingMode || "monthly",
          addons_json: JSON.stringify(normalizedAddons),
        },
        expand: [
          "items.data.price",
          "latest_invoice.payment_intent",
          "latest_invoice.payment_intent.charges",
          "latest_invoice.lines",
        ],
      },
      { idempotencyKey: idemKey }
    );

    // 5) Compute period total
    const driversQty = normalizedAddons.find(a => a.kind === "driver")?.quantity || 0;
    const stopsHundredsQty = normalizedAddons.find(a => a.kind === "stops100")?.quantity || 0;

    const periodAmountCents = (subscription.items?.data || []).reduce(
      (sum, it) => sum + ((it.price?.unit_amount || 0) * (it.quantity || 1)),
      0
    );

    // 6) Upsert Subscriptions row
    const subPayload = {
      business_id: businessId,
      user_id: userId ?? null,
      stripe_customer_id: biz.stripe_customer_id,
      stripe_subscription_id: subscription.id,
      tier: plan.tierId,
      billing_mode: plan.billingMode || "monthly",
      payment_amount_cents: periodAmountCents,
      currency: "usd",
      total_drivers: driversQty,
      drivers_left: driversQty,
      total_stops: stopsHundredsQty * 100,
      stops_left: stopsHundredsQty * 100,
      status: subscription.status,
      last_payment_at: null,
      current_period_start: subscription.current_period_start ? new Date(subscription.current_period_start * 1000) : null,
      current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
      cancel_at_period_end: !!subscription.cancel_at_period_end,
      canceled_at: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
      default_payment_method_id: subscription.default_payment_method || null,
      latest_invoice_id:
        typeof subscription.latest_invoice === "string"
          ? subscription.latest_invoice
          : subscription.latest_invoice?.id || null,
      metadata: subscription.metadata || {},
      updated_at: new Date(),
    };

    const { data: existing } = await supabase
      .from("Subscriptions")
      .select("id")
      .eq("stripe_subscription_id", subscription.id)
      .single();

    let localSubId = null;
    if (existing?.id) {
      await supabase.from("Subscriptions")
        .update(subPayload)
        .eq("stripe_subscription_id", subscription.id);
      localSubId = existing.id;
    } else {
      const ins = await supabase
        .from("Subscriptions")
        .insert({ ...subPayload, created_at: new Date() })
        .select("id")
        .single();
      localSubId = ins.data?.id ?? null;
    }

    // 7) Extract PI client_secret (so the app can confirm) + save receipt row
    let paymentIntentClientSecret = null;

    const inv = typeof subscription.latest_invoice === "object"
      ? (subscription.latest_invoice)
      : null;

    if (inv) {
      const pi =
        inv.payment_intent && typeof inv.payment_intent === "object"
          ? (inv.payment_intent)
          : null;

      if (pi?.client_secret) paymentIntentClientSecret = pi.client_secret;

      if (localSubId) {
        const charge = pi?.charges?.data?.[0] || null;
        const fingerprint = charge?.payment_method_details?.card?.fingerprint || null;
        const card_fingerprint_hash = fingerprint
          ? crypto.createHash("sha256").update(fingerprint).digest("hex")
          : null;

        await supabase.from("SubscriptionReceipts").insert({
          business_id: businessId,
          subscription_id: localSubId,
          stripe_invoice_id: inv.id,
          stripe_payment_intent_id: pi?.id || (typeof inv.payment_intent === "string" ? inv.payment_intent : null),
          stripe_charge_id: charge?.id || null,
          billing_reason: inv.billing_reason || null,
          invoice_status: inv.status || null,
          payment_intent_status: pi?.status || null,
          amount_due_cents: inv.amount_due || 0,
          amount_paid_cents: inv.amount_paid || 0,
          amount_remaining_cents: inv.amount_remaining || 0,
          subtotal_cents: inv.subtotal || 0,
          tax_cents: inv.tax || 0,
          discount_total_cents: (inv.total_discount_amounts || []).reduce((s, x) => s + (x.amount || 0), 0),
          currency: inv.currency || "usd",
          period_start: inv.lines?.data?.[0]?.period?.start ? new Date(inv.lines.data[0].period.start * 1000) : null,
          period_end:   inv.lines?.data?.[0]?.period?.end   ? new Date(inv.lines.data[0].period.end   * 1000) : null,
          hosted_invoice_url: inv.hosted_invoice_url || null,
          invoice_pdf_url: inv.invoice_pdf || null,
          receipt_url: charge?.receipt_url || null,
          payment_method_id:
            (pi?.payment_method && typeof pi.payment_method === "string")
              ? pi.payment_method
              : (pi?.payment_method)?.id || null,
          pm_brand: charge?.payment_method_details?.card?.brand || null,
          pm_last4: charge?.payment_method_details?.card?.last4 || null,
          pm_exp_month: charge?.payment_method_details?.card?.exp_month || null,
          pm_exp_year: charge?.payment_method_details?.card?.exp_year || null,
          card_fingerprint_hash,
          customer_email: inv.customer_email || null,
          customer_name: inv.customer_name || null,
          line_items: inv.lines || null,
          raw: inv,
          created_at: new Date(),
        });
      }
    }

    // 7b) Optional fallback: if there was no PI (very rare), try to pay invoice server-side
    if (!paymentIntentClientSecret && typeof subscription.latest_invoice === "string") {
      const paid = await stripe.invoices.pay(subscription.latest_invoice, { expand: ["payment_intent"] });
      const pi = typeof paid.payment_intent === "object" ? (paid.payment_intent) : null;
      if (pi?.client_secret) paymentIntentClientSecret = pi.client_secret;
    }

    // 8) Respond to client (client will call confirmPayment with the secret)
    return res.json({
      subscriptionId: subscription.id,
      status: subscription.status,
      paymentIntentClientSecret, // ← this must be non-null for client confirmation (3DS, etc.)
    });
  } catch (e) {
    console.error("subscribe error", e);
    return res.status(500).json({ error: "subscribe failed", detail: String(e?.message || e) });
  }
});


router.post('/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${(err).message}`);
    }

    switch (event.type) {
      case 'invoice.payment_succeeded': {
        const inv = event.data.object;
        const subId = typeof inv.subscription === 'string'
          ? inv.subscription
          : inv.subscription?.id;

        // Flip to active; update period dates + last_payment_at
        await supabase.from('Subscriptions')
          .update({
            status: 'active',
            last_payment_at: new Date(),
            current_period_start: inv.lines?.data?.[0]?.period?.start
              ? new Date(inv.lines.data[0].period.start * 1000) : null,
            current_period_end: inv.lines?.data?.[0]?.period?.end
              ? new Date(inv.lines.data[0].period.end * 1000) : null,
          })
          .eq('stripe_subscription_id', subId);
        break;
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        const subId = typeof inv.subscription === 'string'
          ? inv.subscription
          : inv.subscription?.id;
        await supabase.from('Subscriptions')
          .update({ status: 'past_due' })
          .eq('stripe_subscription_id', subId);
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await supabase.from('Subscriptions')
          .update({
            status: sub.status,
            cancel_at_period_end: !!sub.cancel_at_period_end,
            canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
            current_period_start: sub.current_period_start
              ? new Date(sub.current_period_start * 1000) : null,
            current_period_end: sub.current_period_end
              ? new Date(sub.current_period_end * 1000) : null,
          })
          .eq('stripe_subscription_id', sub.id);
        break;
      }
    }
    res.json({ received: true });
  }
);

router.get('/billing/subscriptions/:id', async (req, res) => {
  const sub = await stripe.subscriptions.retrieve(req.params.id);
  res.json({ status: sub.status });
});


export default router;
