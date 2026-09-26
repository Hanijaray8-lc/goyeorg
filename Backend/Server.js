const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http'); 
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io'); // Socket.io
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser, isJidGroup, isJidStatusBroadcast, isJidNewsletter } = require('@whiskeysockets/baileys');
const pino = require('pino');
const XLSX = require('xlsx'); 
require('dotenv').config();
const crypto = require('crypto');

const { scrapeGoogleMapsLeads } = require('./scraper');
const NodeCache = require('node-cache');
const msgRetryCounterCache = new NodeCache();
const subscriptionRequestRoutes = require('./routes/subscriptionRequestRoutes');
const AiConfig = require('./models/AiConfig');
const { generateGoyeeAiReply } = require('./aiService');
const processedAiMessageIds = new Set();

const app = express();
const server = http.createServer(app);

// Socket.io CORS setup
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true, methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e8 // 100 MB limit for videos
});

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

app.use('/api/subscription-requests', subscriptionRequestRoutes);

const socialExtractorRoutes = require('./routes/socialExtractor');
app.use('/api/social-extractor', socialExtractorRoutes);

// Web Scraper API Endpoint
app.post("/api/scrape-leads", async (req, res) => {
  try {
    const { query, location } = req.body;
    if (!query) {
      return res.status(400).json({ success: false, message: "Query string is required" });
    }

    console.log(`🌐 API request received for query: "${query}" in "${location || 'Any'}"`);
    const leads = await scrapeGoogleMapsLeads(query, location || "");
    return res.json({ success: true, count: leads.length, leads });
  } catch (err) {
    console.error("Scraper API Route Error:", err);
    return res.status(500).json({ success: false, message: "Failed to scrape leads" });
  }
});

// MongoDB connection
mongoose.set('bufferCommands', false);
let isConnectingMongo = false;
const connectMongo = async () => {
  if (mongoose.connection.readyState === 1 || isConnectingMongo) return;
  isConnectingMongo = true;
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000,
    });
    console.log("Connected to MongoDB Atlas");
    if (typeof runDailyCreditResetSweep === 'function') {
      runDailyCreditResetSweep();
    }
  } catch (err) {
    console.error("MongoDB connection error:", err.message);
    setTimeout(connectMongo, 5000);
  } finally {
    isConnectingMongo = false;
  }
};
connectMongo();

mongoose.connection.on('disconnected', () => {
  if (mongoose.connection.readyState !== 1 && !isConnectingMongo) {
    setTimeout(connectMongo, 5000);
  }
});

// MessageHistory Schema (7 days TTL retention)
const messageHistorySchema = new mongoose.Schema({
  email: { type: String, required: true },
  phone: { type: String, required: true },
  message: { type: String },
  status: { type: String, default: "Sent" },
  deviceName: { type: String, default: "Goye Web" },
  sentAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now, expires: 604800 }
});

const MessageHistory = mongoose.models.MessageHistory || mongoose.model('MessageHistory', messageHistorySchema);

// --- WhatsApp Logic Setup (User-Specific) ---
const userClients = {}; // key: email, value: { whatsappClient, latestQR, isWhatsAppAuthenticated }
const socketToEmail = {}; // key: socket.id, value: email
const emailToSockets = {}; // key: email, value: array of socket.id

app.set('userClients', userClients);
app.set('emitToUserSockets', emitToUserSockets);

function emitToUserSockets(email, event, data) {
    const socketIds = emailToSockets[email];
    if (socketIds) {
        socketIds.forEach(id => {
            io.to(id).emit(event, data);
        });
    }
}

// Fetches groups on the already-connected session and PUSHES them to the
// frontend automatically (socket.io "groups_list" / "groups_error")
async function fetchAndBroadcastGroups(email, userClient, { forceRefresh = false } = {}) {
    if (!userClient || !userClient.isWhatsAppAuthenticated || !userClient.whatsappClient) return;
    console.log(`🔎 Fetching WhatsApp groups for ${email}...`);
    try {
        const groupsObj = await getGroupsForUser(userClient, { forceRefresh });
        const groupsList = Object.entries(groupsObj || {}).map(([groupId, g]) => ({
            id: g.id || groupId,
            name: g.subject || "Unnamed group",
            memberCount: Array.isArray(g.participants) ? g.participants.length : 0,
            owner: g.owner || null,
            creation: g.creation || null,
        }));
        console.log(`📋 Groups found for ${email}: ${groupsList.length}`);
        emitToUserSockets(email, "groups_list", { success: true, groups: groupsList });
    } catch (err) {
        console.error(`❌ Error auto-fetching groups for ${email}:`, err);
        emitToUserSockets(email, "groups_error", { success: false, message: `Unable to fetch WhatsApp groups. ${err.message || ""}`.trim() });
    }
}

async function fetchAndBroadcastContacts(email, userClient) {
    if (!userClient || !userClient.isWhatsAppAuthenticated || !userClient.whatsappClient) return;
    console.log(`🔎 Fetching WhatsApp individual contacts for ${email}...`);
    try {
        try {
            await getGroupsForUser(userClient, { forceRefresh: false });
        } catch (err) {
            console.warn(`[auto-contacts] Could not pre-fetch groups:`, err.message);
        }
        
        const contactsList = await getContactsForUser(userClient);
        console.log(`📋 Contacts found for ${email}: ${contactsList.length}`);
        emitToUserSockets(email, "contacts_list", { success: true, contacts: contactsList });
    } catch (err) {
        console.error(`❌ Error auto-fetching contacts for ${email}:`, err);
        emitToUserSockets(email, "contacts_error", { success: false, message: `Unable to fetch WhatsApp contacts. ${err.message || ""}`.trim() });
    }
}

// --- Group Management helpers ---
function normalizePhoneNumber(jid) {
    if (!jid || typeof jid !== 'string') return null;
    if (jid.endsWith('@lid')) return null;
    const idPart = jid.split('@')[0];
    const digits = idPart.replace(/\D/g, '');
    return digits.length > 0 ? digits : null;
}

function resolveParticipantNumber(p) {
    if (!p || !p.id || typeof p.id !== 'string') return { number: null, isHidden: false };
    if (!p.id.endsWith('@lid')) {
        return { number: normalizePhoneNumber(p.id), isHidden: false };
    }
    const altJid = p.phoneNumber || p.jid || p.pn || null;
    if (altJid) {
        const digits = String(altJid).split('@')[0].replace(/\D/g, '');
        if (digits) return { number: digits, isHidden: false };
    }
    return { number: null, isHidden: true };
}

function sanitizeFilenamePart(name) {
    return String(name || "Group")
        .replace(/[\\/:*?"<>|]/g, "")
        .replace(/[\u{1F000}-\u{1FFFF}\u{2190}-\u{2BFF}\u{2600}-\u{27BF}\uFE0F]/gu, "")
        .trim()
        .replace(/\s+/g, "_")
        .slice(0, 60) || "Group";
}

function getIncomingMessageText(msg) {
    if (!msg) return "";
    let m = msg;
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
    if (m.deviceSentMessage?.message) m = m.deviceSentMessage.message;
    if (m.editedMessage?.message?.protocolMessage?.editedMessage) m = m.editedMessage.message.protocolMessage.editedMessage;
    if (m.editedMessage?.message) m = m.editedMessage.message;
    if (m.templateMessage?.hydratedTemplate) m = m.templateMessage.hydratedTemplate;
    if (m.templateMessage?.hydratedFourRowTemplate) m = m.templateMessage.hydratedFourRowTemplate;
    if (m.interactiveMessage?.body?.text) return m.interactiveMessage.body.text.trim();
    if (m.interactiveResponseMessage?.body?.text) return m.interactiveResponseMessage.body.text.trim();

    const text = m.conversation || 
                 m.extendedTextMessage?.text || 
                 m.imageMessage?.caption || 
                 m.videoMessage?.caption || 
                 m.documentMessage?.caption || 
                 m.buttonsResponseMessage?.selectedButtonId ||
                 m.buttonsResponseMessage?.selectedDisplayText ||
                 m.templateButtonReplyMessage?.selectedId ||
                 m.templateButtonReplyMessage?.selectedDisplayText ||
                 m.listResponseMessage?.singleSelectReply?.selectedRowId ||
                 m.listResponseMessage?.title ||
                 m.listResponseMessage?.description ||
                 m.displayText ||
                 "";

    return (typeof text === 'string') ? text.trim() : "";
}

function buildContentDisposition(filename) {
    const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_");
    return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
        ),
    ]);
}

async function fetchGroupsWithRetry(client, { attempts = 2, delayMs = 1000, timeoutMs = 8000 } = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            if (typeof client.groupFetchAllParticipating !== 'function') {
                throw new Error("This WhatsApp library version doesn't support groupFetchAllParticipating(). Please update @whiskeysockets/baileys.");
            }
            const result = await withTimeout(client.groupFetchAllParticipating(), timeoutMs, "groupFetchAllParticipating");
            return result || {};
        } catch (err) {
            lastErr = err;
            console.warn(`⚠️ groupFetchAllParticipating attempt ${i + 1}/${attempts} failed: ${err.message}`);
            if (i < attempts - 1) {
                await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
            }
        }
    }
    throw lastErr;
}

async function getGroupsForUser(userClient, { forceRefresh = false } = {}) {
    const cacheAge = Date.now() - (userClient.groupsCacheAt || 0);
    if (!forceRefresh && userClient.groupsCache && cacheAge < 5 * 60 * 1000) {
        return userClient.groupsCache;
    }
    if (userClient.groupsFetchInFlight) {
        return userClient.groupsFetchInFlight;
    }
    userClient.groupsFetchInFlight = (async () => {
        try {
            const groupsObj = await fetchGroupsWithRetry(userClient.whatsappClient);
            userClient.groupsCache = groupsObj || {};
            userClient.groupsCacheAt = Date.now();
            return userClient.groupsCache;
        } finally {
            userClient.groupsFetchInFlight = null;
        }
    })();
    return userClient.groupsFetchInFlight;
}

async function getContactsForUser(userClient) {
    if (!userClient) return [];
    if (!userClient.contactsMap) userClient.contactsMap = {};
    
    try {
        await getGroupsForUser(userClient);
    } catch (e) {
        console.error("Failed to fetch groups while extracting contacts", e);
    }
    
    // Auto-extract contacts from fetched groups to ensure a comprehensive list
    let extractedCount = 0;
    if (userClient.groupsCache) {
        Object.values(userClient.groupsCache).forEach(group => {
            if (Array.isArray(group.participants)) {
                group.participants.forEach(p => {
                    if (p && p.id) {
                        const jid = p.id.endsWith('@lid') ? (p.phoneNumber ? `${p.phoneNumber}@s.whatsapp.net` : p.id) : p.id;
                        if (jid.endsWith('@s.whatsapp.net') && !userClient.contactsMap[jid]) {
                            const rawNumber = jid.split('@')[0].replace(/\D/g, '');
                            if (rawNumber && rawNumber.length >= 7 && rawNumber.length <= 15) {
                                userClient.contactsMap[jid] = {
                                    id: jid,
                                    name: `+${rawNumber}`,
                                    notify: '',
                                    number: rawNumber,
                                    isBusiness: false,
                                    isSavedContact: false
                                };
                                extractedCount++;
                            }
                        }
                    }
                });
            }
        });
    }
    console.log(`[getContactsForUser] Extracted ${extractedCount} contacts from groups.`);

    const contactsMap = userClient.contactsMap;
    const contactNames = userClient.contactNames || {};

    const list = Object.values(contactsMap).map(c => {
        const rawNum = c.number || (c.id ? c.id.split('@')[0].replace(/\D/g, '') : "");
        const displayName = (c.name && c.name !== "Unknown Contact" && !c.name.startsWith("+"))
            ? c.name
            : (contactNames[c.id] || c.notify || `+${rawNum}`);
        return {
            id: c.id,
            name: displayName,
            notify: c.notify || "",
            number: rawNum,
            isBusiness: !!c.isBusiness,
            isSavedContact: !!(c.name && c.name !== "Unknown Contact" && !c.name.startsWith("+"))
        };
    });

    // Filter strictly valid WhatsApp individual phone numbers (7 to 15 digits, no group/broadcast/lid)
    const filtered = list.filter(c => 
        c.number && 
        c.number.length >= 7 && 
        c.number.length <= 15 && 
        !c.id.includes('@g.us') && 
        !c.id.includes('@broadcast') &&
        !c.id.includes('status')
    );

    // Sort: Saved contacts first, then alphabetically
    return filtered.sort((a, b) => {
        if (a.isSavedContact && !b.isSavedContact) return -1;
        if (!a.isSavedContact && b.isSavedContact) return 1;
        return (a.name || "").localeCompare(b.name || "");
    });
}

function saveContactsToDisk(email, folderName) {
    try {
        if (!userClients[email] || !userClients[email].contactsMap) return;
        const filePath = path.join(__dirname, folderName, "contacts.json");
        fs.writeFileSync(filePath, JSON.stringify(userClients[email].contactsMap, null, 2), "utf8");
    } catch (_) {}
}

function loadContactsFromDisk(email, folderName) {
    try {
        const filePath = path.join(__dirname, folderName, "contacts.json");
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, "utf8");
            const data = JSON.parse(raw);
            if (data && typeof data === "object") {
                if (!userClients[email]) userClients[email] = {};
                userClients[email].contactsMap = data;
                if (!userClients[email].contactNames) userClients[email].contactNames = {};
                for (const [id, c] of Object.entries(data)) {
                    if (c && c.name) userClients[email].contactNames[id] = c.name;
                }
            }
        }
    } catch (_) {}
}

