// routes/billing.js
import express from "express";
import Stripe from "stripe";
import { supabase } from "../utils/supabase.js";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});
const MOBILE_API_VERSION = "2024-06-20";

// ======================= CANONICAL TIER PRICES =======================
// Use *Price IDs* (price_...) if you have them, else fallback to product.default_price
const TIER_PRICE_REF = {
  starter:    { priceId: "price_1Rxd4fFb5QGtuTxnswOezQOy", productId: "prod_StPytgt8pMFCRj" },
  growth:     { priceId: "price_1Rxd71Fb5QGtuTxncCI3eESn", productId: "prod_StPwzSJnzBQ6Zl" },
  pro:        { priceId: "price_1Rxd7aFb5QGtuTxngC037A0a", productId: "prod_StPxGBl2rarQKt" },
  premium:    { priceId: "price_1Rxd8HFb5QGtuTxn3soBEWl7", productId: "prod_StPyErvu7yRVYN" },
  enterprise: { priceId: "price_1Rxd8wFb5QGtuTxnm0iQqR11", productId: "prod_StPytgt8pMFCRj" },
  // custom: leave unmapped or handle ad-hoc only
};

// Default add-on unit rates (cents) if client doesn’t send unitCents
const DEFAULT_ADDONS_BY_TIER = {
  starter:    { driver: 2500, stops100: 1200 },
  growth:     { driver: 2000, stops100: 1000 },
  pro:        { driver: 1800, stops100:  900 },
  premium:    { driver: 2000, stops100:  900 },
  enterprise: { driver: 2000, stops100:  700 },
  custom:     { driver: 2000, stops100:  700 },
};

const ts = (unix) => (unix ? new Date(unix * 1000) : null);
const stringify = (e) => {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  if (e?.message) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
};

// =============================== HELPERS ===============================
async function loadBusinessRow(businessId) {
  const { data, error } = await supabase
    .from("Business")
    .select("id, stripe_customer_id")
    .eq("id", businessId)
    .single();
  if (error || !data) throw new Error("Business not found");
  return data;
}

async function resolveTierPriceIdRef(tierId) {
  const ref = TIER_PRICE_REF[tierId];
  if (!ref) throw new Error(`Unknown tier '${tierId}'`);
  if (ref.priceId) return ref.priceId;

  if (ref.productId) {
    const p = await stripe.products.retrieve(ref.productId, { expand: ["default_price"] });
    const id = typeof p.default_price === "string" ? p.default_price : p.default_price?.id;
    if (!id) throw new Error(`Product ${ref.productId} has no default price`);
    return id;
  }
  throw new Error(`No price/product mapping for tier '${tierId}'`);
}

async function getOrCreateCustomer({ businessId, email, userId }) {
  // prefer existing mapping on Business
  const biz = await loadBusinessRow(businessId);
  if (biz.stripe_customer_id) {
    const c = await stripe.customers.retrieve(biz.stripe_customer_id);
    if (!c?.deleted) return c;
  }
  // search by email
  const found = await stripe.customers.list({ email, limit: 1 });
  if (found.data[0]) {
    const customer = found.data[0];
    await supabase.from("Business").update({
      stripe_customer_id: customer.id, updated_at: new Date(),
    }).eq("id", businessId);
    return customer;
  }
  // create
  const created = await stripe.customers.create({ email, metadata: { userId, businessId } });
  await supabase.from("Business").update({
    stripe_customer_id: created.id, updated_at: new Date(),
  }).eq("id", businessId);
  return created;
}

/** Ensure a default payment method is set. Returns boolean. */
async function ensureDefaultPM(customerId) {
  const c = await stripe.customers.retrieve(customerId);
  // @ts-ignore
  if (c?.invoice_settings?.default_payment_method) return true;

  const pms = await stripe.paymentMethods.list({ customer: customerId, type: "card" });
  if (pms.data[0]) {
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: pms.data[0].id },
    });
    return true;
  }
  return false;
}

