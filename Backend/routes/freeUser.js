// routes/freeUser.js
//
// A completely separate Free User authentication flow.
//
// This does NOT touch the existing `User` model, `/api/register`,
// `/api/login`, or any existing credit logic in Server.js. It lives in its
// own MongoDB collection ("freeusers") with its own bcrypt hashing and its
// own JWT-based auth, exactly as requested.
//
// Mounted in Server.js with:
//   app.use('/api', require('./routes/freeUser'));
// (same pattern already used for teamCampaign / scrapeLeads)

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const router = express.Router();

// Falls back to the shared JWT_SECRET if you already have one in .env for
// something else, then to a dev-only default so nothing crashes on first
// run — but you should set FREE_USER_JWT_SECRET (or JWT_SECRET) in .env
// before deploying.
const JWT_SECRET = process.env.FREE_USER_JWT_SECRET || process.env.JWT_SECRET || 'dev-only-fallback-secret-change-me';
const TOKEN_EXPIRY = '7d';

// ---------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------
const freeUserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    businessName: { type: String, trim: true, default: '' },
    businessType: { type: String, trim: true, default: '' },
    phone: { type: String, required: true, trim: true },
    location: { type: String, required: true, trim: true },
    role: { type: String, default: 'free_user' },
    status: { type: String, default: 'active' }, // 'active' | 'suspended'
    credits: { type: Number, default: 30 },
    freeCredits: { type: Number, default: 30 },
    totalSent: { type: Number, default: 0 },
    lastDailyRewardDate: { type: String, default: '' },
    hasEverSubscribed: { type: Boolean, default: false },
  },
  { timestamps: true } // adds createdAt / updatedAt automatically
);

// Same "avoid OverwriteModelError" guard already used for the existing
// User/MessageLog/Support models in Server.js.
const FreeUser = mongoose.models.FreeUser || mongoose.model('FreeUser', freeUserSchema);

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

