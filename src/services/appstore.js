/**
 * App Store search rankings scraper.
 * Mirrors the logic in appstore_search_rankings.py but in Node.js.
 *
 * Flow:
 *  1. Fetch SSR HTML from apps.apple.com (same data the iPhone app uses)
 *  2. Extract ordered results from the embedded `serialized-server-data` JSON blob
 *  3. Resolve names/metadata for deferred IDs via iTunes Lookup API (batched)
 */

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config/index.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/144.0.0.0 Safari/537.36";

const LOOKUP_BATCH_SIZE = 200;
const LOOKUP_CONCURRENCY = 3;
const LOOKUP_DELAY_MS = 200;

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

// Singleton agent — reuses the proxy tunnel connection pool across all requests.
// Creating a new HttpsProxyAgent per request causes each call to open a fresh
// CONNECT tunnel, which overwhelms the proxy under concurrent load.
let _proxyAgent = null;
export function getProxyAgent() {
  if (!_proxyAgent) {
    _proxyAgent = new HttpsProxyAgent(config.proxyUrl, {
      keepAlive: true,
      maxSockets: config.proxyMaxSockets,
    });
  }
  return _proxyAgent;
}

/**
 * Destroy the singleton proxy agent, closing all keepAlive sockets.
 * Call between batches to prevent socket/buffer accumulation during
 * long-running bulk operations (mining). A fresh agent is lazily
 * created on the next getProxyAgent() call.
 */
export function resetProxyAgent() {
  if (_proxyAgent) {
    _proxyAgent.destroy();
    _proxyAgent = null;
  }
}

