const express = require('express');
const router = express.Router();
const SubscriptionRequest = require('../models/SubscriptionRequest');

// 1. Create a request
router.post('/', async (req, res) => {
    try {
        const { name, email, plan, message, amount, userEmail, upiId, screenshot } = req.body;
        const cleanEmail = String(email || userEmail || '').trim().toLowerCase();
        const cleanName = String(name || '').trim() || (cleanEmail ? cleanEmail.split('@')[0] : 'User');
        const cleanPlan = String(plan || '').trim() || 'One Day';

        if (!cleanEmail) {
            return res.status(400).json({ success: false, message: 'Email address is required.' });
        }

        const newRequest = new SubscriptionRequest({
            name: cleanName,
            email: cleanEmail,
            plan: cleanPlan,
            amount: amount || '',
            upiId: upiId || '',
            screenshot: screenshot || '',
            message: message || (upiId ? `Direct QR Payment via UPI (${upiId})` : (amount ? `Direct QR Payment (${amount})` : "Activation Request")),
            status: 'pending',
            createdAt: new Date()
        });

        await newRequest.save();
        return res.status(201).json({ success: true, message: 'Request submitted successfully!', request: newRequest });
    } catch (err) {
        console.error('Error creating subscription request:', err);
        return res.status(500).json({ success: false, message: 'Server error: failed to create request.' });
    }
});

// 2. Get all requests (newest first - optimized lightweight list)
router.get('/', async (req, res) => {
    try {
        const mongoose = require('mongoose');
        
        // Wait up to 5s if Mongoose is currently establishing connection
        if (mongoose.connection.readyState === 2) {
            for (let i = 0; i < 25; i++) {
                if (mongoose.connection.readyState === 1) break;
                await new Promise(r => setTimeout(r, 200));
            }
        }

        let requests = [];
        try {
            requests = await SubscriptionRequest.find({}, { screenshot: 0 }).sort({ createdAt: -1 }).lean();
        } catch (e) {
            console.error('Mongoose find error, trying native db:', e.message);
        }

        // Native db collection fallback if Mongoose query returned empty or failed
        if (!requests || requests.length === 0) {
            try {
                if (mongoose.connection.db) {
                    requests = await mongoose.connection.db.collection('subscriptionrequests')
                        .find({}, { projection: { screenshot: 0 } })
                        .sort({ createdAt: -1 })
                        .toArray();
                }
            } catch (errDb) {
                console.error('Native collection fetch error:', errDb.message);
            }
        }

        let screenshotIdSet = new Set();
        try {
            if (mongoose.connection.db) {
                const withShots = await mongoose.connection.db.collection('subscriptionrequests')
                    .find({ screenshot: { $exists: true, $ne: '' } }, { projection: { _id: 1 } })
                    .toArray();
                screenshotIdSet = new Set(withShots.map(d => String(d._id)));
            }
        } catch (e) {}

        // Lookup phone number for each user from users or freeusers
        const phoneMap = {};
        try {
            if (mongoose.connection.db && requests && requests.length > 0) {
                const emails = requests.map(r => String(r.email || '').trim().toLowerCase()).filter(Boolean);
                if (emails.length > 0) {
                    const uList = await mongoose.connection.db.collection('users')
                        .find({ email: { $in: emails } }, { projection: { email: 1, phone: 1 } })
                        .toArray();
                    uList.forEach(u => { if (u.email && u.phone) phoneMap[u.email.toLowerCase()] = u.phone; });

                    const fList = await mongoose.connection.db.collection('freeusers')
                        .find({ email: { $in: emails } }, { projection: { email: 1, phone: 1 } })
                        .toArray();
                    fList.forEach(f => { if (f.email && f.phone && !phoneMap[f.email.toLowerCase()]) phoneMap[f.email.toLowerCase()] = f.phone; });
                }
            }
        } catch (phErr) {
            console.error('Error attaching phone numbers:', phErr.message);
        }

        const mapped = (requests || []).map(r => {
            const cleanEmail = String(r.email || '').trim().toLowerCase();
            return {
                ...r,
                phone: r.phone || phoneMap[cleanEmail] || '',
                hasScreenshot: screenshotIdSet.has(String(r._id)) || !!r.hasScreenshot
            };
        });

        return res.json({ success: true, requests: mapped });
    } catch (err) {
        console.error('Error fetching subscription requests:', err);
        return res.json({ success: true, requests: [] });
    }
});

