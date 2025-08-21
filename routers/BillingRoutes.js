// routes/billingRoutes.ts
/* eslint-disable no-console */
import express, { Request, Response } from "express";
import Stripe from "stripe";
import { supabase } from "../utils/supabase.js";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});
const MOBILE_API_VERSION = "2024-06-20";

// ======================= CANONICAL TIER PRICES =======================
// Use Stripe *Price IDs* (price_...). If missing, we fallback to product.default_price.
const TIER_PRICE_REF: Record<
  string,
  { priceId?: string; productId?: string }
> = {
  starter: { priceId: "price_1Rxd4fFb5QGtuTxnswOezQOy", productId: "prod_StPytgt8pMFCRj" },
  growth: { priceId: "price_1Rxd71Fb5QGtuTxncCI3eESn", productId: "prod_StPwzSJnzBQ6Zl" },
  pro: { priceId: "price_1Rxd7aFb5QGtuTxngC037A0a", productId: "prod_StPxGBl2rarQKt" },
  premium: { priceId: "price_1Rxd8HFb5QGtuTxn3soBEWl7", productId: "prod_StPyErvu7yRVYN" },
  enterprise: { priceId: "price_1Rxd8wFb5QGtuTxnm0iQqR11", productId: "prod_StPytgt8pMFCRj" },
  // custom: leave unmapped or handle ad-hoc only
};

// Default add-on unit rates (cents) if client does not send unitCents
const DEFAULT_ADDONS_BY_TIER: Record<
  string,
  { driver: number; stops100: number }
> = {
  starter: { driver: 0, stops100: 1200 },
  growth: { driver: 0, stops100: 1000 },
  pro: { driver: 0, stops100: 900 },
  premium: { driver: 0, stops100: 900 },
  enterprise: { driver: 0, stops100: 700 },
  custom: { driver: 2000, stops100: 700 },
};

// =============================== TYPES ===============================
type AddonInput = {
  kind: "driver" | "stops100";
  quantity: number; // count (drivers or blocks of +100 stops)
  unitCents?: number; // cents(price per unit)
};

type SubscribeBody = {
  userId?: string | number | null;
  businessId: string | number;
  plan: {
    tierId: string;
    billingMode: "monthly"; // (extend if you later support annual)
    baseAmountCents?: number; // optional ad-hoc base price in cents
    addons?: AddonInput[];
    notes?: string;
  };
};

type CustomerCreateBody = {
  name: string;
  email: string;
  businessId?: string | number;
  phone?: string;
  address?: any; // Stripe.AddressParam shape optional
  metadata?: Record<string, string>;
  forceNew?: boolean;
};

// =============================== UTILS ===============================
const ts = (unix?: number | null) => (unix ? new Date(unix * 1000) : null);
const stringify = (e: unknown) => {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  // @ts-ignore
  if (e?.message) return (e as any).message;
  try { return JSON.stringify(e); } catch { return String(e); }
};

// Stripe Idempotency-Key must be ASCII & short. This makes a safe key.
function safeIdemKey(parts: Array<string | number | boolean | null | undefined>) {
  const joined = parts
    .map((p) => (p === undefined || p === null ? "" : String(p)))
    .join(":");
  // allow alnum _ . - : only
  const safe = joined.replace(/[^\w.\-:]/g, "_");
  return safe.slice(0, 200);
}

// =============================== HELPERS ===============================
async function loadBusinessRow(businessId: string | number) {
  const { data, error } = await supabase
    .from("Business")
    .select("id, stripe_customer_id")
    .eq("id", businessId)
    .single();
  if (error || !data) throw new Error("Business not found");
  return data as { id: number; stripe_customer_id: string | null };
}