const PROXY_HEADERS = {
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "accept-language": "en-US,en;q=0.9",
  priority: "u=0, i",
  referer: "https://apps.apple.com/",
  "sec-ch-ua":
    '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
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
export async function fetchSearchHtmlViaProxy(
  term,
  country = "us",
  platform = "iphone",
) {
  const url = `https://apps.apple.com/${country}/${platform}/search?term=${encodeURIComponent(term)}`;

  if (!config.proxyUrl) {
    console.warn("[appstore] PROXY_URL not set — falling back to direct fetch");
    throw new Error("[appstore] PROXY_URL not set");
  }

  console.log(`[appstore] Fetching via proxy: ${url}`);

  const response = await axios.get(url, {
    httpsAgent: getProxyAgent(),
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
      // Subtitle lives in the display metadata — try known lockup paths
      const subtitle =
        lockup.metadata?.subtitle ??
        lockup.subtitle ??
        lockup.subtitleText ??
        fields.subtitle ??
        null;
      results.push({
        rank: results.length + 1,
        id: appId,
        name: fields.name ?? "",
        subtitle: subtitle ? decodeHtmlEntities(subtitle) : null,
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

export async function lookupAppMetadata(appIds, country = "us", redis = null) {
  if (appIds.length === 0) return {};

  const metadata = {};
  let uncachedIds = appIds;

  // Check Redis cache first
  if (redis) {
    const keys = appIds.map((id) => `itunes:meta:${country}:${id}`);
    try {
      const cached = await redis.mget(...keys);
      uncachedIds = [];
      for (let i = 0; i < appIds.length; i++) {
        if (cached[i]) {
          try {
            metadata[appIds[i]] = JSON.parse(cached[i]);
          } catch {}
        } else {
          uncachedIds.push(appIds[i]);
        }
      }
      if (uncachedIds.length < appIds.length) {
        console.log(
          `[appstore] iTunes metadata cache: ${appIds.length - uncachedIds.length} hits, ${uncachedIds.length} misses`,
        );
      }
    } catch (err) {
      console.warn(
        `[appstore] Redis MGET failed: ${err.message} — fetching all`,
      );
      uncachedIds = appIds;
    }
  }

  if (uncachedIds.length === 0) return metadata;

  // Build batches
  const batches = [];
  for (let i = 0; i < uncachedIds.length; i += LOOKUP_BATCH_SIZE) {
    batches.push(uncachedIds.slice(i, i + LOOKUP_BATCH_SIZE));
  }

  // Process batches in concurrent waves (LOOKUP_CONCURRENCY at a time)
  for (let i = 0; i < batches.length; i += LOOKUP_CONCURRENCY) {
    const wave = batches.slice(i, i + LOOKUP_CONCURRENCY);

    const waveResults = await Promise.all(
      wave.map(async (batch) => {
        const url = `https://itunes.apple.com/lookup?id=${batch.join(",")}&country=${country}`;
        try {
          const useProxyForLookup = !!config.proxyUrl;
          let data;
          if (useProxyForLookup) {
            const resp = await axios.get(url, {
              httpsAgent: getProxyAgent(),
              headers: { "User-Agent": USER_AGENT },
              timeout: 15000,
              responseType: "json",
            });
            data = resp.data;
          } else {
            const response = await fetch(url, {
              headers: { "User-Agent": USER_AGENT },
            });
            data = await response.json();
          }
          return data.results ?? [];
        } catch (err) {
          console.warn(`iTunes Lookup failed for batch: ${err.message}`);
          return [];
        }
      }),
    );

    // Merge results and cache new entries
    const toCache = {};
    for (const results of waveResults) {
      for (const result of results) {
        const id = String(result.trackId ?? "");
        if (!id) continue;
        const entry = {
          name: result.trackName ?? "",
          bundleId: result.bundleId ?? "",
          developer: result.artistName ?? "",
          price: result.formattedPrice ?? "",
          genre: result.primaryGenreName ?? "",
          rating: result.averageUserRating ?? null,
          ratingCount: result.userRatingCount ?? null,
          iconUrl: result.artworkUrl512 ?? result.artworkUrl100 ?? null,
          releaseDate: result.releaseDate ?? null,
          lastUpdated: result.currentVersionReleaseDate ?? null,
        };
        metadata[id] = entry;
        if (redis) toCache[id] = entry;
      }
    }

    if (redis && Object.keys(toCache).length > 0) {
      const pipeline = redis.pipeline();
      for (const [id, entry] of Object.entries(toCache)) {
        pipeline.setex(
          `itunes:meta:${country}:${id}`,
          config.cacheTtlItunesMeta,
          JSON.stringify(entry),
        );
      }
      pipeline
        .exec()
        .catch((err) =>
          console.warn(`[appstore] Redis cache write failed: ${err.message}`),
        );
    }

    // Small delay between waves (not after the last one)
    if (i + LOOKUP_CONCURRENCY < batches.length) {
      await new Promise((r) => setTimeout(r, LOOKUP_DELAY_MS));
    }
  }

  return metadata;
}

// ── Version history extractor ─────────────────────────────────────────────────

/**
 * @typedef {"keyword_rank"|"rating"|"review_count"|"visibility"} VersionEventType
 * @typedef {"up"|"down"|"neutral"} VersionEventDirection
 *
 * @typedef {object} VersionEvent
 * @property {VersionEventType}      type       - Signal category
 * @property {string}                label      - Human-readable summary, e.g. "+8 for AI Planner"
 * @property {number|null}           delta      - Numeric change (positive = improvement)
 * @property {VersionEventDirection} direction  - Derived direction of the change
 *
 * @typedef {"positive"|"negative"|"neutral"} VerdictType
 *
 * @typedef {object} VersionVerdict
 * @property {VerdictType}     type    - Overall verdict for this release window
 * @property {VersionEvent[]}  events  - Individual signals that drove the verdict
 */

/**
 * Parse the serialized-server-data blob from an app page HTML and return
 * the full version history array.
 *
 * Each entry: { version, releaseDate, releaseNotes, verdict }
 *   - version:      "1.0.12"
 *   - releaseDate:  ISO 8601 string, or null if unparseable
 *   - releaseNotes: string | null
 *   - verdict:      { type: "positive"|"negative"|"neutral", events: VersionEvent[] }
 *
 * verdict is scaffolded as neutral/empty for now. The goal is to backfill it
 * with real signal (keyword rank deltas, rating changes, visibility shifts)
 * measured in the window after each release.
 *
 * VersionEvent shape:
 *   {
 *     type: "keyword_rank" | "rating" | "review_count" | "visibility",
 *     label: string,          // human-readable summary, e.g. "+8 for AI Planner"
 *     delta: number | null,   // numeric change (positive = improvement)
 *     direction: "up" | "down" | "neutral",
 *   }
 *
 * Returns [] if the blob is absent or the shelf cannot be found.
 *
 * @param {string} html
 * @returns {Array<object>}
 */
function extractVersionHistory(html) {
  const blobMatch = html.match(
    /<script\s+type="application\/json"\s+id="serialized-server-data">\s*(\{.*?\})\s*<\/script>/s,
  );
  if (!blobMatch) return [];

  let blob;
  try {
    blob = JSON.parse(blobMatch[1]);
  } catch {
    return [];
  }

  const pageData = blob?.data?.[0]?.data;
  if (!pageData) return [];

  // App detail pages store shelves in shelfMapping (keyed by id), not in a shelves array
  const versionShelf = pageData.shelfMapping?.mostRecentVersion ?? null;
  if (!versionShelf) return [];

  // Full history is nested under seeAllAction.pageData — prefer it;
  // fall back to the single mostRecentVersion item when absent.
  const historyItems =
    versionShelf.seeAllAction?.pageData?.shelves?.[0]?.items ??
    versionShelf.items ??
    [];

  return historyItems
    .filter((item) => item.primarySubtitle)
    .map((item) => {
      // mostRecentVersion items prefix the version with "Version " — strip it.
      const version = item.primarySubtitle.replace(/^Version\s+/i, "").trim();

      let releaseDate = null;
      if (item.secondarySubtitle) {
        const parsed = new Date(item.secondarySubtitle);
        if (!isNaN(parsed.getTime())) releaseDate = parsed.toISOString();
      }

      return {
        version,
        releaseDate,
        releaseNotes: item.text ?? null,
        // Placeholder — will be populated by post-release signal analysis:
        // keyword rank deltas, rating changes, visibility shifts measured
        // in the ~14-day window after this version went live.
        verdict: {
          type: "neutral", // "positive" | "negative" | "neutral"
          events: [], // VersionEvent[]
        },
      };
    });
}

// ── Single-app page scraper ───────────────────────────────────────────────────

/**
 * Scrape rich metadata for a single app from its App Store HTML page.
 * Uses the `software-application` JSON-LD block embedded in the page.
 *
 * @param {string} appleId
 * @param {string} [country="us"]
 * @param {string|null} [proxyUrl=null] - Optional HTTP/HTTPS/SOCKS proxy URL
 * @returns {Promise<object|null>}
 */
export async function scrapeAppPageMetadata(
  appleId,
  country = "us",
  proxyUrl = null,
) {
  // Apple redirects placeholder slugs to the real URL automatically
  const url = `https://apps.apple.com/${country}/app/a/id${appleId}`;

  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: `geo=${country.toUpperCase()}`,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
  };

  let html;
  if (proxyUrl) {
    // Use axios + the shared singleton agent so requests actually route through
    // the proxy. Native fetch ignores the `agent` option (undici-backed), so
    // using fetch here bypasses the proxy and hits Apple direct — causing 429s.
    let resp;
    try {
      resp = await axios.get(url, {
        httpsAgent: getProxyAgent(),
        headers,
        timeout: 15000,
        responseType: "text",
        maxRedirects: 5,
      });
    } catch (err) {
      if (err.response?.status === 404) return null;
      throw new Error(`HTTP ${err.response?.status ?? "?"} fetching app page`);
    }
    html = resp.data;
  } else {
    const response = await fetch(url, { headers, redirect: "follow" });
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`HTTP ${response.status} fetching app page`);
    }
    html = await response.text();
  }

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
  const subtitle = subtitleMatch?.[1]?.trim()
    ? decodeHtmlEntities(subtitleMatch[1].trim())
    : null;

  // --- og:image (social/share banner, different from icon) ---
  const ogImageMatch = html.match(
    /<meta\s+property="og:image"\s+content="([^"]+)"/,
  );
  const socialImageUrl = ogImageMatch?.[1] ?? null;

  // --- canonical URL ---
  const canonicalMatch = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/);
  const appStoreUrl = canonicalMatch?.[1] ?? null;

  // --- version history (serialized-server-data blob) ---
  const versionHistory = extractVersionHistory(html);

  // --- rating breakdown (histogram bars) ---
  // Apple renders bars with aria-label="5 star, 90%" (percentage, singular "star")
  const ratingBreakdown = {};
  const barRe = /aria-label="(\d) star,\s*([\d.]+)%"/g;
  let barMatch;
  while ((barMatch = barRe.exec(html)) !== null) {
    ratingBreakdown[parseInt(barMatch[1], 10)] = parseFloat(barMatch[2]);
  }
  const hasBreakdown = Object.keys(ratingBreakdown).length === 5;
  const reviewCount = ld.aggregateRating?.reviewCount ?? null;

  let ratingBreakdownFinal = null;
  if (hasBreakdown) {
    ratingBreakdownFinal = {};
    for (const [star, pct] of Object.entries(ratingBreakdown)) {
      ratingBreakdownFinal[star] = {
        percentage: pct,
        count:
          reviewCount !== null ? Math.round((reviewCount * pct) / 100) : null,
      };
    }
  }

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
    reviewCount,
    developer: ld.author?.name ?? null,
    developerUrl: ld.author?.url ?? null,
    appStoreUrl,
    ratingBreakdown: ratingBreakdownFinal,
    versionHistory,
  };
}