async function startWhatsAppForUser(email) {
    if (!email) return;
    
    if (userClients[email]) {
        return userClients[email];
    }

    userClients[email] = {
        whatsappClient: null,
        latestQR: "",
        isWhatsAppAuthenticated: false,
        loading: true,
        contactNames: {},
        contactsMap: {},
        messageStore: {}
    };

    try {
        const folderName = `auth_info_${email.replace(/[^a-zA-Z0-9]/g, '_')}`;
        loadContactsFromDisk(email, folderName);

        const { state, saveCreds } = await useMultiFileAuthState(folderName);
        const { version } = await fetchLatestBaileysVersion();

        const messageStore = userClients[email].messageStore || {};
        userClients[email].messageStore = messageStore;

        const client = makeWASocket({
            version,
            auth: state,
            msgRetryCounterCache,
            printQRInTerminal: false,
            logger: pino({ level: "error" }),
            browser: ["Goye", "Chrome", "1.0.0"],
            syncFullHistory: true,
            markOnlineOnConnect: true,
            retryRequestDelayMs: 250,
            maxMsgRetryCount: 5,
            getMessage: async (key) => {
                if (key && key.id) {
                    const store = userClients[email]?.messageStore || messageStore;
                    if (store && store[key.id]) {
                        return store[key.id];
                    }
                }
                return { conversation: "" };
            }
        });

        userClients[email].whatsappClient = client;
        userClients[email].loading = false;

        client.ev.on('creds.update', saveCreds);

        const cacheContacts = (list) => {
            if (!userClients[email] || !Array.isArray(list)) return;
            if (!userClients[email].contactsMap) userClients[email].contactsMap = {};
            if (!userClients[email].contactNames) userClients[email].contactNames = {};
            let changed = false;

            for (const c of list) {
                if (!c || !c.id) continue;
                const id = c.id;
                if (id === 'status@broadcast' || id.endsWith('@broadcast') || id.endsWith('@g.us')) continue;

                // If @lid, only accept if valid phoneNumber/jid provided
                if (id.endsWith('@lid') && !c.phoneNumber && !c.jid) continue;

                const effectiveId = (id.endsWith('@lid') && (c.phoneNumber || c.jid))
                    ? (String(c.phoneNumber || c.jid).includes('@') ? String(c.phoneNumber || c.jid) : `${String(c.phoneNumber || c.jid).replace(/\D/g, '')}@s.whatsapp.net`)
                    : id;

                if (!effectiveId.endsWith('@s.whatsapp.net')) continue;

                const rawNumber = effectiveId.split('@')[0].replace(/\D/g, '');
                if (!rawNumber || rawNumber.length < 7 || rawNumber.length > 15) continue;

                const name = c.name || c.pushName || c.notify || c.verifiedName || '';
                if (name) {
                    userClients[email].contactNames[effectiveId] = name;
                }

                const existing = userClients[email].contactsMap[effectiveId] || {};
                const bestName = c.name || c.pushName || existing.name || c.notify || existing.notify || c.verifiedName || `+${rawNumber}`;

                userClients[email].contactsMap[effectiveId] = {
                    id: effectiveId,
                    name: bestName,
                    notify: c.notify || existing.notify || '',
                    number: rawNumber,
                    isBusiness: !!(c.verifiedName || existing.isBusiness),
                    isSavedContact: !!(c.name || (existing.name && existing.name !== `+${rawNumber}`))
                };
                changed = true;
            }

            if (changed) {
                saveContactsToDisk(email, folderName);
            }
        };

        const cacheChats = (chats) => {
            if (!userClients[email] || !Array.isArray(chats)) return;
            if (!userClients[email].contactsMap) userClients[email].contactsMap = {};
            let changed = false;

            for (const chat of chats) {
                if (!chat || !chat.id) continue;
                const id = chat.id;
                if (!id.endsWith('@s.whatsapp.net')) continue;

                const rawNumber = id.split('@')[0].replace(/\D/g, '');
                if (!rawNumber || rawNumber.length < 7 || rawNumber.length > 15) continue;

                const name = chat.name || chat.pushName || chat.notify || userClients[email].contactNames?.[id] || '';
                const existing = userClients[email].contactsMap[id] || {};

                userClients[email].contactsMap[id] = {
                    id,
                    name: name || existing.name || `+${rawNumber}`,
                    notify: chat.notify || existing.notify || '',
                    number: rawNumber,
                    isBusiness: !!existing.isBusiness,
                    isSavedContact: !!(name || existing.isSavedContact)
                };
                changed = true;
            }

            if (changed) {
                saveContactsToDisk(email, folderName);
            }
        };

        client.ev.on('messaging-history.set', ({ contacts, chats, messages, isLatest }) => {
            console.log(`📥 [messaging-history.set] Received history sync for ${email}: ${contacts?.length || 0} contacts, ${chats?.length || 0} chats`);
            if (Array.isArray(contacts)) cacheContacts(contacts);
            if (Array.isArray(chats)) cacheChats(chats);
            if (Array.isArray(messages)) {
                for (const m of messages) {
                    if (m && m.key && m.key.remoteJid && m.key.remoteJid.endsWith('@s.whatsapp.net')) {
                        const jid = m.key.remoteJid;
                        const rawNumber = jid.split('@')[0].replace(/\D/g, '');
                        if (rawNumber && rawNumber.length >= 7 && rawNumber.length <= 15) {
                            if (!userClients[email].contactsMap[jid]) {
                                userClients[email].contactsMap[jid] = {
                                    id: jid,
                                    name: m.pushName || `+${rawNumber}`,
                                    notify: m.pushName || '',
                                    number: rawNumber,
                                    isBusiness: false,
                                    isSavedContact: !!m.pushName
                                };
                            }
                        }
                    }
                }
            }
            saveContactsToDisk(email, folderName);
            fetchAndBroadcastContacts(email, userClients[email]);
        });

        client.ev.on('contacts.upsert', cacheContacts);
        client.ev.on('contacts.update', cacheContacts);
        client.ev.on('contacts.set', (update) => {
            if (update && Array.isArray(update.contacts)) cacheContacts(update.contacts);
        });
        client.ev.on('chats.upsert', cacheChats);
        client.ev.on('chats.set', (update) => {
            if (update && Array.isArray(update.chats)) cacheChats(update.chats);
        });
        const handleIncomingAiMessage = async (m, source = 'upsert') => {
            if (!m || !m.key || !m.key.id) return;
            const msgId = m.key.id;

            // Store message payload in messageStore for E2EE retry fulfilment
            if (m.message && userClients[email]?.messageStore) {
                userClients[email].messageStore[msgId] = m.message;
            }

            // Prevent duplicate triggers or replying to messages already handled
            if (processedAiMessageIds.has(msgId)) return;

            const rawRemoteJid = m.key.remoteJid || '';
            if (!rawRemoteJid) return;

            // Ignore groups, status broadcasts, and WhatsApp channels/newsletters
            if (isJidGroup(rawRemoteJid) || isJidStatusBroadcast(rawRemoteJid) || isJidNewsletter(rawRemoteJid) || rawRemoteJid.endsWith('@broadcast') || rawRemoteJid.endsWith('@newsletter')) {
                return;
            }

            // Normalize JID (removes :device suffixes, e.g. 919524648478:25@s.whatsapp.net -> 919524648478@s.whatsapp.net)
            const targetJid = jidNormalizedUser(rawRemoteJid);
            const myJid = client?.user?.id ? jidNormalizedUser(client.user.id) : '';
            const myLid = client?.user?.lid ? jidNormalizedUser(client.user.lid) : '';
            const myNumber = myJid ? myJid.split('@')[0].replace(/\D/g, '') : '';

            // Cache contact if phone number or pushName is available
            let rawNumber = targetJid.split('@')[0].replace(/\D/g, '');
            if (targetJid.endsWith('@lid')) {
                if (m.key.participant) {
                    rawNumber = m.key.participant.split('@')[0].replace(/\D/g, '');
                } else if (userClients[email]?.contactsMap?.[targetJid]?.number) {
                    rawNumber = userClients[email].contactsMap[targetJid].number;
                }
            }
            if (rawNumber && rawNumber.length >= 7 && rawNumber.length <= 15 && m.pushName) {
                const existing = userClients[email].contactsMap?.[targetJid] || {};
                userClients[email].contactsMap[targetJid] = {
                    id: targetJid,
                    name: (existing.name && !existing.name.startsWith('+')) ? existing.name : (m.pushName || `+${rawNumber}`),
                    notify: m.pushName || existing.notify || '',
                    number: rawNumber,
                    isBusiness: !!existing.isBusiness,
                    isSavedContact: true
                };
            }

            const customerText = getIncomingMessageText(m.message);
            if (!customerText || !customerText.trim()) return;

            // Detect if this is the business owner testing from their own phone or chat
            const isSelfChat = targetJid === myJid || 
                               (myLid && targetJid === myLid) || 
                               (myNumber && (targetJid.includes(myNumber) || rawRemoteJid.includes(myNumber)));
            const isCommandPrefix = /^[!#]/i.test(customerText.trim());

            if (m.key.fromMe) {
                // If sent from the owner's account:
                // Only reply if it was sent to the owner's own number/self-chat (testing) OR prefixed with ! or #
                if (!isSelfChat && !isCommandPrefix) {
                    return; // Owner is chatting manually with someone else -> do not auto-reply
                }
                console.log(`🧪 [Goyee AI] Owner self-test message detected on ${targetJid}: "${customerText}"`);
            }

            // Mark message ID as processed immediately to prevent duplicate concurrent triggers
            processedAiMessageIds.add(msgId);
            if (processedAiMessageIds.size > 2000) {
                const first = processedAiMessageIds.values().next().value;
                processedAiMessageIds.delete(first);
            }

            const customerPhone = (rawNumber && rawNumber.length >= 7 && rawNumber.length <= 15) ? `+${rawNumber}` : targetJid;
            const customerName = m.pushName || userClients[email]?.contactNames?.[targetJid] || "Customer";

            console.log(`🤖 [Goyee AI] Incoming query via [${source}] from ${customerName} (${customerPhone}) [${rawRemoteJid}]: "${customerText}"`);

            try {
                const cleanEmail = String(email).trim().toLowerCase();
                const safeEmailRegex = new RegExp(`^${cleanEmail.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i');
                let aiConfig = await AiConfig.findOne({ email: safeEmailRegex, enabled: true });
                if (!aiConfig || !aiConfig.knowledgeBase || !aiConfig.knowledgeBase.trim()) {
                    aiConfig = await AiConfig.findOne({ email: safeEmailRegex });
                }
                if (!aiConfig || !aiConfig.enabled || !aiConfig.knowledgeBase || !aiConfig.knowledgeBase.trim()) {
                    aiConfig = await AiConfig.findOne({ enabled: true, knowledgeBase: { $exists: true, $ne: "" } }).sort({ updatedAt: -1 });
                }

                if (!aiConfig || !aiConfig.enabled || !aiConfig.knowledgeBase || !aiConfig.knowledgeBase.trim()) {
                    console.log(`⚠️ [Goyee AI] Auto-reply skipped for ${customerPhone}: AI disabled or empty Knowledge Base.`);
                    return;
                }

                const queryToAsk = customerText.replace(/^[!#]\s*/, '').trim() || customerText.trim();
                const aiReply = await generateGoyeeAiReply({
                    knowledgeBase: aiConfig.knowledgeBase,
                    customerPhone,
                    customerName,
                    customerMessage: queryToAsk,
                    apiKey: aiConfig.apiKey
                });

                if (aiReply && aiReply.trim()) {
                    let sentMsg;
                    // First try to reply using rawRemoteJid with quoted message
                    const dispatchJid = rawRemoteJid || targetJid;
                    try {
                        sentMsg = await client.sendMessage(dispatchJid, { text: aiReply.trim() }, { quoted: m });
                    } catch (qErr) {
                        console.warn(`⚠️ [Goyee AI] Quoted send to ${dispatchJid} failed, attempting direct send:`, qErr.message);
                        try {
                            sentMsg = await client.sendMessage(dispatchJid, { text: aiReply.trim() });
                        } catch (dErr) {
                            if (targetJid && targetJid !== dispatchJid) {
                                sentMsg = await client.sendMessage(targetJid, { text: aiReply.trim() });
                            } else {
                                throw dErr;
                            }
                        }
                    }

                    if (sentMsg && sentMsg.key && sentMsg.key.id) {
                        processedAiMessageIds.add(sentMsg.key.id);
                        if (userClients[email]?.messageStore && sentMsg.message) {
                            userClients[email].messageStore[sentMsg.key.id] = sentMsg.message;
                        }
                    }

                    console.log(`✅ [Goyee AI] Auto-replied to ${customerPhone} successfully!`);

                    try {
                        await MessageHistory.create({
                            email: email,
                            phone: rawNumber || targetJid,
                            message: `[AI Reply] ${aiReply.trim()}`,
                            status: "Sent",
                            deviceName: "Goyee AI Assistant",
                            sentAt: new Date()
                        });
                    } catch (hErr) {}

                    emitToUserSockets(email, "ai_reply_sent", {
                        phone: customerPhone,
                        name: customerName,
                        query: customerText,
                        reply: aiReply.trim(),
                        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    });
                }
            } catch (aiErr) {
                console.error(`❌ [Goyee AI] Auto-reply error for ${customerPhone}:`, aiErr.message);
            }
        };

        client.ev.on('messages.upsert', async ({ messages, type }) => {
            if (!userClients[email] || !Array.isArray(messages)) return;
            for (const m of messages) {
                await handleIncomingAiMessage(m, 'upsert');
            }
        });

        client.ev.on('messages.update', async (updates) => {
            if (!userClients[email] || !Array.isArray(updates)) return;
            for (const u of updates) {
                if (u && u.key && u.update && u.update.message) {
                    const synthMsg = { key: u.key, message: u.update.message, pushName: u.update.pushName };
                    await handleIncomingAiMessage(synthMsg, 'update');
                }
            }
        });

        client.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                if (userClients[email]) {
                    userClients[email].latestQR = qr;
                    emitToUserSockets(email, "qr", qr);
                }
            }

            if (connection === 'open') {
                console.log(`✅ WhatsApp Authenticated for ${email}!`);
                if (userClients[email]) {
                    userClients[email].latestQR = ""; 
                    userClients[email].isWhatsAppAuthenticated = true;
                    
                    const userInfo = client.user ? {
                        id: client.user.id ? client.user.id.split(':')[0] : '',
                        name: client.user.name || client.user.verifiedName || ''
                    } : null;
                    
                    emitToUserSockets(email, "ready", { message: "WhatsApp Authenticated Successfully!", user: userInfo });

                    setTimeout(() => {
                        fetchAndBroadcastGroups(email, userClients[email], { forceRefresh: true });
                        fetchAndBroadcastContacts(email, userClients[email]);
                    }, 1200);
                }
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log(`❌ WhatsApp connection closed for ${email}. Reconnecting:`, shouldReconnect);
                
                if (shouldReconnect) {
                    delete userClients[email];
                    startWhatsAppForUser(email);
                } else {
                    if (userClients[email]) {
                        userClients[email].latestQR = ""; 
                        userClients[email].isWhatsAppAuthenticated = false;
                        emitToUserSockets(email, "logout", "User logged out from phone");
                    }
                    const authPath = path.join(__dirname, folderName);
                    if (fs.existsSync(authPath)) {
                        try { fs.rmSync(authPath, { recursive: true, force: true }); } catch(e) {}
                    }
                    delete userClients[email];
                    startWhatsAppForUser(email);
                }
            }
        });
    } catch (err) {
        console.error(`Error starting WhatsApp for ${email}:`, err);
        delete userClients[email];
    }
}

// --- Socket Connection ---
io.on("connection", (socket) => {
    console.log("React UI Connected to Socket!");

    socket.on("register_email", async (email) => {
        if (!email) return;
        
        socketToEmail[socket.id] = email;
        if (!emailToSockets[email]) {
            emailToSockets[email] = [];
        }
        if (!emailToSockets[email].includes(socket.id)) {
            emailToSockets[email].push(socket.id);
        }

        console.log(`Socket ${socket.id} registered for email: ${email}`);
        await startWhatsAppForUser(email);

        const userClient = userClients[email];
        if (userClient) {
            if (userClient.isWhatsAppAuthenticated) {
                const client = userClient.whatsappClient;
                const userInfo = client && client.user ? {
                    id: client.user.id ? client.user.id.split(':')[0] : '',
                    name: client.user.name || client.user.verifiedName || ''
                } : null;
                socket.emit("ready", { message: "WhatsApp Authenticated Successfully!", user: userInfo });
                fetchAndBroadcastGroups(email, userClient, { forceRefresh: false });
                fetchAndBroadcastContacts(email, userClient);
            } else if (userClient.latestQR) {
                socket.emit("qr", userClient.latestQR);
            }
        }
    });

    socket.on("disconnect", () => {
        const email = socketToEmail[socket.id];
        if (email) {
            if (emailToSockets[email]) {
                emailToSockets[email] = emailToSockets[email].filter(id => id !== socket.id);
                if (emailToSockets[email].length === 0) {
                    delete emailToSockets[email];
                }
            }
            delete socketToEmail[socket.id];
        }
        console.log("Socket disconnected:", socket.id);
    });

    socket.on("check_status", () => {
        const email = socketToEmail[socket.id];
        if (!email) return;
        const userClient = userClients[email];
        if (userClient) {
            if (userClient.isWhatsAppAuthenticated) {
                const client = userClient.whatsappClient;
                const userInfo = client && client.user ? {
                    id: client.user.id ? client.user.id.split(':')[0] : '',
                    name: client.user.name || client.user.verifiedName || ''
                } : null;
                socket.emit("ready", { message: "WhatsApp Authenticated Successfully!", user: userInfo });
                fetchAndBroadcastGroups(email, userClient, { forceRefresh: false });
                fetchAndBroadcastContacts(email, userClient);
            } else if (userClient.latestQR) {
                socket.emit("qr", userClient.latestQR); 
            }
        }
    });

    let forceResetting = false;
    socket.on("request_new_qr", async () => {
        const email = socketToEmail[socket.id];
        if (!email) return;

        if (forceResetting) return;
        forceResetting = true;
        
        console.log(`♻️ Force restarting WhatsApp to generate new QR for ${email}...`);
        const userClient = userClients[email];
        if (userClient) {
            userClient.isWhatsAppAuthenticated = false;
            userClient.latestQR = "";
            if (userClient.whatsappClient) {
                userClient.whatsappClient.ev.removeAllListeners('connection.update');
                try { userClient.whatsappClient.end(new Error("Force reset")); } catch(e) {}
            }
        }
        
        setTimeout(() => {
            const folderName = `auth_info_${email.replace(/[^a-zA-Z0-9]/g, '_')}`;
            const authPath = path.join(__dirname, folderName);
            if (fs.existsSync(authPath)) {
                try { fs.rmSync(authPath, { recursive: true, force: true }); } catch(e) {}
            }
            delete userClients[email];
            startWhatsAppForUser(email);
            forceResetting = false;
        }, 2000);
    });

    socket.on("send_bulk_message", async (data, callback) => {
        let email = (data && data.email) || socketToEmail[socket.id];
        if (!email) {
            console.log(`❌ No email associated with socket: ${socket.id}`);
            if (typeof callback === "function") {
                callback({ success: false, error: "No user account found. Please reconnect WhatsApp." });
            }
            return;
        }
        socketToEmail[socket.id] = email;
        const userClient = userClients[email];
        
        if (!userClient || !userClient.isWhatsAppAuthenticated || !userClient.whatsappClient) {
            console.log(`❌ WhatsApp not authenticated for email: ${email}`);
            if (typeof callback === "function") {
                callback({ success: false, error: "WhatsApp is not connected! Please scan the QR code or reconnect your device." });
            }
            return;
        }

        const whatsappClient = userClient.whatsappClient;
        const { numbers, text, media, delay } = data;
        const userDelay = delay !== undefined ? Number(delay) : 3;
        const delayMs = Math.max(3000, Math.min(60000, (isNaN(userDelay) || userDelay <= 0 ? 3 : userDelay) * 1000));
        console.log(`📥 [Bulk Send] ${numbers ? numbers.length : 0} numbers for ${email} | Delay: ${delayMs / 1000}s`);

        let isSubscribed = false;
        let availableCredits = 0;
        if (email) {
            let u = await User.findOne({ email: String(email).trim().toLowerCase() });
            if (!u && mongoose.models.FreeUser) {
                u = await FreeUser.findOne({ email: String(email).trim().toLowerCase() });
            }
            if (u) {
                isSubscribed = !!(u.subscriptionExpiresAt && new Date(u.subscriptionExpiresAt).getTime() > Date.now());
                availableCredits = u.credits || 0;
            }
        }

        let numbersToSend = Array.isArray(numbers) ? numbers : [];
        if (!isSubscribed) {
            const maxAllowed = Math.max(0, availableCredits * 2);
            if (numbersToSend.length > maxAllowed) {
                numbersToSend = numbersToSend.slice(0, maxAllowed);
            }
        }

        if (numbersToSend.length === 0) {
            console.log(`⚠️ [Bulk Send] No numbers allowed to send for ${email} (availableCredits: ${availableCredits})`);
            if (typeof callback === "function") {
                callback({ success: false, error: availableCredits <= 0 ? "You have 0 credits. Please recharge or upgrade to send messages." : "No valid phone numbers found." });
            }
            return;
        }
        
        let validNumbersCount = 0;
        let successCount = 0;
        let failedCount = 0;
        
        socket.emit("bulk_progress_start", { total: numbersToSend.length });

        for (const num of numbersToSend) {
            if (num && String(num).trim() !== "") {
                validNumbersCount++;
                let cleanNum = String(num).replace(/\D/g, '');
                if (cleanNum.length === 10) {
                    cleanNum = '91' + cleanNum;
                }
                const formattedNumber = `${cleanNum}@s.whatsapp.net`;
                
                socket.emit("bulk_progress_update", { status: "sending", number: num });
                
                try {
                    let existsOnWA = true;
                    try {
                        const checkNumber = await whatsappClient.onWhatsApp(formattedNumber);
                        if (checkNumber && checkNumber.length > 0 && !checkNumber[0].exists) {
                            existsOnWA = false;
                        }
                    } catch (checkErr) {
                        console.warn(`[onWhatsApp] Warning for ${num}:`, checkErr.message);
                    }

                    if (!existsOnWA) {
                        console.error(`❌ Number ${num} is not registered on WhatsApp`);
                        socket.emit("bulk_progress_update", { status: "failed", number: num, reason: "Number is not registered on WhatsApp" });
                        failedCount++;
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                        continue;
                    }

                    // Pre-handshake Signal encryption session to eliminate "Waiting for this message"
                    try {
                        await whatsappClient.presenceSubscribe(formattedNumber);
                        await whatsappClient.sendPresenceUpdate('composing', formattedNumber);
                        await new Promise(resolve => setTimeout(resolve, 800));
                    } catch (pErr) {
                        console.warn(`[Handshake] Presence notice for ${num}:`, pErr.message);
                    }

                    const mediaItems = Array.isArray(media) ? media : (media && media.data ? [media] : []);
                    
                    if (mediaItems.length > 0) {
                        let isFirst = true;
                        for (const item of mediaItems) {
                            if (!item || !item.data) continue;
                            const buffer = Buffer.from(item.data, 'base64');
                            let mime = item.mimetype ? item.mimetype.toLowerCase() : '';
                            const name = item.filename ? item.filename.toLowerCase() : '';
                            
                            if (!mime || mime === 'application/octet-stream') {
                                const ext = name.split('.').pop();
                                const mimeMap = {
                                    'png': 'image/png',
                                    'jpg': 'image/jpeg',
                                    'jpeg': 'image/jpeg',
                                    'gif': 'image/gif',
                                    'webp': 'image/webp',
                                    'mp4': 'video/mp4',
                                    'mov': 'video/quicktime',
                                    'avi': 'video/x-msvideo',
                                    'pdf': 'application/pdf',
                                    'csv': 'text/csv',
                                    'xls': 'application/vnd.ms-excel',
                                    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                                    'doc': 'application/msword',
                                    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                                    'txt': 'text/plain'
                                };
                                mime = mimeMap[ext] || mime;
                            }

                            const isImage = mime.startsWith('image/') || name.match(/\.(jpg|jpeg|png|gif|webp)$/i);
                            const isVideo = mime.startsWith('video/') || name.match(/\.(mp4|mov|avi|webm|mkv)$/i);
                            
                            let mediaMessage = {};
                            const captionText = isFirst ? (text || '') : '';
                            if (isImage) {
                                mediaMessage = { image: buffer, caption: captionText, mimetype: mime || 'image/jpeg' };
                            } else if (isVideo) {
                                mediaMessage = { video: buffer, caption: captionText, mimetype: mime || 'video/mp4' };
                            } else {
                                mediaMessage = { 
                                    document: buffer, 
                                    caption: captionText, 
                                    mimetype: mime || 'application/pdf', 
                                    fileName: item.filename || 'document.pdf' 
                                };
                            }
                            const sentResult = await whatsappClient.sendMessage(formattedNumber, mediaMessage);
                            if (sentResult && sentResult.key && sentResult.key.id && userClient && userClient.messageStore) {
                                userClient.messageStore[sentResult.key.id] = sentResult.message;
                            }
                            isFirst = false;
                            if (mediaItems.length > 1) {
                                // 3.5s delay between consecutive media to ensure Signal protocol key ratchet sync completes across sender devices
                                await new Promise(resolve => setTimeout(resolve, 3500));
                            }
                        }
                    } else {
                        await whatsappClient.sendMessage(formattedNumber, { text: text || '' });
                    }
                    try { await whatsappClient.sendPresenceUpdate('paused', formattedNumber); } catch (e) {}
                    console.log(`✅ Message sent to ${num}`);
                    try {
                        await MessageHistory.create({
                            email: email || "user@goye.com",
                            phone: String(num).trim(),
                            message: text || (media && media.filename ? `[Media] ${media.filename}` : "WhatsApp Message"),
                            status: "Sent",
                            deviceName: "Goye Web",
                            sentAt: new Date()
                        });
                    } catch (histErr) {
                        console.error("MessageHistory save error:", histErr.message);
                    }
                    socket.emit("bulk_progress_update", { status: "sent", number: num });
                    successCount++;
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                } catch (error) {
                    console.error(`❌ Failed to send to ${num}`, error);
                    let reason = error.message || "Unable to send message. Please try again.";
                    if (reason.includes("reading 'id'") || reason.includes("undefined") || reason.includes("Cannot read properties")) {
                        reason = "Number is not registered on WhatsApp.";
                    }
                    try {
                        await MessageHistory.create({
                            email: email || "user@goye.com",
                            phone: String(num).trim(),
                            message: text || (media && media.filename ? `[Media] ${media.filename}` : "WhatsApp Message"),
                            status: "Failed",
                            deviceName: "Goye Web",
                            sentAt: new Date()
                        });
                    } catch (histErr) {
                        console.error("MessageHistory save error:", histErr.message);
                    }
                    socket.emit("bulk_progress_update", { status: "failed", number: num, reason: reason });
                    failedCount++;
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            } else {
                if (num) {
                    socket.emit("bulk_progress_update", { status: "failed", number: num, reason: "Invalid empty number" });
                    failedCount++;
                }
            }
        }

        if (validNumbersCount > 0 || failedCount > 0) {
            const d = new Date();
            const offset = d.getTimezoneOffset() * 60000;
            const today = new Date(d.getTime() - offset).toISOString().split('T')[0];
            
            await MessageLog.findOneAndUpdate(
                { date: today },
                { $inc: { count: validNumbersCount, successCount: successCount, failedCount: failedCount } },
                { upsert: true, returnDocument: 'after' }
            );
        }

        socket.emit("bulk_progress_completed", { success: true, sent: successCount, failed: failedCount, total: numbersToSend.length });

        if (typeof callback === "function") {
            callback({ success: true, sent: successCount, failed: failedCount, total: numbersToSend.length });
        }
    });

    socket.on("get_groups", async (data) => {
        const email = (data && data.email) || socketToEmail[socket.id];
        if (!email) {
            socket.emit("groups_error", { success: false, message: "No WhatsApp data found. Please log in again." });
            return;
        }

        const userClient = userClients[email];
        if (!userClient || !userClient.isWhatsAppAuthenticated || !userClient.whatsappClient) {
            socket.emit("groups_error", { success: false, message: "No WhatsApp data found. Please scan the QR code first." });
            return;
        }

        console.log(`🔎 [get_groups] Fetching WhatsApp groups for ${email}...`);
        try {
            const groupsObj = await getGroupsForUser(userClient, { forceRefresh: true });
            const groupsList = Object.entries(groupsObj || {}).map(([groupId, g]) => ({
                id: g.id || groupId,
                name: g.subject || "Unnamed group",
                memberCount: Array.isArray(g.participants) ? g.participants.length : 0,
                owner: g.owner || null,
                creation: g.creation || null,
            }));
            console.log(`📋 [get_groups] Groups found for ${email}: ${groupsList.length}`);
            socket.emit("groups_list", { success: true, groups: groupsList });
        } catch (err) {
            console.error(`❌ [get_groups] Error fetching groups for ${email}:`, err);
            socket.emit("groups_error", { success: false, message: `Unable to fetch WhatsApp groups. ${err.message || ""}`.trim() });
        }
    });

    socket.on("get_contacts", async (data) => {
        const email = (data && data.email) || socketToEmail[socket.id];
        if (!email) {
            socket.emit("contacts_error", { success: false, message: "No WhatsApp data found. Please log in again." });
            return;
        }

        const userClient = userClients[email];
        if (!userClient || !userClient.isWhatsAppAuthenticated || !userClient.whatsappClient) {
            socket.emit("contacts_error", { success: false, message: "No WhatsApp data found. Please scan the QR code first." });
            return;
        }

        console.log(`🔎 [get_contacts] Fetching WhatsApp individual contacts for ${email}...`);
        try {
            // First ensure groups are fetched, so we can extract all group participants as contacts
            try {
                await getGroupsForUser(userClient, { forceRefresh: false });
            } catch (groupErr) {
                console.warn(`[get_contacts] Could not pre-fetch groups for contact extraction:`, groupErr.message);
            }

            const contactsList = await getContactsForUser(userClient);
            console.log(`📋 [get_contacts] Contacts found for ${email}: ${contactsList.length}`);
            socket.emit("contacts_list", { success: true, contacts: contactsList });
        } catch (err) {
            console.error(`❌ [get_contacts] Error fetching contacts for ${email}:`, err);
            socket.emit("contacts_error", { success: false, message: `Unable to fetch WhatsApp contacts. ${err.message || ""}`.trim() });
        }
    });

    socket.on("get_group_members", async (data, callback) => {
        const cb = typeof callback === "function" ? callback : () => {};
        const email = socketToEmail[socket.id];
        const userClient = userClients[email];

        if (!userClient || !userClient.isWhatsAppAuthenticated || !userClient.whatsappClient) {
            return cb({ success: false, error: "WhatsApp client is not connected." });
        }

        const groupId = data && data.groupId;
        if (!groupId) {
            return cb({ success: false, error: "Invalid group ID." });
        }

        try {
            const groupsObj = await getGroupsForUser(userClient);
            let group = groupsObj[groupId];
            if (!group) {
                group = await withTimeout(userClient.whatsappClient.groupMetadata(groupId), 10000, "groupMetadata");
            }
            if (!group) {
                return cb({ success: false, error: "Group not found." });
            }

            const participants = Array.isArray(group.participants) ? group.participants : [];
            if (participants.length === 0) {
                return cb({ success: true, groupId, name: group.subject, members: [], warning: "This group has no participants." });
            }

            const members = [];
            for (const p of participants) {
                const number = normalizePhoneNumber(p.id);
                if (number) members.push(number);
            }
            cb({ success: true, groupId, name: group.subject, totalParticipants: participants.length, availableNumbers: members.length, members });
        } catch (err) {
            console.error(`❌ Error fetching members for group ${groupId}:`, err);
            cb({ success: false, error: "Failed to fetch group members." });
        }
    });

    // --- Web Scraper: Google Maps Scraping ---
    socket.on("start_scrape", async (data) => {
        const { query, location } = data || {};
        if (!query || !query.trim()) {
            socket.emit("scrape_error", { message: "Please enter a valid search query." });
            return;
        }

        console.log(`🕷️ [WebScraper] Starting scrape for query: "${query}", location: "${location || ""}"`);

        try {
            await scrapeGoogleMapsLeads(query, location, {
                onLead: (lead) => {
                    socket.emit("scrape_lead", lead);
                },
                onPhoneUpdate: (id, phone) => {
                    socket.emit("scrape_phone_update", { id, phone });
                },
                onComplete: (leads) => {
                    socket.emit("scrape_complete", { count: leads.length });
                }
            });
        } catch (err) {
            console.error("❌ Web Scraper error:", err);
            socket.emit("scrape_error", { message: err.message || "Failed to scrape listings." });
        }
    });
});

const schedule = require('node-schedule');
const Schedule = require('./models/Schedule');

// --- Goyee AI Configuration Endpoints ---
app.get('/api/ai-config', async (req, res) => {
    try {
        const email = String(req.query.email || "").trim().toLowerCase();
        if (!email) return res.status(400).json({ error: "Email is required" });
        let config = await AiConfig.findOne({ email });
        if (!config) {
            config = { email, enabled: false, knowledgeBase: "", apiKey: "" };
        }
        res.json({ success: true, config });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/ai-config', async (req, res) => {
    try {
        const { email, enabled, knowledgeBase, apiKey } = req.body;
        if (!email) return res.status(400).json({ error: "Email is required" });
        const cleanEmail = String(email).trim().toLowerCase();
        const config = await AiConfig.findOneAndUpdate(
            { email: cleanEmail },
            { 
                enabled: !!enabled, 
                knowledgeBase: knowledgeBase || "", 
                apiKey: apiKey ? String(apiKey).trim() : "",
                updatedAt: new Date() 
            },
            { upsert: true, returnDocument: 'after' }
        );
        res.json({ success: true, config });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/ai-config/test', async (req, res) => {
    try {
        const { knowledgeBase, query, apiKey } = req.body;
        if (!query) return res.status(400).json({ error: "Query is required" });
        const reply = await generateGoyeeAiReply({
            knowledgeBase: knowledgeBase || "No knowledge base provided.",
            customerPhone: "+919876543210",
            customerName: "Test Customer",
            customerMessage: query,
            apiKey: apiKey ? String(apiKey).trim() : process.env.GEMINI_API_KEY
        });
        res.json({ success: true, reply });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/schedules', async (req, res) => {
    try {
        const { email } = req.query;
        const query = email ? { email } : {};
        const schedules = await Schedule.find(query).sort({ scheduledFor: 1 });
        res.json(schedules);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/schedules', async (req, res) => {
    try {
        const newSchedule = new Schedule(req.body);
        await newSchedule.save();
        scheduleJob(newSchedule);
        res.json({ message: 'Scheduled successfully', schedule: newSchedule });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/schedules/:id', async (req, res) => {
    try {
        const updated = await Schedule.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after' });
        const existingJob = schedule.scheduledJobs[updated._id.toString()];
        if (existingJob) existingJob.cancel();
        
        if (updated.status === 'Pending') {
            scheduleJob(updated);
        }
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/schedules/:id', async (req, res) => {
    try {
        await Schedule.findByIdAndDelete(req.params.id);
        const existingJob = schedule.scheduledJobs[req.params.id];
        if (existingJob) existingJob.cancel();
        res.json({ message: 'Deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function scheduleJob(scheduleDoc) {
    if (scheduleDoc.status !== 'Pending') return;
    
    schedule.scheduleJob(scheduleDoc._id.toString(), new Date(scheduleDoc.scheduledFor), async () => {
        try {
            console.log('Running scheduled job for', scheduleDoc._id);
            const email = scheduleDoc.email;
            const userClient = userClients[email];
            if (!userClient || !userClient.isWhatsAppAuthenticated) {
                console.log(`Cannot send scheduled message: WhatsApp not authenticated for ${email}`);
                await Schedule.findByIdAndUpdate(scheduleDoc._id, { status: 'Failed' });
                return;
            }
            
            const whatsappClient = userClient.whatsappClient;
            let validNumbersCount = 0;
            let successCount = 0;
            let failedCount = 0;
            const schedDelay = scheduleDoc && scheduleDoc.delay !== undefined ? Number(scheduleDoc.delay) : 2;
            const schedDelayMs = Math.max(1000, Math.min(60000, (isNaN(schedDelay) || schedDelay <= 0 ? 2 : schedDelay) * 1000));
            console.log(`⏱️ Scheduled broadcast delay configured: ${schedDelayMs / 1000}s`);
 
            io.emit("bulk_progress_start", { total: scheduleDoc.contacts.length });
 
            for (let num of scheduleDoc.contacts) {
                if (!num || String(num).trim() === "") {
                    io.emit("bulk_progress_update", { status: "failed", number: num, reason: "Invalid empty number" });
                    failedCount++;
                    continue;
                }
 
                validNumbersCount++;
                let cleanNum = String(num).replace(/\D/g, '');
                if (cleanNum.length === 10) {
                    cleanNum = '91' + cleanNum;
                }
                const formattedNumber = `${cleanNum}@s.whatsapp.net`;
 
                io.emit("bulk_progress_update", { status: "sending", number: num });
 
                try {
                    const checkNumber = await whatsappClient.onWhatsApp(formattedNumber);
                    if (!checkNumber || checkNumber.length === 0 || !checkNumber[0].exists) {
                        io.emit("bulk_progress_update", { status: "failed", number: num, reason: "Number is not registered on WhatsApp" });
                        failedCount++;
                        continue;
                    }

                    // Pre-handshake Signal encryption session
                    try {
                        await whatsappClient.presenceSubscribe(formattedNumber);
                        await whatsappClient.sendPresenceUpdate('composing', formattedNumber);
                        await new Promise(resolve => setTimeout(resolve, 800));
                    } catch (pErr) {}

                    const schedMedia = scheduleDoc.media;
                    const mediaItems = Array.isArray(schedMedia) ? schedMedia : (schedMedia && schedMedia.data ? [schedMedia] : []);
                    
                    if (mediaItems.length > 0) {
                        let isFirst = true;
                        for (const item of mediaItems) {
                            if (!item || !item.data) continue;
                            const buffer = Buffer.from(item.data, 'base64');
                            let mime = item.mimetype ? item.mimetype.toLowerCase() : '';
                            const name = item.filename ? item.filename.toLowerCase() : '';
                            
                            if (!mime || mime === 'application/octet-stream') {
                                const ext = name.split('.').pop();
                                const mimeMap = {
                                    'png': 'image/png',
                                    'jpg': 'image/jpeg',
                                    'jpeg': 'image/jpeg',
                                    'gif': 'image/gif',
                                    'webp': 'image/webp',
                                    'mp4': 'video/mp4',
                                    'mov': 'video/quicktime',
                                    'avi': 'video/x-msvideo',
                                    'pdf': 'application/pdf',
                                    'csv': 'text/csv',
                                    'xls': 'application/vnd.ms-excel',
                                    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                                    'doc': 'application/msword',
                                    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                                    'txt': 'text/plain'
                                };
                                mime = mimeMap[ext] || mime;
                            }

                            const isImage = mime.startsWith('image/') || name.match(/\.(jpg|jpeg|png|gif|webp)$/i);
                            const isVideo = mime.startsWith('video/') || name.match(/\.(mp4|mov|avi|webm|mkv)$/i);

                            let mediaMessage = {};
                            const captionText = isFirst ? (scheduleDoc.message || '') : '';
                            if (isImage) {
                                mediaMessage = { image: buffer, caption: captionText, mimetype: mime || 'image/jpeg' };
                            } else if (isVideo) {
                                mediaMessage = { video: buffer, caption: captionText, mimetype: mime || 'video/mp4' };
                            } else {
                                mediaMessage = { 
                                    document: buffer, 
                                    caption: captionText, 
                                    mimetype: mime || 'application/pdf', 
                                    fileName: item.filename || 'document.pdf' 
                                };
                            }
                            const sentResult = await whatsappClient.sendMessage(formattedNumber, mediaMessage);
                            if (sentResult && sentResult.key && sentResult.key.id && userClients[email] && userClients[email].messageStore) {
                                userClients[email].messageStore[sentResult.key.id] = sentResult.message;
                            }
                            isFirst = false;
                            if (mediaItems.length > 1) {
                                // 3.5s delay between consecutive media to ensure Signal protocol key ratchet sync completes across sender devices
                                await new Promise(resolve => setTimeout(resolve, 3500));
                            }
                        }
                    } else {
                        await whatsappClient.sendMessage(formattedNumber, { text: scheduleDoc.message || '' });
                    }
                    io.emit("bulk_progress_update", { status: "sent", number: num });
                    try {
                        await MessageHistory.create({
                            email: email || "user@goye.com",
                            phone: String(num).trim(),
                            message: scheduleDoc.message || (scheduleDoc.media && scheduleDoc.media.filename ? `[Media] ${scheduleDoc.media.filename}` : "Scheduled Message"),
                            status: "Sent",
                            deviceName: "Goye Scheduled",
                            sentAt: new Date()
                        });
                    } catch (histErr) {}
                    successCount++;
                    await new Promise(resolve => setTimeout(resolve, schedDelayMs));
                } catch(e) {
                    console.error('Error sending scheduled to', num, e);
                    let reason = e.message || "Unable to send message.";
                    if (reason.includes("reading 'id'") || reason.includes("undefined") || reason.includes("Cannot read properties")) {
                        reason = "Number is not registered on WhatsApp.";
                    }
                    try {
                        await MessageHistory.create({
                            email: email || "user@goye.com",
                            phone: String(num).trim(),
                            message: scheduleDoc.message || (scheduleDoc.media && scheduleDoc.media.filename ? `[Media] ${scheduleDoc.media.filename}` : "Scheduled Message"),
                            status: "Failed",
                            deviceName: "Goye Scheduled",
                            sentAt: new Date()
                        });
                    } catch (histErr) {}
                    io.emit("bulk_progress_update", { status: "failed", number: num, reason: reason });
                    failedCount++;
                }
            }
 
            if (validNumbersCount > 0 || failedCount > 0) {
                const d = new Date();
                const offset = d.getTimezoneOffset() * 60000;
                const today = new Date(d.getTime() - offset).toISOString().split('T')[0];
                await MessageLog.findOneAndUpdate(
                    { date: today },
                    { $inc: { count: validNumbersCount, successCount: successCount, failedCount: failedCount } },
                    { upsert: true, returnDocument: 'after' }
                );
            }
 
            io.emit("bulk_progress_completed", { success: true });
            
            if (successCount === 0 && failedCount > 0) {
                 await Schedule.findByIdAndUpdate(scheduleDoc._id, { status: 'Failed', sentAt: new Date() });
            } else {
                 await Schedule.findByIdAndUpdate(scheduleDoc._id, { status: 'Completed', sentAt: new Date() });
            }
        } catch(e) {
            console.error('Job error', e);
            io.emit("bulk_progress_completed", { success: false });
            await Schedule.findByIdAndUpdate(scheduleDoc._id, { status: 'Failed' });
        }
    });
}
 
mongoose.connection.once('open', async () => {
    const pendings = await Schedule.find({ status: 'Pending' });
    for (const s of pendings) {
        if (s.email) {
            await startWhatsAppForUser(s.email);
        }
        scheduleJob(s);
    }
});

setInterval(async () => {
    try {
        if (mongoose.connection.readyState !== 1) return;
        const due = await Schedule.find({ status: 'Pending', scheduledFor: { $lte: new Date() } });
        for (const s of due) {
            if (!schedule.scheduledJobs[s._id.toString()]) {
                console.log(`⏰ Catch-up: re-registering overdue schedule ${s._id}`);
                if (s.email) await startWhatsAppForUser(s.email);
                scheduleJob(s);
            }
        }
    } catch (e) {
        console.warn('Schedule catch-up sweep skipped/error:', e.message);
    }
}, 60 * 1000);

const PORT = process.env.PORT || 5000;

// USER LOGIN & REGISTER API ROUTES
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  businessName: { type: String, required: false },
  businessType: { type: String, required: false },
  phone: { type: String, required: false },
  location: { type: String, required: false },
  credits: { type: Number, default: 30 },
  totalSent: { type: Number, default: 0 },
  lastDailyRewardDate: { type: String, default: "" },
  isSubscribed: { type: Boolean, default: false },
  subscriptionPlan: { type: String, default: "" },
  subscriptionStartedAt: { type: Date, default: null },
  subscriptionExpiresAt: { type: Date, default: null },
  upcomingPlan: { type: String, default: "" },
  upcomingPlanStartsAt: { type: Date, default: null },
  upcomingPlanExpiresAt: { type: Date, default: null }
});

const messageLogSchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true }, // Format: YYYY-MM-DD
  count: { type: Number, default: 0 },
  successCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 }
});

const User = mongoose.models.User || mongoose.model('User', userSchema);
const MessageLog = mongoose.models.MessageLog || mongoose.model('MessageLog', messageLogSchema);

const freeUserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  passwordHash: { type: String, required: false },
  businessName: { type: String, required: false, default: "" },
  businessType: { type: String, required: false, default: "" },
  phone: { type: String, required: true },
  location: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  credits: { type: Number, default: 30 },
  totalSent: { type: Number, default: 0 },
  lastDailyRewardDate: { type: String, default: "" },
  isSubscribed: { type: Boolean, default: false },
  subscriptionPlan: { type: String, default: "" },
  subscriptionStartedAt: { type: Date, default: null },
  subscriptionExpiresAt: { type: Date, default: null },
  upcomingPlan: { type: String, default: "" },
  upcomingPlanStartsAt: { type: Date, default: null },
  upcomingPlanExpiresAt: { type: Date, default: null },
  status: { type: String, enum: ["active", "blocked", "suspended"], default: "active" }
});

const FreeUser = mongoose.models.FreeUser || mongoose.model('FreeUser', freeUserSchema);

// Helper to get today's date in YYYY-MM-DD format (local timezone)
function getTodayDateString() {
  const d = new Date();
  const offset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - offset).toISOString().split('T')[0];
}

// 🧪 TEST ENDPOINT FOR IMMEDIATE VERIFICATION (Simulate Yesterday / Midnight)
app.post('/api/test/simulate-midnight', async (req, res) => {
  try {
    const { email } = req.body;
    const yesterday = "2026-08-19"; // Previous day
    let user = await FreeUser.findOneAndUpdate(
      { email: String(email).trim().toLowerCase() },
      { $set: { lastDailyRewardDate: yesterday } },
      { returnDocument: 'after' }
    );
    if (!user) {
      user = await User.findOneAndUpdate(
        { email: String(email).trim().toLowerCase() },
        { $set: { lastDailyRewardDate: yesterday } },
        { returnDocument: 'after' }
      );
    }
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.json({
      success: true,
      message: `Simulated previous day for ${email}! Now refresh frontend or fetch credits.`,
      user
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 🧪 TEST ENDPOINT TO EXPIRE ACTIVE PLAN IMMEDIATELY IN DATABASE
app.post('/api/test/expire-plan', async (req, res) => {
  try {
    const { email } = req.body;
    const pastDate = new Date(Date.now() - 10000); // 10 seconds ago
    let user = await FreeUser.findOneAndUpdate(
      { email: String(email).trim().toLowerCase() },
      { $set: { isSubscribed: false, subscriptionExpiresAt: pastDate, credits: 0 } },
      { returnDocument: 'after' }
    );
    if (!user) {
      user = await User.findOneAndUpdate(
        { email: String(email).trim().toLowerCase() },
        { $set: { isSubscribed: false, subscriptionExpiresAt: pastDate, credits: 0 } },
        { returnDocument: 'after' }
      );
    }
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.json({
      success: true,
      message: `Plan expired in database for ${email}!`,
      user
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Helper to check and auto-activate a queued / upcoming subscription plan
 * when the current active subscription expires (like mobile recharge queueing).
 */
async function checkAndActivateQueuedPlan(userDoc, Model) {
  if (!userDoc) return userDoc;
  const now = Date.now();
  if (userDoc.upcomingPlan && userDoc.upcomingPlanExpiresAt) {
    const currentExp = userDoc.subscriptionExpiresAt ? new Date(userDoc.subscriptionExpiresAt).getTime() : 0;
    const upcomingExp = new Date(userDoc.upcomingPlanExpiresAt).getTime();

    // If current plan has expired, but upcoming plan is still valid: auto-activate!
    if (now >= currentExp && now < upcomingExp) {
      const updateData = {
        subscriptionPlan: userDoc.upcomingPlan,
        subscriptionStartedAt: userDoc.upcomingPlanStartsAt || new Date(),
        subscriptionExpiresAt: userDoc.upcomingPlanExpiresAt,
        upcomingPlan: "",
        upcomingPlanStartsAt: null,
        upcomingPlanExpiresAt: null,
        isSubscribed: true,
        credits: 99999
      };
      if (Model && Model.findByIdAndUpdate) {
        const updated = await Model.findByIdAndUpdate(userDoc._id, { $set: updateData }, { returnDocument: 'after' });
        if (updated) return updated;
      }
      Object.assign(userDoc, updateData);
      if (typeof userDoc.save === 'function') {
        await userDoc.save();
      }
    } else if (now >= upcomingExp) {
      // Both current and upcoming plans have passed their expiry
      if (Model && Model.findByIdAndUpdate) {
        await Model.findByIdAndUpdate(userDoc._id, {
          $set: { upcomingPlan: "", upcomingPlanStartsAt: null, upcomingPlanExpiresAt: null }
        });
      }
      userDoc.upcomingPlan = "";
      userDoc.upcomingPlanStartsAt = null;
      userDoc.upcomingPlanExpiresAt = null;
    }
  }
  return userDoc;
}

/**
 * Daily credit reset helper for Free Users.
 * If user is NOT subscribed and a new day (midnight) has passed,
 * RESET credits to EXACTLY 10 (not += 10, not 30+10).
 * Strictly applies ONLY to pure FreeUser accounts that have NEVER subscribed.
 */
async function checkAndApplyDailyReset(userDoc, Model) {
  if (!userDoc) return userDoc;

  // Auto-activate any queued plan first if due
  userDoc = await checkAndActivateQueuedPlan(userDoc, Model);

  // Strictly ONLY FreeUser accounts are eligible for daily 10 credits reset
  const isFreeUserModel = Model === FreeUser || (userDoc.constructor && userDoc.constructor.modelName === 'FreeUser');
  if (!isFreeUserModel) {
    return userDoc;
  }

  // If user has EVER subscribed (has active or expired subscription history),
  // permanently STOP the daily 10 credit logic!
  const hasSubscriptionHistory = !!(userDoc.subscriptionExpiresAt || userDoc.subscriptionStartedAt || userDoc.subscriptionPlan);
  if (hasSubscriptionHistory) {
    // If expired, ensure isSubscribed is false and credits are 0
    const isStillSubscribed = !!(userDoc.subscriptionExpiresAt && new Date(userDoc.subscriptionExpiresAt).getTime() > Date.now());
    if (!isStillSubscribed && (userDoc.isSubscribed || userDoc.credits !== 0)) {
      const updated = await Model.findByIdAndUpdate(
        userDoc._id,
        { $set: { isSubscribed: false, credits: 0 } },
        { returnDocument: 'after' }
      );
      if (updated) return updated;
    }
    return userDoc;
  }

  const today = getTodayDateString();

  // If user doc has no lastDailyRewardDate set yet, initialize it to today so we don't repeatedly reset credits
  if (!userDoc.lastDailyRewardDate) {
    const updated = await Model.findByIdAndUpdate(
      userDoc._id,
      { $set: { lastDailyRewardDate: today } },
      { returnDocument: 'after' }
    );
    if (updated) return updated;
    return userDoc;
  }

  // Only reset to 10 if midnight has genuinely passed (a new day has started)
  if (userDoc.lastDailyRewardDate !== today) {
    const updatedUser = await Model.findOneAndUpdate(
      {
        _id: userDoc._id,
        lastDailyRewardDate: { $ne: today },
        subscriptionExpiresAt: null,
        subscriptionStartedAt: null,
        $or: [
          { isSubscribed: false },
          { isSubscribed: { $exists: false } }
        ]
      },
      {
        $set: {
          credits: 10,
          lastDailyRewardDate: today
        }
      },
      { returnDocument: 'after' }
    );

    if (updatedUser) {
      return updatedUser;
    }
  }

  return userDoc;
}

// Background sweep running periodically to reset free user credits at midnight
// Strictly resets ONLY pure FreeUser accounts that have NEVER subscribed
async function runDailyCreditResetSweep() {
  try {
    if (mongoose.connection.readyState !== 1) {
      return; // Do not call database queries before initial connection is complete
    }

    const today = getTodayDateString();

    const resetQuery = {
      lastDailyRewardDate: { $ne: today },
      subscriptionExpiresAt: null,
      subscriptionStartedAt: null,
      $or: [
        { subscriptionPlan: "" },
        { subscriptionPlan: null },
        { subscriptionPlan: { $exists: false } }
      ],
      $or: [
        { isSubscribed: false },
        { isSubscribed: { $exists: false } }
      ]
    };

    const updateDoc = {
      $set: {
        credits: 10,
        lastDailyRewardDate: today
      }
    };

    // Strictly reset ONLY pure FreeUser accounts that have NEVER subscribed
    if (mongoose.models.FreeUser) {
      await mongoose.models.FreeUser.updateMany(resetQuery, updateDoc);
    }
  } catch (err) {
    console.error('Error in daily credit reset sweep:', err);
  }
}

// Run reset sweep periodically every 10 minutes (connection callback triggers initial run)
setInterval(runDailyCreditResetSweep, 10 * 60 * 1000);

app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, businessName, businessType, phone, location } = req.body;
    if (!name || !email || !password || !phone || !location) {
      return res.status(400).json({ message: "Please fill in all required fields." });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters." });
    }
    const normalizedEmail = email ? String(email).trim().toLowerCase() : "";
    const existingUser = (await User.findOne({ email: normalizedEmail })) || (mongoose.models.FreeUser ? await mongoose.models.FreeUser.findOne({ email: normalizedEmail }) : null);
    if (existingUser) return res.status(400).json({ message: "User already exists" });
    
    const d = new Date();
    const offset = d.getTimezoneOffset() * 60000;
    const today = new Date(d.getTime() - offset).toISOString().split('T')[0];

    const newUser = new User({ 
      name, email: normalizedEmail, password,
      businessName: businessName || "",
      businessType: businessType || "",
      phone: phone || "",
      location: location || "",
      credits: 30,
      lastDailyRewardDate: today
    });
    
    await newUser.save();
    res.status(201).json({ message: "Registration successful!" });
  } catch (error) {
    res.status(500).json({ message: "Error registering user", error });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password, fromFreeUserLogin } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Please enter both email and password." });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const safeEmailRegex = new RegExp(`^${normalizedEmail.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i');
    
    let user = await User.findOne({ email: safeEmailRegex });
    let modelToUse = User;

    // Dual-lookup: If not found in User collection, check FreeUser collection!
    if (!user && mongoose.models.FreeUser) {
      user = await mongoose.models.FreeUser.findOne({ email: safeEmailRegex });
      modelToUse = mongoose.models.FreeUser;

      // Auto-copy free user data into the User (subscribed users) collection
      // so they appear in the admin Subscribed Users panel.
      if (user) {
        const existsInUserCol = await User.findOne({ email: safeEmailRegex });
        if (!existsInUserCol) {
          try {
            await new User({
              name: user.name,
              email: user.email,
              password: user.password,
              businessName: user.businessName || "",
              businessType: user.businessType || "",
              phone: user.phone || "",
              location: user.location || "",
              credits: user.credits || 0,
              totalSent: user.totalSent || 0,
              lastDailyRewardDate: user.lastDailyRewardDate || "",
              isSubscribed: user.isSubscribed || false,
              subscriptionPlan: user.subscriptionPlan || "",
              subscriptionStartedAt: user.subscriptionStartedAt || null,
              subscriptionExpiresAt: user.subscriptionExpiresAt || null,
            }).save();
            console.log(`✅ Auto-copied free user "${user.email}" into Subscribed Users collection.`);
          } catch (copyErr) {
            console.error(`⚠️ Failed to auto-copy free user "${user.email}":`, copyErr.message);
          }
        }
      }
    }

    if (!user) return res.status(401).json({ message: "Invalid email or password" });

    if (user.status === "blocked" || user.status === "suspended") {
      return res.status(403).json({ message: "Your account is blocked." });
    }

    const inputPass = String(password).trim();
    const storedPass = user.password || user.passwordHash || "";

    let isPasswordMatch = (storedPass === inputPass);
    if (!isPasswordMatch && storedPass) {
      try {
        const bcrypt = require('bcrypt');
        isPasswordMatch = await bcrypt.compare(inputPass, storedPass);
      } catch (bcErr) {}
    }

    if (!isPasswordMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    user = await checkAndActivateQueuedPlan(user, modelToUse);
    user = await checkAndApplyDailyReset(user, modelToUse);

    const hasSubHistory = !!(user.subscriptionExpiresAt || user.subscriptionStartedAt || user.subscriptionPlan);
    const isSubscribed = Boolean(
      user.isSubscribed === true ||
      (user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt).getTime() > Date.now()) ||
      (user.upcomingPlanExpiresAt && new Date(user.upcomingPlanExpiresAt).getTime() > Date.now())
    );
    const isFreeUserModel = modelToUse === FreeUser || (user.constructor && user.constructor.modelName === 'FreeUser');
    // Also check if the user exists in the FreeUser collection (they may have been auto-copied to User)
    let freeUserRecord = null;
    if (isFreeUserModel) {
      freeUserRecord = user;
    } else if (mongoose.models.FreeUser) {
      freeUserRecord = await mongoose.models.FreeUser.findOne({ email: safeEmailRegex });
    }
    const hasFreeUserRecord = !!freeUserRecord;
    
    // If login came from the free user login page AND user has a FreeUser record,
    // give them their actual credits from the FreeUser record.
    // STRICT ISOLATION:
    // When logging into Subscription side:
    // If active paid subscription: 99999 credits.
    // If not subscribed: STRICTLY 0 credits! Free credits must NEVER carry over to Subscription side.
    const isActualFreeUserLogin = Boolean(fromFreeUserLogin);
    const realCredits = (freeUserRecord && freeUserRecord.credits !== undefined) ? freeUserRecord.credits : (user.credits || 0);
    const effectiveCredits = isSubscribed ? 99999 : (isActualFreeUserLogin ? realCredits : 0);

    console.log(`🔍 LOGIN DEBUG: email=${user.email}, isSubscribed=${isSubscribed}, userCredits=${user.credits}, effectiveCredits=${effectiveCredits}`);

    res.status(200).json({ 
      message: "Login successful!", 
      id: user._id,
      name: user.name, 
      email: user.email, 
      businessName: user.businessName || "",
      businessType: user.businessType || "",
      phone: user.phone || "", 
      location: user.location || "", 
      credits: effectiveCredits,
      totalSent: user.totalSent || 0,
      isSubscribed: isSubscribed,
      subscriptionPlan: isSubscribed ? (user.subscriptionPlan || "Pro Plan") : (hasSubHistory ? (user.subscriptionPlan || "") : ""),
      subscriptionStartedAt: user.subscriptionStartedAt || null,
      subscriptionExpiresAt: user.subscriptionExpiresAt || null,
      upcomingPlan: user.upcomingPlan || "",
      upcomingPlanStartsAt: user.upcomingPlanStartsAt || null,
      upcomingPlanExpiresAt: user.upcomingPlanExpiresAt || null,
      isFreeUser: !isSubscribed && (isActualFreeUserLogin || hasFreeUserRecord)
    });
  } catch (error) {
    res.status(500).json({ message: "Error logging in", error: error.message });
  }
});

// ==========================================
// FREE USER LOGIN & REGISTER API ROUTES
// Completely separate from the User model/routes above — used only by
// the dedicated /free-user/* authentication flow.
// ==========================================

app.post('/api/free-user/register', async (req, res) => {
  try {
    const { name, email, password, businessName, businessType, phone, location } = req.body;

    if (!name || !email || !password || !phone || !location) {
      return res.status(400).json({ message: "Please fill in all required fields." });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters." });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existingFreeUser = (await FreeUser.findOne({ email: normalizedEmail })) || (mongoose.models.User ? await mongoose.models.User.findOne({ email: normalizedEmail }) : null);
    if (existingFreeUser) return res.status(400).json({ message: "An account with this email already exists." });

    const today = getTodayDateString();

    const newFreeUser = new FreeUser({
      name,
      email: normalizedEmail,
      password,
      businessName: businessName ? businessName.trim() : "",
      businessType: businessType ? businessType.trim() : "",
      phone,
      location,
      credits: 30,
      lastDailyRewardDate: today
    });

    await newFreeUser.save();
    res.status(201).json({ message: "Registration successful!" });
  } catch (error) {
    console.error('Free user registration error:', error);
    res.status(500).json({ message: "Error registering user", error: error.message });
  }
});

app.post('/api/free-user/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Please enter both email and password." });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const safeEmailRegex = new RegExp(`^${normalizedEmail.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i');
    
    let freeUser = await FreeUser.findOne({ email: safeEmailRegex });
    let modelToUse = FreeUser;

    // Dual-lookup: If not found in FreeUser collection, check User collection!
    if (!freeUser && mongoose.models.User) {
      freeUser = await mongoose.models.User.findOne({ email: safeEmailRegex });
      modelToUse = mongoose.models.User;
    }

    if (!freeUser) return res.status(401).json({ message: "Invalid email or password" });

    if (freeUser.status === "blocked" || freeUser.status === "suspended") {
      return res.status(403).json({
        success: false,
        message: "Your account is blocked."
      });
    }

    const inputPass = String(password).trim();
    const storedPass = freeUser.password || freeUser.passwordHash || "";

    let isMatch = (storedPass === inputPass);
    if (!isMatch && (storedPass.startsWith('$2a$') || storedPass.startsWith('$2b$'))) {
      try {
        const bcrypt = require('bcrypt');
        isMatch = await bcrypt.compare(inputPass, storedPass);
      } catch (e) {}
    }

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Auto-sync into FreeUser collection so they appear in Admin Free Users page!
    if (mongoose.models.FreeUser) {
      try {
        const existsInFree = await FreeUser.findOne({ email: safeEmailRegex });
        if (!existsInFree) {
          const newFreeUserDoc = await new FreeUser({
            name: freeUser.name,
            email: freeUser.email,
            password: freeUser.password || inputPass,
            passwordHash: freeUser.passwordHash || "",
            businessName: freeUser.businessName || "",
            businessType: freeUser.businessType || "",
            phone: freeUser.phone || "",
            location: freeUser.location || "",
            credits: 30,
            totalSent: 0,
            lastDailyRewardDate: getTodayDateString(),
            isSubscribed: false,
            subscriptionPlan: "",
            status: freeUser.status || "active",
            createdAt: freeUser.createdAt || new Date()
          }).save();
          console.log(`✅ Auto-synced user "${freeUser.email}" into Free Users collection.`);
          freeUser = newFreeUserDoc;
          modelToUse = FreeUser;
        }
      } catch (syncErr) {
        console.error(`⚠️ Failed to sync user to FreeUser "${freeUser.email}":`, syncErr.message);
      }
    }

    freeUser = await checkAndApplyDailyReset(freeUser, modelToUse);

    const secretKey = process.env.JWT_SECRET || 'goye-secret-token-key-2026';
    const tokenPayload = `${freeUser._id.toString()}:${Date.now()}`;
    const tokenSignature = crypto.createHmac('sha256', secretKey).update(tokenPayload).digest('hex');
    const token = Buffer.from(`${tokenPayload}:${tokenSignature}`).toString('base64url');

    const subscriptionExpiresAt = freeUser.subscriptionExpiresAt || null;
    const isSubscribed = !!(
      subscriptionExpiresAt &&
      new Date(subscriptionExpiresAt).getTime() > Date.now()
    );

    // STRICT ISOLATION:
    // Free User side must NEVER inherit Subscription plan or 99999 subscription credits!
    // Free User always operates strictly under Free User rules (30 initial credits, 10 daily).
    let freeCredits = freeUser.freeCredits !== undefined ? freeUser.freeCredits : freeUser.credits;
    if (freeCredits === undefined || freeCredits === null || (freeCredits === 0 && (freeUser.freeTotalSent || freeUser.totalSent || 0) === 0)) {
      freeCredits = 30;
      await modelToUse.findByIdAndUpdate(freeUser._id, { $set: { freeCredits: 30, credits: 30 } });
    }

    res.status(200).json({
      message: "Login successful!",
      token,
      user: {
        id: freeUser._id,
        name: freeUser.name,
        email: freeUser.email,
        businessName: freeUser.businessName,
        businessType: freeUser.businessType,
        phone: freeUser.phone,
        location: freeUser.location,
        credits: freeCredits,
        totalSent: freeUser.freeTotalSent || freeUser.totalSent || 0,
        isFreeUser: true,
        isSubscribed: false,
        subscriptionPlan: "",
        subscriptionStartedAt: null,
        subscriptionExpiresAt: null
      }
    });
  } catch (error) {
    console.error('Free user login error:', error);
    res.status(500).json({ message: "Error logging in", error: error.message });
  }
});

app.get('/api/free-user/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
    if (!token) return res.status(401).json({ message: "Not authenticated." });

    const secretKey = process.env.JWT_SECRET || 'goye-secret-token-key-2026';
    let freeUser = null;
    try {
      const decoded = Buffer.from(token, 'base64url').toString('utf8');
      const parts = decoded.split(':');
      if (parts.length >= 3) {
        const userId = parts[0];
        const timestamp = parts[1];
        const signature = parts[2];
        const expectedSignature = crypto.createHmac('sha256', secretKey).update(`${userId}:${timestamp}`).digest('hex');
        if (signature === expectedSignature) {
          freeUser = await FreeUser.findById(userId);
          if (!freeUser && mongoose.models.User) {
            freeUser = await User.findById(userId);
          }
        }
      }
    } catch (tokenErr) {}

    if (!freeUser && mongoose.Types.ObjectId.isValid(token)) {
      freeUser = await FreeUser.findById(token);
      if (!freeUser && mongoose.models.User) {
        freeUser = await User.findById(token);
      }
    }

    if (!freeUser) return res.status(401).json({ message: "Invalid or expired session. Please log in again." });

    const isSubscribed = !!(
      freeUser.subscriptionExpiresAt &&
      new Date(freeUser.subscriptionExpiresAt).getTime() > Date.now()
    );

    let freeCredits = freeUser.freeCredits !== undefined ? freeUser.freeCredits : freeUser.credits;
    if (freeCredits === undefined || freeCredits === null || (freeCredits === 0 && (freeUser.freeTotalSent || freeUser.totalSent || 0) === 0)) {
      freeCredits = 30;
      const TargetModel = (freeUser.constructor && freeUser.constructor.modelName === 'User') || !mongoose.models.FreeUser ? (mongoose.models.User || FreeUser) : FreeUser;
      await TargetModel.findByIdAndUpdate(freeUser._id, { $set: { freeCredits: 30, credits: 30 } });
    }

    return res.status(200).json({
      user: {
        id: freeUser._id,
        name: freeUser.name,
        email: freeUser.email,
        businessName: freeUser.businessName || "",
        businessType: freeUser.businessType || "",
        phone: freeUser.phone || "",
        location: freeUser.location || "",
        role: freeUser.role || "free_user",
        status: freeUser.status || "active",
        credits: freeCredits,
        totalSent: freeUser.freeTotalSent || freeUser.totalSent || 0,
        isFreeUser: true,
        isSubscribed: false,
        subscriptionPlan: "",
        subscriptionStartedAt: null,
        subscriptionExpiresAt: null,
        createdAt: freeUser.createdAt,
        updatedAt: freeUser.updatedAt
      }
    });
  } catch (error) {
    console.error('Free user /me error:', error);
    return res.status(500).json({ message: "Error fetching user data", error: error.message });
  }
});

