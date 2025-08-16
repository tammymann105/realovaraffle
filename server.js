require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const nodemailer = require('nodemailer');
const multer = require('multer');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const paypal = require('@paypal/checkout-server-sdk');

const app = express();
const upload = multer();
const PORT = process.env.PORT || 4242;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://realovaraffle.vercel.app';

// Log requests
app.use((req, res, next) => {
  console.log(`📡 ${req.method} ${req.url}`);
  next();
});

// PayPal setup
const PayPalEnv = process.env.PAYPAL_MODE === 'live'
  ? paypal.core.LiveEnvironment
  : paypal.core.SandboxEnvironment;

const paypalClient = new paypal.core.PayPalHttpClient(
  new PayPalEnv(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
);

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
});

// Helper: CAPTCHA condition
function shouldTriggerCaptcha(email, ip) {
  const entries = fs.existsSync('entries.json') ? JSON.parse(fs.readFileSync('entries.json')) : [];
  return entries.filter(e => e.email === email || e.ip === ip).length >= 3;
}

// --- API Routes ---

// Create Stripe session
app.post('/create-stripe-session', async (req, res) => {
  try {
    const { name, email, stake, numbers, dob } = req.body;
    if (!name || !email || !stake || !numbers || !dob) return res.status(400).json({ error: 'Missing user data' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: 'Realova Raffle Entry' },
          unit_amount: parseInt(stake) * 100
        },
        quantity: 1
      }],
      metadata: { name, email, stake, dob, numbers: numbers.join(',') },
      success_url: `${FRONTEND_URL}/success.html`,
      cancel_url: `${FRONTEND_URL}/cancel.html`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Stripe session error:", err);
    res.status(500).json({ error: 'Stripe session creation failed' });
  }
});

// Create PayPal order
app.post('/create-paypal-order', async (req, res) => {
  try {
    const { name, email, stake, numbers, dob } = req.body;

    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer('return=representation');
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: 'EUR', value: stake.toString() },
        description: 'Realova Raffle Entry'
      }],
      application_context: {
        brand_name: 'Realova Raffle',
        user_action: 'PAY_NOW',
        landing_page: 'LOGIN',
        return_url: `${FRONTEND_URL}/success.html`,
        cancel_url: `${FRONTEND_URL}/cancel.html`
      }
    });

    const order = await paypalClient.execute(request);
    const approvalUrl = order.result.links.find(link => link.rel === 'approve')?.href;

    res.json({ url: approvalUrl });
  } catch (err) {
    console.error("❌ PayPal error:", err);
    res.status(500).json({ error: 'PayPal order creation failed' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🎯 Backend running → http://localhost:${PORT}`);
});