/** Create/reuse a monthly Price for an add-on unit amount, scoped by (kind, businessId, tierId, unit_amount_cents). */
async function getOrCreateAddonPrice({ kind, unit_amount_cents, businessId, tierId }) {
  try {
    const { data } = await supabase
      .from("StripePriceCache")
      .select("stripe_price_id")
      .eq("type", kind)
      .eq("business_id", businessId)
      .eq("tier_id", tierId)
      .eq("unit_amount_cents", unit_amount_cents)
      .single();
    if (data?.stripe_price_id) return data.stripe_price_id;
  } catch {}

  const price = await stripe.prices.create({
    unit_amount: unit_amount_cents,
    currency: "usd",
    recurring: { interval: "month" },
    product_data: {
      name: kind === "driver" ? "Movaro Driver Add-on" : "Movaro Stops Add-on (per 100)",
      metadata: { kind, tierId, businessId },
    },
    metadata: { kind, tierId, businessId, unit_amount_cents: String(unit_amount_cents) },
  });

  try {
    await supabase.from("StripePriceCache").insert({
      type: kind,
      business_id: businessId,
      tier_id: tierId,
      unit_amount_cents,
      stripe_price_id: price.id,
      created_at: new Date(),
    });
  } catch {}

  return price.id;
}

/** Snapshot the subscription into Subscriptions (upsert by stripe_subscription_id). */
async function upsertSubscriptionState({
  businessId,
  userId,
  stripeCustomerId,
  subscription,
  tier,
  billingMode,
  totals,
}) {
  const totalDrivers = Number(totals?.drivers || 0);
  const totalStops   = Number(totals?.stopsHundreds || 0) * 100;

  // Sum unit_amount * quantity (cents)
  const periodAmountCents = (subscription.items?.data || []).reduce(
    (sum, it) => sum + (it.price?.unit_amount || 0) * (it.quantity || 1),
    0
  );

  const payload = {
    business_id: businessId,
    user_id: userId ?? null,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: subscription.id,
    tier,
    billing_mode: billingMode,
    payment_amount_cents: periodAmountCents,
    currency: subscription.currency || "usd",
    total_drivers: totalDrivers,
    drivers_left: totalDrivers,
    total_stops: totalStops,
    stops_left: totalStops,
    status: subscription.status,
    last_payment_at: null,
    current_period_start: ts(subscription.current_period_start),
    current_period_end: ts(subscription.current_period_end),
    cancel_at_period_end: !!subscription.cancel_at_period_end,
    canceled_at: ts(subscription.canceled_at),
    default_payment_method_id: subscription.default_payment_method || null,
    latest_invoice_id:
      typeof subscription.latest_invoice === "string"
        ? subscription.latest_invoice
        : subscription.latest_invoice?.id || null,
    metadata: subscription.metadata || {},
    updated_at: new Date(),
  };

  const { data: existing, error: findErr } = await supabase
    .from("Subscriptions")
    .select("id")
    .eq("stripe_subscription_id", subscription.id)
    .single();

  // Not-found (PGRST116) is fine
  if (findErr && findErr.code !== "PGRST116") throw findErr;

  if (existing?.id) {
    const { error } = await supabase
      .from("Subscriptions")
      .update(payload)
      .eq("stripe_subscription_id", subscription.id);
    if (error) throw error;
    return existing.id;
  } else {
    const { data, error } = await supabase
      .from("Subscriptions")
      .insert({ ...payload, created_at: new Date() })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }
}

/** (Optional) persist each Stripe subscription item for quick reporting. */
async function recordSubscriptionItems({ businessId, subscriptionIdLocal, subscription, tierId }) {
  const items = subscription.items?.data || [];
  if (!items.length) return;
  const rows = items.map(it => ({
    subscription_id: subscriptionIdLocal,
    business_id: businessId,
    type: it.price?.metadata?.kind || "base",
    stripe_price_id: it.price?.id || null,
    stripe_item_id: it.id || null,
    quantity: it.quantity || 1,
    unit_amount_cents: it.price?.unit_amount ?? null,
    tier_id: tierId,
    created_at: new Date(),
  }));
  try { await supabase.from("SubscriptionItems").insert(rows); } catch {}
}