app.get('/api/free-user/profile/:id', async (req, res) => {
  try {
    let modelToUse = FreeUser;
    let freeUser = await FreeUser.findById(req.params.id).select('-password');
    if (!freeUser && mongoose.models.User) {
      freeUser = await User.findById(req.params.id).select('-password');
      modelToUse = User;
    }
    if (!freeUser) return res.status(404).json({ message: "Free user not found" });
    if (freeUser.status === "blocked") {
      return res.status(403).json({ success: false, message: "Your account is blocked." });
    }

    freeUser = await checkAndApplyDailyReset(freeUser, modelToUse);
    const hasSubHistory = !!(freeUser.subscriptionExpiresAt || freeUser.subscriptionStartedAt || freeUser.subscriptionPlan);
    const isSubscribed = !!(freeUser.subscriptionExpiresAt && new Date(freeUser.subscriptionExpiresAt).getTime() > Date.now());
    const effectiveCredits = isSubscribed ? 99999 : (freeUser.credits !== undefined ? freeUser.credits : 0);

    res.status(200).json({
      id: freeUser._id,
      name: freeUser.name,
      email: freeUser.email,
      businessName: freeUser.businessName,
      businessType: freeUser.businessType,
      phone: freeUser.phone,
      location: freeUser.location,
      credits: effectiveCredits,
      totalSent: freeUser.totalSent || 0,
      isSubscribed: isSubscribed,
      subscriptionPlan: isSubscribed ? (freeUser.subscriptionPlan || "") : "",
      subscriptionStartedAt: freeUser.subscriptionStartedAt,
      subscriptionExpiresAt: freeUser.subscriptionExpiresAt
    });
  } catch (error) {
    res.status(500).json({ message: "Error fetching free user profile", error: error.message });
  }
});