async function resolveTierPriceIdRef(tierId: string): Promise<string> {
  const ref = TIER_PRICE_REF[tierId];
  if (!ref) throw new Error(`Unknown tier '${tierId}'`);
  if (ref.priceId) return ref.priceId;
  if (ref.productId) {
    const product = await stripe.products.retrieve(ref.productId, { expand: ["default_price"] });
    const dp = product.default_price;
    const priceId = typeof dp === "string" ? dp : dp?.id;
    if (!priceId) throw new Error(`Product ${ref.productId} has no default price`);
    return priceId;
  }
  throw new Error(`No price/product mapping for tier '${tierId}'`);
}

/** If userId not provided, try to infer it from most recent subscription for the business. */
async function resolveUserIdIfMissing(
  businessId: string | number,
  providedUserId?: string | number | null
): Promise<string | number | null> {
  if (providedUserId) return providedUserId;
  try {
    const { data } = await supabase
      .from("Subscriptions")
      .select("user_id")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (data && data[0]?.user_id) return data[0].user_id;
  } catch {}
  return null;
}

/** Ensure a default payment method is set. Returns boolean. */
async function ensureDefaultPM(customerId: string): Promise<boolean> {
  const c = (await stripe.customers.retrieve(customerId)) as Stripe.Customer;
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

/** Create/reuse a monthly Price for an add-on unit amount, cached in StripePriceCache. */
async function getOrCreateAddonPrice({
  kind,
  unit_amount_cents,
  businessId,
  tierId,
}: {
  kind: "driver" | "stops100";
  unit_amount_cents: number;
  businessId: string | number;
  tierId: string;
}): Promise<string> {
  try {
    const { data } = await supabase
      .from("StripePriceCache")
      .select("stripe_price_id")
      .eq("type", kind)
      .eq("business_id", businessId)
      .eq("tier_id", tierId)
      .eq("unit_amount_cents", unit_amount_cents)
      .single();
    if (data?.stripe_price_id) return data.stripe_price_id as string;
  } catch {}

  const price = await stripe.prices.create({
    unit_amount: unit_amount_cents,
    currency: "usd",
    recurring: { interval: "month" },
    product_data: {
      name: kind === "driver" ? "Movaro Driver Add-on" : "Movaro Stops Add-on (per 100)",
      metadata: { kind, tierId, businessId: String(businessId) },
    },
    metadata: { kind, tierId, businessId: String(businessId), unit_amount_cents: String(unit_amount_cents) },
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

/** Upsert subscription snapshot into Subscriptions (by stripe_subscription_id). */
async function upsertSubscriptionState({
  businessId,
  userId,
  stripeCustomerId,
  subscription,
  tier,
  billingMode,
  totals,
}: {
  businessId: string | number;
  userId: string | number | null;
  stripeCustomerId: string;
  subscription: Stripe.Subscription;
  tier: string | null;
  billingMode: string;
  totals: { drivers: number; stopsHundreds: number };
}): Promise<number> {
  const totalDrivers = Number(totals?.drivers || 0);
  const totalStops = Number(totals?.stopsHundreds || 0) * 100;

  const periodAmountCents = (subscription.items?.data || []).reduce(
    (sum, it) => sum + ((it.price?.unit_amount || 0) * (it.quantity || 1)),
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
    currency: (subscription as any).currency || "usd",
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
    default_payment_method_id: (subscription as any).default_payment_method || null,
    latest_invoice_id:
      typeof subscription.latest_invoice === "string"
        ? subscription.latest_invoice
        : (subscription.latest_invoice as any)?.id || null,
    metadata: (subscription as any).metadata || {},
    updated_at: new Date(),
  };

  const { data: existing, error: findErr } = await supabase
    .from("Subscriptions")
    .select("id")
    .eq("stripe_subscription_id", subscription.id)
    .single();

  if (findErr && (findErr as any).code !== "PGRST116") throw findErr;

  if (existing?.id) {
    const { error } = await supabase
      .from("Subscriptions")
      .update(payload)
      .eq("stripe_subscription_id", subscription.id);
    if (error) throw error;
    return existing.id as number;
  } else {
    const { data, error } = await supabase
      .from("Subscriptions")
      .insert({ ...payload, created_at: new Date() })
      .select("id")
      .single();
    if (error) throw error;
    return (data as any).id as number;
  }
}

/** (Optional) persist each Stripe subscription item for quick reporting. */
async function recordSubscriptionItems({
  businessId,
  subscriptionIdLocal,
  subscription,
  tierId,
}: {
  businessId: string | number;
  subscriptionIdLocal: number;
  subscription: Stripe.Subscription;
  tierId: string | null;
}) {
  const items = subscription.items?.data || [];
  if (!items.length) return;
  const rows = items.map((it) => ({
    subscription_id: subscriptionIdLocal,
    business_id: businessId,
    type: (it.price?.metadata as any)?.kind || "base",
    stripe_price_id: it.price?.id || null,
    stripe_item_id: it.id || null,
    quantity: it.quantity || 1,
    unit_amount_cents: it.price?.unit_amount ?? null,
    tier_id: tierId,
    created_at: new Date(),
  }));
  try {
    await supabase.from("SubscriptionItems").insert(rows);
  } catch {}
}

/** Insert a receipt row for a Stripe.Invoice into SubscriptionReceipts. */
async function insertReceiptRow({
  businessId,
  subscriptionId,
  invoice,
}: {
  businessId: string | number;
  subscriptionId: number;
  invoice: Stripe.Invoice; // expanded (lines, payment_intent, charges)
}) {
  if (!invoice) return;

  const piObj = typeof invoice.payment_intent === "object" ? (invoice.payment_intent as Stripe.PaymentIntent) : null;
  const paymentIntentId = typeof invoice.payment_intent === "string" ? invoice.payment_intent : piObj?.id || null;
  const charge = (piObj?.charges?.data || [])[0] || null;

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
    tax_cents: (invoice as any).tax || 0,
    discount_total_cents: (invoice.total_discount_amounts || []).reduce((s, x: any) => s + (x.amount || 0), 0),
    currency: invoice.currency || "usd",

    period_start: ts((invoice as any).period_start || invoice.lines?.data?.[0]?.period?.start),
    period_end: ts((invoice as any).period_end || invoice.lines?.data?.[0]?.period?.end),

    hosted_invoice_url: invoice.hosted_invoice_url || null,
    invoice_pdf_url: (invoice as any).invoice_pdf || null,
    receipt_url: (charge as any)?.receipt_url || null,

    payment_method_id:
      typeof (piObj as any)?.payment_method === "string"
        ? (piObj as any).payment_method
        : (piObj as any)?.payment_method?.id || null,
    pm_brand: (charge as any)?.payment_method_details?.card?.brand || null,
    pm_last4: (charge as any)?.payment_method_details?.card?.last4 || null,
    pm_exp_month: (charge as any)?.payment_method_details?.card?.exp_month || null,
    pm_exp_year: (charge as any)?.payment_method_details?.card?.exp_year || null,

    customer_email: (invoice as any).customer_email || null,
    customer_name: (invoice as any).customer_name || null,

    line_items: invoice.lines || null,
    raw: invoice,
    created_at: new Date(),
  });
  if (error) throw error;
}

async function getBusinessByStripeCustomerId(stripeCustomerId: string) {
  try {
    const { data, error } = await supabase
      .from("Business")
      .select("id")
      .eq("stripe_customer_id", stripeCustomerId)
      .single();
    if (error) return null;
    return data as { id: number } | null;
  } catch {
    return null;
  }
}

// ================================ ROUTES ================================

/** Check customer state: exists + has default payment method */
router.post("/payment-sheet", async (req: Request, res: Response) => {
  try {
    const { businessId, email, name, createIfMissing = true } = (req.body || {}) as {
      businessId?: string | number;
      email?: string;
      name?: string;
      createIfMissing?: boolean;
    };

    if (!businessId || !email) {
      return res.status(400).json({ error: "Missing businessId/email" });
    }

    // 1) Load business
    const { data: biz, error: bizErr } = await supabase
      .from("Business")
      .select("id, stripe_customer_id")
      .eq("id", businessId)
      .single();

    if (bizErr || !biz) {
      return res.status(404).json({ error: "Business not found" });
    }

    // 2) Ensure Stripe customer exists (re-use by email, or create)
    let customerId = biz.stripe_customer_id as string | null;
    let createdNew = false;

    if (!customerId && createIfMissing) {
      let customer: Stripe.Customer | null = null;

      // try reuse by email
      const found = await stripe.customers.list({ email, limit: 1 });
      if (found.data[0]) {
        customer = found.data[0];
        // optional: freshen name/metadata
        const toUpdate: Stripe.CustomerUpdateParams = {};
        if (name && customer.name !== name) toUpdate.name = name;
        if (Object.keys(toUpdate).length > 0) {
          customer = await stripe.customers.update(customer.id, toUpdate);
        }
      } else {
        // create
        const idemKey = safeIdemKey(["cust", businessId, email]);
        customer = await stripe.customers.create(
          {
            email,
            name,
            metadata: { businessId: String(businessId) },
          },
          { idempotencyKey: idemKey }
        );
        createdNew = true;
      }

      customerId = customer.id;

      // persist mapping to Business (idempotent)
      try {
        await supabase
          .from("Business")
          .update({ stripe_customer_id: customerId, updated_at: new Date() })
          .eq("id", businessId);
      } catch (e) {
        console.warn("Business mapping update warning:", stringify(e));
      }
    }

    // If still no customer (e.g., createIfMissing=false)
    if (!customerId) {
      return res.status(409).json({ error: "missing_customer" });
    }

    // 3) Determine if a default payment method exists
    const cust = (await stripe.customers.retrieve(customerId)) as Stripe.Customer;
    // @ts-ignore
    const defaultPM = cust?.invoice_settings?.default_payment_method || null;

    let hasDefaultPaymentMethod = !!defaultPM;
    if (!hasDefaultPaymentMethod) {
      const pms = await stripe.paymentMethods.list({
        customer: customerId,
        type: "card",
      });
      hasDefaultPaymentMethod = pms.data.length > 0;
      // (Optional) set first card as default here if you want:
      // if (!defaultPM && pms.data[0]) {
      //   await stripe.customers.update(customerId, {
      //     invoice_settings: { default_payment_method: pms.data[0].id },
      //   });
      //   hasDefaultPaymentMethod = true;
      // }
    }

    // 4) If card on file → no need for PaymentSheet
    if (hasDefaultPaymentMethod) {
      return res.json({
        ok: true,
        hasStripeCustomer: true,
        hasDefaultPaymentMethod: true,
        customerId,
        ephemeralKey: null,
        setupIntentClientSecret: null,
        merchantCountryCode: "US",
        createdNew,
      });
    }

    // 5) Else, prepare PaymentSheet (Ephemeral Key + SetupIntent)
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: MOBILE_API_VERSION }
    );
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: "off_session",
    });

    return res.json({
      ok: true,
      hasStripeCustomer: true,
      hasDefaultPaymentMethod: false,
      customerId,
      ephemeralKey: ephemeralKey.secret,
      setupIntentClientSecret: setupIntent.client_secret,
      merchantCountryCode: "US",
      createdNew,
    });
  } catch (err) {
    console.error("payment-sheet error:", err);
    // Always return JSON (prevents the client’s “Unexpected character: <”)
    return res.status(500).json({ ok: false, error: "payment-sheet failed", detail: stringify(err) });
  }
});

