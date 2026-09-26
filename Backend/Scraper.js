const { chromium } = require("playwright");

// ── Helper: fetch mobile-only phone from a listing detail page ──────────────
async function fetchMobilePhone(context, listingUrl) {
  const detailPage = await context.newPage();
  try {
    await detailPage.goto(listingUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    let rawPhone = null;
    try {
      await detailPage.waitForSelector('a[href^="tel:"]', { timeout: 4000 });
      rawPhone = await detailPage.evaluate(() => {
        const tel = document.querySelector('a[href^="tel:"]');
        return tel ? tel.getAttribute("href").replace("tel:", "").trim() : null;
      });
    } catch (_) {}
    if (rawPhone) {
      const raw = rawPhone.replace(/[\s\-\.]/g, ""); // strip spaces/dashes only
      if (raw.length >= 6) return rawPhone.trim();   // return as-is from Google Maps
    }
    return null;
  } catch (_) {
    return null;
  } finally {
    await detailPage.close().catch(() => {});
  }
}

// ── Helper: extract ONLY listings not yet seen from the current feed DOM ─────
async function extractNewListings(page, seenNamesArray) {
  return await page.evaluate((seenArr) => {
    const seen = new Set(seenArr);
    const results = [];

    const feed = document.querySelector('div[role="feed"]');
    if (!feed) return results;

    const UI_LABELS =
      /^(All filters|Results|Sponsored|Ad\b|More results|Open now|Hours|Directions|Website|Call|Save|Share|Send to phone|Photos|Reviews|Overview|Menu|More info|Add missing info|Suggest an edit|Claim this business|Delivery|Dine-in|Takeaway|No-contact delivery)$/i;

    const anchors = Array.from(feed.querySelectorAll('a[href*="/maps/place/"]'));

    for (const anchor of anchors) {
      const name = (anchor.getAttribute("aria-label") || "").trim();
      if (!name || name.length < 2) continue;
      if (seen.has(name.toLowerCase())) continue; // already emitted

      // Scope card text to exactly this listing
      let cardRoot = anchor;
      while (cardRoot.parentElement && cardRoot.parentElement !== feed) {
        const parent = cardRoot.parentElement;
        if (parent.querySelectorAll('a[href*="/maps/place/"]').length > 1) break;
        cardRoot = parent;
      }
      const cardText = (cardRoot.innerText || "").trim();

      // Rating
      let rating = null;
      const ratingMatch = cardText.match(/\b([1-5]\.[0-9])\b/);
      if (ratingMatch) rating = ratingMatch[1];

      // Phone — Fast path: tel: link in card, then broad regex in card text
      let phone = null;
      const telLink = cardRoot.querySelector('a[href^="tel:"]');
      if (telLink) {
        const raw = telLink.getAttribute("href").replace("tel:", "").trim();
        if (raw.replace(/\D/g, "").length >= 6) phone = raw; // accept mobile OR landline
      }
      if (!phone) {
        // Match mobile (6-9XXXXXXXXX) OR landline (0X-XXXXXXXX / 0XXXXXXXXXXX)
        const phoneReg = /(?:(?:\+?91[\s\-]?)?[6-9]\d{4}[\s\-]?\d{5}|\b0\d{2,5}[\s\-]?\d{3}[\s\-]?\d{3,4}\b)/g;
        const m = cardText.match(phoneReg);
        if (m && m[0].replace(/\D/g, "").length >= 6) phone = m[0].trim();
      }

      // Address
      let address = null;
      const textLines = cardText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 6 && l !== name && !UI_LABELS.test(l));
      const addrLine = textLines.find(
        (l) =>
          !l.match(/^\+?\d[\d\s\-]{8,}$/) &&
          !l.match(/^[1-5]\.[0-9]/) &&
          !l.match(/^\d+\s*(review|rating)/i) &&
          !l.match(/^(Open|Closed|Opens|Closes)/i) &&
          !UI_LABELS.test(l) &&
          l.length > 6 &&
          (l.includes(",") || /[A-Za-z]{4,}/.test(l))
      );
      if (addrLine) address = addrLine;

      results.push({ name, phone, address, rating, _listingUrl: anchor.href });
    }
    return results;
  }, seenNamesArray);
}