app.post('/api/free-user/credits', async (req, res) => {
  try {
    const { id, email } = req.body;
    if (!id && !email) return res.status(400).json({ message: "id or email is required" });
    let modelToUse = FreeUser;
    let freeUser = id ? await FreeUser.findById(id) : await FreeUser.findOne({ email: { $regex: new RegExp(`^${String(email).trim()}$`, 'i') } });
    if (!freeUser && mongoose.models.User) {
      freeUser = id ? await User.findById(id) : await User.findOne({ email: { $regex: new RegExp(`^${String(email).trim()}$`, 'i') } });
      modelToUse = User;
    }
    if (!freeUser) return res.status(404).json({ message: "Free user not found" });
    if (freeUser.status === "blocked") {
      return res.status(403).json({ success: false, message: "Your account is blocked." });
    }

    freeUser = await checkAndApplyDailyReset(freeUser, modelToUse);
    const hasSubHistory = !!(freeUser.subscriptionExpiresAt || freeUser.subscriptionStartedAt || freeUser.subscriptionPlan);
    const isSubscribed = !!(freeUser.subscriptionExpiresAt && new Date(freeUser.subscriptionExpiresAt).getTime() > Date.now());
    const effectiveCredits = isSubscribed ? 99999 : (freeUser.credits !== undefined ? freeUser.credits : 0);

    let normalizedSent = freeUser.totalSent || 0;
    if (!isSubscribed && effectiveCredits <= 0 && normalizedSent % 2 !== 0) {
      normalizedSent = Math.floor(normalizedSent / 2) * 2;
    }

    res.status(200).json({
      credits: effectiveCredits,
      totalSent: normalizedSent,
      isSubscribed: isSubscribed,
      subscriptionPlan: isSubscribed ? (freeUser.subscriptionPlan || "") : "",
      subscriptionStartedAt: freeUser.subscriptionStartedAt,
      subscriptionExpiresAt: freeUser.subscriptionExpiresAt,
      rewarded: false,
      lastDailyRewardDate: freeUser.lastDailyRewardDate
    });
  } catch (error) {
    res.status(500).json({ message: "Error fetching free user credits", error: error.message });
  }
});

