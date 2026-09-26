const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { TeamCampaign, TeamCampaignMember, TeamCampaignContact } = require('../models/teamCampaignModel');

// Helper function to get User model safely
function getUserModel() {
    return mongoose.models.User || null;
}

// 1. Create a Team Campaign
router.post('/create', async (req, res) => {
    try {
        const {
            title,
            leaderEmail,
            leaderName,
            messageTemplate,
            media,
            contacts,
            splitSizePerPerson = 100,
            maxMembers = 5,
            includeLeaderAsSender = true
        } = req.body;

        if (!leaderEmail || !contacts || !Array.isArray(contacts) || contacts.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid payload: leaderEmail and contacts array are required.' });
        }

        const UserModel = getUserModel();
        let user = null;
        if (UserModel && mongoose.connection.readyState === 1) {
            try {
                user = await UserModel.findOne({ email: leaderEmail });
                if (!user) {
                    user = await UserModel.findOne({});
                }
            } catch (err) {
                console.log('MongoDB user query warning:', err.message);
            }
        }

        if (!user) {
            user = { name: 'Leader', email: leaderEmail, credits: 100 };
        }

        // Goye Credit Rule: 1 credit = 2 messages
        const totalContactsCount = contacts.length;
        const creditsRequired = Math.ceil(totalContactsCount / 2);

        const userBalance = typeof user.credits === 'number' ? user.credits : 100;
        if (userBalance < creditsRequired) {
            return res.status(400).json({
                success: false,
                message: `Insufficient credits. This campaign requires ${creditsRequired} credits for ${totalContactsCount} contacts (1 credit = 2 messages). Your current balance is ${userBalance} credits.`
            });
        }

        // Generate unique join code
        const joinCode = 'CAMP-' + Math.random().toString(36).substring(2, 7).toUpperCase();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours TTL

        const newCampaign = new TeamCampaign({
            title: title || 'Team Bulk Campaign',
            leaderEmail,
            messageTemplate: messageTemplate || '',
            media: media || null,
            totalContactsCount,
            splitSizePerPerson: Number(splitSizePerPerson),
            maxMembers: Number(maxMembers),
            includeLeaderAsSender: !!includeLeaderAsSender,
            creditsRequired,
            escrowCreditsLocked: 0,
            status: 'WAITING_FOR_TEAM',
            joinCode,
            expiresAt
        });

        await newCampaign.save();

        // Create contact documents
        const contactDocs = contacts.map(phone => ({
            campaignId: newCampaign._id,
            assignedToEmail: includeLeaderAsSender ? leaderEmail : '',
            phoneNumber: String(phone).trim(),
            status: 'PENDING'
        }));

        await TeamCampaignContact.insertMany(contactDocs);

        // If Leader is included as sender, add Leader as 1st approved member (automatically READY)
        if (includeLeaderAsSender) {
            const leaderMember = new TeamCampaignMember({
                campaignId: newCampaign._id,
                memberEmail: leaderEmail,
                memberName: leaderName || user.name || 'Leader',
                memberPhone: user.phone || '',
                allocatedCount: 0,
                status: 'READY',
                approvedAt: new Date()
            });
            await leaderMember.save();
        }

        res.status(201).json({
            success: true,
            campaign: newCampaign,
            joinCode,
            creditsRequired,
            message: 'Team Campaign created successfully!'
        });
    } catch (error) {
        console.error('Error creating team campaign:', error);
        res.status(500).json({ success: false, message: 'Server error while creating campaign', error: error.message });
    }
});

