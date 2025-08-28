/* eslint-disable no-console */
import express from "express";
import Stripe from "stripe";
import { supabase } from "../utils/supabase.js";
import crypto from "crypto";


const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const MOBILE_API_VERSION = "2024-06-20";

const DISCOUNT_CODE_LA_CUTOFF_ISO = '2025-09-22T06:59:59.999Z';
const DEFAULT_DISCOUNT_CODE = 'beta-signup';

const LA_CUTOFF_ISO = '2025-09-10T23:59:59-07:00'; // PDT cutoff
const PROMO_COUPON_ID = process.env.STRIPE_PROMO_1Y_COUPON_ID; // coupon_...

function addOneYear(d) {
  const n = new Date(d);
  n.setFullYear(n.getFullYear() + 1);
  return n;
}

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

    let savedToBusiness = false;
    if (businessId) {
      try {
        const cutoff = new Date("2025-09-10T23:59:59"); // Sept 10, 11:59 PM local time
        const now = new Date();
    
        const updatePayload = {
          stripe_customer_id: customer.id,
          updated_at: new Date(),
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
// /billing/payment-sheet
router.post("/payment-sheet", async (req, res) => {
  try {
    const {
      businessId,
      email,
      name,
      customerId: customerIdIn, // optional
      userId,                   // optional -> Profile.id
      tier,                     // optional -> e.g. 'starter'
      billingMode = "monthly",  // optional; default monthly
      paymentAmountCents,       // optional; number (cents)
      paymentAmount,            // optional; number (dollars)
      totalDrivers,             // optional
      totalStops,               // optional
      driversLeft,              // optional
      stopsLeft,                // optional
      createIfMissing = true,
      clientIntentId,           // <<—— pass from client; ties this call to /subscribe
    } = req.body || {};

    if (!businessId || !email) {
      return res.status(400).json({ ok:false, error:"Missing businessId/email" });
    }

    // ---------- 1) Load business ----------
    const { data: biz, error: bizErr } = await supabase
      .from("Business")
      .select("id, stripe_customer_id")
      .eq("id", businessId)
      .single();

    console.log('payment sheet biz top: ', biz)

    if (bizErr || !biz) {
      return res.status(404).json({ ok:false, error:"Business not found" });
    }

    // ---------- 2) Ensure/retrieve Stripe customer ----------
    let customerId = customerIdIn || biz.stripe_customer_id || null;
    let createdNew = false;

    console.log('payment sheet customerId: ', customerId)

    if (!customerId && createIfMissing) {
      // Try re-use by email first
      let customer = null;
      try {
        const found = await stripe.customers.list({ email, limit: 1 });
        if (found.data[0]) {
          customer = found.data[0];
          if (name && customer.name !== name) {
            customer = await stripe.customers.update(customer.id, { name });
          }
        }
      } catch (e) {
        console.warn("Stripe customers.list warn:", e?.message || e);
      }

      console.log('payment sheet customer: ', customer)

      if (!customer) {
        const idemKey = safeIdemKey(["cust", businessId, email]);
        customer = await stripe.customers.create(
          { email, name, metadata: { businessId: String(businessId) } },
          { idempotencyKey: idemKey }
        );
        createdNew = true;
      }

      console.log('payment sheet customerId: ', customerId)

      customerId = customer.id;

      console.log('create new record: ', customerId)

      // Persist to Business (best effort)
      try {
        const response =await supabase
          .from("Business")
          .update({ stripe_customer_id: customerId, updated_at: new Date() })
          .eq("id", businessId)
          .select();

        console.log('update business: ', response)

      } catch (e) {
        console.warn("Business mapping update warn:", e?.message || e);
      }
    }

    if (!customerId) {
      return res.status(409).json({ ok:false, error:"missing_customer" });
    }

    // ---------- 3) Check for default payment method ----------
    const cust = await stripe.customers.retrieve(customerId);
    const defaultPM = cust?.invoice_settings?.default_payment_method || null;

    let hasDefaultPaymentMethod = !!defaultPM;
    if (!hasDefaultPaymentMethod) {
      const pms = await stripe.paymentMethods.list({ customer: customerId, type: "card" });
      hasDefaultPaymentMethod = (pms.data || []).length > 0;
    }

    // ---------- 4) Prepare PaymentSheet pieces if needed ----------
    const MOBILE_API_VERSION = "2024-06-20";
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

    // ---------- 5) Reserve/refresh ONE local snapshot row keyed by checkout_key ----------
    const amountCents = Number.isFinite(paymentAmountCents)
      ? Math.round(Number(paymentAmountCents))
      : Number.isFinite(paymentAmount)
      ? Math.round(Number(paymentAmount) * 100)
      : null;

    const asInt = (v) =>
      v === undefined || v === null || Number.isNaN(Number(v))
        ? null
        : Math.max(0, Math.floor(Number(v)));

    const checkoutKey = safeIdemKey([
      "checkout",
      businessId,
      clientIntentId || "once",
    ]);

    // Try to find existing pending row for this checkout key
    const { data: pendingRow } = await supabase
      .from("Subscriptions")
      .select("id, created_at")
      .eq("business_id", businessId)
      .is("stripe_subscription_id", null)
      .filter("metadata->>checkout_key", "eq", checkoutKey)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    console.log('payment sheet pendingRow: ', pendingRow)

    const snapshotPayload = {
      business_id: businessId,
      user_id: userId ?? null,
      stripe_customer_id: customerId,
      stripe_subscription_id: null,
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
      default_payment_method_id: (typeof defaultPM === "string" ? defaultPM : defaultPM?.id) || null,
      latest_invoice_id: null,
      metadata: {
        source: "payment-sheet",
        createdNewCustomer: !!createdNew,
        checkout_key: checkoutKey,
      },
      updated_at: new Date(),
    };

    if (pendingRow?.id) {
      // Refresh the pending row
      const response = await supabase
        .from("Subscriptions")
        .update(snapshotPayload)
        .eq("id", pendingRow.id)
        .select();

      console.log('update pending row: ', response)
    } else {
      // Insert a single pending row for this checkout key
      const response = await supabase.from("Subscriptions").insert(snapshotPayload);

      console.log('insert pending row: ', response)
    }

    // ---------- 6) Respond ----------
    return res.json({
      ok: true,
      hasStripeCustomer: true,
      hasDefaultPaymentMethod,
      customerId,
      ephemeralKey: epkSecret,               // null if already has card
      setupIntentClientSecret: siSecret,     // null if already has card
      merchantCountryCode: "US",
      createdNew,
      checkoutKey,                           // <<— the client can keep it if needed
    });
  } catch (err) {
    console.error("payment-sheet error:", err);
    return res.status(500).json({
      ok:false,
      error:"payment-sheet failed",
      detail:String(err?.message || err),
    });
  }
});



router.post('/subscribe', async (req, res) => {
  try {
    const {
      businessId,
      userId,
      clientIntentId: clientIntentIdTop,
      discountCode: discountCodeIn,
      plan,
    } = req.body || {};

    console.log('subscribe req.body: ', req.body)

    if (!businessId || !plan?.tierId) {
      return res.status(400).json({ error: 'Missing businessId/plan' });
    }

    // --- 1) Load business (need created_at for promo eligibility) ---
    const { data: bizRow, error: bizErr } = await supabase
      .from('Business')
      .select('id, stripe_customer_id, created_at')
      .eq('id', businessId)
      .single();

    if (bizErr || !bizRow) return res.status(404).json({ error: 'Business not found' });
    if (!bizRow.stripe_customer_id) return res.status(409).json({ error: 'missing_customer' });

    // Free-year eligibility
    const LA_CUTOFF_ISO = '2025-09-10T23:59:59-07:00'; // 11:59 PM PT Sep 10
    const PROMO_COUPON_ID = 'beta-signup'; // coupon_...
    const createdAt = bizRow.created_at ? new Date(bizRow.created_at) : new Date();
    const eligibleForPromo = !!PROMO_COUPON_ID && createdAt <= new Date(LA_CUTOFF_ISO);

    // Discount window eligibility (11:59 PM PT Sep 21 → 06:59:59.999Z on Sep 22)
    const DISCOUNT_CODE_LA_CUTOFF_ISO = '2025-09-22T06:59:59.999Z';
    const eligibleForDiscountWindow = new Date() <= new Date(DISCOUNT_CODE_LA_CUTOFF_ISO);

    // Carry the same clientIntentId across calls
    const clientIntentIdResolved = clientIntentIdTop || plan?.clientIntentId || null;
    const checkoutKey = safeIdemKey(['checkout', businessId, clientIntentIdResolved || 'once']);

    // --- 2) Ensure default PM (ok if absent when invoice is $0) ---
    const cust = await stripe.customers.retrieve(bizRow.stripe_customer_id);
    let defaultPM = cust?.invoice_settings?.default_payment_method || null;
    if (!defaultPM) {
      const pms = await stripe.paymentMethods.list({
        customer: bizRow.stripe_customer_id,
        type: 'card',
      });
      if (pms.data[0]) {
        await stripe.customers.update(bizRow.stripe_customer_id, {
          invoice_settings: { default_payment_method: pms.data[0].id },
        });
        defaultPM = pms.data[0].id;
      }
    }

    // --- 3) Build subscription items (base + add-ons) ---
    const items = [];
    const normalizedAddons = [];

    // Base
    if (Number.isFinite(plan.baseAmountCents)) {
      const baseUnit = Math.round(Number(plan.baseAmountCents));
      const basePrice = await stripe.prices.create(
        {
          unit_amount: baseUnit,
          currency: 'usd',
          recurring: { interval: 'month' },
          product_data: { name: `Movaro ${plan.tierId} (base)` },
          metadata: { type: 'base', tierId: plan.tierId, businessId: String(businessId) },
        },
        { idempotencyKey: safeIdemKey(['price','base', businessId, plan.tierId, baseUnit, clientIntentIdResolved || '']) }
      );
      items.push({ price: basePrice.id, quantity: 1 });
    } else {
      const mapped = TIER_PRICE_REF[plan.tierId]?.priceId;
      if (!mapped) return res.status(400).json({ error: `Unknown tierId: ${plan.tierId}` });
      items.push({ price: mapped, quantity: 1 });
    }

    // Add-ons
    const addonsArr = Array.isArray(plan.addons) ? plan.addons : [];
    for (const a of addonsArr) {
      const kind = String(a?.kind || '').toLowerCase();
      if (!['driver', 'stops100'].includes(kind)) continue;

      const quantity = Math.max(0, Math.floor(Number(a?.quantity || 0)));
      if (!quantity) continue;

      const unitCents = Math.max(0, Math.round(Number(a?.unitCents || 0)));

      const addonPrice = await stripe.prices.create(
        {
          unit_amount: unitCents,
          currency: 'usd',
          recurring: { interval: 'month' },
          product_data: {
            name: kind === 'driver' ? 'Movaro Driver Add-on' : 'Movaro Stops Add-on (per 100)',
            metadata: { kind, tierId: plan.tierId, businessId: String(businessId) },
          },
          metadata: { kind, tierId: plan.tierId, businessId: String(businessId) },
        },
        { idempotencyKey: safeIdemKey(['price','addon', kind, businessId, plan.tierId, unitCents, clientIntentIdResolved || '']) }
      );

      items.push({ price: addonPrice.id, quantity });
      normalizedAddons.push({ kind, quantity, unitCents, priceId: addonPrice.id });
    }

    // --- 3b) Discount resolution (only if inside window and not free-year) ---
    const discountCodeRaw = (
      (discountCodeIn || plan?.couponId || process.env.DEFAULT_DISCOUNT_CODE || '')
        .toString()
        .trim()
    );

    let resolvedDiscount = null; // { promotion_code } or { coupon }
    let resolvedKind = null;
    let resolvedId = null;

    if (!eligibleForPromo && eligibleForDiscountWindow && discountCodeRaw) {
      try {
        const pc = await stripe.promotionCodes.list({ code: discountCodeRaw, active: true, limit: 1 });
        if (pc.data[0]) {
          resolvedDiscount = { promotion_code: pc.data[0].id };
          resolvedKind = 'promotion_code';
          resolvedId = pc.data[0].id;
        }
      } catch {}
      if (!resolvedDiscount) {
        try {
          const c = await stripe.coupons.retrieve(discountCodeRaw);
          // @ts-ignore
          if (c && !c.deleted) {
            resolvedDiscount = { coupon: c.id };
            resolvedKind = 'coupon';
            resolvedId = c.id;
          }
        } catch {}
      }
    }

    // --- 3c) Idempotency key for subscription ---
    const idemKey = safeIdemKey([
      'sub',
      businessId,
      plan.tierId,
      plan.billingMode || 'monthly',
      Number(plan.baseAmountCents) || 0,
      ...normalizedAddons.flatMap(a => [a.kind, a.unitCents, a.quantity]),
      eligibleForPromo ? 'promoFreeYear'
        : eligibleForDiscountWindow
          ? (resolvedKind ? `${resolvedKind}:${resolvedId}` : 'inWindow:noDiscount')
          : 'outOfWindow',
      clientIntentIdResolved || Date.now(),
    ]);

    // --- 4) Create subscription in Stripe ---
    const subParams = {
      customer: bizRow.stripe_customer_id,
      items,
      payment_settings: { save_default_payment_method: 'on_subscription' },
      payment_behavior: 'default_incomplete',
      collection_method: 'charge_automatically',
      proration_behavior: 'create_prorations',
      metadata: {
        businessId: String(businessId),
        userId: userId ? String(userId) : '',
        tierId: plan.tierId,
        billingMode: plan.billingMode || 'monthly',
        addons_json: JSON.stringify(normalizedAddons),
        baseDrivers: String(plan.baseDrivers ?? plan.extras?.baseDrivers ?? 0),
        baseStops:   String(plan.baseStops   ?? plan.extras?.baseStops   ?? 0),
        promoApplied: eligibleForPromo ? 'true' : 'false',
        appliedDiscountCode: eligibleForPromo ? '' : (eligibleForDiscountWindow ? (discountCodeRaw || '') : ''),
        appliedDiscountKind: eligibleForPromo ? 'free_year_promo' : (eligibleForDiscountWindow ? (resolvedKind || '') : 'outside_window'),
        appliedDiscountId:   eligibleForPromo ? (PROMO_COUPON_ID || '') : (eligibleForDiscountWindow ? (resolvedId || '') : ''),
        discountWindowEligible: eligibleForDiscountWindow ? 'true' : 'false',
        discountWindowCutoffIso: DISCOUNT_CODE_LA_CUTOFF_ISO,
        checkout_key: checkoutKey, // keep the thread
      },
      expand: [
        'items.data.price',
        'latest_invoice.payment_intent',
        'latest_invoice.payment_intent.charges',
        'latest_invoice.lines',
      ],
    };

    if (eligibleForPromo) {
      subParams.discounts = [{ coupon: PROMO_COUPON_ID }];
    } else if (resolvedDiscount) {
      subParams.discounts = [resolvedDiscount];
    }

    const subscription = await stripe.subscriptions.create(subParams, { idempotencyKey: idemKey });

    // --- 5) Compute allowances ---
    const addonDrivers = normalizedAddons.filter(a => a.kind === 'driver').reduce((s, a) => s + (a.quantity || 0), 0);
    const addonStopsHundreds = normalizedAddons.filter(a => a.kind === 'stops100').reduce((s, a) => s + (a.quantity || 0), 0);
    const baseDrivers = Math.max(0, Math.floor(Number(plan.baseDrivers ?? plan.extras?.baseDrivers ?? 0)));
    const baseStops   = Math.max(0, Math.floor(Number(plan.baseStops   ?? plan.extras?.baseStops   ?? 0)));

    const totalDrivers = baseDrivers + addonDrivers;
    const totalStops   = baseStops + (addonStopsHundreds * 100);

    const periodAmountCents = (subscription.items?.data || [])
      .reduce((sum, it) => sum + ((it.price?.unit_amount || 0) * (it.quantity || 1)), 0);

    const promoEndsAt = eligibleForPromo ? (() => { const d = new Date(createdAt); d.setFullYear(d.getFullYear() + 1); return d; })() : null;
    const unlimited = !!eligibleForPromo;

    // --- 6) Update the *pending* snapshot row if present; else upsert by sub id ---
    const subPayload = {
      business_id: businessId,
      user_id: userId ?? null,
      stripe_customer_id: bizRow.stripe_customer_id,
      stripe_subscription_id: subscription.id,
      tier: plan.tierId,
      billing_mode: plan.billingMode || 'monthly',
      payment_amount_cents: periodAmountCents,
      currency: 'usd',
      total_drivers: unlimited ? null : totalDrivers,
      drivers_left:  unlimited ? null : totalDrivers,
      total_stops:   unlimited ? null : totalStops,
      stops_left:    unlimited ? null : totalStops,
      is_promo: unlimited,
      promo_ends_at: promoEndsAt,
      unlimited_drivers: unlimited,
      unlimited_stops: unlimited,
      status: subscription.status,
      last_payment_at: null,
      current_period_start: subscription.current_period_start ? new Date(subscription.current_period_start * 1000) : null,
      current_period_end:   subscription.current_period_end   ? new Date(subscription.current_period_end   * 1000) : null,
      cancel_at_period_end: !!subscription.cancel_at_period_end,
      canceled_at: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
      default_payment_method_id:
        typeof subscription.default_payment_method === 'string'
          ? subscription.default_payment_method
          : (subscription.default_payment_method)?.id || null,
      latest_invoice_id:
        typeof subscription.latest_invoice === 'string'
          ? subscription.latest_invoice
          : subscription.latest_invoice?.id || null,
      metadata: {
        ...(subscription.metadata || {}),
        checkout_key: checkoutKey,
      },
      updated_at: new Date(),
    };

    // Try to upgrade the pending snapshot by checkout_key
    const { data: pending } = await supabase
      .from('Subscriptions')
      .select('id, created_at')
      .eq('business_id', businessId)
      .is('stripe_subscription_id', null)
      .filter('metadata->>checkout_key', 'eq', checkoutKey)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    console.log('pending: ', pending)

    let localSubId = null;

    if (pending?.id) {
      console.log('update in place')
      // Update in place (no new row)
      await supabase.from('Subscriptions').update(subPayload).eq('id', pending.id);
      localSubId = pending.id;
    } else {
      console.log('fallback: upsert by Stripe subscription id')
      // Fallback: upsert by Stripe subscription id
      const { data: existing } = await supabase
        .from('Subscriptions')
        .select('id')
        .eq('stripe_subscription_id', subscription.id)
        .maybeSingle();

      console.log('existing: ', existing)

      if (existing?.id) {
        console.log('update existing')
        await supabase.from('Subscriptions')
          .update(subPayload)
          .eq('stripe_subscription_id', subscription.id);
        localSubId = existing.id;
      } else {
        console.log('insert new')
        const ins = await supabase.from('Subscriptions')
          .insert({ ...subPayload, created_at: new Date() })
          .select('id')
          .single();
        localSubId = ins.data?.id ?? null;
      }
    }

    // --- 7) Persist first invoice receipt (may be $0) ---
    let paymentIntentClientSecret = null;
    const inv = typeof subscription.latest_invoice === 'object' ? subscription.latest_invoice : null;

    if (inv) {
      const pi = typeof inv.payment_intent === 'object' ? inv.payment_intent : null;
      if (pi?.client_secret) paymentIntentClientSecret = pi.client_secret;

      if (localSubId) {
        const charge = pi?.charges?.data?.[0] || null;
        const fingerprint = charge?.payment_method_details?.card?.fingerprint || null;
        const card_fingerprint_hash = fingerprint
          ? crypto.createHash('sha256').update(fingerprint).digest('hex')
          : null;

        await supabase.from('SubscriptionReceipts').insert({
          business_id: businessId,
          subscription_id: localSubId,
          stripe_invoice_id: inv.id,
          stripe_payment_intent_id: pi?.id || (typeof inv.payment_intent === 'string' ? inv.payment_intent : null),
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
          currency: inv.currency || 'usd',
          period_start: inv.lines?.data?.[0]?.period?.start ? new Date(inv.lines.data[0].period.start * 1000) : null,
          period_end:   inv.lines?.data?.[0]?.period?.end   ? new Date(inv.lines.data[0].period.end   * 1000) : null,
          hosted_invoice_url: inv.hosted_invoice_url || null,
          invoice_pdf_url: inv.invoice_pdf || null,
          receipt_url: charge?.receipt_url || null,
          payment_method_id:
            (pi?.payment_method && typeof pi.payment_method === 'string')
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

    // Optional cleanup
    await supabase.from('CustomOffers').delete().eq('business_id', businessId);

    // --- 8) Respond (client will poll /billing/subscriptions/:id until 'active') ---
    return res.json({
      subscriptionId: subscription.id,
      status: subscription.status,
      paymentIntentClientSecret: paymentIntentClientSecret || null,
      discount: {
        freeYear: eligibleForPromo,
        windowEligible: eligibleForDiscountWindow,
        appliedCode: eligibleForPromo ? null : (eligibleForDiscountWindow ? (discountCodeRaw || null) : null),
        kind: eligibleForPromo ? 'free_year_promo' : (eligibleForDiscountWindow ? (resolvedKind || null) : null),
        id: eligibleForPromo ? (PROMO_COUPON_ID || null) : (eligibleForDiscountWindow ? (resolvedId || null) : null),
        cutoffIsoUtc: DISCOUNT_CODE_LA_CUTOFF_ISO,
      },
      promo: {
        applied: eligibleForPromo,
        endsAt: eligibleForPromo ? promoEndsAt : null,
        unlimitedDrivers: !!eligibleForPromo,
        unlimitedStops: !!eligibleForPromo,
      },
      checkoutKey, // useful for debugging
    });
  } catch (e) {
    console.error('subscribe error', e);
    return res.status(500).json({ error: 'subscribe failed', detail: String(e?.message || e) });
  }
});


    // Optional: clean up any outstanding custom offers for this business
//     await supabase.from('CustomOffers').delete().eq('business_id', businessId);

//     // --- 8) Respond ---
//     const promoEnds = eligibleForPromo ? promoEndsAt : null;

//     return res.json({
//       subscriptionId: subscription.id,
//       status: subscription.status,
//       paymentIntentClientSecret: paymentIntentClientSecret || null,
//       discount: {
//         freeYear: eligibleForPromo,
//         windowEligible: eligibleForDiscountWindow,
//         appliedCode: eligibleForPromo ? null : (eligibleForDiscountWindow ? (discountCodeRaw || null) : null),
//         kind: eligibleForPromo ? 'free_year_promo' : (eligibleForDiscountWindow ? (resolvedKind || null) : null),
//         id: eligibleForPromo ? (PROMO_COUPON_ID || null) : (eligibleForDiscountWindow ? (resolvedId || null) : null),
//         cutoffIsoUtc: DISCOUNT_CODE_LA_CUTOFF_ISO,
//       },
//       promo: {
//         applied: eligibleForPromo,
//         endsAt: promoEnds,
//         unlimitedDrivers: !!eligibleForPromo,
//         unlimitedStops: !!eligibleForPromo,
//       },
//     });
//   } catch (e) {
//     console.error('subscribe error', e);
//     return res.status(500).json({ error: 'subscribe failed', detail: String(e?.message || e) });
//   }
// });


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

router.get('/subscriptions/:id', async (req, res) => {
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
  const reqId = `sum-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const log = (...args) => console.log('[billing/summary]', reqId, ...args);

  try {
    const businessId = req.query.businessId;
    log('start', { businessId });

    if (!businessId) {
      log('missing businessId');
      return res.status(400).json({ ok: false, error: 'Missing businessId' });
    }

    // Load business → need stripe_customer_id
    let biz;
    try {
      biz = await loadBusinessRow(businessId);
      log('business loaded', { id: biz?.id, stripe_customer_id: biz?.stripe_customer_id });
    } catch (e) {
      log('loadBusinessRow error', e?.message || e);
      return res.status(404).json({ ok: false, error: 'Business not found' });
    }

    if (!biz?.stripe_customer_id) {
      log('no stripe_customer_id mapped for business');
      return res.json({
        ok: true,
        customerId: null,
        subscription: null,
        paymentMethods: [],
        invoiceOpen: null,
        usage: null,
        promo: null,
      });
    }

    const customerId = biz.stripe_customer_id;

    // Pull most-recent local subscription row
    log('querying Subscriptions (local cache)', { customerId });
    const { data: subRow, error: subRowError } = await supabase
      .from('Subscriptions')
      .select('*')
      .eq('stripe_customer_id', customerId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (subRowError) log('supabase Subscriptions maybeSingle error', subRowError.message || subRowError);
    log('subRow result', {
      found: !!subRow,
      stripe_subscription_id: subRow?.stripe_subscription_id || null,
      status: subRow?.status || null,
      is_promo: subRow?.is_promo || false,
      promo_ends_at: subRow?.promo_ends_at || null,
      unlimited_drivers: subRow?.unlimited_drivers || false,
      unlimited_stops: subRow?.unlimited_stops || false,
    });

    // Fallback to Stripe if nothing local
    let stripeSub = null;
    if (!subRow) {
      log('no local subRow; listing Stripe subscriptions…');
      const list = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 1,
        expand: ['data.latest_invoice.payment_intent'],
      });
      log('Stripe subscriptions.list result', { count: list?.data?.length || 0 });
      stripeSub = list.data?.[0] || null;
      if (stripeSub) {
        log('picked Stripe sub', { id: stripeSub.id, status: stripeSub.status });
      } else {
        log('no Stripe subscriptions found');
      }
    }

    // Promo/unlimited flags (from local row only)
    const now = new Date();
    const promoActive =
      !!subRow?.is_promo &&
      !!subRow?.promo_ends_at &&
      new Date(subRow.promo_ends_at) > now;

    const unlimitedDrivers = !!subRow?.unlimited_drivers && promoActive;
    const unlimitedStops   = !!subRow?.unlimited_stops   && promoActive;

    // Usage block — if promo+unlimited, return nulls so UI renders “Unlimited”
    let usage;
    if (promoActive && (unlimitedDrivers || unlimitedStops)) {
      usage = {
        driversTotal: null,
        driversUsed: null,
        driversLeft: null,
        stopsTotal: null,
        stopsUsed: null,
        stopsLeft: null,
        asOf: now.toISOString(),
      };
      log('usage computed (promo/unlimited)', usage);
    } else {
      const totalDrivers = subRow?.total_drivers ?? 0;
      const totalStops   = subRow?.total_stops   ?? 0;
      const driversLeft  = subRow?.drivers_left  ?? totalDrivers;
      const stopsLeft    = subRow?.stops_left    ?? totalStops;

      usage = {
        driversTotal: totalDrivers,
        driversUsed: Math.max(0, totalDrivers - (driversLeft ?? 0)),
        driversLeft: Math.max(0, driversLeft ?? 0),
        stopsTotal: totalStops,
        stopsUsed: Math.max(0, totalStops - (stopsLeft ?? 0)),
        stopsLeft: Math.max(0, stopsLeft ?? 0),
        asOf: now.toISOString(),
      };
      log('usage computed (standard)', usage);
    }

    // Payment methods & default
    log('retrieving Stripe customer for default PM…');
    const cust = await stripe.customers.retrieve(customerId);
    // @ts-ignore (Stripe types allow string|object)
    const defaultPM = cust?.invoice_settings?.default_payment_method || null;
    const defaultPMId = typeof defaultPM === 'string' ? defaultPM : defaultPM?.id || null;
    log('default payment method', { defaultPMId });

    log('listing Stripe payment methods…');
    const pms = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
    log('paymentMethods count', pms.data?.length || 0);

    const paymentMethods = (pms.data || []).map(pm => ({
      id: pm.id,
      brand: pm.card?.brand || 'card',
      last4: pm.card?.last4 || '',
      exp_month: pm.card?.exp_month || null,
      exp_year: pm.card?.exp_year || null,
      isDefault: defaultPMId === pm.id,
    }));
    log(
      'paymentMethods summarized',
      paymentMethods.map(pm => ({ id: pm.id, last4: pm.last4, isDefault: pm.isDefault }))
    );

    // Open (unpaid) invoice for "Pay now"
    log('listing open invoices…');
    const invs = await stripe.invoices.list({
      customer: customerId,
      status: 'open',
      limit: 1,
      expand: ['data.payment_intent'],
    });
    const inv = invs.data?.[0] || null;
    log('open invoices count', invs.data?.length || 0, inv ? { id: inv.id, amount_due: inv.amount_due } : {});
    const invoiceOpen = inv
      ? {
          id: inv.id,
          amount_due_cents: inv.amount_due || 0,
          created_at: inv.created ? new Date(inv.created * 1000).toISOString() : null,
          status: inv.status,
          hosted_invoice_url: inv.hosted_invoice_url || null,
          invoice_pdf_url: inv.invoice_pdf || null,
        }
      : null;

    // Compose subscription summary (prefer local)
    let subscription = null;
    if (subRow) {
      subscription = {
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
        total_drivers: unlimitedDrivers ? null : subRow.total_drivers,
        total_stops: unlimitedStops ? null : subRow.total_stops,
        is_promo: !!subRow.is_promo,
        promo_ends_at: subRow.promo_ends_at,
        unlimited_drivers: !!subRow.unlimited_drivers,
        unlimited_stops: !!subRow.unlimited_stops,
      };
      log('subscription from local cache', {
        id: subscription.stripe_subscription_id,
        status: subscription.status,
        amount: subscription.payment_amount_cents,
        promo: {
          is_promo: subscription.is_promo,
          ends: subscription.promo_ends_at,
          unlimited_drivers: subscription.unlimited_drivers,
          unlimited_stops: subscription.unlimited_stops,
          active: promoActive,
        },
      });
    } else if (stripeSub) {
      // Fallback (no local totals or promo flags)
      subscription = {
        stripe_subscription_id: stripeSub.id,
        status: stripeSub.status,
        tier: (stripeSub.metadata)?.tierId || null,
        billing_mode: (stripeSub.metadata)?.billingMode || null,
        current_period_start: stripeSub.current_period_start
          ? new Date(stripeSub.current_period_start * 1000)
          : null,
        current_period_end: stripeSub.current_period_end
          ? new Date(stripeSub.current_period_end * 1000)
          : null,
        cancel_at_period_end: !!stripeSub.cancel_at_period_end,
        payment_amount_cents: (stripeSub.items?.data || []).reduce(
          (s, it) => s + ((it.price?.unit_amount || 0) * (it.quantity || 1)),
          0
        ),
        last_payment_at: null,
        latest_invoice_id:
          typeof stripeSub.latest_invoice === 'string'
            ? stripeSub.latest_invoice
            : stripeSub.latest_invoice?.id || null,
        total_drivers: null, // unknown from Stripe alone
        total_stops: null,   // unknown from Stripe alone
        is_promo: false,
        promo_ends_at: null,
        unlimited_drivers: false,
        unlimited_stops: false,
      };
      log('subscription from Stripe fallback', {
        id: subscription.stripe_subscription_id,
        status: subscription.status,
        amount: subscription.payment_amount_cents,
      });
    } else {
      log('no subscription found (local or Stripe)');
    }

    // High-level promo object for convenience in UI
    const promo = subRow
      ? {
          applied: !!subRow.is_promo,
          active: promoActive,
          endsAt: subRow.promo_ends_at || null,
          unlimitedDrivers,
          unlimitedStops,
        }
      : null;

    log('responding');
    return res.json({
      ok: true,
      customerId,
      subscription,
      paymentMethods,
      invoiceOpen,
      usage,
      promo,
    });
    } catch (e) {
    console.error('[billing/summary]', 'fatal', e?.message || e, e?.stack || '');
    return res.status(500).json({ ok: false, error: 'summary_failed', detail: String(e?.message || e) });
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