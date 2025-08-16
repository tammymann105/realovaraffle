require('dotenv').config();

const express = require('express');
const fs = require('fs');
const cors = require('cors');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const paypal = require('@paypal/checkout-server-sdk');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 4242;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://realovaraffle.vercel.app';

// --- CORS ---
app.use(cors({
  origin: FRONTEND_URL,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  credentials: true
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// --- Email setup ---
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
});

// --- PayPal setup ---
const PayPalEnv = process.env.PAYPAL_MODE === 'live'
  ? paypal.core.LiveEnvironment
  : paypal.core.SandboxEnvironment;

const paypalClient = new paypal.core.PayPalHttpClient(
  new PayPalEnv(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
);

// --- Helper files ---
const entriesFile = 'entries.json';
const codesFile = 'codes.json';

// --- Helper functions ---
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function readJSON(file) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {}; }

// --- API endpoints ---

// Play / submit raffle
app.post('/api/play', async (req, res) => {
  try {
    const { name, email, dob, stake, numbers, captcha } = req.body;
    if (!name || !email || !dob || !stake || !numbers) 
      return res.status(400).json({ error: 'Missing fields' });

    // Save entry
    const entries = readJSON(entriesFile);
    const entryId = Date.now().toString();
    entries[entryId] = { entryId, name, email, dob, stake, numbers };
    saveJSON(entriesFile, entries);

    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const codes = readJSON(codesFile);
    codes[email] = code;
    saveJSON(codesFile, codes);

    // Send email
    await transporter.sendMail({
      from: `"Realova Raffle" <${process.env.MAIL_USER}>`,
      to: email,
      subject: 'Your Realova Raffle Verification Code',
      text: `Hi ${name},\nYour verification code is: ${code}`,
      html: `<p>Hi ${name},</p><p>Your verification code is: <strong>${code}</strong></p>`
    });

    console.log(`✅ Sent code ${code} to ${email}`);

    res.json({ success: true, entryId });

  } catch (err) {
    console.error('❌ /api/play error:', err);
    res.status(500).json({ error: 'Server error: could not send code' });
  }
});

// Verify code
app.post('/api/verify-code', (req, res) => {
  const { email, code } = req.body;
  const codes = readJSON(codesFile);

  if (codes[email] && codes[email] === code) {
    delete codes[email];
    saveJSON(codesFile, codes);
    res.json({ success: true });
  } else {
    res.json({ success: false, error: 'Invalid verification code' });
  }
});

// Resend code
app.post('/api/resend-code', async (req, res) => {
  const { email } = req.body;
  const codes = readJSON(codesFile);

  if (!codes[email]) return res.json({ success: false, error: 'No code found for this email' });

  try {
    await transporter.sendMail({
      from: `"Realova Raffle" <${process.env.MAIL_USER}>`,
      to: email,
      subject: 'Your Realova Raffle Verification Code',
      text: `Your verification code is: ${codes[email]}`,
      html: `<p>Your verification code is: <strong>${codes[email]}</strong></p>`
    });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ /api/resend-code error:', err);
    res.json({ success: false, error: 'Could not send code' });
  }
});

// Stripe session
app.post('/create-stripe-session', async (req, res) => {
  try {
    const { name, email, stake, numbers, dob } = req.body;
    if (!name || !email || !stake || !numbers || !dob) 
      return res.status(400).json({ error: 'Missing user data' });

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

// PayPal order
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
app.listen(PORT, () => console.log(`🎯 Backend running → http://localhost:${PORT}`));
