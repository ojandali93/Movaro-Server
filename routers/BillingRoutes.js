// routes/billing.js
import express from "express";
import Stripe from "stripe";
import { supabase } from "../utils/supabase.js"; // should be instantiated with service_role key

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

/** ===================== PRICE MAPS (use real price IDs) ===================== */
// IMPORTANT: These MUST be Stripe Price IDs (price_...), not product IDs.
const BASE_PRICE = {
  starter:    { monthly: "price_starter_month" },
  growth:     { monthly: "price_growth_month"  },
  pro:        { monthly: "price_pro_month"     },
  premium:    { monthly: "price_premium_month" },
  enterprise: { monthly: "price_enterprise_month" },
};
// If you sell add-ons as recurring line items, add their price IDs here:
const ADDON_DRIVER_MONTH   = "price_addon_driver_month";    // per driver / month
const ADDON_STOPS100_MONTH = "price_addon_stops100_month";  // per +100 stops / month

const ts = (unix) => (unix ? new Date(unix * 1000) : null);

/** =========================== HELPERS ============================ */
async function ensureDefaultPM(customerId) {
  const customer = await stripe.customers.retrieve(customerId);
  // @ts-ignore
  if (customer?.invoice_settings?.default_payment_method) return;

  const pms = await stripe.paymentMethods.list({ customer: customerId, type: "card" });
  if (pms.data[0]) {
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: pms.data[0].id },
    });
  }
}

/** Optionally: tie stripe customer to the business record */
async function saveCustomerToBusiness(businessId, stripeCustomerId) {
  // If you have stripe_customer_id in Businesses, save it for future lookups
  const { error } = await supabase
    .from("Businesses")
    .update({ stripe_customer_id: stripeCustomerId, updated_at: new Date() })
    .eq("id", businessId);
  if (error) throw error;
}