// 2.1 Get single screenshot by ID on-demand
router.get('/:id/screenshot', async (req, res) => {
    try {
        const mongoose = require('mongoose');
        let screenshot = null;
        try {
            const doc = await SubscriptionRequest.findById(req.params.id, { screenshot: 1 });
            if (doc && doc.screenshot) screenshot = doc.screenshot;
        } catch (e) {}

        if (!screenshot && mongoose.connection.db) {
            try {
                const { ObjectId } = require('mongodb');
                const doc = await mongoose.connection.db.collection('subscriptionrequests').findOne(
                    { _id: new ObjectId(req.params.id) },
                    { projection: { screenshot: 1 } }
                );
                if (doc && doc.screenshot) screenshot = doc.screenshot;
            } catch (e) {}
        }

        if (!screenshot) {
            return res.status(404).json({ success: false, message: 'Screenshot not found' });
        }
        return res.json({ success: true, screenshot });
    } catch (err) {
        console.error('Error fetching request screenshot:', err);
        return res.status(500).json({ success: false, message: 'Failed to fetch screenshot' });
    }
});

// 3. Update request status
router.put('/:id', async (req, res) => {
    try {
        const { status } = req.body;
        if (!['pending', 'approved', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status value.' });
        }

        const request = await SubscriptionRequest.findById(req.params.id);
        if (!request) {
            return res.status(404).json({ success: false, message: 'Request not found.' });
        }

        const oldStatus = request.status;
        request.status = status;
        await request.save();

        if (status === 'approved' && oldStatus !== 'approved') {
            const mongoose = require('mongoose');
            const User = mongoose.models.User || mongoose.model('User');
            let FreeUser = mongoose.models.FreeUser;
            if (!FreeUser) {
                try { FreeUser = mongoose.model('FreeUser'); } catch (e) {}
            }
            const Notification = require('../models/Notification');
            
            const lowerPlan = (request.plan || '').toLowerCase();
            let durationMs = 24 * 60 * 60 * 1000; // default 24h for 1 Day
            let durationText = "24 Hours";
            
            if (lowerPlan.includes('week')) {
                durationMs = 7 * 24 * 60 * 60 * 1000;
                durationText = "7 Days";
            } else if (lowerPlan.includes('15') || lowerPlan.includes('fifteen')) {
                durationMs = 15 * 24 * 60 * 60 * 1000;
                durationText = "15 Days";
            } else if (lowerPlan.includes('3 month') || lowerPlan.includes('three')) {
                durationMs = 90 * 24 * 60 * 60 * 1000;
                durationText = "3 Months";
            } else if (lowerPlan.includes('6 month') || lowerPlan.includes('six')) {
                durationMs = 180 * 24 * 60 * 60 * 1000;
                durationText = "6 Months";
            } else if (lowerPlan.includes('18 month') || lowerPlan.includes('eighteen')) {
                durationMs = 540 * 24 * 60 * 60 * 1000;
                durationText = "18 Months";
            } else if (lowerPlan.includes('year') || lowerPlan.includes('1 yr')) {
                durationMs = 365 * 24 * 60 * 60 * 1000;
                durationText = "1 Year";
            } else if (lowerPlan.includes('month')) {
                durationMs = 30 * 24 * 60 * 60 * 1000;
                durationText = "30 Days";
            }

            const cleanTargetEmail = String(request.email || '').trim().toLowerCase();
            const safeRegExp = cleanTargetEmail ? new RegExp(`^${cleanTargetEmail.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i') : null;

            const formatDate = (date) => {
                return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) + ', ' +
                       date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
            };

            const db = mongoose.connection.db;
            let existingUser = null;
            if (db && safeRegExp) {
                existingUser = await db.collection('users').findOne({ email: safeRegExp });
                if (!existingUser) {
                    existingUser = await db.collection('freeusers').findOne({ email: safeRegExp });
                }
            }

            // Check if user currently has an active plan that hasn't expired yet
            const nowTime = Date.now();
            const isCurrentlyActive = existingUser && 
                existingUser.subscriptionExpiresAt && 
                new Date(existingUser.subscriptionExpiresAt).getTime() > nowTime;

            let userUpdate = {};
            let notifMessage = "";
            let notifTitle = "🎉 Plan Activated!";
            const notifCreatedAt = new Date();

            if (isCurrentlyActive) {
                // If user already has an active subscription, queue the new plan like mobile recharge!
                // Start after existing upcoming plan or after current active plan expiry
                const baseTime = (existingUser.upcomingPlanExpiresAt && new Date(existingUser.upcomingPlanExpiresAt).getTime() > new Date(existingUser.subscriptionExpiresAt).getTime())
                    ? new Date(existingUser.upcomingPlanExpiresAt).getTime()
                    : new Date(existingUser.subscriptionExpiresAt).getTime();

                const upcomingStartsAt = new Date(baseTime);
                const upcomingExpiresAt = new Date(baseTime + durationMs);

                userUpdate = {
                    isSubscribed: true,
                    hasEverSubscribed: true,
                    credits: 99999,
                    upcomingPlan: request.plan,
                    upcomingPlanStartsAt: upcomingStartsAt,
                    upcomingPlanExpiresAt: upcomingExpiresAt
                };

                notifTitle = "⏳ Plan Queued!";
                notifMessage = `Your ${request.plan} has been approved and queued!\n` +
                    `It will automatically activate when your current plan ends on: ${formatDate(upcomingStartsAt)}\n` +
                    `Valid until: ${formatDate(upcomingExpiresAt)} (${durationText}).`;
            } else {
                // No active subscription: activate immediately
                const startedAt = new Date();
                const expiresAt = new Date(startedAt.getTime() + durationMs);

                userUpdate = {
                    isSubscribed: true,
                    hasEverSubscribed: true,
                    subscriptionPlan: request.plan,
                    subscriptionStartedAt: startedAt,
                    subscriptionExpiresAt: expiresAt,
                    upcomingPlan: "",
                    upcomingPlanStartsAt: null,
                    upcomingPlanExpiresAt: null,
                    credits: 99999
                };

                notifTitle = "🎉 Plan Activated!";
                notifMessage = `Your ${request.plan} has been approved and activated.\nStart: ${formatDate(startedAt)}\nExpires: ${formatDate(expiresAt)}\nValid for: ${durationText}.`;
            }

            // Update in Subscribed Users and Free Users collection directly in MongoDB
            if (db && safeRegExp) {
                await db.collection('users').updateMany({ email: safeRegExp }, { $set: userUpdate });
                const freeUserUpdate = { ...userUpdate };
                delete freeUserUpdate.credits; // Preserve free user's trial credits
                await db.collection('freeusers').updateMany({ email: safeRegExp }, { $set: freeUserUpdate });
            }
            if (safeRegExp) {
                try {
                    const UserMod = mongoose.models.User || mongoose.model('User');
                    await UserMod.updateMany({ email: safeRegExp }, { $set: userUpdate });
                } catch (e) {}
                try {
                    const FreeUserMod = mongoose.models.FreeUser || mongoose.model('FreeUser');
                    const freeUserUpdate = { ...userUpdate };
                    delete freeUserUpdate.credits; // Preserve free user's trial credits
                    await FreeUserMod.updateMany({ email: safeRegExp }, { $set: freeUserUpdate });
                } catch (e) {}
            }

            // Create or update persistent approval notification for this user
            try {
                const reqIdStr = String(request._id);

                await Notification.findOneAndUpdate(
                    { requestId: reqIdStr },
                    {
                        userEmail: cleanTargetEmail,
                        type: 'request_approved',
                        title: notifTitle,
                        requestId: reqIdStr,
                        message: notifMessage,
                        creditsEarned: 99999,
                        read: false,
                        createdAt: notifCreatedAt
                    },
                    { upsert: true, returnDocument: 'after' }
                );
            } catch (notifErr) {
                console.error('Error creating user approval notification:', notifErr);
            }
        }

        if (status === 'rejected' && oldStatus !== 'rejected') {
            const Notification = require('../models/Notification');
            const cleanTargetEmail = String(request.email || '').trim().toLowerCase();
            // Create persistent rejection notification for this specific user
            try {
                const reqIdStr = String(request._id);
                await Notification.findOneAndUpdate(
                    { requestId: reqIdStr, type: 'request_rejected' },
                    {
                        userEmail: cleanTargetEmail,
                        type: 'request_rejected',
                        title: '❌ Plan Request Rejected',
                        requestId: reqIdStr,
                        message: `⚠️ Your subscription request for the ${request.plan} plan was rejected by Admin. Please contact Admin or support team for more details.`,
                        creditsEarned: 0,
                        read: false,
                        createdAt: new Date()
                    },
                    { upsert: true, returnDocument: 'after' }
                );
            } catch (notifErr) {
                console.error('Error creating user rejection notification:', notifErr);
            }
        }

        return res.json({ success: true, request });
    } catch (err) {
        console.error('Error updating subscription request status:', err);
        return res.status(500).json({ success: false, message: 'Server error: failed to update request status.' });
    }
});

module.exports = router;