/** Create (or reuse) a Stripe customer and map to Business */
router.post("/customers", async (req: Request<unknown, unknown, CustomerCreateBody>, res: Response) => {
  try {
    const { name, email, businessId, phone, metadata, forceNew } = req.body || {};
    if (!name || !email) return res.status(400).json({ error: "Missing required fields: name, email" });

    let customer: Stripe.Customer | null = null;

    if (!forceNew) {
      try {
        const found = await stripe.customers.list({ email, limit: 1 });
        if (found.data[0]) {
          customer = found.data[0];
          const toUpdate: Stripe.CustomerUpdateParams = {};
          if (name && customer.name !== name) toUpdate.name = name;
          if (phone && customer.phone !== phone) toUpdate.phone = phone;
          if (metadata && typeof metadata === "object") {
            toUpdate.metadata = { ...(customer.metadata || {}), ...metadata };
          }
          if (Object.keys(toUpdate).length > 0) {
            customer = await stripe.customers.update(customer.id, toUpdate);
          }
        }
      } catch (e) {
        console.warn("Stripe customers.list warning:", stringify(e));
      }
    }

    if (!customer) {
      const createParams: Stripe.CustomerCreateParams = {
        name,
        email,
        ...(phone ? { phone } : {}),
        metadata: {
          ...(metadata || {}),
          ...(businessId ? { businessId: String(businessId) } : {}),
          businessName: name,
        },
      };
      const idemKey = safeIdemKey(["cust", businessId || email, name]);
      customer = await stripe.customers.create(createParams, { idempotencyKey: idemKey });
    }

    let savedToBusiness = false;
    if (businessId) {
      try {
        const { error: updErr } = await supabase
          .from("Business")
          .update({
            stripe_customer_id: customer.id,
            updated_at: new Date(),
          })
          .eq("id", businessId);
        if (!updErr) savedToBusiness = true;
        else console.warn("Business update warning:", stringify(updErr));
      } catch (e) {
        console.warn("Business update exception:", stringify(e));
      }
    }

    const clean = (c: Stripe.Customer) => ({
      id: c.id,
      name: c.name || null,
      email: c.email || null,
      phone: c.phone || null,
      address: (c as any).address || null,
      shipping: (c as any).shipping || null,
      preferred_locales: (c as any).preferred_locales || null,
      tax_exempt: (c as any).tax_exempt || "none",
      metadata: c.metadata || {},
      created: c.created ? new Date(c.created * 1000) : null,
    });

    res.json({ customerId: customer.id, customer: clean(customer), savedToBusiness });
  } catch (err) {
    console.error("create-customer error:", err);
    res.status(500).json({ error: "create-customer failed", detail: stringify(err) });
  }
});

