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

// Log all requests
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

// IP blacklist
const blacklist = new Set(fs.existsSync('blacklist.json') ? JSON.parse(fs.readFileSync('blacklist.json')) : []);
app.use((req, res, next) => {
  const ip = req.ip.replace('::ffff:', '');
  if (blacklist.has(ip)) return res.status(403).json({ error: 'Access denied.' });
  next();
});

// Email Transport
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
});

// CAPTCHA condition
function shouldTriggerCaptcha(email, ip) {
  const entries = fs.existsSync('entries.json') ? JSON.parse(fs.readFileSync('entries.json')) : [];
  return entries.filter(e => e.email === email || e.ip === ip).length >= 3;
}

// Serve main page
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// CAPTCHA check route
app.get('/api/should-captcha', (req, res) => {
  const { email } = req.query;
  const ip = req.ip.replace('::ffff:', '');
  return res.json({ requireCaptcha: shouldTriggerCaptcha(email, ip) });
});

// Handle entry & send code
app.post('/api/play', upload.none(), async (req, res) => {
  try {
    const { name, email, dob, stake, numbers, captcha } = req.body;
    const parsedNumbers = Array.isArray(numbers) ? numbers : [numbers];
    const ip = req.ip.replace('::ffff:', '');
    const isLocal = req.hostname.includes('localhost') || ip === '127.0.0.1' || ip === '::1';
    const captchaNeeded = !isLocal && shouldTriggerCaptcha(email, ip);

    if (captchaNeeded) {
      if (!captcha) return res.status(400).json({ error: 'CAPTCHA required' });
      const verify = await axios.post(
        'https://www.google.com/recaptcha/api/siteverify',
        `secret=${process.env.RECAPTCHA_SECRET}&response=${captcha}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      if (!verify.data.success) return res.status(400).json({ error: 'CAPTCHA failed', details: verify.data });
    }

    const birth = new Date(dob);
    const today = new Date(); today.setFullYear(today.getFullYear() - 18);
    if (birth > today) return res.status(400).json({ error: 'You must be 18 or older to play.' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 5 * 60 * 1000;

    const codes = fs.existsSync('codes.json') ? JSON.parse(fs.readFileSync('codes.json')) : {};
    codes[email] = { code, expires };
    fs.writeFileSync('codes.json', JSON.stringify(codes, null, 2));

    await transporter.sendMail({
      from: process.env.MAIL_USER,
      to: email,
      subject: 'Your Raffle Verification Code',
      html: `<p>Hi ${name},</p><p>Your verification code is: <strong>${code}</strong></p><p>It expires in 5 minutes.</p>`
    });

    const entries = fs.existsSync('entries.json') ? JSON.parse(fs.readFileSync('entries.json')) : [];
    const entryId = Date.now().toString();
    entries.push({ entryId, name, email, stake, numbers: parsedNumbers, dob, ip, status: 'pending' });
    fs.writeFileSync('entries.json', JSON.stringify(entries, null, 2));

    res.json({ success: true, entryId, message: 'Verification code sent to email.' }); // ✅ FIXED
  } catch (err) {
    console.error('🔥 /api/play error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Verify the code
app.post('/api/verify-code', (req, res) => {
  const { email, code } = req.body;
  const codes = fs.existsSync('codes.json') ? JSON.parse(fs.readFileSync('codes.json')) : {};
  const entry = codes[email];
  if (!entry) return res.status(400).json({ error: 'No code sent. Please request a new one.' });
  if (Date.now() > entry.expires) return res.status(400).json({ error: 'Code expired. Request a new one.' });
  if (entry.code !== code) return res.status(400).json({ error: 'Invalid code.' });

  delete codes[email];
  fs.writeFileSync('codes.json', JSON.stringify(codes, null, 2));
  res.json({ success: true });
});

// Resend code
app.post('/api/resend-code', (req, res) => {
  const { email } = req.body;
  const entries = fs.existsSync('entries.json') ? JSON.parse(fs.readFileSync('entries.json')) : [];
  const user = entries.find(e => e.email === email);
  if (!user) return res.status(400).json({ error: 'User not found' });

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = Date.now() + 5 * 60 * 1000;

  const codes = fs.existsSync('codes.json') ? JSON.parse(fs.readFileSync('codes.json')) : {};
  codes[email] = { code, expires };
  fs.writeFileSync('codes.json', JSON.stringify(codes, null, 2));

  transporter.sendMail({
    from: process.env.MAIL_USER,
    to: email,
    subject: 'Your New Raffle Verification Code',
    html: `<p>Your new code is: <strong>${code}</strong>. It expires in 5 minutes.</p>`
  });

  res.json({
    success: true,
    entryId: user.entryId, // ✅ FIXED
    message: 'Verification code sent to email.'
  });
});

// Stripe Checkout
app.post('/create-stripe-session', async (req, res) => {
  try {
    console.log("✅ /create-stripe-session called");
    const { name, email, stake, numbers, dob } = req.body;
    if (!name || !email || !stake || !numbers || !dob) {
      return res.status(400).json({ error: 'Missing user data' });
    }

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
      success_url: 'http://localhost:4242/success.html',
      cancel_url: 'http://localhost:4242/cancel.html'
    });

    console.log("✅ Stripe session created:", session.url);
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Stripe session error:", err);
    res.status(500).json({ error: 'Stripe session creation failed' });
  }
});

// PayPal Checkout
app.post('/create-paypal-order', async (req, res) => {
  try {
    console.log("✅ /create-paypal-order called");
    const { name, email, stake, numbers, dob } = req.body;

    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer('return=representation');
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: 'EUR',
          value: stake.toString()
        },
        description: 'Realova Raffle Entry'
      }],
      application_context: {
        brand_name: 'Realova Raffle',
        user_action: 'PAY_NOW',
        landing_page: 'LOGIN',
        return_url: 'http://localhost:4242/success.html',
        cancel_url: 'http://localhost:4242/cancel.html'
      }
    });

    const order = await paypalClient.execute(request);
    const approvalUrl = order.result.links.find(link => link.rel === 'approve')?.href;

    console.log("✅ PayPal order created:", approvalUrl);
    res.json({ url: approvalUrl });
  } catch (err) {
    console.error("❌ PayPal error:", err);
    res.status(500).json({ error: 'PayPal order creation failed' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`🎯 Realova backend running → http://localhost:${PORT}`);
});
