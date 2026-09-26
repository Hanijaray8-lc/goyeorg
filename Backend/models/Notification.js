const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userEmail: { type: String, required: true, index: true },
  type: { type: String, default: 'request_approved' }, // 'request_approved' or 'request_rejected'
  title: { type: String },
  requestId: { type: String },
  message: { type: String, required: true },
  creditsEarned: { type: Number, default: 0 },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);
