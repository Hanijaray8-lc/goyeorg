const mongoose = require('mongoose');

const teamCampaignSchema = new mongoose.Schema({
    title: { type: String, required: true },
    leaderEmail: { type: String, required: true },
    messageTemplate: { type: String, default: '' },
    media: {
        data: { type: String },
        mimetype: { type: String },
        filename: { type: String }
    },
    totalContactsCount: { type: Number, required: true },
    splitSizePerPerson: { type: Number, required: true, default: 100 },
    maxMembers: { type: Number, required: true, default: 5 },
    includeLeaderAsSender: { type: Boolean, default: true },
    creditsRequired: { type: Number, required: true }, // Math.ceil(totalContactsCount / 2)
    escrowCreditsLocked: { type: Number, default: 0 },
    status: {
        type: String,
        enum: ['DRAFT', 'WAITING_FOR_TEAM', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED'],
        default: 'WAITING_FOR_TEAM'
    },
    joinCode: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now }
});

const teamCampaignMemberSchema = new mongoose.Schema({
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'TeamCampaign', required: true },
    memberEmail: { type: String, required: true },
    memberName: { type: String, default: 'Team Member' },
    memberPhone: { type: String, default: '' },
    allocatedCount: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    status: {
        type: String,
        enum: ['PENDING_APPROVAL', 'APPROVED', 'READY', 'SENDING', 'COMPLETED', 'FAILED', 'DISCONNECTED'],
        default: 'PENDING_APPROVAL'
    },
    joinedAt: { type: Date, default: Date.now },
    approvedAt: { type: Date }
});

const teamCampaignContactSchema = new mongoose.Schema({
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'TeamCampaign', required: true },
    assignedToEmail: { type: String, default: '' },
    phoneNumber: { type: String, required: true },
    status: {
        type: String,
        enum: ['PENDING', 'PROCESSING', 'SENT', 'FAILED'],
        default: 'PENDING'
    },
    failureReason: { type: String, default: '' },
    sentAt: { type: Date }
});

const TeamCampaign = mongoose.models.TeamCampaign || mongoose.model('TeamCampaign', teamCampaignSchema);
const TeamCampaignMember = mongoose.models.TeamCampaignMember || mongoose.model('TeamCampaignMember', teamCampaignMemberSchema);
const TeamCampaignContact = mongoose.models.TeamCampaignContact || mongoose.model('TeamCampaignContact', teamCampaignContactSchema);

module.exports = {
    TeamCampaign,
    TeamCampaignMember,
    TeamCampaignContact
};