/** Insert a receipt row for a Stripe.Invoice into SubscriptionReceipts. */
async function insertReceiptRow({
  businessId,
  subscriptionId,
  stripeSubscriptionId,
  invoice, // Stripe.Invoice with (lines, payment_intent, charges) expanded
}) {
  if (!invoice) return;

  const piObj = typeof invoice.payment_intent === "object" ? invoice.payment_intent : null;

  const paymentIntentId =
    typeof invoice.payment_intent === "string"
      ? invoice.payment_intent
      : piObj?.id || null;

  const charge = piObj?.charges?.data?.[0] || null;

  const { error } = await supabase.from("SubscriptionReceipts").insert({
    business_id: businessId,
    subscription_id: subscriptionId,

    stripe_invoice_id: invoice.id,
    stripe_payment_intent_id: paymentIntentId,
    stripe_charge_id: charge?.id || null,

    billing_reason: invoice.billing_reason || null,
    invoice_status: invoice.status || null,
    payment_intent_status: piObj?.status || null,

    amount_due_cents: invoice.amount_due || 0,
    amount_paid_cents: invoice.amount_paid || 0,
    amount_remaining_cents: invoice.amount_remaining || 0,
    subtotal_cents: invoice.subtotal || 0,
    tax_cents: invoice.tax || 0,
    discount_total_cents: (invoice.total_discount_amounts || []).reduce(
      (s, x) => s + (x.amount || 0), 0),
    currency: invoice.currency || "usd",

    period_start: ts(invoice.period_start || invoice.lines?.data?.[0]?.period?.start),
    period_end: ts(invoice.period_end || invoice.lines?.data?.[0]?.period?.end),

    hosted_invoice_url: invoice.hosted_invoice_url || null,
    invoice_pdf_url: invoice.invoice_pdf || null,
    receipt_url: charge?.receipt_url || null,

    payment_method_id: typeof piObj?.payment_method === "string"
      ? piObj.payment_method
      : piObj?.payment_method?.id || null,
    pm_brand: charge?.payment_method_details?.card?.brand || null,
    pm_last4: charge?.payment_method_details?.card?.last4 || null,
    pm_exp_month: charge?.payment_method_details?.card?.exp_month || null,
    pm_exp_year: charge?.payment_method_details?.card?.exp_year || null,

    customer_email: invoice.customer_email || null,
    customer_name: invoice.customer_name || null,

    line_items: invoice.lines || null,
    raw: invoice,
    created_at: new Date(),
  });
  if (error) throw error;
}

async function getBusinessByStripeCustomerId(stripeCustomerId) {
  try {
    const { data, error } = await supabase
      .from("Business")
      .select("id")
      .eq("stripe_customer_id", stripeCustomerId)
      .single();
    if (error) return null;
    return data;
  } catch {
    return null;
  }
}

// ================================ ROUTES ================================

/**
 * POST /billing/payment-sheet
 * Body: { userId, email, businessId, tier?, paymentAmount?, totalDrivers?, totalStops?, driversLeft?, stopsLeft? }
 * Returns ephemeral key + setup intent for PaymentSheet.
 * Only creates one "pending_payment_method" Subscriptions row the first time a Stripe customer is attached.
 */
