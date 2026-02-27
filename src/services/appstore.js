/**
 * App Store search rankings scraper.
 * Mirrors the logic in appstore_search_rankings.py but in Node.js.
 *
 * Flow:
 *  1. Fetch SSR HTML from apps.apple.com (same data the iPhone app uses)
 *  2. Extract ordered results from the embedded `serialized-server-data` JSON blob
 *  3. Resolve names/metadata for deferred IDs via iTunes Lookup API (batched)
 */

import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config/index.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/144.0.0.0 Safari/537.36";

const LOOKUP_BATCH_SIZE = 150;

// ── Step 1 ──────────────────────────────────────────────────────────────────

export async function fetchSearchHtml(
  term,
  country = "us",
  platform = "iphone",
  { signal } = {},
) {
  console.log(`[appstore] Fetching search HTML for ${term} at ${Date.now()}`);
  const url = `https://apps.apple.com/${country}/${platform}/search?term=${encodeURIComponent(term)}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: `geo=${country.toUpperCase()}`,
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching App Store search page`);
  }

  return response.text();
}

// ── Proxy fetch ──────────────────────────────────────────────────────────────

const PROXY_HEADERS = {
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "accept-language": "en-US,en;q=0.9",
  priority: "u=0, i",
  referer: "https://apps.apple.com/",
  "sec-ch-ua": '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "same-origin",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  cookie: "geo=US",
};

/**
 * Fetch App Store search HTML via a configured HTTPS proxy.
 * Falls back to a direct fetch if PROXY_URL is not set.
 *
 * @param {string} term
 * @param {string} [country="us"]
 * @param {string} [platform="iphone"]
 * @returns {Promise<string>} HTML string
 */
export async function fetchSearchHtmlViaProxy(term, country = "us", platform = "iphone") {
  const url = `https://apps.apple.com/${country}/${platform}/search?term=${encodeURIComponent(term)}`;

  if (!config.proxyUrl) {
    console.warn("[appstore] PROXY_URL not set — falling back to direct fetch");
    throw new Error("[appstore] PROXY_URL not set");
  }

  console.log(`[appstore] Fetching via proxy: ${url}`);
  const agent = new HttpsProxyAgent(config.proxyUrl);

  const response = await axios.get(url, {
    httpsAgent: agent,
    headers: PROXY_HEADERS,
    timeout: 10000,
    responseType: "text",
  });

  return response.data;
}

// ── Step 2 ──────────────────────────────────────────────────────────────────

export function extractSearchResults(html) {
  const pattern =
    /<script\s+type="application\/json"\s+id="serialized-server-data">\s*(\{.*?\})\s*<\/script>/s;
  const match = html.match(pattern);

  if (!match) {
    throw new Error(
      "Could not find serialized-server-data in HTML. Apple may have changed their page structure.",
    );
  }

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch (err) {
    throw new Error(
      `Failed to parse serialized-server-data JSON: ${err.message}`,
    );
  }

  const pageData = data?.data?.[0]?.data;
  if (!pageData) {
    throw new Error("Unexpected JSON structure in serialized-server-data.");
  }

  const results = [];

  // First ~12 items: fully rendered with metadata
  const shelves = pageData.shelves ?? [];
  for (const shelf of shelves) {
    if (shelf.contentType !== "searchResult") continue;
    for (const item of shelf.items ?? []) {
      const lockup = item.lockup;
      if (!lockup) continue;
      const fields = lockup.impressionMetrics?.fields ?? {};
      const rawId = fields.id ?? "";
      const appId = rawId.includes("::") ? rawId.split("::")[0] : rawId;
      results.push({
        rank: results.length + 1,
        id: appId,
        name: fields.name ?? "",
        bundleId: fields.bundleId ?? "",
        impressionIndex: fields.impressionIndex ?? null,
      });
    }
  }

  // Deferred results: ordered IDs only (the "nextPage")
  const nextPage = pageData.nextPage;
  if (nextPage && typeof nextPage === "object") {
    for (const item of nextPage.results ?? []) {
      if (item.type === "apps") {
        results.push({
          rank: results.length + 1,
          id: item.id,
          name: "",
          bundleId: "",
          impressionIndex: null,
        });
      }
    }
  }

  return results;
}

// ── Step 3 ──────────────────────────────────────────────────────────────────