// Strips passwordHash (and anything password-shaped) before anything is
// ever sent to the frontend.
function publicFreeUser(doc) {
  return {
    id: doc._id,
    name: doc.name,
    email: doc.email,
    businessName: doc.businessName || '',
    businessType: doc.businessType || '',
    phone: doc.phone,
    location: doc.location,
    role: doc.role,
    status: doc.status,
    credits: doc.credits !== undefined ? doc.credits : 30,
    totalSent: doc.totalSent !== undefined ? doc.totalSent : 0,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function signToken(freeUser) {
  return jwt.sign(
    { id: freeUser._id.toString(), email: freeUser.email, role: 'free_user' },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

// Auth middleware for protected Free User routes. Exported so future
// Free User route files (credits, connection, messaging — next phases)
// can reuse the exact same check instead of duplicating it.
function requireFreeUserAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ message: 'Not authenticated.' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'free_user') {
      return res.status(403).json({ message: 'Not authorized.' });
    }
    req.freeUserId = payload.id;
    req.freeUserEmail = payload.email;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired session. Please log in again.' });
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------
// POST /api/free-user/register
// ---------------------------------------------------------------------
router.post('/free-user/register', async (req, res) => {
  try {
    const { name, email, password, businessName, businessType, phone, location } = req.body || {};

    const missing = [];
    if (!name) missing.push('name');
    if (!email) missing.push('email');
    if (!password) missing.push('password');
    if (!phone) missing.push('phone');
    if (!location) missing.push('location');
    if (missing.length > 0) {
      return res.status(400).json({ message: `Missing required field(s): ${missing.join(', ')}` });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    if (!EMAIL_RE.test(normalizedEmail)) {
      return res.status(400).json({ message: 'Please enter a valid email address.' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    const existing = await FreeUser.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const d = new Date();
    const offset = d.getTimezoneOffset() * 60000;
    const today = new Date(d.getTime() - offset).toISOString().split('T')[0];

    const freeUser = new FreeUser({
      name: String(name).trim(),
      email: normalizedEmail,
      passwordHash,
      businessName: String(businessName || '').trim(),
      businessType: String(businessType || '').trim(),
      phone: String(phone).trim(),
      location: String(location).trim(),
      credits: 30,
      freeCredits: 30,
      totalSent: 0,
      lastDailyRewardDate: today,
    });

    await freeUser.save();

    return res.status(201).json({
      message: 'Registration successful! You can now log in.',
      user: publicFreeUser(freeUser),
    });
  } catch (error) {
    // Duplicate-key race: two concurrent registrations with the same email.
    if (error && error.code === 11000) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }
    console.error('❌ Free User register error:', error);
    return res.status(500).json({ message: 'Error registering user.', error: error.message });
  }
});

// ---------------------------------------------------------------------
// POST /api/free-user/login
// ---------------------------------------------------------------------
router.post('/free-user/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const safeEmailRegex = new RegExp(`^${normalizedEmail.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i');

    let freeUser = await FreeUser.findOne({ email: safeEmailRegex });
    const User = mongoose.models.User;
    let subUser = null;
    if (User) {
      try {
        subUser = await User.findOne({ email: safeEmailRegex });
      } catch (err) {
        console.warn('⚠️ User collection lookup warning:', err.message);
      }
    }

    // 1. If not found in FreeUser collection, check if they exist in Subscribed User collection!
    if (!freeUser) {
      if (!subUser) {
        return res.status(401).json({ message: 'Invalid email or password.' });
      }

      // Check password against Subscribed user's credentials
      const inputPass = String(password).trim();
      const storedPass = subUser.password || subUser.passwordHash || '';
      let isMatch = (storedPass === inputPass);
      if (!isMatch && storedPass) {
        try {
          isMatch = await bcrypt.compare(inputPass, storedPass);
        } catch (_) {}
      }

      if (!isMatch) {
        return res.status(401).json({ message: 'Invalid email or password.' });
      }

      // First-time user logging into Free Portal gets 30 welcome trial credits
      const assignedCredits = 30;

      const passwordHash = (storedPass.startsWith('$2b$') || storedPass.startsWith('$2a$'))
        ? storedPass
        : await bcrypt.hash(inputPass, 10);

      const d = new Date();
      const offset = d.getTimezoneOffset() * 60000;
      const today = new Date(d.getTime() - offset).toISOString().split('T')[0];

      // Auto-bridge and create FreeUser record so they can use Free Portal seamlessly
      freeUser = new FreeUser({
        name: subUser.name || 'User',
        email: normalizedEmail,
        passwordHash,
        businessName: subUser.businessName || '',
        businessType: subUser.businessType || '',
        phone: subUser.phone || '',
        location: subUser.location || '',
        credits: assignedCredits,
        freeCredits: assignedCredits,
        totalSent: subUser.totalSent || 0,
        lastDailyRewardDate: today,
        status: subUser.status === 'blocked' || subUser.status === 'suspended' ? 'suspended' : 'active',
      });

      await freeUser.save();
      console.log(`✅ Auto-bridged Subscribed user "${normalizedEmail}" to FreeUser collection (credits: ${assignedCredits}).`);
    } else {
      // 2. FreeUser already exists — verify password
      const inputPass = String(password).trim();
      let isMatch = false;
      if (freeUser.passwordHash) {
        try {
          isMatch = await bcrypt.compare(inputPass, freeUser.passwordHash);
        } catch (_) {}
        if (!isMatch && freeUser.passwordHash === inputPass) {
          isMatch = true;
        }
      }

      // Fallback: in case user updated password on Subscribed portal
      if (!isMatch && subUser) {
        const storedPass = subUser.password || subUser.passwordHash || '';
        let isSubMatch = (storedPass === inputPass);
        if (!isSubMatch && storedPass) {
          try {
            isSubMatch = await bcrypt.compare(inputPass, storedPass);
          } catch (_) {}
        }
        if (isSubMatch) {
          isMatch = true;
          // Sync updated password hash into freeUser record
          try {
            freeUser.passwordHash = await bcrypt.hash(inputPass, 10);
            await freeUser.save();
          } catch (_) {}
        }
      }

      if (!isMatch) {
        return res.status(401).json({ message: 'Invalid email or password.' });
      }
    }

    if (freeUser.status !== 'active') {
      return res.status(403).json({ message: 'This account is not active. Please contact support.' });
    }

    // STRICT GATEKEEPER:
    // Once a user has subscribed to ANY plan (current or expired), they are a Subscribed User!
    // They are strictly barred from using the Free User portal.
    const hasSubHistory = !!(
      (subUser && (subUser.hasEverSubscribed || subUser.subscriptionPlan || subUser.subscriptionStartedAt || subUser.isSubscribed)) ||
      (freeUser && (freeUser.hasEverSubscribed || freeUser.subscriptionPlan || freeUser.subscriptionStartedAt || freeUser.isSubscribed))
    );

    if (hasSubHistory) {
      const detectedName = (subUser && subUser.name) || (freeUser && freeUser.name) || '';
      return res.status(403).json({
        isUpgradedUser: true,
        name: detectedName,
        username: detectedName,
        message: 'You have upgraded to a Premium Subscribed account! Free User portal is only for new trial users. Please log in through the Subscribed Portal.',
        redirectUrl: '/userlogin'
      });
    }

    // Daily Credit & Expired Subscription Refill Guard:
    // If user's subscription in subUser or freeUser is expired (or non-existent),
    // ensure they receive their daily 10 credits and never stay at 0 on login.
    const d = new Date();
    const offset = d.getTimezoneOffset() * 60000;
    const today = new Date(d.getTime() - offset).toISOString().split('T')[0];

    const isSubActive = !!(
      (freeUser.subscriptionExpiresAt && new Date(freeUser.subscriptionExpiresAt).getTime() > Date.now()) ||
      (subUser && subUser.subscriptionExpiresAt && new Date(subUser.subscriptionExpiresAt).getTime() > Date.now())
    );

    if (!isSubActive) {
      let needsSave = false;
      // If midnight has passed (new day) OR credits is 0 on login:
      if (freeUser.lastDailyRewardDate !== today || !freeUser.credits || freeUser.credits <= 0) {
        freeUser.credits = 10;
        freeUser.freeCredits = 10;
        freeUser.isSubscribed = false;
        freeUser.lastDailyRewardDate = today;
        needsSave = true;
      }
      if (needsSave) {
        await freeUser.save();
        console.log(`✅ Daily 10 credits refilled for FreeUser "${normalizedEmail}" on login.`);
      }
    }

    const token = signToken(freeUser);

    return res.status(200).json({
      message: 'Login successful!',
      token,
      user: publicFreeUser(freeUser),
    });
  } catch (error) {
    console.error('❌ Free User login error:', error);
    return res.status(500).json({ message: 'Error logging in.', error: error.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/free-user/me   (protected — requires "Authorization: Bearer <token>")
// ---------------------------------------------------------------------
router.get('/free-user/me', requireFreeUserAuth, async (req, res) => {
  try {
    const freeUser = await FreeUser.findById(req.freeUserId);
    if (!freeUser) {
      return res.status(404).json({ message: 'Account not found.' });
    }
    return res.status(200).json({ user: publicFreeUser(freeUser) });
  } catch (error) {
    console.error('❌ Free User /me error:', error);
    return res.status(500).json({ message: 'Error fetching profile.', error: error.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/admin/free-users   (Admin — "Free User Details" page)
// ---------------------------------------------------------------------
// Mirrors the existing GET /api/users exactly: '-passwordHash' strips the
// hash the same way '-password' strips the existing User model's password,
// sorted newest-first, .lean() for speed. Note: like /api/users and every
// other /api/admin/* route in the current backend, this has no backend-side
// admin auth check yet — access control is currently frontend-only
// (AdminSidebar/route gating). Flagging this because it's a real gap, not
// something new introduced here; happy to add a proper admin auth
// middleware once I see how AdminLogin/AdminSidebar currently work.
router.get('/admin/free-users', async (req, res) => {
  try {
    const freeUsers = await FreeUser.find({}).sort({ createdAt: -1 }).lean();
    return res.status(200).json(freeUsers);
  } catch (error) {
    console.error('❌ Admin free-users list error:', error);
    return res.status(500).json({ message: 'Error fetching free users.', error: error.message });
  }
});

module.exports = router;
// Exported so future credit/connection/messaging/admin routes can import
// the same model + auth middleware instead of redefining them.
module.exports.FreeUser = FreeUser;
module.exports.requireFreeUserAuth = requireFreeUserAuth;