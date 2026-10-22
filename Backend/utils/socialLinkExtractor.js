/**
 * Utility to extract official social media links (Instagram, Facebook, YouTube)
 * from a business's website with fast timeouts and safe regex parsing.
 */

// Ignored slugs that are not user profile handles
const IGNORED_IG = new Set([
  "p", "reel", "reels", "explore", "stories", "accounts", "about", 
  "legal", "developer", "privacy", "terms", "directory"
]);
const IGNORED_FB = new Set([
  "sharer", "share", "sharer.php", "login", "dialog", "policies", 
  "privacy", "help", "tr", "plugins"
]);

/**
 * Extract official social media URLs from HTML content
 */
function parseSocialsFromHtml(html) {
  const result = {
    instagram: null,
    facebook: null,
    youtube: null
  };

  if (!html || typeof html !== "string") return result;

  // 1. Instagram profile match
  const igRegex = /https?:\/\/(?:www\.)?instagram\.com\/([a-zA-Z0-9._]{2,35})\/?(?:\?[^\s"'<>]*)?/gi;
  let match;
  while ((match = igRegex.exec(html)) !== null) {
    const handle = match[1].toLowerCase();
    if (!IGNORED_IG.has(handle) && !handle.startsWith("tag")) {
      result.instagram = `https://www.instagram.com/${match[1]}/`;
      break;
    }
  }

  // 2. Facebook page match
  const fbRegex = /https?:\/\/(?:www\.)?facebook\.com\/(?:pages\/[^\/\s"'<>]+\/)?([a-zA-Z0-9._-]{2,50})\/?(?:\?[^\s"'<>]*)?/gi;
  while ((match = fbRegex.exec(html)) !== null) {
    const handle = match[1].toLowerCase();
    if (!IGNORED_FB.has(handle)) {
      result.facebook = `https://www.facebook.com/${match[1]}/`;
      break;
    }
  }

  // 3. YouTube channel match
  const ytRegex = /https?:\/\/(?:www\.)?youtube\.com\/(@[a-zA-Z0-9._-]+|channel\/[a-zA-Z0-9_-]+|user\/[a-zA-Z0-9_-]+)/gi;
  while ((match = ytRegex.exec(html)) !== null) {
    result.youtube = `https://www.youtube.com/${match[1]}`;
    break;
  }

  return result;
}

/**
 * Fetch a website's HTML with a strict 3-second timeout and extract social links
 */
async function extractSocialsFromWebsite(websiteUrl) {
  if (!websiteUrl || typeof websiteUrl !== "string" || !websiteUrl.startsWith("http")) {
    return { instagram: null, facebook: null, youtube: null };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3200);

  try {
    const response = await fetch(websiteUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      redirect: "follow"
    });

    clearTimeout(timeoutId);
    if (!response.ok) return { instagram: null, facebook: null, youtube: null };

    const html = await response.text();
    return parseSocialsFromHtml(html);
  } catch (_) {
    clearTimeout(timeoutId);
    return { instagram: null, facebook: null, youtube: null };
  }
}

/**
 * Resolves the absolute best official link for a business:
 * - If found on website -> Returns the 100% direct official URL (e.g. instagram.com/palmyra_restaurant/)
 * - Fallback -> Returns smart direct Google/YouTube channel locator URL that prevents login wall and hits the official account
 */
function resolveOfficialProfileUrl(plat, bizName, location, officialSocials = {}) {
  const cleanLoc = (location || "").split(",")[0].trim();
  const queryBiz = `${bizName} ${cleanLoc}`.trim();

  if (plat === "instagram") {
    if (officialSocials && officialSocials.instagram) return officialSocials.instagram;
    // Smart Google direct locator for the exact Instagram account (bypasses login wall, ranks #1)
    return `https://www.google.com/search?q=site:instagram.com+${encodeURIComponent(queryBiz)}`;
  }

  if (plat === "facebook") {
    if (officialSocials && officialSocials.facebook) return officialSocials.facebook;
    return `https://www.google.com/search?q=site:facebook.com+${encodeURIComponent(queryBiz)}`;
  }

  if (plat === "youtube") {
    if (officialSocials && officialSocials.youtube) return officialSocials.youtube;
    // Fallback: Clean restaurant food review/vlog search without weird channel filters
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(queryBiz)}`;
  }

  return `https://www.google.com/maps/search/${encodeURIComponent(queryBiz)}`;
}

/**
 * Extract phone number from a website's HTML content
 */
function extractPhoneFromHtml(html) {
  if (!html || typeof html !== "string") return null;
  // 1. Check tel: links
  const telMatch = html.match(/href=["']tel:([^"']+)["']/i);
  if (telMatch && telMatch[1]) {
    const raw = telMatch[1].trim();
    if (raw.replace(/\D/g, "").length >= 8) return raw;
  }
  // 2. Mobile regex
  const mob = html.match(/(?:\+?91[\s\-]?)?[6-9]\d{4}[\s\-]?\d{5}\b/);
  if (mob) return mob[0].trim();
  // 3. Landline regex
  const land = html.match(/\b0\d{2,4}[\s\-]?\d{6,8}\b/);
  if (land) return land[0].trim();

  return null;
}

async function extractPhoneFromWebsite(websiteUrl) {
  if (!websiteUrl || typeof websiteUrl !== "string" || !websiteUrl.startsWith("http")) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3500);
  try {
    const res = await fetch(websiteUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml"
      }
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const html = await res.text();
    return extractPhoneFromHtml(html);
  } catch (_) {
    clearTimeout(timeoutId);
    return null;
  }
}

module.exports = {
  extractSocialsFromWebsite,
  parseSocialsFromHtml,
  resolveOfficialProfileUrl,
  extractPhoneFromWebsite
};