/** Snapshot the subscription state into Subscriptions table (upsert by stripe_subscription_id) */
async function upsertSubscriptionState({
  businessId,
  userId,
  stripeCustomerId,
  subscription,       // Stripe.Subscription
  tier,
  billingMode,        // 'monthly'|'annual'
  totals,             // { drivers, stopsHundreds }
}) {
  const totalDrivers = Number(totals?.drivers || 0);
  const totalStops   = Number(totals?.stopsHundreds || 0) * 100;

  // Sum unit_amount * quantity (cents)
  const periodAmountCents = (subscription.items?.data || []).reduce(
    (sum, it) => sum + (it.price?.unit_amount || 0) * (it.quantity || 1),
    0
  );

  // Try to upsert by stripe_subscription_id
  const payload = {
    business_id: businessId,
    user_id: userId,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: subscription.id,
    tier,
    billing_mode: billingMode,
    payment_amount_cents: periodAmountCents,
    currency: subscription.currency || "usd",
    total_drivers: totalDrivers,
    drivers_left: totalDrivers, // initialize; decrement in your app as you allocate
    total_stops: totalStops,
    stops_left: totalStops,     // initialize; decrement as used
    status: subscription.status,
    last_payment_at: null, // set on invoice.paid webhook
    current_period_start: ts(subscription.current_period_start),
    current_period_end: ts(subscription.current_period_end),
    cancel_at_period_end: !!subscription.cancel_at_period_end,
    canceled_at: ts(subscription.canceled_at),
    default_payment_method_id: subscription.default_payment_method || null,
    latest_invoice_id: typeof subscription.latest_invoice === "string"
      ? subscription.latest_invoice
      : subscription.latest_invoice?.id || null,
    metadata: subscription.metadata || {},
    updated_at: new Date(),
  };

  // If row exists, update; else insert
  const { data: existing, error: findErr } = await supabase
    .from("Subscriptions")
    .select("id")
    .eq("stripe_subscription_id", subscription.id)
    .single();

  if (findErr && findErr.code !== "PGRST116") { // not found is OK (PGRST116)
    throw findErr;
  }

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

/** Insert a receipt for the initial invoice if present */
async function insertInitialReceiptIfAny({
  businessId,
  subscriptionId,              // your Subscriptions.id (UUID)
  stripeSubscriptionId,
  invoice,                     // Stripe.Invoice
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
    discount_total_cents: (invoice.total_discount_amounts || []).reduce((s, x) => s + (x.amount || 0), 0),
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

/** =========================== ENDPOINTS ============================ */

/**
 * POST /billing/payment-sheet
 * Body: { userId, email, businessId, tier, paymentAmount, totalDrivers, totalStops, driversLeft, stopsLeft }
 * Returns: PaymentSheet config. Also ensures you have a Stripe customer and (optionally) stores a pending Subscriptions row.
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
 * Body: { userId, businessId, plan: { tierId, billingMode, extraDrivers, extraStopsHundreds } }
 * Creates Stripe subscription, then upserts Subscriptions and inserts a first receipt (if invoice exists).
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

    await ensureDefaultPM(bizRow.stripe_customer_id);

    // Build subscription items (supports custom quantities)
    const basePriceId = BASE_PRICE[plan.tierId]?.[plan.billingMode];
    if (!basePriceId) {
      return res
        .status(400)
        .json({ error: "Unknown tierId/billingMode mapping to price" });
    }

    const extraDrivers = Number(plan.extraDrivers || 0);
    const extraStopsHundreds = Number(plan.extraStopsHundreds || 0);

    const items = [{ price: basePriceId, quantity: 1 }];
    if (extraDrivers > 0)
      items.push({ price: ADDON_DRIVER_MONTH, quantity: extraDrivers });
    if (extraStopsHundreds > 0)
      items.push({ price: ADDON_STOPS100_MONTH, quantity: extraStopsHundreds });

    // Create subscription (expand latest invoice fully)
    const subscription = await stripe.subscriptions.create({
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
    });

    const { error } = await supabase
      .from("Subscriptions")
      .update({
        stripe_subscription_id: subscription.id,   // 👈 here
        status: subscription.status,               // e.g., 'active' or 'trialing'
        current_period_start: new Date(subscription.current_period_start * 1000),
        current_period_end: new Date(subscription.current_period_end * 1000),
        latest_invoice_id: subscription.latest_invoice?.id || null,
        last_payment_at: subscription.latest_invoice?.status === "paid"
          ? new Date()
          : null,
        updated_at: new Date(),
      })
      .eq("business_id", businessId)
      .eq("user_id", userId);

    if (error) throw error;

    // Upsert subscription in Supabase
    const subscriptionId = await upsertSubscriptionState({
      businessId: bizRow.id,
      userId,
      stripeCustomerId: bizRow.stripe_customer_id,
      subscription,
      tier: plan.tierId,
      billingMode: plan.billingMode,
      totals: { drivers: extraDrivers, stopsHundreds: extraStopsHundreds },
    });


    // Resolve latest invoice object (if it came back as an ID)
    let invoiceObj = null;
    if (subscription.latest_invoice) {
      if (typeof subscription.latest_invoice === "string") {
        invoiceObj = await stripe.invoices.retrieve(subscription.latest_invoice, {
          expand: ["payment_intent", "payment_intent.charges", "lines"],
        });
      } else {
        invoiceObj = subscription.latest_invoice;
      }
    }

    // Insert the first receipt (if we have an invoice)
    if (invoiceObj) {
      await insertInitialReceiptIfAny({
        businessId: bizRow.id,
        subscriptionId: subscriptionId,
        stripeSubscriptionId: subscription.id,
        invoice: invoiceObj,
      });
    }

    return res.json({
      subscriptionId: subscription.id,
      status: subscription.status,
      latestInvoiceId: invoiceObj?.id || null,
      currentPeriodStart: ts(subscription.current_period_start),
      currentPeriodEnd: ts(subscription.current_period_end),
    });
  } catch (err) {
    console.error("subscribe error", err);
    return res.status(500).json({
      error: "subscribe failed",
      detail: String(err?.message || err),
    });
  }
});

export default router;