app.get('/api/free-user/subscription/:id', async (req, res) => {
  try {
    let freeUser = await FreeUser.findById(req.params.id).select('subscriptionPlan subscriptionExpiresAt status');
    if (!freeUser && mongoose.models.User) {
      freeUser = await User.findById(req.params.id).select('subscriptionPlan subscriptionExpiresAt status');
    }
    if (!freeUser) return res.status(404).json({ message: "Free user not found" });
    if (freeUser.status === "blocked") {
      return res.status(403).json({ success: false, message: "Your account is blocked." });
    }

    const isActive = !!(freeUser.subscriptionExpiresAt && new Date(freeUser.subscriptionExpiresAt) > new Date());

    res.status(200).json({
      isSubscribed: isActive,
      subscriptionPlan: isActive ? freeUser.subscriptionPlan : "",
      subscriptionExpiresAt: freeUser.subscriptionExpiresAt
    });
  } catch (error) {
    res.status(500).json({ message: "Error fetching free user subscription", error: error.message });
  }
});

app.post('/api/free-user/message-sent', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ message: "id is required" });
    let freeUser = await FreeUser.findById(id);
    if (!freeUser) return res.status(404).json({ message: "Free user not found" });
    if (freeUser.status === "blocked") {
      return res.status(403).json({ success: false, message: "Your account is blocked." });
    }

    freeUser = await checkAndApplyDailyReset(freeUser, FreeUser);
    const isSubscribed = !!(freeUser.subscriptionExpiresAt && new Date(freeUser.subscriptionExpiresAt) > new Date());

    const currentCredits = isSubscribed ? 99999 : (freeUser.credits || 0);
    const currentSent = freeUser.totalSent || 0;

    const willConsumeCredit = (currentSent + 1) % 2 === 0;
    if (!isSubscribed && willConsumeCredit && currentCredits <= 0) {
      return res.status(403).json({
        message: "Daily credit limit reached. Please try again tomorrow.",
        credits: currentCredits,
        totalSent: currentSent
      });
    }

    freeUser.totalSent = currentSent + 1;
    freeUser.lastDailyRewardDate = getTodayDateString();
    if (!isSubscribed && willConsumeCredit) {
      freeUser.credits = Math.max(0, currentCredits - 1);
    }
    await freeUser.save();

    res.status(200).json({
      success: true,
      credits: isSubscribed ? 99999 : freeUser.credits,
      totalSent: freeUser.totalSent,
      messagesRemaining: isSubscribed ? 99999 : freeUser.credits
    });
  } catch (error) {
    res.status(500).json({ message: "Error updating free user usage", error: error.message });
  }
});