// 2. Fetch Join Info for a Teammate
router.get('/join-info/:joinCode', async (req, res) => {
    try {
        const { joinCode } = req.params;
        const campaign = await TeamCampaign.findOne({ joinCode });

        if (!campaign) {
            return res.status(404).json({ success: false, message: 'Campaign not found or invalid link.' });
        }

        if (new Date() > new Date(campaign.expiresAt)) {
            return res.status(410).json({ success: false, message: 'This campaign join link has expired.' });
        }

        if (campaign.status === 'COMPLETED' || campaign.status === 'CANCELLED') {
            return res.status(400).json({ success: false, message: `Campaign is already ${campaign.status.toLowerCase()}.` });
        }

        const currentMembersCount = await TeamCampaignMember.countDocuments({ campaignId: campaign._id });
        const isFull = currentMembersCount >= campaign.maxMembers;

        const leaderMember = await TeamCampaignMember.findOne({ campaignId: campaign._id, memberEmail: campaign.leaderEmail });
        const leaderName = leaderMember ? leaderMember.memberName : campaign.leaderEmail.split('@')[0];

        res.json({
            success: true,
            campaignId: campaign._id,
            title: campaign.title,
            leaderEmail: campaign.leaderEmail,
            leaderName: leaderName,
            totalContactsCount: campaign.totalContactsCount,
            splitSizePerPerson: campaign.splitSizePerPerson,
            maxMembers: campaign.maxMembers,
            currentMembersCount,
            isFull,
            status: campaign.status
        });
    } catch (error) {
        console.error('Error fetching join info:', error);
        res.status(500).json({ success: false, message: 'Error fetching campaign join details' });
    }
});

// 3. Member Join Request
router.post('/join-request', async (req, res) => {
    try {
        const { joinCode, memberEmail, memberName, memberPhone } = req.body;

        const cleanPhone = String(memberPhone || '').replace(/\D/g, '');
        const effectiveEmail = (memberEmail && memberEmail.trim()) 
            ? memberEmail.trim() 
            : (cleanPhone ? `${cleanPhone}@goyeteam.com` : null);

        if (!joinCode || !effectiveEmail) {
            return res.status(400).json({ success: false, message: 'Campaign join code and mobile number are required.' });
        }

        const campaign = await TeamCampaign.findOne({ joinCode });
        if (!campaign) {
            return res.status(404).json({ success: false, message: 'Campaign not found.' });
        }

        if (new Date() > new Date(campaign.expiresAt)) {
            return res.status(410).json({ success: false, message: 'Campaign invite link has expired.' });
        }

        // Check if member limit reached
        const currentMembersCount = await TeamCampaignMember.countDocuments({ campaignId: campaign._id });
        if (currentMembersCount >= campaign.maxMembers) {
            return res.status(400).json({ success: false, message: `Team capacity full (${campaign.maxMembers}/${campaign.maxMembers} members).` });
        }

        // Check if member already joined
        let member = await TeamCampaignMember.findOne({ 
            campaignId: campaign._id, 
            $or: [
                { memberEmail: effectiveEmail },
                ...(cleanPhone ? [{ memberPhone: String(memberPhone).trim() }] : [])
            ]
        });
        if (member) {
            return res.json({
                success: true,
                member,
                message: 'You have already joined this campaign.'
            });
        }

        member = new TeamCampaignMember({
            campaignId: campaign._id,
            memberEmail: effectiveEmail,
            memberName: memberName || 'Team Member',
            memberPhone: memberPhone || '',
            status: 'PENDING_APPROVAL'
        });

        await member.save();

        res.status(201).json({
            success: true,
            member,
            message: 'Join request submitted! Waiting for Leader approval.'
        });
    } catch (error) {
        console.error('Error submitting join request:', error);
        res.status(500).json({ success: false, message: 'Error joining campaign' });
    }
});

// 4. Leader Approves Member
router.post('/approve-member', async (req, res) => {
    try {
        const { campaignId, memberEmail, leaderEmail } = req.body;

        const campaign = await TeamCampaign.findById(campaignId);
        if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found.' });

        if (campaign.leaderEmail !== leaderEmail) {
            return res.status(403).json({ success: false, message: 'Only the campaign Leader can approve members.' });
        }

        const member = await TeamCampaignMember.findOneAndUpdate(
            { campaignId, memberEmail },
            { status: 'APPROVED', approvedAt: new Date() },
            { returnDocument: 'after' }
        );

        if (!member) return res.status(404).json({ success: false, message: 'Member not found.' });

        res.json({
            success: true,
            member,
            message: `Member ${memberEmail} approved successfully.`
        });
    } catch (error) {
        console.error('Error approving member:', error);
        res.status(500).json({ success: false, message: 'Error approving member' });
    }
});