/** Create subscription (base + add-ons), snapshot, and store initial receipt */
router.post("/subscribe", async (req: Request<unknown, unknown, SubscribeBody>, res: Response) => {
  try {
    const { businessId, plan } = req.body || ({} as SubscribeBody);
    let { userId } = req.body || ({} as SubscribeBody);

    if (!businessId || !plan?.tierId || !plan?.billingMode) {
      return res.status(400).json({ error: "Missing businessId/plan fields" });
    }
    if (plan.billingMode !== "monthly") {
      return res.status(400).json({ error: "Only monthly billing is supported right now" });
    }

    const biz = await loadBusinessRow(businessId);
    if (!biz.stripe_customer_id) {
      return res.status(409).json({ error: "missing_customer" });
    }

    // resolve userId if not provided
    userId = await resolveUserIdIfMissing(businessId, userId);

    const hasPM = await ensureDefaultPM(biz.stripe_customer_id);
    if (!hasPM) {
      return res.status(200).json({
        requiresPaymentMethod: true,
        message: "No default payment method found. Collect a card with PaymentSheet, then retry.",
      });
    }

    // ---------- Build subscription items ----------
    const items: Stripe.SubscriptionCreateParams.Item[] = [];
    let pricingMode = "mapped";
    const addonsArr: AddonInput[] = Array.isArray(plan.addons) ? plan.addons : [];

    // BASE
    if (Number.isFinite(plan.baseAmountCents)) {
      const basePrice = await stripe.prices.create({
        unit_amount: Math.round(Number(plan.baseAmountCents)),
        currency: "usd",
        recurring: { interval: "month" },
        product_data: {
          name: `Movaro ${plan.tierId} (base)`,
          metadata: { kind: "base", tierId: plan.tierId, businessId: String(businessId) },
        },
        metadata: { kind: "base", tierId: plan.tierId, businessId: String(businessId), source: "custom_base" },
      });
      items.push({ price: basePrice.id, quantity: 1 });
      pricingMode = "base_ad_hoc";
    } else {
      const tierPriceIdRef = await resolveTierPriceIdRef(plan.tierId);
      items.push({ price: tierPriceIdRef, quantity: 1 });
      pricingMode = "mapped";
    }

    // ADD-ONS
    const normalizedAddons: Array<{ kind: "driver" | "stops100"; quantity: number; unitCents: number; priceId: string }> = [];
    for (const raw of addonsArr) {
      const kind = String(raw?.kind || "").toLowerCase() as "driver" | "stops100";
      if (!["driver", "stops100"].includes(kind)) continue;
      const quantity = Math.max(0, Math.floor(Number(raw?.quantity || 0)));
      if (!quantity) continue;

      let unitCents = Number.isFinite(raw?.unitCents) ? Math.round(Number(raw.unitCents)) : NaN;
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

    const idemKey = safeIdemKey([
      "sub",
      businessId,
      plan.tierId,
      plan.billingMode,
      pricingMode,
      Number(plan.baseAmountCents) || 0,
      ...normalizedAddons.flatMap((a) => [a.kind, a.unitCents, a.quantity]),
    ]);

    // ---------- Create subscription ----------
    const subscription = await stripe.subscriptions.create(
      {
        customer: biz.stripe_customer_id,
        items,
        payment_settings: { save_default_payment_method: "on_subscription" },
        payment_behavior: "default_incomplete",
        proration_behavior: "create_prorations",
        metadata: {
          businessId: String(businessId),
          userId: userId ? String(userId) : "",
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
      { idempotencyKey: idemKey }
    );

    // ---------- Persist snapshot ----------
    const totals = {
      drivers: normalizedAddons.find((a) => a.kind === "driver")?.quantity || 0,
      stopsHundreds: normalizedAddons.find((a) => a.kind === "stops100")?.quantity || 0,
    };

    const subscriptionIdLocal = await upsertSubscriptionState({
      businessId,
      userId: userId ?? null,
      stripeCustomerId: biz.stripe_customer_id,
      subscription,
      tier: plan.tierId,
      billingMode: plan.billingMode,
      totals,
    });

    await recordSubscriptionItems({
      businessId,
      subscriptionIdLocal,
      subscription,
      tierId: plan.tierId,
    });

    // ---------- Store initial invoice ----------
    let invoiceObj: Stripe.Invoice | null = null;
    if (subscription.latest_invoice) {
      invoiceObj =
        typeof subscription.latest_invoice === "string"
          ? await stripe.invoices.retrieve(subscription.latest_invoice, {
              expand: ["payment_intent", "payment_intent.charges", "lines"],
            })
          : (subscription.latest_invoice as Stripe.Invoice);

      if (invoiceObj) {
        await insertReceiptRow({
          businessId,
          subscriptionId: subscriptionIdLocal,
          invoice: invoiceObj,
        });
      }
    }

    const paymentIntentSecret =
      (invoiceObj?.payment_intent as any)?.client_secret || null;

    res.json({
      subscriptionId: subscription.id,
      status: subscription.status,
      latestInvoiceId: (invoiceObj as any)?.id || null,
      currentPeriodStart: ts(subscription.current_period_start),
      currentPeriodEnd: ts(subscription.current_period_end),
      paymentIntentClientSecret: paymentIntentSecret,
    });
  } catch (err) {
    console.error("subscribe error:", err);
    res.status(500).json({ error: "subscribe failed", detail: stringify(err) });
  }
});

/** Billing portal */
router.post("/portal", async (req: Request, res: Response) => {
  try {
    const { businessId, returnUrl } = req.body || {};
    if (!businessId || !returnUrl) {
      return res.status(400).json({ error: "Missing businessId/returnUrl" });
    }
    const biz = await loadBusinessRow(businessId);
    if (!biz.stripe_customer_id) return res.status(409).json({ error: "missing_customer" });

    const session = await stripe.billingPortal.sessions.create({
      customer: biz.stripe_customer_id,
      return_url: returnUrl,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("portal error", err);
    res.status(500).json({ error: "portal failed", detail: stringify(err) });
  }
});

// ============================ WEBHOOK HANDLER ============================
/**
 * Wire this in app entry with express.raw:
 *   import bodyParser from 'body-parser';
 *   import billingRouter, { billingWebhook } from './routes/billingRoutes';
 *   app.use('/billing', billingRouter);
 *   app.post('/billing/webhook', bodyParser.raw({ type: 'application/json' }), billingWebhook);
 */
export async function billingWebhook(req: Request, res: Response) {
  const sig = req.headers["stripe-signature"] as string;
  let event: Stripe.Event;

  try {
    const rawBody = (req as any).body ?? (req as any).rawBody; // express.raw supplies Buffer
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET as string);
  } catch (err) {
    console.error("Webhook signature verification failed:", stringify(err));
    return res.status(400).send(`Webhook Error: ${stringify(err)}`);
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;

        const business = await getBusinessByStripeCustomerId(String(sub.customer));

        const { data: localSub } = await supabase
          .from("Subscriptions")
          .select("id, user_id, business_id")
          .eq("stripe_subscription_id", sub.id)
          .single();

        const userId = (localSub as any)?.user_id ?? null;
        const businessId = (localSub as any)?.business_id ?? business?.id ?? null;

        if (!businessId) {
          console.warn("No businessId found for subscription", sub.id);
          break;
        }

        await upsertSubscriptionState({
          businessId,
          userId,
          stripeCustomerId: String(sub.customer),
          subscription: sub,
          tier: (sub.items?.data?.[0]?.price as any)?.nickname || sub.metadata?.tierId || null,
          billingMode: "monthly",
          totals: { drivers: 0, stopsHundreds: 0 },
        });

        // Refresh items snapshot
        try {
          const subscriptionIdLocal = (localSub as any)?.id as number | undefined;
          if (subscriptionIdLocal) {
            await supabase.from("SubscriptionItems").delete().eq("subscription_id", subscriptionIdLocal);
            await recordSubscriptionItems({
              businessId,
              subscriptionIdLocal,
              subscription: sub,
              tierId: sub.metadata?.tierId || null,
            });
          }
        } catch {}

        break;
      }

      case "invoice.payment_succeeded": {
        const inv = event.data.object as Stripe.Invoice;

        const { data: localSub } = await supabase
          .from("Subscriptions")
          .select("id, business_id")
          .eq("stripe_subscription_id", inv.subscription)
          .single();

        let businessId = (localSub as any)?.business_id || null;
        if (!businessId) {
          const biz = await getBusinessByStripeCustomerId(String(inv.customer));
          businessId = biz?.id || null;
        }

        if (!businessId || !(localSub as any)?.id) {
          console.warn("invoice.payment_succeeded: cannot map local subscription/business", inv.id);
          break;
        }

        await insertReceiptRow({
          businessId,
          subscriptionId: (localSub as any).id as number,
          invoice: inv,
        });

        await supabase
          .from("Subscriptions")
          .update({ last_payment_at: new Date(), updated_at: new Date() })
          .eq("id", (localSub as any).id);
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