router.post("/payment-sheet", async (req, res) => {
  try {
    const { userId, email, businessId, tier, paymentAmount, totalDrivers, totalStops, driversLeft, stopsLeft } = req.body || {};
    if (!userId || !email || !businessId) {
      return res.status(400).json({ error: "Missing userId/email/businessId" });
    }

    const biz = await loadBusinessRow(businessId);
    const hadCustomer = !!biz.stripe_customer_id;
    const customer = await getOrCreateCustomer({ businessId, email, userId });

    // Only create the "pending" row once (first customer attach). Upsert prevents dupes if raced.
    if (!hadCustomer && tier && paymentAmount != null) {
      try {
        await supabase.from("Subscriptions").upsert({
          business_id: businessId,
          user_id: userId,
          stripe_customer_id: customer.id,
          stripe_subscription_id: null,
          tier,
          billing_mode: "monthly",
          payment_amount_cents: Math.round(Number(paymentAmount) * 100) || 0,
          currency: "usd",
          total_drivers: Number(totalDrivers || 0),
          drivers_left: Number(driversLeft || totalDrivers || 0),
          total_stops: Number(totalStops || 0),
          stops_left: Number(stopsLeft || totalStops || 0),
          status: "pending_payment_method",
          last_payment_at: null,
          current_period_start: new Date(),
          current_period_end: null,
          cancel_at_period_end: false,
          canceled_at: null,
          default_payment_method_id: null,
          latest_invoice_id: null,
          metadata: customer.metadata || {},
          created_at: new Date(),
          updated_at: new Date(),
        }, { onConflict: "business_id,status" }); // requires a partial unique index: see SQL below
      } catch (e) {
        console.warn("Subscriptions pre-upsert warning:", stringify(e));
      }
    }

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: MOBILE_API_VERSION }
    );
    const setupIntent = await stripe.setupIntents.create({ customer: customer.id });

    return res.json({
      customerId: customer.id,
      ephemeralKey: ephemeralKey.secret,
      setupIntentClientSecret: setupIntent.client_secret,
      merchantCountryCode: "US",
    });
  } catch (err) {
    console.error("payment-sheet error:", err);
    return res.status(400).json({ error: stringify(err) });
  }
});

/**
 * POST /billing/subscribe
 * Body:
 * {
 *   userId, businessId,
 *   plan: {
 *     tierId, billingMode: "monthly",
 *     baseAmountCents?,                 // optional, else canonical tier price
 *     addons?: [ {kind:"driver"|"stops100", quantity:int, unitCents:int}, ... ],
 *     notes?: string
 *   }
 * }
 * Creates a subscription with distinct line items, snapshots DB, stores initial receipt.
 */
