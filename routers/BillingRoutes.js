// server.js or routes/billing.js
import express from "express";
import Stripe from "stripe";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

// POST /billing/payment-sheet
router.post("/payment-sheet", async (req, res) => {
  try {
    const { userId, email } = req.body;

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
