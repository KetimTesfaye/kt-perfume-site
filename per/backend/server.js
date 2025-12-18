require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const basicAuth = require('basic-auth');

const Order = require('./models/Order');

const app = express();
app.use(bodyParser.json({ verify: (req, res, buf) => { req.rawBody = buf } }));
app.use(cors());

// config
const PORT = process.env.PORT || 4000;
const MONGODB_URI = process.env.MONGODB_URI;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const SITE_BASE = process.env.SITE_BASE_URL || `http://localhost:${PORT}`;

// connect to mongodb
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(()=>console.log('MongoDB connected'))
  .catch(err=>{ console.error('MongoDB connect error', err); process.exit(1); });

const stripe = require('stripe')(STRIPE_SECRET_KEY);

/* -------------------------
   Helpers
------------------------- */
function requireAdmin(req, res, next) {
  const user = basicAuth(req);
  if (!user || user.pass !== ADMIN_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Unauthorized');
  }
  next();
}

/* -------------------------
   API: Create Order (from site)
   Body: { name, phone, items: [{name,qty,price}], source }
------------------------- */
app.post('/api/orders', async (req, res) => {
  try {
    const { name, phone, items = [], source = 'website' } = req.body;
    const total = items.reduce((s,it)=>s + (it.price||0)*(it.qty||1), 0);
    const order = new Order({ name, phone, items, total, source });
    await order.save();
    return res.json({ ok:true, order });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok:false, error: err.message });
  }
});

/* -------------------------
   API: Create Stripe Checkout Session
   Body: { orderId }
   We fetch the order, create checkout and attach session id to order
------------------------- */
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId required' });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const line_items = order.items.map(it=>({
      price_data: {
        currency: 'usd', // change to appropriate currency; convert ETB => USD if needed
        product_data: { name: it.name },
        unit_amount: Math.round((it.price || 0) * 100) // in cents
      },
      quantity: it.qty || 1
    }));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      success_url: `${SITE_BASE}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_BASE}/cancel.html`,
      metadata: { orderId: order._id.toString() }
    });

    // attach session to order
    order.stripeSessionId = session.id;
    await order.save();

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------
   Stripe webhook to confirm payment
------------------------- */
app.post('/webhook/stripe', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.warn('Webhook signature mismatch:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  // Handle the checkout.session.completed event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata && session.metadata.orderId;
    if (orderId) {
      const order = await Order.findById(orderId);
      if (order) {
        order.status = 'paid';
        await order.save();
        // Optionally use WhatsApp Cloud API to send confirmation
        // sendWhatsAppMessage(order.phone, `Your order ${order._id} is confirmed. Thank you!`);
      }
    }
  }
  res.json({ received: true });
});

/* -------------------------
   WhatsApp Cloud API: Send a text message (server-side)
   POST /send-whatsapp { phone, message }
   Requires WHATSAPP_TOKEN & WA_PHONE_ID
   See: Meta WhatsApp Cloud API docs.
   (This will send using your business account via Graph API).
------------------------- */
app.post('/send-whatsapp', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone & message required' });

  try {
    const url = `https://graph.facebook.com/v17.0/${WA_PHONE_ID}/messages`;
    const payload = {
      messaging_product: "whatsapp",
      to: phone.replace(/\D/g,''),
      type: "text",
      text: { body: message }
    };
    const r = await axios.post(url, payload, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
    return res.json({ ok:true, data: r.data });
  } catch (err) {
    console.error('WhatsApp send error', err?.response?.data || err.message);
    return res.status(500).json({ ok:false, error: err?.response?.data || err.message });
  }
});

/* -------------------------
   WhatsApp webhook endpoint (verify + receive)
   For verification GET: respond with hub.challenge when hub.verify_token matches
   For messages POST: receive messages (store or forward)
   See Meta docs for details.
------------------------- */
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  // you should set your own verify token and compare
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'ketim_verify';
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  } else {
    return res.status(403).send('Forbidden');
  }
});

app.post('/webhook/whatsapp', (req, res) => {
  // Actual message handling (keep simple)
  const body = req.body;
  console.log('WhatsApp webhook received:', JSON.stringify(body).slice(0, 1000));
  // TODO: parse incoming messages and optionally store them in DB or notify admin
  res.sendStatus(200);
});

/* -------------------------
   ADMIN: simple view of orders (basic auth)
------------------------- */
app.get('/admin', requireAdmin, async (req, res) => {
  const orders = await Order.find().sort({ createdAt: -1 }).limit(200).lean();
  // send minimal HTML (you can expand this)
  let html = `<!doctype html><html><head><meta charset="utf-8"><title>Admin - Ketim Orders</title>
  <style>body{font-family:Arial;padding:20px}table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #eee}</style></head><body>`;
  html += `<h2>Orders</h2><table><thead><tr><th>ID</th><th>Name</th><th>Phone</th><th>Total</th><th>Status</th><th>Created</th></tr></thead><tbody>`;
  for (const o of orders) {
    html += `<tr><td>${o._id}</td><td>${o.name}</td><td>${o.phone}</td><td>${o.total}</td><td>${o.status}</td><td>${new Date(o.createdAt).toLocaleString()}</td></tr>`;
  }
  html += `</tbody></table></body></html>`;
  res.send(html);
});

/* -------------------------
   Serve static (optional)
------------------------- */
app.use(express.static('public'));

/* -------------------------
   Start
------------------------- */
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