app.get('/api/admin/free-users', async (req, res) => {
  try {
    const freeUsers = await FreeUser.find({}, '-password').sort({ _id: -1 }).lean();
    const withStatus = freeUsers.map((u) => ({ ...u, status: u.status || "active" }));
    res.status(200).json(withStatus);
  } catch (error) {
    console.error('Admin free users fetch error:', error);
    res.status(500).json({ message: "Error fetching free users", error: error.message });
  }
});

app.patch('/api/admin/free-users/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!["active", "blocked"].includes(status)) {
      return res.status(400).json({ message: "status must be 'active' or 'blocked'." });
    }

    const freeUser = await FreeUser.findByIdAndUpdate(
      req.params.id,
      { status },
      { returnDocument: 'after' }
    ).select('-password');

    if (!freeUser) return res.status(404).json({ message: "Free user not found" });

    res.status(200).json({
      message: status === "blocked" ? "User blocked." : "User unblocked.",
      freeUser
    });
  } catch (error) {
    console.error('Admin free user status update error:', error);
    res.status(500).json({ message: "Error updating free user status", error: error.message });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find({}, '-password').sort({ _id: -1 }).lean();
    res.status(200).json(users);
  } catch (error) {
    res.status(500).json({ message: "Error fetching users", error });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const deletedUser = await User.findByIdAndDelete(req.params.id);
    if (!deletedUser) return res.status(404).json({ message: "User not found" });
    res.status(200).json({ message: "User deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting user", error });
  }
});