// Leader Rejects Member
router.post('/reject-member', async (req, res) => {
    try {
        const { campaignId, memberEmail, leaderEmail } = req.body;

        const campaign = await TeamCampaign.findById(campaignId);
        if (!campaign) {
            return res.status(404).json({ success: false, message: 'Campaign not found.' });
        }

        if (campaign.leaderEmail !== leaderEmail) {
            return res.status(403).json({ success: false, message: 'Only the campaign Leader can reject members.' });
        }

        await TeamCampaignMember.findOneAndDelete({ campaignId, memberEmail });

        res.json({
            success: true,
            message: `Member ${memberEmail} rejected successfully.`
        });
    } catch (error) {
        console.error('Error rejecting member:', error);
        res.status(500).json({ success: false, message: 'Error rejecting member' });
    }
});

// Member Connects WhatsApp & Marks Ready
router.post('/member-ready', async (req, res) => {
    try {
        const { campaignId, memberEmail, memberPhone } = req.body;
        const member = await TeamCampaignMember.findOneAndUpdate(
            { campaignId, memberEmail },
            { status: 'READY', memberPhone: memberPhone || '' },
            { returnDocument: 'after' }
        );
        res.json({ success: true, member });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error updating member status' });
    }
});

// 5. Fetch Leader Lobby Data
router.get('/:campaignId/lobby', async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ success: false, message: 'Database not connected. Please retry.' });
        }
        const { campaignId } = req.params;
        const campaign = await TeamCampaign.findById(campaignId);
        if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found.' });

        const members = await TeamCampaignMember.find({ campaignId });
        const contactsCount = await TeamCampaignContact.countDocuments({ campaignId });
        const sentCount = await TeamCampaignContact.countDocuments({ campaignId, status: 'SENT' });
        const failedCount = await TeamCampaignContact.countDocuments({ campaignId, status: 'FAILED' });
        const failedContacts = await TeamCampaignContact.find({ campaignId, status: 'FAILED' }).select('phoneNumber assignedToEmail failureReason');
        const assignedContacts = await TeamCampaignContact.find({ campaignId }).select('phoneNumber assignedToEmail status failureReason');

        res.json({
            success: true,
            campaign,
            members,
            failedContacts,
            assignedContacts,
            stats: {
                totalContacts: contactsCount,
                sent: sentCount,
                failed: failedCount,
                pending: contactsCount - (sentCount + failedCount)
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching lobby data' });
    }
});