router.post("/subscribe", async (req, res) => {
  try {
    const { userId, businessId, plan } = req.body || {};
    if (!userId || !businessId || !plan?.tierId || !plan?.billingMode) {
      return res.status(400).json({ error: "Missing userId/businessId/plan fields" });
    }
    if (plan.billingMode !== "monthly") {
      return res.status(400).json({ error: "Only monthly billing is supported right now" });
    }

    const biz = await loadBusinessRow(businessId);

    const hasPM = await ensureDefaultPM(biz.stripe_customer_id);
    if (!hasPM) {
      return res.status(200).json({
        requiresPaymentMethod: true,
        message: "No default payment method found. Collect a card with PaymentSheet, then retry.",
      });
    }

    // ---------- Build subscription items ----------
    const items = [];
    let pricingMode = "mapped";
    const addonsArr = Array.isArray(plan.addons) ? plan.addons : [];

    // BASE
    if (Number.isFinite(plan.baseAmountCents)) {
      const basePrice = await stripe.prices.create({
        unit_amount: Math.round(plan.baseAmountCents),
        currency: "usd",
        recurring: { interval: "month" },
        product_data: {
          name: `Movaro ${plan.tierId} (base)`,
          metadata: { kind: "base", tierId: plan.tierId, businessId },
        },
        metadata: { kind: "base", tierId: plan.tierId, businessId, source: "custom_base" },
      });
      items.push({ price: basePrice.id, quantity: 1 });
      pricingMode = "base_ad_hoc";
    } else {
      const tierPriceIdRef = await resolveTierPriceIdRef(plan.tierId);
      items.push({ price: tierPriceIdRef, quantity: 1 });
      pricingMode = "mapped";
    }

    // ADD-ONS
    const normalizedAddons = [];
    for (const raw of addonsArr) {
      const kind = String(raw?.kind || "").toLowerCase(); // 'driver' | 'stops100'
      if (!["driver", "stops100"].includes(kind)) continue;
      const quantity = Math.max(0, Math.floor(Number(raw?.quantity || 0)));
      if (!quantity) continue;

      let unitCents = Number.isFinite(raw?.unitCents) ? Math.round(Number(raw.unitCents)) : null;
      if (!Number.isFinite(unitCents)) {
        unitCents = DEFAULT_ADDONS_BY_TIER[plan.tierId]?.[kind] ?? 2000;
      }

      const priceId = await getOrCreateAddonPrice({
        kind,
        unit_amount_cents: unitCents,
        businessId,
        tierId: plan.tierId,
      });

      items.push({ price: priceId, quantity });
      normalizedAddons.push({ kind, quantity, unitCents, priceId });
    }
    if (items.length > 1) pricingMode += "_plus_addons";

    // Idempotency is tied to normalized pricing
    const idempotencyKey = [
      "sub", businessId, plan.tierId, plan.billingMode, pricingMode,
      Number(plan.baseAmountCents) || 0,
      ...normalizedAddons.flatMap(a => [a.kind, a.unitCents, a.quantity]),
    ].join(":");

    // ---------- Create subscription ----------
    const subscription = await stripe.subscriptions.create(
      {
        customer: biz.stripe_customer_id,
        items,
        payment_settings: { save_default_payment_method: "on_subscription" },
        payment_behavior: "default_incomplete",
        proration_behavior: "create_prorations",
        metadata: {
          businessId, userId,
          tierId: plan.tierId,
          billingMode: plan.billingMode,
          pricingMode,
          baseAmountCents: Number.isFinite(plan.baseAmountCents) ? String(plan.baseAmountCents) : "",
          addons_json: JSON.stringify(normalizedAddons),
          notes: plan.notes || "",
        },
        expand: [
          "latest_invoice.payment_intent",
          "latest_invoice.payment_intent.charges",
          "latest_invoice.lines",
          "items.data.price",
        ],
      },
      { idempotencyKey }
    );

    // ---------- Persist state snapshot ----------
    const totals = {
      drivers: normalizedAddons.find(a => a.kind === "driver")?.quantity || 0,
      stopsHundreds: normalizedAddons.find(a => a.kind === "stops100")?.quantity || 0,
    };
    const subscriptionIdLocal = await upsertSubscriptionState({
      businessId,
      userId,
      stripeCustomerId: biz.stripe_customer_id,
      subscription,
      tier: plan.tierId,
      billingMode: plan.billingMode,
      totals,
    });

    // Optional: store each line item for quick analytics
    await recordSubscriptionItems({
      businessId, subscriptionIdLocal, subscription, tierId: plan.tierId,
    });

    // ---------- Store initial invoice/receipt ----------
    let invoiceObj = null;
    if (subscription.latest_invoice) {
      invoiceObj = typeof subscription.latest_invoice === "string"
        ? await stripe.invoices.retrieve(subscription.latest_invoice, {
            expand: ["payment_intent", "payment_intent.charges", "lines"],
          })
        : subscription.latest_invoice;

      if (invoiceObj) {
        await insertReceiptRow({
          businessId,
          subscriptionId: subscriptionIdLocal,
          stripeSubscriptionId: subscription.id,
          invoice: invoiceObj,
        });
      }
    }

    const paymentIntentSecret = invoiceObj?.payment_intent?.client_secret || null;

    return res.json({
      subscriptionId: subscription.id,
      status: subscription.status,
      latestInvoiceId: invoiceObj?.id || null,
      currentPeriodStart: ts(subscription.current_period_start),
      currentPeriodEnd: ts(subscription.current_period_end),
      paymentIntentClientSecret: paymentIntentSecret,
    });
  } catch (err) {
    console.error("subscribe error:", err);
    return res.status(500).json({ error: "subscribe failed", detail: stringify(err) });
  }
});