// ── Main scraper ─────────────────────────────────────────────────────────────
// callbacks = { onLead(lead), onPhoneUpdate(id, phone), onComplete(leads) }
// When callbacks are provided → progressive/streaming mode (used by Socket.IO).
// Without callbacks → batch mode (used by REST API, returns full results at end).
async function scrapeGoogleMapsLeads(searchQuery, locationQuery, callbacks = {}) {
  const { onLead, onPhoneUpdate, onComplete } = callbacks;
  const isProgressive = typeof onLead === "function";

  const fullQuery = locationQuery
    ? `${searchQuery} in ${locationQuery}`
    : searchQuery;

  console.log(`🔍 [Scraper] Fetching REAL Google Maps data for: "${fullQuery}"`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--no-zygote",
        "--window-size=1280,900"
      ]
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
      locale: "en-IN",
      geolocation: { longitude: 80.2707, latitude: 13.0827 },
      permissions: ["geolocation"]
    });

    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const url = `https://www.google.com/maps/search/${encodeURIComponent(fullQuery)}`;
    console.log(`📍 Navigating to: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Dismiss cookie/consent dialogs
    try {
      const acceptBtn = page
        .locator(
          'button:has-text("Accept all"), button:has-text("Reject all"), button[aria-label="Accept all"], form:nth-child(2) button'
        )
        .first();
      if (await acceptBtn.isVisible({ timeout: 4000 })) {
        await acceptBtn.click();
        console.log("✅ Cookie dialog dismissed");
      }
    } catch (_) {}

    console.log("⏳ Waiting for Google Maps results to load...");
    try {
      await page.waitForSelector('div[role="feed"]', { timeout: 20000 });
    } catch (_) {
      console.warn("⚠️ Feed not found after 20s");
    }
    await page.waitForTimeout(2000);

    // ── State tracking ──────────────────────────────────────────────────────
    const seenNames = new Set();
    const allLeads = [];
    let idCounter = 1;

    // Phone extraction queue — filled as listings are discovered
    const phoneQueue = [];
    let scrollingDone = false;

    // ── Concurrent phone extraction worker ──────────────────────────────────
    // Runs in background while scrolling continues; 2 tabs at a time for stable cloud hosting memory.
    const PHONE_CONCURRENCY = 2;
    const phoneWorkerPromise = (async () => {
      while (!scrollingDone || phoneQueue.length > 0) {
        if (phoneQueue.length === 0) {
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        const batch = phoneQueue.splice(0, Math.min(PHONE_CONCURRENCY, phoneQueue.length));
        await Promise.all(
          batch.map(async (lead) => {
            const phone = await fetchMobilePhone(context, lead._listingUrl);
            delete lead._listingUrl;
            if (phone) {
              lead.phone = phone;
              console.log(`✅ ${lead.name}: ${phone}`);
              if (isProgressive && onPhoneUpdate) onPhoneUpdate(lead.id, phone);
            } else {
              console.log(`ℹ️ ${lead.name}: no phone on Google Maps`);
            }
          })
        );
      }
    })();

    // ── Progressive scroll + extract loop ───────────────────────────────────
    console.log("📜 Starting progressive scroll and extract...");
    let staleScrolls = 0;
    const MAX_STALE = 3;

    while (true) {
      // Extract listings not yet seen — runs after each scroll
      const newListings = await extractNewListings(page, [...seenNames]);

      for (const listing of newListings) {
        listing.id = idCounter++;
        seenNames.add(listing.name.toLowerCase());
        allLeads.push(listing);

        // Emit to frontend immediately (without _listingUrl)
        const { _listingUrl, ...leadToSend } = listing;
        if (isProgressive) onLead(leadToSend);

        // Queue for detail-page phone extraction (only if no phone from card)
        if (!listing.phone && listing._listingUrl) {
          phoneQueue.push(listing);
        } else {
          delete listing._listingUrl;
        }
      }

      // Check for Google's "end of list" text
      const reachedEnd = await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (!feed) return false;
        return (feed.innerText || "").toLowerCase().includes("reached the end of the list");
      });
      if (reachedEnd) {
        console.log("✅ Google Maps: end of list reached.");
        break;
      }

      if (newListings.length === 0) {
        staleScrolls++;
        console.log(`⚠️ No new listings (stale ${staleScrolls}/${MAX_STALE})`);
        if (staleScrolls >= MAX_STALE) {
          console.log("✅ Stopping — no more results loading.");
          break;
        }
      } else {
        staleScrolls = 0;
      }

      console.log(`📊 Total listings so far: ${seenNames.size} — scrolling...`);
      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) feed.scrollBy(0, 1500);
      });
      await page.waitForTimeout(1500);
    }

    // Signal phone worker that scrolling is done, then await it
    scrollingDone = true;
    console.log(`📞 Waiting for phone extraction to finish (${phoneQueue.length} remaining)...`);
    await phoneWorkerPromise;

    await browser.close();

    const realLeads = allLeads.filter((l) => l.name && l.name.length > 2);

    if (realLeads.length === 0) {
      throw new Error(
        "Google Maps returned no listings for this query. Try a different search."
      );
    }

    console.log(`✅ [Scraper] Done — ${realLeads.length} REAL listings extracted!`);

    if (isProgressive && onComplete) onComplete(realLeads);
    return realLeads;

  } catch (error) {
    console.error("❌ [Scraper Error]:", error.message);
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    throw error;
  }
}

module.exports = { scrapeGoogleMapsLeads };