const mongoose = require('mongoose');

const SubscriptionRequestSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true },
    plan: { type: String, required: true },
    amount: { type: String },
    upiId: { type: String },
    screenshot: { type: String },
    message: { type: String },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('SubscriptionRequest', SubscriptionRequestSchema);