app.get('/api/messages/stats', async (req, res) => {
  try {
    const stats = await MessageLog.find().sort({ date: 1 });
    res.status(200).json(stats);
  } catch (error) {
    res.status(500).json({ message: "Error fetching message stats", error });
  }
});

app.post('/api/user/credits', async (req, res) => {
  try {
    const { email, id, isFreeUser: reqIsFreeUser } = req.body;
    let user = null;
    let isFreeUser = reqIsFreeUser === true;
    const cleanEmail = email ? String(email).trim() : "";

    if (isFreeUser) {
      if (id && mongoose.Types.ObjectId.isValid(id)) {
        user = await FreeUser.findById(id);
      }
      if (!user && cleanEmail) {
        user = await FreeUser.findOne({ email: cleanEmail.toLowerCase() });
      }
      if (!user && cleanEmail) {
        user = await User.findOne({ email: cleanEmail.toLowerCase() });
      }
    } else {
      if (cleanEmail) {
        user = await User.findOne({ email: cleanEmail.toLowerCase() });
      }
      if (!user && (id || cleanEmail)) {
        if (id && mongoose.Types.ObjectId.isValid(id)) {
          user = await FreeUser.findById(id);
        }
        if (!user && cleanEmail) {
          user = await FreeUser.findOne({ email: cleanEmail.toLowerCase() });
        }
        if (user) isFreeUser = true;
      }
    }
    if (!user) return res.status(404).json({ message: "User not found" });

    user = await checkAndActivateQueuedPlan(user, isFreeUser ? FreeUser : User);
    if (isFreeUser) {
      user = await checkAndApplyDailyReset(user, FreeUser);
    }
    const hasSubHistory = !!(user.subscriptionExpiresAt || user.subscriptionStartedAt || user.subscriptionPlan);
    const isSubscribed = !isFreeUser && !!(
      user.isSubscribed || 
      (user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt).getTime() > Date.now()) ||
      (user.upcomingPlanExpiresAt && new Date(user.upcomingPlanExpiresAt).getTime() > Date.now())
    );
    
    // STRICT ISOLATION:
    // If request is for Free User -> return freeCredits (or credits), max 30 initial.
    // If request is for Subscription User -> if paid subscription: 99999. If not subscribed: STRICTLY 0! Free credits must NEVER be returned!
    let effectiveCredits = 0;
    if (isFreeUser) {
      const rawCreds = user.freeCredits !== undefined ? user.freeCredits : (user.credits !== undefined ? user.credits : 30);
      effectiveCredits = Math.min(30, rawCreds);
    } else {
      effectiveCredits = isSubscribed ? 99999 : 0;
    }

    res.status(200).json({ 
      credits: effectiveCredits, 
      totalSent: isFreeUser ? (user.freeTotalSent || user.totalSent || 0) : (user.totalSent || 0), 
      isSubscribed: isFreeUser ? false : isSubscribed,
      subscriptionPlan: isFreeUser ? "" : (isSubscribed ? (user.subscriptionPlan || "One Day") : (hasSubHistory ? (user.subscriptionPlan || "") : "")),
      subscriptionStartedAt: isFreeUser ? null : (isSubscribed ? user.subscriptionStartedAt : (hasSubHistory ? user.subscriptionStartedAt : null)),
      subscriptionExpiresAt: isFreeUser ? null : (user.subscriptionExpiresAt || null),
      upcomingPlan: isFreeUser ? "" : (user.upcomingPlan || ""),
      upcomingPlanStartsAt: isFreeUser ? null : (user.upcomingPlanStartsAt || null),
      upcomingPlanExpiresAt: isFreeUser ? null : (user.upcomingPlanExpiresAt || null),
      rewarded: false,
      isFreeUser: isFreeUser
    });
  } catch (error) {
    res.status(500).json({ message: "Error fetching credits", error });
  }
});

app.post('/api/user/increment-sent', async (req, res) => {
  try {
    const { email, id } = req.body;
    let user = null;
    if (email) {
      user = await User.findOne({ email: String(email).trim().toLowerCase() });
    }
    if (!user && (id || email)) {
      const normalizedEmail = email ? String(email).trim().toLowerCase() : null;
      const query = id ? { _id: id } : { email: normalizedEmail };
      user = await FreeUser.findOne(query);
    }
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isSubscribed = !!(user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt).getTime() > Date.now());
    const availableCredits = user.credits || 0;

    // Guard: If not subscribed and credits <= 0, do not increment totalSent beyond allowed quota
    if (!isSubscribed && availableCredits <= 0) {
      return res.status(200).json({ totalSent: user.totalSent || 0, credits: 0, limited: true });
    }

    user.totalSent = (user.totalSent || 0) + 1;
    await user.save();

    res.status(200).json({ totalSent: user.totalSent, credits: user.credits || 0 });
  } catch (error) {
    res.status(500).json({ message: "Error incrementing sent", error });
  }
});

app.post('/api/user/use-credit', async (req, res) => {
  try {
    const { email, id, amount } = req.body;
    let user = null;
    let isFreeUser = false;
    if (email) {
      user = await User.findOne({ email: String(email).trim().toLowerCase() });
    }
    if (!user && (id || email)) {
      const normalizedEmail = email ? String(email).trim().toLowerCase() : null;
      user = id ? await FreeUser.findById(id) : await FreeUser.findOne({ email: normalizedEmail });
      if (user) isFreeUser = true;
    }
    if (user) {
      const isSubscribed = !!(user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt).getTime() > Date.now());
      if (!isSubscribed) {
        user.credits = Math.max(0, (user.credits || 0) - (amount || 1));
        user.lastDailyRewardDate = getTodayDateString();
        await user.save();
      }
      res.status(200).json({ credits: isSubscribed ? 99999 : user.credits, totalSent: user.totalSent || 0 });
    } else {
      res.status(404).json({ message: "User not found" });
    }
  } catch (error) {
    res.status(500).json({ message: "Error using credit", error });
  }
});

app.post('/api/user/sync-usage', async (req, res) => {
  try {
    const { email, id, credits, totalSent } = req.body;
    let user = null;
    if (email) {
      user = await User.findOne({ email: String(email).trim().toLowerCase() });
      if (!user && mongoose.models.FreeUser) {
        user = await FreeUser.findOne({ email: String(email).trim().toLowerCase() });
      }
    } else if (id && mongoose.Types.ObjectId.isValid(id)) {
      user = await FreeUser.findById(id);
      if (!user && mongoose.models.User) {
        user = await User.findById(id);
      }
    }
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const isSubscribed = !!(user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt).getTime() > Date.now());
    if (!isSubscribed && credits !== undefined) {
      user.credits = Math.max(0, Number(credits));
    }
    if (totalSent !== undefined) {
      user.totalSent = Math.max(user.totalSent || 0, Number(totalSent));
    }
    user.lastDailyRewardDate = getTodayDateString();
    await user.save();

    res.status(200).json({ success: true, credits: isSubscribed ? 99999 : user.credits, totalSent: user.totalSent });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error syncing usage", error: error.message });
  }
});

