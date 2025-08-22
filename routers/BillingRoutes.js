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
        const cutoff = new Date("2025-09-10T23:59:59"); // Sept 10, 11:59 PM local time
        const now = new Date();
    
        const updatePayload = {
          stripe_customer_id: customer.id,
          updated_at: new Date(),
          exempt: now < cutoff,
        };
    
        const { error } = await supabase
          .from("Business")
          .update(updatePayload)
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
    let defaultPM = (cust)?.invoice_settings?.default_payment_method || null;
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
          // optional: store the base sent from client for auditing
          baseDrivers: String(plan.baseDrivers ?? plan.extras?.baseDrivers ?? 0),
          baseStops:   String(plan.baseStops   ?? plan.extras?.baseStops   ?? 0),
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

    // 5) Compute allowances (base + add-ons) and period total  -----------------
    const addonDrivers = normalizedAddons
      .filter(a => a.kind === "driver")
      .reduce((sum, a) => sum + (a.quantity || 0), 0);

    const addonStopsHundreds = normalizedAddons
      .filter(a => a.kind === "stops100")
      .reduce((sum, a) => sum + (a.quantity || 0), 0);

    // base from client (preferred), fall back to nested extras, else 0
    const baseDrivers = Math.max(
      0,
      Math.floor(Number(plan.baseDrivers ?? plan.extras?.baseDrivers ?? 0))
    );
    const baseStops = Math.max(
      0,
      Math.floor(Number(plan.baseStops ?? plan.extras?.baseStops ?? 0))
    );

    const totalDrivers = baseDrivers + addonDrivers;
    const totalStops   = baseStops + (addonStopsHundreds * 100);

    const periodAmountCents = (subscription.items?.data || []).reduce(
      (sum, it) => sum + ((it.price?.unit_amount || 0) * (it.quantity || 1)),
      0
    );

    // 6) Upsert Subscriptions row (by subscription id) -------------------------
    const subPayload = {
      business_id: businessId,
      user_id: userId ?? null,
      stripe_customer_id: biz.stripe_customer_id,
      stripe_subscription_id: subscription.id,
      tier: plan.tierId,
      billing_mode: plan.billingMode || "monthly",
      payment_amount_cents: periodAmountCents,
      currency: "usd",
      total_drivers: totalDrivers,
      drivers_left:  totalDrivers,
      total_stops:   totalStops,
      stops_left:    totalStops,
      status: subscription.status,
      last_payment_at: null,
      current_period_start: subscription.current_period_start ? new Date(subscription.current_period_start * 1000) : null,
      current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
      cancel_at_period_end: !!subscription.cancel_at_period_end,
      canceled_at: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
      default_payment_method_id: (subscription).default_payment_method || null,
      latest_invoice_id:
        typeof subscription.latest_invoice === "string"
          ? subscription.latest_invoice
          : (subscription.latest_invoice)?.id || null,
      metadata: subscription.metadata || {},
      updated_at: new Date(),
    };

    // prefer upsert by stripe_subscription_id (not customer)
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

    // 7) Extract PI client_secret (so the app can confirm) + save receipt ------
    let paymentIntentClientSecret = null;

    const inv = typeof subscription.latest_invoice === "object"
      ? (subscription.latest_invoice)
      : null;

    if (inv) {
      const pi = inv.payment_intent && typeof inv.payment_intent === "object"
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

    // 7b) Optional: if no PI, try to pay invoice server-side (rare)
    if (!paymentIntentClientSecret && typeof subscription.latest_invoice === "string") {
      const paid = await stripe.invoices.pay(subscription.latest_invoice, { expand: ["payment_intent"] });
      const pi = typeof paid.payment_intent === "object" ? (paid.payment_intent) : null;
      if (pi?.client_secret) paymentIntentClientSecret = pi.client_secret;
    }

    // 8) Respond to client
    return res.json({
      subscriptionId: subscription.id,
      status: subscription.status,
      paymentIntentClientSecret,
    });
  } catch (e) {
    console.error("subscribe error", e);
    return res.status(500).json({ error: "subscribe failed", detail: String(e?.message || e) });
  }
});