/**
 * POST /billing/portal
 * Body: { businessId, returnUrl }
 */
router.post("/portal", async (req, res) => {
  try {
    const { businessId, returnUrl } = req.body || {};
    if (!businessId || !returnUrl) {
      return res.status(400).json({ error: "Missing businessId/returnUrl" });
    }

    const biz = await loadBusinessRow(businessId);
    const session = await stripe.billingPortal.sessions.create({
      customer: biz.stripe_customer_id,
      return_url: returnUrl,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("portal error", err);
    return res.status(500).json({ error: "portal failed", detail: stringify(err) });
  }
});

// ============================ WEBHOOK HANDLER ============================
/**
 * Wire this in index.js with express.raw:
 *   import bodyParser from 'body-parser';
 *   import billingRouter, { billingWebhook } from './routes/billing.js';
 *   app.use('/billing', billingRouter);
 *   app.post('/billing/webhook', bodyParser.raw({ type: 'application/json' }), billingWebhook);
 */
export async function billingWebhook(req, res) {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    const rawBody = req.body ?? req.rawBody; // express.raw supplies Buffer
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", stringify(err));
    return res.status(400).send(`Webhook Error: ${stringify(err)}`);
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;

        // Map to local business
        const business = await getBusinessByStripeCustomerId(sub.customer);

        // Preserve userId if we already have the local row
        const { data: localSub } = await supabase
          .from("Subscriptions")
          .select("id, user_id, business_id")
          .eq("stripe_subscription_id", sub.id)
          .single();

        const userId = localSub?.user_id ?? null;
        const businessId = localSub?.business_id ?? business?.id ?? null;

        if (!businessId) {
          console.warn("No businessId found for subscription", sub.id);
          break;
        }

        await upsertSubscriptionState({
          businessId,
          userId,
          stripeCustomerId: sub.customer,
          subscription: sub,
          tier: sub.items?.data?.[0]?.price?.nickname || null,
          billingMode: "monthly",
          totals: { drivers: 0, stopsHundreds: 0 },
        });

        // Optional: refresh SubscriptionItems on update
        try {
          const subscriptionIdLocal = localSub?.id;
          if (subscriptionIdLocal) {
            // naive refresh: delete+reinsert
            await supabase.from("SubscriptionItems").delete().eq("subscription_id", subscriptionIdLocal);
            await recordSubscriptionItems({
              businessId, subscriptionIdLocal, subscription: sub, tierId: sub.metadata?.tierId || null,
            });
          }
        } catch {}

        break;
      }

      case "invoice.payment_succeeded": {
        const inv = event.data.object;

        // Find local subscription
        const { data: localSub } = await supabase
          .from("Subscriptions")
          .select("id, business_id")
          .eq("stripe_subscription_id", inv.subscription)
          .single();

        let businessId = localSub?.business_id || null;
        if (!businessId) {
          const biz = await getBusinessByStripeCustomerId(inv.customer);
          businessId = biz?.id || null;
        }

        if (!businessId || !localSub?.id) {
          console.warn("invoice.payment_succeeded: cannot map local subscription/business", inv.id);
          break;
        }

        await insertReceiptRow({
          businessId,
          subscriptionId: localSub.id,
          stripeSubscriptionId: inv.subscription,
          invoice: inv,
        });

        await supabase
          .from("Subscriptions")
          .update({ last_payment_at: new Date(), updated_at: new Date() })
          .eq("id", localSub.id);
        break;
      }

      case "invoice.payment_failed": {
        // optional: mark past_due / notify owner
        break;
      }

      default:
        break;
    }

    return res.json({ received: true });
  } catch (e) {
    console.error("Webhook processing error:", stringify(e));
    return res.status(500).json({ error: "webhook failure" });
  }
}

export default router;
