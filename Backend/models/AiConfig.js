const mongoose = require('mongoose');

const AiConfigSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, index: true },
    enabled: { type: Boolean, default: false },
    knowledgeBase: { type: String, default: "" },
    apiKey: { type: String, default: "" },
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('AiConfig', AiConfigSchema);