router.post('/invoices/:invoiceId/pay', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    if (!invoiceId) return res.status(400).json({ ok: false, error: 'Missing invoiceId' });

    const paid = await stripe.invoices.pay(invoiceId, { expand: ['payment_intent'] }); // uses default PM
    const status = paid.status; // 'paid' if success
    const piStatus = typeof paid.payment_intent === 'object' ? paid.payment_intent?.status : null;

    return res.json({ ok: true, invoiceStatus: status, paymentIntentStatus: piStatus });
  } catch (e) {
    // surfaces decline codes in Stripe error if any
    console.error('invoice pay error:', e);
    return res.status(400).json({ ok: false, error: 'pay_failed', detail: String(e?.message || e) });
  }
});

// GET /billing/history?businessId=123&limit=20&cursor=<iso or id>
router.get('/history', async (req, res) => {
  try {
    const businessId = req.query.businessId;
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const cursor = req.query.cursor; // optional ISO or created_at

    if (!businessId) return res.status(400).json({ error: 'Missing businessId' });

    // Prefer your local receipts table
    let qb = supabase
      .from('SubscriptionReceipts')
      .select(`
        id,
        created_at,
        stripe_invoice_id,
        stripe_payment_intent_id,
        stripe_charge_id,
        billing_reason,
        invoice_status,
        payment_intent_status,
        amount_due_cents,
        amount_paid_cents,
        amount_remaining_cents,
        subtotal_cents,
        tax_cents,
        currency,
        period_start,
        period_end,
        hosted_invoice_url,
        invoice_pdf_url,
        receipt_url,
        customer_email,
        customer_name
      `)
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (cursor) {
      // naive cursor: created_at < cursor
      qb = qb.lt('created_at', cursor);
    }

    const { data, error } = await qb;
    if (error) throw new Error(error.message);

    // If we have rows locally, return those
    if (data && data.length) {
      const nextCursor = data.length === limit ? data[data.length - 1].created_at : null;
      return res.json({ ok: true, source: 'local', items: data, nextCursor });
    }

    // Fallback to Stripe (if table empty for this biz)
    // Need the customer id
    const biz = await loadBusinessRow(businessId);
    if (!biz?.stripe_customer_id) return res.json({ ok: true, source: 'stripe', items: [], nextCursor: null });

    const invs = await stripe.invoices.list({
      customer: biz.stripe_customer_id,
      limit,
      ...(cursor ? { created: { lt: Math.floor(new Date(cursor).getTime() / 1000) } } : {}),
      expand: ['data.payment_intent'],
    });

    const items = (invs.data || []).map((inv) => ({
      id: null,
      created_at: inv.created ? new Date(inv.created * 1000).toISOString() : null,
      stripe_invoice_id: inv.id,
      stripe_payment_intent_id: typeof inv.payment_intent === 'object' ? inv.payment_intent?.id : inv.payment_intent || null,
      stripe_charge_id: null,
      billing_reason: inv.billing_reason || null,
      invoice_status: inv.status || null,
      payment_intent_status: typeof inv.payment_intent === 'object' ? inv.payment_intent?.status : null,
      amount_due_cents: inv.amount_due || 0,
      amount_paid_cents: inv.amount_paid || 0,
      amount_remaining_cents: inv.amount_remaining || 0,
      subtotal_cents: inv.subtotal || 0,
      tax_cents: inv.tax || 0,
      currency: inv.currency || 'usd',
      period_start: inv.lines?.data?.[0]?.period?.start ? new Date(inv.lines.data[0].period.start * 1000).toISOString() : null,
      period_end:   inv.lines?.data?.[0]?.period?.end   ? new Date(inv.lines.data[0].period.end   * 1000).toISOString() : null,
      hosted_invoice_url: inv.hosted_invoice_url || null,
      invoice_pdf_url: inv.invoice_pdf || null,
      receipt_url: null,
      customer_email: inv.customer_email || null,
      customer_name: inv.customer_name || null,
    }));

    const nextCursor = invs.has_more && invs.data.length
      ? new Date(invs.data[invs.data.length - 1].created * 1000).toISOString()
      : null;

    return res.json({ ok: true, source: 'stripe', items, nextCursor });
  } catch (e) {
    console.error('history error:', e);
    return res.status(500).json({ ok: false, error: 'history failed', detail: String(e?.message || e) });
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

/** Safely pull subscription id from a Stripe Invoice or Subscription ref */
function subIdFromInvoice(inv) {
  if (!inv) return null;
  if (typeof inv.subscription === 'string') return inv.subscription;
  return inv.subscription?.id || null;
}

function periodFromLines(inv) {
  const line = inv?.lines?.data?.[0];
  return {
    start: line?.period?.start ? new Date(line.period.start * 1000) : null,
    end: line?.period?.end ? new Date(line.period.end * 1000) : null,
  };
}

async function upsertReceiptFromInvoice(inv) {
  // Expand PI if present so we can store details
  let pi = null;
  if (typeof inv.payment_intent === 'object') {
    pi = inv.payment_intent;
  }

  const charge = pi?.charges?.data?.[0] || null;
  const fingerprint = charge?.payment_method_details?.card?.fingerprint || null;
  const card_fingerprint_hash = fingerprint
    ? crypto.createHash('sha256').update(fingerprint).digest('hex')
    : null;

  const period = periodFromLines(inv);

  // We don’t necessarily know local subscription_id; store what we can
  const row = {
    business_id: (inv.customer) || null, // You can’t map business_id directly from invoice; optional to leave null
    // If you DO store mapping of stripe_customer_id -> business_id, you can join it first and populate business_id.

    // Store linkage by invoice/subscription — these are the important foreigns
    stripe_invoice_id: inv.id,
    stripe_payment_intent_id:
      (typeof inv.payment_intent === 'string' ? inv.payment_intent : pi?.id) || null,
    stripe_charge_id: charge?.id || null,

    billing_reason: inv.billing_reason || null,
    invoice_status: inv.status || null,
    payment_intent_status: pi?.status || null,

    amount_due_cents: inv.amount_due || 0,
    amount_paid_cents: inv.amount_paid || 0,
    amount_remaining_cents: inv.amount_remaining || 0,
    subtotal_cents: inv.subtotal || 0,
    tax_cents: inv.tax || 0,
    currency: inv.currency || 'usd',

    period_start: period.start,
    period_end: period.end,

    hosted_invoice_url: inv.hosted_invoice_url || null,
    invoice_pdf_url: inv.invoice_pdf || null,
    receipt_url: charge?.receipt_url || null,

    payment_method_id:
      (pi?.payment_method && typeof pi.payment_method === 'string')
        ? (pi.payment_method)
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
    updated_at: new Date(),
  };

  // Upsert by unique key stripe_invoice_id to avoid duplicates
  // Make sure you have a unique index on SubscriptionReceipts.stripe_invoice_id
  const { error } = await supabase
    .from('SubscriptionReceipts')
    .upsert(row, { onConflict: 'stripe_invoice_id' });

  if (error) {
    console.warn('SubscriptionReceipts upsert warn:', error.message);
  }
}

async function markSubscription(
  stripeSubscriptionId,
  fields
) {
  if (!stripeSubscriptionId) return;
  const { error } = await supabase
    .from('Subscriptions')
    .update({ ...fields, updated_at: new Date() })
    .eq('stripe_subscription_id', stripeSubscriptionId);

  if (error) {
    console.warn('Subscriptions update warn:', error.message);
  }
}

/** Main webhook handler (exported) */
export async function stripeWebhookHandler(req, res) {
  const sig = req.headers['stripe-signature'];
  if (!sig) {
    return res.status(400).json({ ok: false, error: 'Missing stripe-signature' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verify failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      // ========= INVOICES =========
      case 'invoice.payment_succeeded': {
        const inv = event.data.object;
        const subId = subIdFromInvoice(inv);

        await upsertReceiptFromInvoice(inv);

        // Mark subscription active and set period dates + last_payment_at
        const period = periodFromLines(inv);
        await markSubscription(subId || '', {
          status: 'active',
          last_payment_at: new Date(),
          current_period_start: period.start,
          current_period_end: period.end,
        });
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object;
        const subId = subIdFromInvoice(inv);

        await upsertReceiptFromInvoice(inv);

        await markSubscription(subId || '', {
          status: 'past_due',
        });
        break;
      }

      case 'invoice.finalized': {
        // Optional: store an early copy (status = 'open') so history shows immediately
        const inv = event.data.object;
        await upsertReceiptFromInvoice(inv);
        break;
      }

      // ========= SUBSCRIPTIONS =========
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;

        await markSubscription(sub.id, {
          status: sub.status,
          cancel_at_period_end: !!sub.cancel_at_period_end,
          canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
          current_period_start: sub.current_period_start
            ? new Date(sub.current_period_start * 1000)
            : null,
          current_period_end: sub.current_period_end
            ? new Date(sub.current_period_end * 1000)
            : null,
          // You may also store default_payment_method if present:
          default_payment_method_id:
            typeof sub.default_payment_method === 'string'
              ? sub.default_payment_method
              : (sub.default_payment_method)?.id || null,
        });
        break;
      }

      // ========= OPTIONAL: PI lifecycle (for debugging or analytics) =========
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed':
      case 'payment_intent.processing': {
        // Usually not needed if invoice events are handled, but you can log if desired
        break;
      }

      default:
        // No-op for other events
        break;
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err.message || err);
    // Return 2xx so Stripe doesn’t retry forever if your DB momentarily fails.
    // If you prefer retries, return 500 instead – but be sure your handler is idempotent.
    return res.status(200).json({ received: true, note: 'handled with warnings' });
  }
}

// GET /billing/summary?businessId=123
router.get('/summary', async (req, res) => {
  try {
    const businessId = req.query.businessId;
    if (!businessId) return res.status(400).json({ ok:false, error:'Missing businessId' });

    const biz = await loadBusinessRow(businessId);
    if (!biz?.stripe_customer_id) {
      return res.json({ ok:true, subscription:null, paymentMethods:[], invoiceOpen:null, usage:null, customerId:null });
    }

    const customerId = biz.stripe_customer_id;

    // Pull the most recent subscription row you already maintain
    const { data: subRow } = await supabase
      .from('Subscriptions')
      .select('*')
      .eq('stripe_customer_id', customerId)
      .order('updated_at', { ascending:false })
      .limit(1)
      .maybeSingle();

    // Fallback to Stripe if needed
    let stripeSub = null;
    if (!subRow) {
      const list = await stripe.subscriptions.list({ customer: customerId, status:'all', limit: 1, expand: ['data.latest_invoice.payment_intent'] });
      stripeSub = list.data[0] || null;
    }

    // Usage: prefer your DB counters; fallback to totals - left
    const totalDrivers = subRow?.total_drivers ?? 0;
    const totalStops   = subRow?.total_stops   ?? 0;
    const driversLeft  = subRow?.drivers_left  ?? totalDrivers;
    const stopsLeft    = subRow?.stops_left    ?? totalStops;

    const usage = {
      driversTotal: totalDrivers,
      driversUsed: Math.max(0, totalDrivers - driversLeft),
      driversLeft: Math.max(0, driversLeft),
      stopsTotal: totalStops,
      stopsUsed: Math.max(0, totalStops - stopsLeft),
      stopsLeft: Math.max(0, stopsLeft),
      asOf: new Date().toISOString(),
    };

    // Payment methods + default
    const cust = await stripe.customers.retrieve(customerId);
    // @ts-ignore
    const defaultPM = cust?.invoice_settings?.default_payment_method || null;
    const pms = await stripe.paymentMethods.list({ customer: customerId, type:'card' });

    const paymentMethods = (pms.data || []).map(pm => ({
      id: pm.id,
      brand: pm.card?.brand || 'card',
      last4: pm.card?.last4 || '',
      exp_month: pm.card?.exp_month || null,
      exp_year: pm.card?.exp_year || null,
      isDefault: (typeof defaultPM === 'string' ? defaultPM : defaultPM?.id) === pm.id,
    }));

    // Find an open invoice (unpaid) for "Pay now"
    const invs = await stripe.invoices.list({ customer: customerId, status: 'open', limit: 1, expand:['data.payment_intent'] });
    const inv = invs.data?.[0] || null;
    const invoiceOpen = inv ? {
      id: inv.id,
      amount_due_cents: inv.amount_due || 0,
      created_at: inv.created ? new Date(inv.created * 1000).toISOString() : null,
      status: inv.status,
      hosted_invoice_url: inv.hosted_invoice_url || null,
      invoice_pdf_url: inv.invoice_pdf || null,
    } : null;

    // Compose subscription summary
    const subscription = subRow ? {
      stripe_subscription_id: subRow.stripe_subscription_id,
      status: subRow.status,
      tier: subRow.tier,
      billing_mode: subRow.billing_mode,
      current_period_start: subRow.current_period_start,
      current_period_end: subRow.current_period_end,
      cancel_at_period_end: subRow.cancel_at_period_end,
      payment_amount_cents: subRow.payment_amount_cents,
      last_payment_at: subRow.last_payment_at,
      latest_invoice_id: subRow.latest_invoice_id,
      total_drivers: subRow.total_drivers,
      total_stops: subRow.total_stops,
    } : (stripeSub ? {
      stripe_subscription_id: stripeSub.id,
      status: stripeSub.status,
      tier: (stripeSub.metadata)?.tierId || null,
      billing_mode: (stripeSub.metadata)?.billingMode || null,
      current_period_start: stripeSub.current_period_start ? new Date(stripeSub.current_period_start * 1000) : null,
      current_period_end: stripeSub.current_period_end ? new Date(stripeSub.current_period_end * 1000) : null,
      cancel_at_period_end: !!stripeSub.cancel_at_period_end,
      payment_amount_cents: (stripeSub.items?.data || []).reduce((s, it)=> s + ((it.price?.unit_amount||0) * (it.quantity||1)), 0),
      last_payment_at: null,
      latest_invoice_id: typeof stripeSub.latest_invoice === 'string' ? stripeSub.latest_invoice : stripeSub.latest_invoice?.id || null,
      total_drivers: 0,
      total_stops: 0,
    } : null);

    return res.json({ ok:true, customerId, subscription, paymentMethods, invoiceOpen, usage });
  } catch (e:any) {
    console.error('summary error:', e);
    return res.status(500).json({ ok:false, error:'summary_failed', detail:String(e?.message||e) });
  }
});

// POST /billing/payment-methods/default
// body: { businessId: string|number, paymentMethodId: string }
router.post('/payment-methods/default', async (req, res) => {
  try {
    const { businessId, paymentMethodId } = req.body || {};
    if (!businessId || !paymentMethodId) return res.status(400).json({ ok:false, error:'Missing params' });

    const biz = await loadBusinessRow(businessId);
    if (!biz?.stripe_customer_id) return res.status(404).json({ ok:false, error:'Missing Stripe customer' });

    // Attach PM to customer if not already attached
    try {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: biz.stripe_customer_id });
    } catch (_) { /* if already attached, ignore */ }

    const updated = await stripe.customers.update(biz.stripe_customer_id, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    return res.json({ ok:true, defaultPaymentMethodId: (updated).invoice_settings?.default_payment_method || paymentMethodId });
  } catch (e) {
    console.error('set default pm error:', e);
    return res.status(400).json({ ok:false, error:'set_default_failed', detail:String(e?.message||e) });
  }
});

// POST /billing/payment-methods/:pmId/detach
// body: { businessId }
router.post('/payment-methods/:pmId/detach', async (req, res) => {
  try {
    const { pmId } = req.params;
    const { businessId } = req.body || {};
    if (!pmId || !businessId) return res.status(400).json({ ok:false, error:'Missing params' });

    const biz = await loadBusinessRow(businessId);
    if (!biz?.stripe_customer_id) return res.status(404).json({ ok:false, error:'Missing Stripe customer' });

    const cust = await stripe.customers.retrieve(biz.stripe_customer_id);
    // @ts-ignore
    const defaultPM = cust?.invoice_settings?.default_payment_method || null;
    const defaultId = typeof defaultPM === 'string' ? defaultPM : defaultPM?.id;

    if (defaultId === pmId) {
      return res.status(400).json({ ok:false, error:'cannot_detach_default' });
    }

    const result = await stripe.paymentMethods.detach(pmId);
    return res.json({ ok:true, detached: result.id });
  } catch (e) {
    console.error('detach pm error:', e);
    return res.status(400).json({ ok:false, error:'detach_failed', detail:String(e?.message||e) });
  }
});


// POST /billing/subscription/cancel
// body: { businessId, atPeriodEnd?: boolean }  (default true)
router.post('/subscription/cancel', async (req, res) => {
  try {
    const { businessId, atPeriodEnd = true } = req.body || {};
    if (!businessId) return res.status(400).json({ ok:false, error:'Missing businessId' });

    const biz = await loadBusinessRow(businessId);
    if (!biz?.stripe_customer_id) return res.status(404).json({ ok:false, error:'Missing Stripe customer' });

    const subs = await stripe.subscriptions.list({ customer: biz.stripe_customer_id, status:'all', limit:1 });
    const sub = subs.data[0];
    if (!sub) return res.status(404).json({ ok:false, error:'No subscription' });

    let updated;
    if (atPeriodEnd) {
      updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
    } else {
      // Immediate cancel
      updated = await stripe.subscriptions.cancel(sub.id);
    }

    // Reflect in DB (best-effort)
    await supabase.from('Subscriptions').update({
      status: updated.status,
      cancel_at_period_end: !!updated.cancel_at_period_end,
      canceled_at: updated.canceled_at ? new Date(updated.canceled_at * 1000) : null,
      updated_at: new Date(),
    }).eq('stripe_subscription_id', updated.id);

    return res.json({ ok:true, subscriptionId: updated.id, status: updated.status, cancel_at_period_end: updated.cancel_at_period_end });
  } catch (e) {
    console.error('cancel sub error:', e);
    return res.status(400).json({ ok:false, error:'cancel_failed', detail:String(e?.message||e) });
  }
});

// POST /billing/subscription/reactivate
// body: { businessId }
router.post('/subscription/reactivate', async (req, res) => {
  try {
    const { businessId } = req.body || {};
    if (!businessId) return res.status(400).json({ ok:false, error:'Missing businessId' });

    const biz = await loadBusinessRow(businessId);
    if (!biz?.stripe_customer_id) return res.status(404).json({ ok:false, error:'Missing Stripe customer' });

    const subs = await stripe.subscriptions.list({ customer: biz.stripe_customer_id, status:'all', limit:1 });
    const sub = subs.data[0];
    if (!sub) return res.status(404).json({ ok:false, error:'No subscription' });

    const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });

    await supabase.from('Subscriptions').update({
      status: updated.status,
      cancel_at_period_end: !!updated.cancel_at_period_end,
      updated_at: new Date(),
    }).eq('stripe_subscription_id', updated.id);

    return res.json({ ok:true, subscriptionId: updated.id, status: updated.status, cancel_at_period_end: updated.cancel_at_period_end });
  } catch (e) {
    console.error('reactivate sub error:', e);
    return res.status(400).json({ ok:false, error:'reactivate_failed', detail:String(e?.message||e) });
  }
});



export default router;