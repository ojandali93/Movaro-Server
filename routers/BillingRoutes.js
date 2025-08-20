// routes/billing.js
import express from "express";
import Stripe from "stripe";
import { supabase } from "../utils/supabase.js";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

/** ======================= PRICE MAPS (REPLACE THESE) ======================= **
 * IMPORTANT: Use Stripe Price IDs (price_...), NOT product IDs.
 */
const BASE_PRICE = {
  starter:    { monthly: "price_starter_month" },
  growth:     { monthly: "price_growth_month"  },
  pro:        { monthly: "price_pro_month"     },
  premium:    { monthly: "price_premium_month" },
  enterprise: { monthly: "price_enterprise_month" },
};
// Add-ons (optional recurring line items)
const ADDON_DRIVER_MONTH   = "price_addon_driver_month";   // per driver / month
const ADDON_STOPS100_MONTH = "price_addon_stops100_month"; // per +100 stops / month
/** ========================================================================= */

const ts = (unix) => (unix ? new Date(unix * 1000) : null);

/** =============================== HELPERS ================================ */

async function saveCustomerToBusiness(businessId, stripeCustomerId) {
  const { error } = await supabase
    .from("Businesses")
    .update({ stripe_customer_id: stripeCustomerId, updated_at: new Date() })
    .eq("id", businessId);
  if (error) throw error;
}

async function getBusinessByStripeCustomerId(stripeCustomerId) {
  const { data, error } = await supabase
    .from("Businesses")
    .select("id")
    .eq("stripe_customer_id", stripeCustomerId)
    .single();
  if (error) return null;
  return data;
}

async function getOrCreateCustomer({ businessId, email, userId }) {
  // Prefer DB mapping first
  const { data: bizRow } = await supabase
    .from("Businesses")
    .select("stripe_customer_id")
    .eq("id", businessId)
    .single();

  if (bizRow?.stripe_customer_id) {
    return await stripe.customers.retrieve(bizRow.stripe_customer_id);
  }

  // Fallback: try finding by email
  const found = await stripe.customers.list({ email, limit: 1 });
  if (found.data.length > 0) {
    const customer = found.data[0];
    await saveCustomerToBusiness(businessId, customer.id);
    return customer;
  }

  // Create new
  const created = await stripe.customers.create({
    email,
    metadata: { userId, businessId },
  });
  await saveCustomerToBusiness(businessId, created.id);
  return created;
}

/** Ensure a default payment method is set. Returns boolean. */
async function ensureDefaultPM(customerId) {
  const customer = await stripe.customers.retrieve(customerId);
  // @ts-ignore (Stripe type)
  if (customer?.invoice_settings?.default_payment_method) return true;

  const pms = await stripe.paymentMethods.list({ customer: customerId, type: "card" });
  if (pms.data[0]) {
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: pms.data[0].id },
    });
    return true;
  }
  return false;
}

function mapPlanToItems(plan) {
  const tierId = String(plan?.tierId || "").trim();
  const billingMode = String(plan?.billingMode || "").trim(); // 'monthly'|'annual' (you only mapped monthly above)
  const basePriceId = BASE_PRICE[tierId]?.[billingMode];
  if (!basePriceId) {
    throw new Error("Unknown tierId/billingMode mapping to price");
  }

  const extraDrivers = Number(plan?.extraDrivers || 0);
  const extraStopsHundreds = Number(plan?.extraStopsHundreds || 0);

  const items = [{ price: basePriceId, quantity: 1 }];
  if (extraDrivers > 0) items.push({ price: ADDON_DRIVER_MONTH, quantity: extraDrivers });
  if (extraStopsHundreds > 0) items.push({ price: ADDON_STOPS100_MONTH, quantity: extraStopsHundreds });

  return { items, extraDrivers, extraStopsHundreds };
}

/** Upsert subscription snapshot into Subscriptions table (by stripe_subscription_id) */
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
  const totalStops = Number(totals?.stopsHundreds || 0) * 100;

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

  // Not-found code is OK
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