// 5b. Fetch Member's Own Assigned Contacts (Privacy Isolated)
router.get('/:campaignId/my-contacts', async (req, res) => {
    try {
        const { campaignId } = req.params;
        const { email } = req.query;
        if (!email) return res.status(400).json({ success: false, message: 'Email required' });
        const contacts = await TeamCampaignContact.find({ campaignId, assignedToEmail: email }).select('phoneNumber status failureReason');
        res.json({ success: true, contacts });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 6. Leader Starts Campaign Master Dispatch
router.post('/start', async (req, res) => {
    try {
        const { campaignId, leaderEmail } = req.body;

        const campaign = await TeamCampaign.findById(campaignId);
        if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found.' });

        if (campaign.leaderEmail !== leaderEmail) {
            return res.status(403).json({ success: false, message: 'Only campaign Leader can start dispatches.' });
        }

        const approvedMembers = await TeamCampaignMember.find({
            campaignId,
            status: { $in: ['APPROVED', 'READY'] }
        });

        if (approvedMembers.length === 0) {
            return res.status(400).json({ success: false, message: 'At least 1 approved team member is required.' });
        }

        // Get all pending contacts
        const allContacts = await TeamCampaignContact.find({ campaignId, status: 'PENDING' });
        if (allContacts.length === 0) {
            return res.status(400).json({ success: false, message: 'No pending contacts found to dispatch.' });
        }

        // Split contacts equally among approved members
        const chunkSize = Math.ceil(allContacts.length / approvedMembers.length);

        for (let i = 0; i < approvedMembers.length; i++) {
            const member = approvedMembers[i];
            const memberContacts = allContacts.slice(i * chunkSize, (i + 1) * chunkSize);
            const contactIds = memberContacts.map(c => c._id);

            await TeamCampaignContact.updateMany(
                { _id: { $in: contactIds } },
                { assignedToEmail: member.memberEmail }
            );

            await TeamCampaignMember.findByIdAndUpdate(member._id, {
                allocatedCount: memberContacts.length,
                status: 'SENDING'
            });
        }

        campaign.status = 'IN_PROGRESS';
        campaign.escrowCreditsLocked = campaign.creditsRequired;
        await campaign.save();

        // Trigger background message sending engine
        runTeamDispatchEngine(campaign._id, req.app);

        res.json({
            success: true,
            campaign,
            message: `Team Campaign dispatches launched across ${approvedMembers.length} member(s)!`
        });
    } catch (error) {
        console.error('Error starting team campaign:', error);
        res.status(500).json({ success: false, message: 'Error starting campaign dispatches' });
    }
});

// Async Background Dispatch Processing Engine — Round-Based Sequential Chunk Scheduler
async function runTeamDispatchEngine(campaignId, app) {
    try {
        const userClients = app ? app.get('userClients') : null;
        const emitToUserSockets = app ? app.get('emitToUserSockets') : null;

        const campaign = await TeamCampaign.findById(campaignId);
        if (!campaign) return;

        // Configurable chunk size per round for each team member (Set to 1 for 1-by-1 Round-Robin alternating dispatch)
        const CHUNK_SIZE = 1;
        let roundIndex = 1;

        console.log(`\n🚀 [Campaign ${campaignId}] Round-Robin 1-by-1 dispatch scheduler started (Chunk Size: ${CHUNK_SIZE})`);

        while (true) {
            const members = await TeamCampaignMember.find({
                campaignId,
                status: { $in: ['SENDING', 'APPROVED', 'READY'] }
            });

            if (members.length === 0) break;

            // Check if there are any remaining pending contacts across all members
            let pendingTotalInCampaign = 0;
            for (const m of members) {
                const pCount = await TeamCampaignContact.countDocuments({
                    campaignId,
                    assignedToEmail: m.memberEmail,
                    status: 'PENDING'
                });
                pendingTotalInCampaign += pCount;
            }

            if (pendingTotalInCampaign === 0) {
                console.log(`[Campaign ${campaignId}] All rounds completed! No pending contacts remaining.`);
                break;
            }

            console.log(`\n==========================================`);
            console.log(`[Campaign] Round ${roundIndex} started`);
            console.log(`==========================================`);

            let processedInThisRound = 0;

            for (let i = 0; i < members.length; i++) {
                const member = members[i];

                // Fetch up to CHUNK_SIZE pending contacts for THIS member (preserves original order)
                const chunkContacts = await TeamCampaignContact.find({
                    campaignId,
                    assignedToEmail: member.memberEmail,
                    status: 'PENDING'
                }).limit(CHUNK_SIZE);

                if (chunkContacts.length === 0) {
                    console.log(`[Campaign] ${member.memberName} (${member.memberEmail}): no pending contacts left in this round`);
                    continue;
                }

                const currentSent = member.sentCount || 0;
                const currentFailed = member.failedCount || 0;
                const startRange = currentSent + currentFailed + 1;
                const endRange = startRange + chunkContacts.length - 1;

                console.log(`[Campaign] Member ${i + 1} (${member.memberName}): sending messages ${startRange}–${endRange}`);

                // Check WhatsApp session for this member (3-tier lookup: Exact -> Case-Insensitive -> Active Session Fallback)
                const mEmail = (member.memberEmail || '').toLowerCase().trim();
                let userClientObj = userClients ? userClients[member.memberEmail] : null;
                if (!userClientObj && userClients) {
                    const matchedKey = Object.keys(userClients).find(k => k.toLowerCase().trim() === mEmail);
                    if (matchedKey) userClientObj = userClients[matchedKey];
                }
                if (!userClientObj && userClients) {
                    userClientObj = Object.values(userClients).find(uc => uc && uc.isWhatsAppAuthenticated) || null;
                }
                const isAuth = userClientObj && userClientObj.isWhatsAppAuthenticated;
                const whatsappClient = isAuth ? userClientObj.whatsappClient : null;

                let sentInChunk = 0;
                let failedInChunk = 0;

                for (const contact of chunkContacts) {
                    processedInThisRound++;
                    let cleanNum = String(contact.phoneNumber).replace(/\D/g, '');
                    if (cleanNum.length === 10) cleanNum = '91' + cleanNum;
                    const jid = `${cleanNum}@s.whatsapp.net`;

                    let isSuccess = false;
                    let failReason = '';

                    if (whatsappClient && whatsappClient.user) {
                        try {
                            if (campaign.media && campaign.media.data) {
                                const buffer = Buffer.from(campaign.media.data, 'base64');
                                let mime = campaign.media.mimetype ? campaign.media.mimetype.toLowerCase() : '';
                                if (mime.startsWith('image/')) {
                                    await whatsappClient.sendMessage(jid, { image: buffer, caption: campaign.messageTemplate || '' });
                                } else {
                                    await whatsappClient.sendMessage(jid, { document: buffer, mimetype: campaign.media.mimetype, fileName: campaign.media.filename || 'file', caption: campaign.messageTemplate || '' });
                                }
                            } else {
                                await whatsappClient.sendMessage(jid, { text: campaign.messageTemplate || 'Hello from Goye Team Campaign!' });
                            }
                            isSuccess = true;
                        } catch (err) {
                            console.error(`Error sending message to ${contact.phoneNumber}:`, err.message);
                            let reason = err.message || 'WhatsApp sending error';
                            if (reason.includes("reading 'id'") || reason.includes("undefined") || reason.includes("Cannot read properties")) {
                                reason = 'WhatsApp session disconnected during send';
                            }
                            failReason = reason;
                        }
                    } else {
                        failReason = 'Member WhatsApp session not connected or authenticated';
                    }

                    if (isSuccess) {
                        contact.status = 'SENT';
                        sentInChunk++;
                        // Goye credit rule: Deduct 1 credit per 2 successful messages from Leader only
                        const totalSuccessSoFar = (member.sentCount || 0) + sentInChunk;
                        if (totalSuccessSoFar % 2 === 0) {
                            try {
                                const UserModel = mongoose.models.User;
                                if (UserModel) {
                                    await UserModel.findOneAndUpdate(
                                        { email: campaign.leaderEmail },
                                        { $inc: { credits: -1 } }
                                    );
                                }
                            } catch (e) {}
                        }
                    } else {
                        contact.status = 'FAILED';
                        contact.failureReason = failReason;
                        failedInChunk++;
                    }

                    await contact.save();

                    // Update live counts for member
                    const updatedSent = (member.sentCount || 0) + (isSuccess ? 1 : 0);
                    const updatedFailed = (member.failedCount || 0) + (!isSuccess ? 1 : 0);
                    member.sentCount = updatedSent;
                    member.failedCount = updatedFailed;

                    const remainingForMember = await TeamCampaignContact.countDocuments({
                        campaignId,
                        assignedToEmail: member.memberEmail,
                        status: 'PENDING'
                    });

                    let currentMemberStatus = 'SENDING';
                    if (remainingForMember === 0) {
                        currentMemberStatus = updatedFailed > 0 ? 'FAILED' : 'COMPLETED';
                    }
                    member.status = currentMemberStatus;

                    await TeamCampaignMember.findByIdAndUpdate(member._id, {
                        sentCount: updatedSent,
                        failedCount: updatedFailed,
                        status: currentMemberStatus
                    });

                    // Emit live progress update via socket
                    if (emitToUserSockets) {
                        const progressPayload = {
                            memberEmail: member.memberEmail,
                            total: member.allocatedCount || (updatedSent + updatedFailed + remainingForMember),
                            sent: updatedSent,
                            failed: updatedFailed,
                            status: currentMemberStatus
                        };
                        emitToUserSockets(member.memberEmail, "team_progress_update", progressPayload);
                        emitToUserSockets(campaign.leaderEmail, "team_progress_update", progressPayload);
                    }

                    // Delay between individual messages (1.5 seconds)
                    await new Promise(r => setTimeout(r, 1500));
                }

                console.log(`[Campaign] Member ${i + 1} chunk completed`);

                // Delay between member chunks (1 second)
                await new Promise(r => setTimeout(r, 1000));
            }

            console.log(`[Campaign] Round ${roundIndex} completed\n`);
            roundIndex++;

            if (processedInThisRound === 0) {
                break; // Prevent infinite loop if no contacts processed
            }
        }

        // Final overall campaign status update
        const remainingContacts = await TeamCampaignContact.countDocuments({ campaignId, status: 'PENDING' });
        if (remainingContacts === 0) {
            const allMembers = await TeamCampaignMember.find({ campaignId });
            const hasFailed = allMembers.some(m => m.status === 'FAILED');
            await TeamCampaign.findByIdAndUpdate(campaignId, { status: hasFailed ? 'FAILED' : 'COMPLETED' });
        }
    } catch (err) {
        console.error('Error in runTeamDispatchEngine:', err);
    }
}

module.exports = router;