// ── Lightweight name+subtitle scraper (for mining) ──────────────────────────

/**
 * Scrape ONLY name + subtitle from an app page. Skips version history,
 * rating breakdown, description, and all other heavy parsing.
 * Designed for high-concurrency bulk scraping (mining service).
 *
 * @param {string} appleId
 * @param {string} [country="us"]
 * @param {string|null} [proxyUrl=null]
 * @returns {Promise<{ name: string, subtitle: string|null } | null>}
 */
export async function scrapeAppNameSubtitle(
  appleId,
  country = "us",
  proxyUrl = null,
) {
  const url = `https://apps.apple.com/${country}/app/a/id${appleId}`;
  const t0 = performance.now();

  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: `geo=${country.toUpperCase()}`,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
  };

  let html;
  if (proxyUrl) {
    let resp;
    try {
      resp = await axios.get(url, {
        httpsAgent: getProxyAgent(),
        headers,
        timeout: 15000,
        responseType: "text",
        maxRedirects: 5,
      });
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      console.log(
        `[scrape] ${appleId} (${country}): ERROR ${err.response?.status ?? "?"} — ${ms}ms`,
      );
      if (err.response?.status === 404) return null;
      throw new Error(`HTTP ${err.response?.status ?? "?"} fetching app page`);
    }
    html = resp.data;
    resp.data = null; // release response buffer immediately
  } else {
    const response = await fetch(url, { headers, redirect: "follow" });
    if (!response.ok) {
      const ms = Math.round(performance.now() - t0);
      console.log(
        `[scrape] ${appleId} (${country}): ERROR ${response.status} — ${ms}ms`,
      );
      if (response.status === 404) return null;
      throw new Error(`HTTP ${response.status} fetching app page`);
    }
    html = await response.text();
  }
  const ms = Math.round(performance.now() - t0);
  if (ms > 3000) console.log(`[scrape] SLOW ${appleId} (${country}): ${ms}ms`);

  // Extract name from the software-application JSON-LD block specifically.
  // MUST NOT use html.match(/"name":...) — the page contains multiple JSON-LD
  // blocks and the very first "name" key belongs to the Apple website itself
  // ("App Store"), not the individual app.
  // IMPORTANT: regex match groups are V8 "sliced strings" that retain the entire
  // parent HTML buffer (~300KB). We must copy them to detach from the buffer,
  // otherwise 6000+ entries in knownMeta × 300KB = 1.8GB retained.
  const ldMatch =
    html.match(
      /<script\s[^>]*id=["']?software-application["']?[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i,
    ) ??
    html.match(
      /<script\s[^>]*type=["']application\/ld\+json["'][^>]*id=["']?software-application["']?[^>]*>([\s\S]*?)<\/script>/i,
    );
  const nameMatch = ldMatch?.[1]?.match(/"name"\s*:\s*"([^"]+)"/);
  const name = nameMatch?.[1] ? (" " + nameMatch[1]).slice(1) : null;

  // Extract subtitle from HTML
  const subtitleMatch = html.match(/<h2\s+class="subtitle[^"]*">([^<]+)<\/h2>/);
  const rawSubtitle = subtitleMatch?.[1]?.trim();
  const subtitle = rawSubtitle
    ? (" " + decodeHtmlEntities(rawSubtitle)).slice(1)
    : null;

  // Release HTML string immediately
  html = null;

  if (!name) return null;
  return { name, subtitle };
}