export async function lookupAppMetadata(appIds, country = "us") {
  const metadata = {};

  for (let i = 0; i < appIds.length; i += LOOKUP_BATCH_SIZE) {
    const batch = appIds.slice(i, i + LOOKUP_BATCH_SIZE);
    const url = `https://itunes.apple.com/lookup?id=${batch.join(",")}&country=${country}`;

    let data;
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
      });
      data = await response.json();
    } catch (err) {
      // Non-fatal: skip this batch, names will be empty
      console.warn(`iTunes Lookup failed for batch ${i}: ${err.message}`);
      continue;
    }

    for (const result of data.results ?? []) {
      const id = String(result.trackId ?? "");
      if (!id) continue;
      metadata[id] = {
        name: result.trackName ?? "",
        bundleId: result.bundleId ?? "",
        developer: result.artistName ?? "",
        price: result.formattedPrice ?? "",
        genre: result.primaryGenreName ?? "",
        rating: result.averageUserRating ?? null,
        ratingCount: result.userRatingCount ?? null,
        iconUrl: result.artworkUrl512 ?? result.artworkUrl100 ?? null,
      };
    }

    // Be nice to Apple's servers between batches
    if (i + LOOKUP_BATCH_SIZE < appIds.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return metadata;
}

// ── Single-app page scraper ───────────────────────────────────────────────────

/**
 * Scrape rich metadata for a single app from its App Store HTML page.
 * Uses the `software-application` JSON-LD block embedded in the page.
 *
 * @param {string} appleId
 * @param {string} [country="us"]
 * @returns {Promise<object|null>}
 */
