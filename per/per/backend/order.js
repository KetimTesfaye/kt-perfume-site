const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  items: [{ name: String, qty: Number, price: Number }],
  total: { type: Number, default: 0 },
  status: { type: String, enum: ['pending','paid','cancelled','fulfilled'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  source: { type: String, default: 'website' }, // e.g. 'whatsapp', 'stripe'
  stripeSessionId: { type: String, default: null }
});

module.exports = mongoose.model('Order', OrderSchema);