app.post('/api/user/add-credits', async (req, res) => {
  try {
    const { email, id, amount, exactCredits, totalSent } = req.body;
    const addVal = parseInt(amount || 4, 10);
    let user = null;
    
    if (email) {
      const cleanEmail = String(email).trim();
      const safeRegex = new RegExp(`^${cleanEmail.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i');
      user = await FreeUser.findOne({ email: safeRegex });
      if (!user) {
        user = await User.findOne({ email: safeRegex });
      }
    } else if (id && mongoose.Types.ObjectId.isValid(id)) {
      user = await FreeUser.findById(id);
      if (!user) {
        user = await User.findById(id);
      }
    }

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (exactCredits !== undefined) {
      user.credits = Number(exactCredits);
    } else {
      user.credits = (user.credits || 0) + addVal;
    }

    if (totalSent !== undefined) {
      user.totalSent = Math.max(user.totalSent || 0, Number(totalSent));
    }

    user.lastDailyRewardDate = getTodayDateString();
    await user.save();

    return res.status(200).json({ success: true, credits: user.credits || 0, totalSent: user.totalSent || 0 });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Error adding credits", error: error.message });
  }
});

// --- Message History Routes ---

app.get('/api/history', async (req, res) => {
  try {
    const { email, search, status } = req.query;
    if (!email) return res.status(400).json({ success: false, message: "Email required." });

    const cleanEmail = String(email).trim();
    const query = { email: { $regex: new RegExp(`^${cleanEmail.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i') } };

    if (status && status !== 'All') {
      query.status = status;
    }

    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim().replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i');
      query.$or = [
        { phone: searchRegex },
        { message: searchRegex }
      ];
    }

    const records = await MessageHistory.find(query).sort({ sentAt: -1, createdAt: -1 });
    return res.json({ success: true, records });
  } catch (error) {
    console.error('Error fetching history:', error);
    return res.status(500).json({ success: false, message: 'Error fetching history', error: error.message });
  }
});

app.get('/api/user/total-sent', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ success: false, message: 'Email required.' });

    const cleanEmail = String(email).trim();
    const user = await User.findOne({ email: { $regex: new RegExp(`^${cleanEmail.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i') } });
    
    return res.json({ success: true, totalSent: user ? (user.totalSent || 0) : 0 });
  } catch (error) {
    console.error('Error fetching total sent:', error);
    return res.status(500).json({ success: false, message: 'Error fetching total sent' });
  }
});

// Notifications API
const Notification = require('./models/Notification');

app.get('/api/notifications', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ success: false, message: 'Email query required.' });
    if (mongoose.connection.readyState !== 1) {
      return res.json({ success: true, notifications: [] });
    }
    const cleanEmail = String(email).trim();
    const safeRegex = new RegExp(`^${cleanEmail.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i');
    const notifications = await Notification.find({ userEmail: safeRegex }).sort({ createdAt: -1 });
    return res.json({ success: true, notifications });
  } catch (error) {
    return res.json({ success: true, notifications: [] });
  }
});

app.post('/api/notifications', async (req, res) => {
  try {
    const { email, userEmail, title, message, creditsEarned } = req.body;
    const targetEmail = userEmail || email;
    if (!targetEmail) return res.status(400).json({ success: false, message: 'Email required' });

    const cleanEmail = String(targetEmail).trim();
    const newNotification = new Notification({
      userEmail: cleanEmail,
      title: title || 'Plan Activated!',
      message: message || 'Your plan successfully activated',
      creditsEarned: creditsEarned || 0,
      read: false,
      createdAt: new Date()
    });

    await newNotification.save();
    return res.status(201).json({ success: true, notification: newNotification });
  } catch (error) {
    console.error('Error creating notification:', error);
    return res.status(500).json({ success: false, message: 'Error creating notification' });
  }
});

app.put('/api/notifications/mark-read', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email required.' });

    const cleanEmail = String(email).trim();
    const safeRegex = new RegExp(`^${cleanEmail.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i');
    await Notification.updateMany({ userEmail: safeRegex, read: false }, { $set: { read: true } });
    return res.json({ success: true, message: 'Notifications marked as read' });
  } catch (error) {
    console.error('Error marking notifications read:', error);
    return res.status(500).json({ success: false, message: 'Error updating notifications' });
  }
});

app.delete('/api/notifications/:id', async (req, res) => {
  try {
    const deletedNotification = await Notification.findByIdAndDelete(req.params.id);
    if (!deletedNotification) {
      return res.status(404).json({ success: false, message: 'Notification not found.' });
    }
    return res.json({ success: true, message: 'Notification deleted successfully.' });
  } catch (error) {
    console.error('Error deleting notification:', error);
    return res.status(500).json({ success: false, message: 'Error deleting notification' });
  }
});

app.post('/api/contact/whatsapp', async (req, res) => {
  try {
    const { name, email, subject, message, text } = req.body;

    const validationErrors = [];
    if (!name || !String(name).trim()) validationErrors.push('Please enter your full name.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) validationErrors.push('Please enter a valid email address.');
    if (!subject || !String(subject).trim()) validationErrors.push('Please enter a subject.');
    if (!message || !String(message).trim()) validationErrors.push('Please enter your message.');

    if (validationErrors.length > 0) {
      return res.status(400).json({ message: validationErrors[0] });
    }

    const activeClient = Object.values(userClients).find(uc => uc.isWhatsAppAuthenticated)?.whatsappClient;
    if (!activeClient) {
      return res.status(503).json({ message: 'WhatsApp is not ready yet. Please try again shortly.' });
    }

    const destination = String(process.env.WHATSAPP_CONTACT_NUMBER || '919486042369').replace(/\D/g, '');
    if (!destination) {
      return res.status(500).json({ message: 'WhatsApp destination is not configured.' });
    }

    const formattedNumber = destination.startsWith('91') ? `${destination}@s.whatsapp.net` : `91${destination}@s.whatsapp.net`;
    const payload = { text: text || `New contact form submission\nName: ${name}\nEmail: ${email}\nSubject: ${subject}\nMessage: ${message}` };

    await activeClient.sendMessage(formattedNumber, payload);
    res.status(200).json({ message: 'Contact message sent successfully.' });
  } catch (error) {
    console.error('Contact WhatsApp error:', error);
    res.status(500).json({ message: 'Unable to send your message right now.' });
  }
});

// --- Support Request / Feedback API ---
const supportSchema = new mongoose.Schema({
  username: { type: String },
  email: { type: String },
  type: { type: String, required: true },
  issueType: { type: String },
  description: { type: String, required: true },
  rating: { type: Number },
  screenshot: {
    filename: { type: String },
    mimetype: { type: String },
    data: { type: String }
  },
  createdAt: { type: Date, default: Date.now }
});

const Support = mongoose.models.Support || mongoose.model('Support', supportSchema);

app.post('/api/support', async (req, res) => {
  try {
    const { username, email, type, issueType, description, rating, screenshot } = req.body;

    const supportDoc = new Support({
      username: username || "Guest",
      email: email || "no-email@goye.com",
      type,
      issueType,
      description,
      rating,
      screenshot
    });
    await supportDoc.save();

    const destination = '919943042369'; 
    let cleanDest = String(destination).replace(/\D/g, '');
    if (cleanDest.length === 10) {
      cleanDest = '91' + cleanDest;
    }
    const formattedNumber = `${cleanDest}@s.whatsapp.net`;

    const dateFormatted = new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
    const timeFormatted = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

    let textMessage = '';
    if (type === 'issue') {
      textMessage = `New Help Request\n\nUser:\n${username}\n\nEmail:\n${email}\n\nIssue:\n${issueType}\n\nDescription:\n${description}\n\nDate:\n${dateFormatted}\n${timeFormatted}`;
    } else {
      const stars = '⭐'.repeat(rating || 0);
      textMessage = `New User Feedback\n\nUser:\n${username}\n\n${stars}\n\nFeedback:\n${description}`;
    }

    // Attempt non-blocking WhatsApp alert to Admin if any WhatsApp session is available
    try {
      let userClient = userClients[email] || Object.values(userClients).find(uc => uc && uc.isWhatsAppAuthenticated);
      if (userClient && userClient.isWhatsAppAuthenticated && userClient.whatsappClient) {
        const whatsappClient = userClient.whatsappClient;
        console.log(`📤 [Support API] Dispatching support notification to admin ${cleanDest}...`);
        
        if (screenshot && screenshot.data) {
          const buffer = Buffer.from(screenshot.data, 'base64');
          await whatsappClient.sendMessage(formattedNumber, {
            image: buffer,
            caption: textMessage,
            mimetype: screenshot.mimetype || 'image/png'
          });
        } else {
          await whatsappClient.sendMessage(formattedNumber, { text: textMessage });
        }
        console.log(`✅ [Support API] Admin WhatsApp notification sent successfully.`);
      } else {
        console.log(`ℹ️ [Support API] WhatsApp session is offline. Support ticket saved in database for Admin review.`);
      }
    } catch (waError) {
      console.warn(`⚠️ [Support API] Note: WhatsApp message could not be sent to admin, but ticket is safely saved in DB:`, waError.message);
    }

    return res.status(200).json({ 
      success: true, 
      message: 'Support request submitted successfully. Our support team will review your report shortly.' 
    });
  } catch (error) {
    console.error('Support API Error:', error);
    return res.status(500).json({ success: false, message: 'Error submitting support request', error: error.message });
  }
});

// --- Group Management: REST read endpoints ---
app.get('/api/groups', async (req, res) => {
    try {
        const { email } = req.query;
        if (!email) return res.status(400).json({ success: false, message: "Query param 'email' is required." });

        const userClient = userClients[email];
        if (!userClient || !userClient.isWhatsAppAuthenticated || !userClient.whatsappClient) {
            return res.status(503).json({ success: false, message: "No WhatsApp data found. Please scan the QR code first." });
        }

        const groupsObj = await getGroupsForUser(userClient, { forceRefresh: true });
        const groupsList = Object.entries(groupsObj || {}).map(([groupId, g]) => ({
            id: g.id || groupId,
            name: g.subject || "Unnamed group",
            memberCount: Array.isArray(g.participants) ? g.participants.length : 0,
            owner: g.owner || null,
            creation: g.creation || null,
        }));
        return res.status(200).json({ success: true, groups: groupsList });
    } catch (err) {
        console.error('❌ GET /api/groups error:', err);
        return res.status(500).json({ success: false, message: "Unable to fetch WhatsApp groups.", error: err.message });
    }
});

app.get('/api/groups/:groupId/members', async (req, res) => {
    try {
        const { groupId } = req.params;
        const { email } = req.query;
        if (!email) return res.status(400).json({ message: "Query param 'email' is required." });

        const userClient = userClients[email];
        if (!userClient || !userClient.isWhatsAppAuthenticated || !userClient.whatsappClient) {
            return res.status(503).json({ message: "WhatsApp client is not connected. Please scan the QR code first." });
        }

        const groupsObj = await getGroupsForUser(userClient);
        let group = groupsObj[groupId];
        if (!group) {
            try {
                group = await withTimeout(userClient.whatsappClient.groupMetadata(groupId), 10000, "groupMetadata");
            } catch (e) {
                return res.status(404).json({ message: "Invalid group ID or group not found." });
            }
        }

        const participants = Array.isArray(group.participants) ? group.participants : [];
        if (participants.length === 0) {
            return res.status(200).json({ groupId, name: group.subject, members: [], warning: "This group has no participants." });
        }

        const members = [];
        for (const p of participants) {
            const number = normalizePhoneNumber(p.id);
            if (number) members.push(number);
        }
        return res.status(200).json({
            groupId,
            name: group.subject,
            totalParticipants: participants.length,
            availableNumbers: members.length,
            members,
        });
    } catch (err) {
        console.error('❌ GET /api/groups/:groupId/members error:', err);
        return res.status(500).json({ message: "Failed to fetch group members.", error: err.message });
    }
});

// --- Group Management: export unique member phone numbers to Excel ---
app.post('/api/groups/export', async (req, res) => {
    try {
        const { email } = req.body || {};
        const groupIds = Array.isArray(req.body?.groupIds) && req.body.groupIds.length > 0
            ? req.body.groupIds
            : (req.body?.groupId ? [req.body.groupId] : []);

        if (!email) {
            return res.status(400).json({ message: "Email is required." });
        }
        if (groupIds.length === 0 || groupIds.some((id) => !id || typeof id !== 'string')) {
            return res.status(400).json({ message: "Please select a valid WhatsApp group to export." });
        }

        const userClient = userClients[email];
        if (!userClient || !userClient.isWhatsAppAuthenticated || !userClient.whatsappClient) {
            return res.status(503).json({ message: "WhatsApp is not connected. Please scan the QR code first." });
        }

        const client = userClient.whatsappClient;
        let groupsCache;
        try {
            groupsCache = await getGroupsForUser(userClient);
        } catch (err) {
            console.error(`❌ Error fetching groups for export (${email}):`, err);
            return res.status(502).json({ message: "Couldn't reach WhatsApp to fetch group data. Please try again." });
        }

        const uniqueKeys = new Set();
        const rows = [];
        const invalidGroupIds = [];
        const emptyGroups = [];
        const exportedGroupNames = [];
        let hiddenNumberCount = 0;

        for (const groupId of groupIds) {
            let group = groupsCache[groupId];

            if (!group) {
                try {
                    group = await withTimeout(client.groupMetadata(groupId), 10000, "groupMetadata");
                    groupsCache[groupId] = group;
                } catch (err) {
                    console.warn(`⚠️ Invalid/unreachable group JID during export (${groupId}):`, err.message);
                    invalidGroupIds.push(groupId);
                    continue;
                }
            }

            const groupName = group.subject || "Unnamed group";
            const participants = Array.isArray(group.participants) ? group.participants : [];
            if (participants.length === 0) {
                emptyGroups.push(groupName);
                continue;
            }

            let addedFromThisGroup = 0;
            for (const p of participants) {
                const { number, isHidden } = resolveParticipantNumber(p);
                const dedupeKey = number || p.id;
                if (!dedupeKey || uniqueKeys.has(dedupeKey)) continue;
                uniqueKeys.add(dedupeKey);
                addedFromThisGroup++;
                if (isHidden) hiddenNumberCount++;
                rows.push({
                    "Name": userClient.contactNames?.[p.id] || "",
                    "Phone Number": number || "",
                    "WhatsApp ID / JID": p.id,
                    "Number Status": isHidden ? "Hidden by WhatsApp privacy" : "Available",
                    "Admin": p.admin === "superadmin" ? "Super Admin" : p.admin === "admin" ? "Admin" : "",
                    "Source Group": groupName,
                });
            }
            if (addedFromThisGroup > 0) exportedGroupNames.push(groupName);
        }

        if (invalidGroupIds.length === groupIds.length) {
            return res.status(404).json({
                message: groupIds.length === 1
                    ? "This group could not be found. It may have been deleted, or you may no longer be a member."
                    : "None of the selected groups could be found.",
                invalidGroupIds,
            });
        }

        if (rows.length === 0) {
            return res.status(422).json({
                message: groupIds.length === 1
                    ? "This group has no members to export."
                    : "None of the selected groups have any members to export.",
                invalidGroupIds,
                emptyGroups,
            });
        }

        const worksheet = XLSX.utils.json_to_sheet(rows);
        worksheet["!cols"] = [{ wch: 24 }, { wch: 16 }, { wch: 28 }, { wch: 22 }, { wch: 12 }, { wch: 24 }];
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Members");
        const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

        const filenameLabel = exportedGroupNames.length === 1
            ? sanitizeFilenamePart(exportedGroupNames[0])
            : `${exportedGroupNames.length || groupIds.length}_Groups`;
        const filename = `${filenameLabel}_Members.xlsx`;

        res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Export-Count, X-Export-Group-Name, X-Export-Hidden-Count");
        res.setHeader("Content-Disposition", buildContentDisposition(filename));
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("X-Export-Count", String(rows.length));
        res.setHeader("X-Export-Group-Name", encodeURIComponent(exportedGroupNames.join(", ") || "Group"));
        res.setHeader("X-Export-Hidden-Count", String(hiddenNumberCount));
        return res.send(buffer);
    } catch (error) {
        console.error("❌ Groups export error:", error);
        return res.status(500).json({ message: "Failed to generate the Excel file. Please try again.", error: error.message });
    }
});

// --- Contact Management: get contacts & export to Excel ---
app.get('/api/contacts', async (req, res) => {
    try {
        const email = req.query.email;
        if (!email) {
            return res.status(400).json({ success: false, message: "Email is required." });
        }
        const userClient = userClients[email];
        if (!userClient || !userClient.isWhatsAppAuthenticated || !userClient.whatsappClient) {
            return res.status(503).json({ success: false, message: "WhatsApp is not connected." });
        }
        const contactsList = await getContactsForUser(userClient);
        return res.status(200).json({ success: true, contacts: contactsList });
    } catch (err) {
        console.error('❌ GET /api/contacts error:', err);
        return res.status(500).json({ success: false, message: "Unable to fetch contacts.", error: err.message });
    }
});

app.post('/api/contacts/export', async (req, res) => {
    try {
        const { email, contactIds } = req.body || {};
        if (!email) {
            return res.status(400).json({ message: "Email is required." });
        }
        const userClient = userClients[email];
        if (!userClient || !userClient.isWhatsAppAuthenticated || !userClient.whatsappClient) {
            return res.status(503).json({ message: "WhatsApp is not connected. Please scan the QR code first." });
        }

        const allContacts = await getContactsForUser(userClient);
        const selectedIdsSet = Array.isArray(contactIds) && contactIds.length > 0 ? new Set(contactIds) : null;
        const targetContacts = selectedIdsSet 
            ? allContacts.filter(c => selectedIdsSet.has(c.id) || selectedIdsSet.has(c.number))
            : allContacts;

        if (targetContacts.length === 0) {
            return res.status(422).json({ message: "No contacts selected or found to export." });
        }

        const rows = targetContacts.map(c => ({
            "Name": c.name || "Unknown Contact",
            "Phone Number": c.number || "",
            "WhatsApp ID / JID": c.id,
            "Notify / Push Name": c.notify || "",
            "Account Type": c.isBusiness ? "Business" : "Standard"
        }));

        const worksheet = XLSX.utils.json_to_sheet(rows);
        worksheet["!cols"] = [{ wch: 25 }, { wch: 18 }, { wch: 32 }, { wch: 22 }, { wch: 16 }];
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Contacts");
        const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

        const filename = "WhatsApp_Contacts.xlsx";
        res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Export-Count");
        res.setHeader("Content-Disposition", buildContentDisposition(filename));
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("X-Export-Count", String(rows.length));
        return res.send(buffer);
    } catch (error) {
        console.error("❌ Contacts export error:", error);
        return res.status(500).json({ message: "Failed to generate the Excel file. Please try again.", error: error.message });
    }
});

try {
  app.use('/api', require('./routes/teamCampaign')({ userClients, emitToUserSockets }));
} catch (e) {
  try {
    const teamCampaignRoutes = require('./routes/teamCampaignRoutes');
    app.use('/api/team-campaign', teamCampaignRoutes);
  } catch (e2) {}
}

try {
  app.use('/api', require('./routes/scrapeLeads'));
} catch (e) {}

app.use((err, req, res, next) => {
    console.error("Express Error:", err);
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));