/** Insert a receipt record for a Stripe.Invoice (first or subsequent) */
async function insertInitialReceiptIfAny({
  businessId,
  subscriptionId, // local Subscriptions.id (UUID)
  stripeSubscriptionId,
  invoice, // Stripe.Invoice
}) {
  if (!invoice) return;

  const piObj =
    typeof invoice.payment_intent === "object" ? invoice.payment_intent : null;

  const paymentIntentId =
    typeof invoice.payment_intent === "string"
      ? invoice.payment_intent
      : piObj?.id || null;

  const charge = piObj?.charges?.data?.[0] || null;

  const { error } = await supabase.from("SubscriptionReceipts").insert({
    business_id: businessId,
    subscription_id: subscriptionId,
    stripe_customer_id: invoice.customer,
    stripe_subscription_id: stripeSubscriptionId,

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
      (s, x) => s + (x.amount || 0),
      0
    ),
    currency: invoice.currency || "usd",

    period_start:
      ts(invoice.period_start || invoice.lines?.data?.[0]?.period?.start),
    period_end:
      ts(invoice.period_end || invoice.lines?.data?.[0]?.period?.end),

    hosted_invoice_url: invoice.hosted_invoice_url || null,
    invoice_pdf_url: invoice.invoice_pdf || null,
    receipt_url: charge?.receipt_url || null,

    payment_method_id:
      typeof piObj?.payment_method === "string"
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

/** =============================== ROUTES ================================ */

/**
 * POST /billing/payment-sheet
 * Body: { userId, email, businessId, tier?, paymentAmount?, totalDrivers?, totalStops?, driversLeft?, stopsLeft? }
 * Creates/ensures a Stripe customer, returns PaymentSheet params (ephemeral key + SetupIntent).
 * Optionally inserts a "pending_payment_method" row if tier/paymentAmount provided.
 */
router.post("/payment-sheet", async (req, res) => {
  try {
    const { userId, email, businessId, tier, paymentAmount, totalDrivers, totalStops, driversLeft, stopsLeft } = req.body;

    if (!userId || !email || !businessId) {
      return res.status(400).json({ error: "Missing userId/email/businessId" });
    }

    // 1) Ensure Stripe Customer
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        metadata: { userId, businessId },
      });
    }

    // 2) Persist customer on the business record (optional but recommended)
    await saveCustomerToBusiness(businessId, customer.id);

    // 3) (Optional) Pre-create a "pending" subscription snapshot for your UI
    //    If you prefer, you can skip this and only insert after Stripe subscription is created.
    if (tier && paymentAmount != null) {
      // Mark as pending_payment_method (not active yet)
      const { error } = await supabase.from("Subscriptions").insert({
        business_id: businessId,
        user_id: userId,
        stripe_customer_id: customer.id,
        stripe_subscription_id: null,
        tier,
        billing_mode: "monthly",
        payment_amount_cents: Math.round(Number(paymentAmount) * 100) || 0, // ensure cents if you passed USD
        currency: "usd",
        total_drivers: Number(totalDrivers || 0),
        drivers_left: Number(driversLeft || totalDrivers || 0),
        total_stops: Number(totalStops || 0),
        stops_left: Number(stopsLeft || totalStops || 0),
        status: "pending_payment_method",
        last_payment_at: null,
        current_period_start: new Date(),
        current_period_end: null, // will be set after subscription creation
        cancel_at_period_end: false,
        canceled_at: null,
        default_payment_method_id: null,
        latest_invoice_id: null,
        metadata: customer.metadata || {},
        created_at: new Date(),
        updated_at: new Date(),
      });
      if (error && error.code !== "23505") { // ignore unique conflicts if you call twice
        // log but don't block the sheet
        console.warn("Subscriptions pre-insert warning:", error);
      }
    }

    // 4) PaymentSheet: Ephemeral Key + SetupIntent
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: "2024-06-20" }
    );
    const setupIntent = await stripe.setupIntents.create({ customer: customer.id });

    res.json({
      customerId: customer.id,
      ephemeralKey: ephemeralKey.secret,
      setupIntentClientSecret: setupIntent.client_secret,
      merchantCountryCode: "US",
    });
  } catch (err) {
    console.error("payment-sheet error", err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /billing/subscribe
 * Body: { userId, businessId, plan: { tierId, billingMode, extraDrivers?, extraStopsHundreds? } }
 * Creates a Stripe subscription (idempotent), upserts your Subscriptions table,
 * and returns PI client secret for the initial invoice if action is required.
 */
router.post("/subscribe", async (req, res) => {
  try {
    const { userId, businessId, plan } = req.body || {};
    if (!userId || !businessId || !plan?.tierId || !plan?.billingMode) {
      return res
        .status(400)
        .json({ error: "Missing userId/businessId/plan fields" });
    }

    // Load business & stripe customer
    const { data: bizRow, error: bizErr } = await supabase
      .from("Businesses")
      .select("id, stripe_customer_id")
      .eq("id", businessId)
      .single();

    if (bizErr || !bizRow?.stripe_customer_id) {
      return res
        .status(400)
        .json({ error: "Business or Stripe customer not found" });
    }

    // Ensure there's a default PM; if not, tell client to collect card first
    const hasPM = await ensureDefaultPM(bizRow.stripe_customer_id);
    if (!hasPM) {
      return res.status(200).json({
        requiresPaymentMethod: true,
        message:
          "No default payment method found. Collect a card with PaymentSheet, then retry.",
      });
    }

    // Build items from plan
    const { items, extraDrivers, extraStopsHundreds } = mapPlanToItems(plan);

    // Create subscription (idempotent)
    const idempotencyKey = `sub:${bizRow.id}:${plan.tierId}:${plan.billingMode}`;
    const subscription = await stripe.subscriptions.create(
      {
        customer: bizRow.stripe_customer_id,
        items,
        payment_settings: { save_default_payment_method: "on_subscription" },
        payment_behavior: "default_incomplete",
        proration_behavior: "create_prorations",
        expand: [
          "latest_invoice.payment_intent",
          "latest_invoice.payment_intent.charges",
          "latest_invoice.lines",
        ],
      },
      { idempotencyKey }
    );

    // Upsert our subscription state
    const subscriptionIdLocal = await upsertSubscriptionState({
      businessId: bizRow.id,
      userId,
      stripeCustomerId: bizRow.stripe_customer_id,
      subscription,
      tier: plan.tierId,
      billingMode: plan.billingMode,
      totals: { drivers: extraDrivers, stopsHundreds: extraStopsHundreds },
    });

    // Resolve/expand invoice if needed
    let invoiceObj = null;
    if (subscription.latest_invoice) {
      if (typeof subscription.latest_invoice === "string") {
        invoiceObj = await stripe.invoices.retrieve(
          subscription.latest_invoice,
          {
            expand: ["payment_intent", "payment_intent.charges", "lines"],
          }
        );
      } else {
        invoiceObj = subscription.latest_invoice;
      }
    }

    // Insert initial receipt if invoice exists
    if (invoiceObj) {
      await insertInitialReceiptIfAny({
        businessId: bizRow.id,
        subscriptionId: subscriptionIdLocal,
        stripeSubscriptionId: subscription.id,
        invoice: invoiceObj,
      });
    }

    const paymentIntentSecret =
      invoiceObj?.payment_intent?.client_secret || null;

    return res.json({
      subscriptionId: subscription.id,
      status: subscription.status,
      latestInvoiceId: invoiceObj?.id || null,
      currentPeriodStart: ts(subscription.current_period_start),
      currentPeriodEnd: ts(subscription.current_period_end),
      paymentIntentClientSecret: paymentIntentSecret, // RN uses this if 3DS is required
    });
  } catch (err) {
    console.error("subscribe error", err);
    return res.status(500).json({
      error: "subscribe failed",
      detail: String(err?.message || err),
    });
  }
});

/**
 * POST /billing/portal
 * Body: { businessId, returnUrl }
 * Creates a Stripe Customer Billing Portal session.
 */
router.post("/portal", async (req, res) => {
  try {
    const { businessId, returnUrl } = req.body || {};
    if (!businessId || !returnUrl) {
      return res.status(400).json({ error: "Missing businessId/returnUrl" });
    }

    const { data: bizRow, error: bizErr } = await supabase
      .from("Businesses")
      .select("stripe_customer_id")
      .eq("id", businessId)
      .single();

    if (bizErr || !bizRow?.stripe_customer_id) {
      return res
        .status(400)
        .json({ error: "Business or Stripe customer not found" });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: bizRow.stripe_customer_id,
      return_url: returnUrl,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("portal error", err);
    return res.status(500).json({ error: "portal failed", detail: err.message });
  }
});

/** ============================ WEBHOOK HANDLER ============================ *
 * Wire this in index.js with express.raw:
 *
 *   import bodyParser from 'body-parser';
 *   import billingRouter, { billingWebhook } from './routes/billing.js';
 *   app.use('/billing', billingRouter);
 *   app.post('/billing/webhook', bodyParser.raw({ type: 'application/json' }), billingWebhook);
 */
export async function billingWebhook(req, res) {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    // If index.js used express.raw, req.body is a Buffer
    const rawBody = req.body ?? req.rawBody;
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;

        // Find local business & existing local subscription row
        const business =
          (await getBusinessByStripeCustomerId(sub.customer)) || null;

        // Try to keep userId if we already have a row
        const { data: localSub } = await supabase
          .from("Subscriptions")
          .select("id, user_id, business_id")
          .eq("stripe_subscription_id", sub.id)
          .single();

        const userId = localSub?.user_id ?? null;
        const businessId = localSub?.business_id ?? business?.id ?? null;

        if (!businessId) {
          // We can't map it—log and continue
          console.warn("No businessId found for subscription", sub.id);
          break;
        }

        await upsertSubscriptionState({
          businessId,
          userId,
          stripeCustomerId: sub.customer,
          subscription: sub,
          tier: sub.items?.data?.[0]?.price?.nickname || null, // optional
          billingMode: "monthly", // adjust if you support annual
          totals: { drivers: 0, stopsHundreds: 0 }, // unknown from webhook alone
        });

        break;
      }
      case "invoice.payment_succeeded": {
        const inv = event.data.object;

        // Find local row by stripe_subscription_id
        const { data: localSub } = await supabase
          .from("Subscriptions")
          .select("id, business_id")
          .eq("stripe_subscription_id", inv.subscription)
          .single();

        // Fallback: map business by customer if needed
        let businessId = localSub?.business_id || null;
        if (!businessId) {
          const biz = await getBusinessByStripeCustomerId(inv.customer);
          businessId = biz?.id || null;
        }

        if (!businessId || !localSub?.id) {
          console.warn(
            "invoice.payment_succeeded: could not map local subscription/business",
            inv.id
          );
          break;
        }

        // Insert/append receipt
        await insertInitialReceiptIfAny({
          businessId,
          subscriptionId: localSub.id,
          stripeSubscriptionId: inv.subscription,
          invoice: inv,
        });

        // Mark last_payment_at on Subscriptions
        await supabase
          .from("Subscriptions")
          .update({
            last_payment_at: new Date(),
            updated_at: new Date(),
          })
          .eq("id", localSub.id);

        break;
      }
      case "invoice.payment_failed": {
        // You can mark the subscription as past_due or notify the business owner
        break;
      }
      default:
        break;
    }

    return res.json({ received: true });
  } catch (e) {
    console.error("Webhook processing error:", e);
    return res.status(500).json({ error: "webhook failure" });
  }
}

export default router;