export async function scrapeAppPageMetadata(appleId, country = "us") {
  // Apple redirects placeholder slugs to the real URL automatically
  const url = `https://apps.apple.com/${country}/app/a/id${appleId}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: `geo=${country.toUpperCase()}`,
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`HTTP ${response.status} fetching app page`);
  }

  const html = await response.text();

  // --- JSON-LD: software-application ---
  const ldMatch =
    html.match(
      /<script\s[^>]*id=["']?software-application["']?[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i,
    ) ??
    html.match(
      /<script\s[^>]*type=["']application\/ld\+json["'][^>]*id=["']?software-application["']?[^>]*>([\s\S]*?)<\/script>/i,
    );

  if (!ldMatch) return null;

  let ld;
  try {
    ld = JSON.parse(ldMatch[1].trim());
  } catch {
    return null;
  }

  // --- subtitle (HTML body — not present in JSON-LD) ---
  const subtitleMatch = html.match(/<h2\s+class="subtitle[^"]*">([^<]+)<\/h2>/);
  const subtitle = subtitleMatch?.[1]?.trim() ?? null;

  // --- og:image (social/share banner, different from icon) ---
  const ogImageMatch = html.match(
    /<meta\s+property="og:image"\s+content="([^"]+)"/,
  );
  const socialImageUrl = ogImageMatch?.[1] ?? null;

  // --- canonical URL ---
  const canonicalMatch = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/);
  const appStoreUrl = canonicalMatch?.[1] ?? null;

  return {
    name: ld.name ?? null,
    subtitle,
    description: ld.description ?? null,
    iconUrl: ld.image ?? null,
    socialImageUrl,
    availableOnDevice: ld.availableOnDevice ?? null,
    operatingSystem: ld.operatingSystem ?? null,
    price: ld.offers?.price ?? null,
    priceCurrency: ld.offers?.priceCurrency ?? null,
    isFree: ld.offers?.category === "free",
    genre: ld.applicationCategory ?? null,
    rating: ld.aggregateRating?.ratingValue ?? null,
    reviewCount: ld.aggregateRating?.reviewCount ?? null,
    developer: ld.author?.name ?? null,
    developerUrl: ld.author?.url ?? null,
    appStoreUrl,
  };
}

// ── Single-app iTunes Lookup (exported) ──────────────────────────────────────

/**
 * Fetch metadata + rating for a single app from the iTunes Lookup API.
 * Returns null if the app is not found.
 *
 * @param {string} appleId
 * @param {string} [country="us"]
 * @returns {Promise<object|null>}
 */
export async function fetchAppMetadata(appleId, country = "us") {
  const meta = await scrapeAppPageMetadata(appleId, country);
  if (!meta) return null;

  // Format price as a display string (same shape callers expect)
  const price = meta.isFree
    ? "Free"
    : meta.price != null
      ? `${meta.priceCurrency} ${meta.price}`
      : "";

  return {
    // ── existing fields (backwards-compatible) ──
    name: meta.name ?? "",
    bundleId: "", // not available from HTML — DB COALESCE keeps existing value
    developer: meta.developer ?? "",
    price,
    genre: meta.genre ?? "",
    rating: meta.rating,
    ratingCount: meta.reviewCount,
    iconUrl: meta.iconUrl,
    // ── new fields ──
    subtitle: meta.subtitle,
    description: meta.description,
    developerUrl: meta.developerUrl,
    socialImageUrl: meta.socialImageUrl,
    availableOnDevice: meta.availableOnDevice,
    operatingSystem: meta.operatingSystem,
    isFree: meta.isFree,
    priceCurrency: meta.priceCurrency,
    appStoreUrl: meta.appStoreUrl,
  };
}

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * Fetch App Store search rankings for a keyword.
 *
 * @param {object} opts
 * @param {string} opts.keyword
 * @param {string} [opts.country="us"]
 * @param {string} [opts.platform="iphone"]  "iphone" | "ipad"
 * @param {number} [opts.limit=50]
 * @returns {Promise<Array>}
 */
export async function getSearchRankings({
  keyword,
  country = "us",
  platform = "iphone",
  limit = 50,
}) {
  const html = await fetchSearchHtml(keyword, country, platform);
  let results = extractSearchResults(html);
  results = results.slice(0, limit);

  // Look up all IDs — the first ~12 already have name/bundleId from SSR but
  // lack developer, genre, rating, etc. which only come from iTunes Lookup.
  const allIds = results.map((r) => r.id);
  const metadata = await lookupAppMetadata(allIds, country);
  for (const result of results) {
    const m = metadata[result.id];
    if (m) {
      result.name = result.name || m.name;
      result.bundleId = result.bundleId || m.bundleId;
      result.developer = m.developer;
      result.price = m.price;
      result.genre = m.genre;
      result.rating = m.rating;
      result.ratingCount = m.ratingCount;
      result.iconUrl = m.iconUrl;
    }
  }

  return results;
}

/**
 * Lightweight scraper: fetch rankings + metadata for TOP N apps only.
 * Optimized for speed — reduces iTunes Lookup API calls by ~80%.
 *
 * @param {object} opts
 * @param {string} opts.keyword
 * @param {string} [opts.country="us"]
 * @param {string} [opts.platform="iphone"]  "iphone" | "ipad"
 * @param {number} [opts.limit=50]
 * @param {number} [opts.topN=10]
 * @returns {Promise<{allResults: Array, topMetadata: object}>}
 *   - allResults: [{rank, id, name, bundleId, ...}] for all apps (only top N enriched)
 *   - topMetadata: {appId: {name, rating, ratingCount, ...}} for top N apps only
 */
export async function getSearchRankingsLite({
  keyword,
  country = "us",
  platform = "iphone",
  limit = 50,
  topN = 10,
}) {
  // Step 1: Scrape HTML (same as getSearchRankings)
  const html = await fetchSearchHtml(keyword, country, platform);

  // Step 2: Extract all IDs + ranks from SSR JSON
  let allResults = extractSearchResults(html);
  allResults = allResults.slice(0, limit);

  // Step 3: Call iTunes Lookup for top N only (instead of all 50)
  const topIds = allResults.slice(0, topN).map((r) => r.id);
  const topMetadata = await lookupAppMetadata(topIds, country);

  // Merge metadata into top results only
  for (let i = 0; i < Math.min(topN, allResults.length); i++) {
    const appId = allResults[i].id;
    const m = topMetadata[appId];
    if (m) {
      allResults[i].name = allResults[i].name || m.name;
      allResults[i].bundleId = allResults[i].bundleId || m.bundleId;
      allResults[i].developer = m.developer;
      allResults[i].price = m.price;
      allResults[i].genre = m.genre;
      allResults[i].rating = m.rating;
      allResults[i].ratingCount = m.ratingCount;
      allResults[i].iconUrl = m.iconUrl;
    }
  }

  return { allResults, topMetadata };
}