// ── Single-app iTunes Lookup (exported) ──────────────────────────────────────

/**
 * Fetch metadata + rating for a single app from the iTunes Lookup API.
 * Returns null if the app is not found.
 *
 * @param {string} appleId
 * @param {string} [country="us"]
 * @param {string|null} [proxyUrl=null] - Optional HTTP/HTTPS/SOCKS proxy URL
 * @returns {Promise<object|null>}
 */
export async function fetchAppMetadata(
  appleId,
  country = "us",
  proxyUrl = null,
) {
  const meta = await scrapeAppPageMetadata(appleId, country, proxyUrl);
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

// ── URL parsing ──────────────────────────────────────────────────────────────

/**
 * Extract the numeric Apple ID from an App Store URL.
 * e.g. "https://apps.apple.com/us/app/my-app/id123456789" → "123456789"
 */
export function parseAppleIdFromUrl(storeUrl) {
  const match = storeUrl.match(/\/id(\d+)/);
  return match ? match[1] : null;
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
  useProxy = false,
}) {
  const html = useProxy
    ? await fetchSearchHtmlViaProxy(keyword, country, platform)
    : await fetchSearchHtml(keyword, country, platform);
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
      result.releaseDate = m.releaseDate;
      result.lastUpdated = m.lastUpdated;
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
      allResults[i].releaseDate = m.releaseDate;
      allResults[i].lastUpdated = m.lastUpdated;
    }
  }

  return { allResults, topMetadata };
}
