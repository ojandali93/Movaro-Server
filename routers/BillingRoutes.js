// server.js or routes/billing.js
import express from "express";
import Stripe from "stripe";
import { supabase } from "../utils/supabase";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

async function ensureDefaultPM(customerId) {
  const customer = await stripe.customers.retrieve(customerId);
  // @ts-ignore
  if (customer?.invoice_settings?.default_payment_method) return;

  const pms = await stripe.paymentMethods.list({
    customer: customerId,
    type: 'card',
  });
  if (pms.data[0]) {
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: pms.data[0].id },
    });
  }
}

// POST /billing/payment-sheet
router.post("/payment-sheet", async (req, res) => {
  try {
    const { userId, email } = req.body;

    // Ensure a Stripe Customer exists for this user
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      console.log('existing: ', existing);
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        metadata: { userId },
      });
      console.log('customer: ', customer);
    }

    // Create an ephemeral key for the client
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: "2024-06-20" }
    );

    // Create a SetupIntent so the PaymentSheet can attach a PM
    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
    });

    const storedPayment = await supabase
      .from('Subscriptions')
      .insert({
        business_id: userId,
        stripe_customer_id: customer.id,
        stripe_subscription_id: null,
        tier: 'free',
        billing_mode: 'monthly',
        payment_amount_cents: 0,
        currency: 'usd',
        total_drivers: 1,
        total_stops: 100,
        drivers_left: 1,
        stops_left: 100,
        status: 'active',
        last_payment_at: new Date(),
        current_period_start: new Date(),
        current_period_end: new Date(),
        cancel_at_period_end: false,
        canceled_at: null,
        default_payment_method_id: null,
        latest_invoice_id: null,
        metadata: {},
        created_at: new Date(),
      })
      .select()
      .single();

    console.log('storedPayment: ', storedPayment);

    res.json({
      customerId: customer.id,
      ephemeralKey: ephemeralKey.secret,
      setupIntentClientSecret: setupIntent.client_secret,
      merchantCountryCode: "US", // or derive dynamically
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

export default router;
