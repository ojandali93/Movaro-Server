// server.js or routes/billing.js
import express from "express";
import Stripe from "stripe";
import { supabase } from '../utils/supabase.js';

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
    const { userId, email, businessId, tier, paymentAmount, totalDrivers, totalStops, driversLeft, stopsLeft } = req.body;

    console.log('req.body: ', JSON.stringify(req.body, null, 2));

    // Ensure a Stripe Customer exists for this user
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        metadata: { userId },
      });
      console.log('customer: ', JSON.stringify(customer, null, 2));
      let currentPeriodEnd = new Date();
      currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + 1);
      const storedPayment = await supabase
        .from('Subscriptions')
        .insert({
          business_id: businessId,
          user_id: userId,
          stripe_customer_id: customer.id,
          stripe_subscription_id: null,
          tier,
          billing_mode: 'monthly',
          payment_amount_cents: paymentAmount,
          currency: 'usd',
          total_drivers: totalDrivers,
          total_stops: totalStops,
          drivers_left: driversLeft,
          stops_left: stopsLeft,
          status: 'active',
          last_payment_at: new Date(),
          current_period_start: new Date(),
          current_period_end: currentPeriodEnd,
          cancel_at_period_end: false,
          canceled_at: null,
          default_payment_method_id: null,
          latest_invoice_id: null,
          metadata: customer.metadata,
          delinquent: customer.delinquent,
          created_at: new Date(),
        })
        .select()
        .single();

      console.log('storedPayment: ', JSON.stringify(storedPayment, null, 2));
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
