/**
 * Keyword popularity scoring.
 *
 * Score (5-95) is built from three signals:
 *   - Prefix depth  (80%) — how short a prefix triggers the keyword in Apple suggest
 *   - Position      (15%) — rank of the keyword in the suggestion list
 *   - Apple Ads     (up to +5 bonus) — Apple's own 1-100 popularity score
 *
 * Both external APIs are authenticated and rate-limited — responses are cached
 * aggressively in Redis.
 */

import axios from "axios";
import { CacheService } from "./cache.js";
import { config } from "../config/index.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/144.0.0.0 Safari/537.36";

const APPLE_ADS_BATCH_SIZE = 100; // Apple Ads API accepts up to 100 terms per request

/** Thrown when Apple Suggest API returns 429 after all retries are exhausted. */
class RateLimitError extends Error {
  constructor(prefix) {
    super(`Suggest API rate limited for prefix "${prefix}"`);
    this.name = "RateLimitError";
  }
}

// ── Signal 1 & 2: Apple Suggest API ─────────────────────────────────────────

/**
 * Fetch autocomplete suggestions for a single prefix from Apple's search suggest API.
 * Results are cached in Redis for 48 hours (very stable, shared across keywords).
 *
 * @param {string} prefix
 * @param {string} storefront  - 2-letter country code, e.g. "us"
 * @param {string} platform    - "iphone" | "ipad"
 * @param {string} mediaApiToken - long-lived Bearer token from Apple's JS bundle
 * @param {object} redis       - ioredis client (fastify.redis)
 * @returns {Promise<Array<{term, source, position}>>}
 */
export async function fetchSuggestions(
  prefix,
  storefront,
  platform,
  mediaApiToken,
  redis,
  httpsAgent = null
) {
  const cache = new CacheService(redis);
  const cacheKey = `suggest:${storefront}:${platform}:${prefix.toLowerCase()}`;

  if (config.cacheTtlSuggest > 0) {
    const cached = await cache.get(cacheKey);
    if (cached) return cached;
  }

  const url =
    `https://amp-api-edge.apps.apple.com/v1/catalog/${storefront}` +
    `/search/suggestions?term=${encodeURIComponent(
      prefix
    )}&kinds=terms&platform=${platform}&limit=10`;

  const headers = {
    Authorization: `Bearer ${mediaApiToken}`,
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    Origin: "https://apps.apple.com",
    "Accept-Language": "en-US,en;q=0.9",
  };

  const MAX_RETRIES = config.suggestMaxRetries ?? 5;
  const BASE_DELAY_MS = config.suggestBaseDelayMs ?? 1000;
  const MAX_DELAY_MS = config.suggestMaxDelayMs ?? 30000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      let status, data;

      if (httpsAgent) {
        // Route through proxy when an agent is provided
        const axiosRes = await axios.get(url, {
          headers,
          httpsAgent,
          timeout: 10000,
          responseType: "json",
        });
        status = axiosRes.status;
        data = axiosRes.data;
      } else {
        const fetchRes = await fetch(url, { headers });
        status = fetchRes.status;
        data = status < 400 ? await fetchRes.json() : null;
      }

      if (status === 429) {
        if (attempt === MAX_RETRIES) {
          throw new RateLimitError(prefix);
        }
        const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * BASE_DELAY_MS);
        const delayMs = Math.min(exponential + jitter, MAX_DELAY_MS);
        console.warn(
          `[popularity] fetchSuggestions 429 for "${prefix}", retry ${attempt + 1}/${MAX_RETRIES} in ${delayMs}ms`
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      if (status >= 400) {
        // Non-429 errors: non-fatal, return empty
        console.warn(
          `[popularity] fetchSuggestions HTTP ${status} for "${prefix}"`
        );
        return [];
      }

      // Response shape: { results: { suggestions: [{ displayTerm, kind, source }, ...] } }
      // Filter to keyword-only suggestions (exclude app/editorial/developer entries
      // which have an "entity" or "context" field — they skew position counts)
      const all = data?.results?.suggestions ?? [];
      const terms = all.filter((t) => !t.entity && !t.context);
      const suggestions = terms.map((t, idx) => ({
        term: (t.displayTerm ?? t.term ?? "").toLowerCase(),
        source: String(t.source ?? "9"),
        position: idx + 1,
      }));

      if (config.cacheTtlSuggest > 0) {
        await cache.set(cacheKey, suggestions, config.cacheTtlSuggest);
      }
      return suggestions;
    } catch (err) {
      if (err instanceof RateLimitError) throw err; // propagate to caller
      // Network or other unexpected errors: non-fatal
      console.warn(
        `[popularity] fetchSuggestions failed for "${prefix}": ${err.message}`
      );
      return [];
    }
  }
}

/**
 * Binary-search over prefix lengths to find the shortest prefix where the
 * keyword first appears in Apple's autocomplete suggestions.
 *
 * Reduces API calls from O(n) to O(log n) — ~4 calls for a 12-char keyword.
 *
 * @returns {{ prefixLength: number, position: number, source: string } | null}
 */
async function findFirstAppearance(
  keyword,
  storefront,
  platform,
  mediaApiToken,
  redis,
  httpsAgent = null
) {
  const norm = keyword.toLowerCase().trim();
  const totalLen = norm.length;

  if (totalLen === 0) return null;

  /**
   * Check whether `norm` appears in suggestions for the given prefix length.
   * Returns the match metadata (including suggestionCount) if found, null otherwise.
   *
   * Three match tiers:
   *   1. Primary: exact match or suggestion starts with the keyword
   *   2. Stem: keyword and a suggestion share ≥80% common prefix
   *      (e.g. "subscriptions" ↔ "subscription manager"). Flagged with `stemMatch: true`.
   *   3. Word-boundary: keyword appears as a whole word inside a suggestion
   *      (e.g. "game" in "pigeon game"). Flagged with `wordBoundary: true`.
   */
  const wordBoundaryRe = new RegExp(`(?:^|\\s)${norm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`);
  const STEM_RATIO = 0.8;

  async function check(prefixLen) {
    const prefix = norm.slice(0, prefixLen);
    const suggestions = await fetchSuggestions(
      prefix,
      storefront,
      platform,
      mediaApiToken,
      redis,
      httpsAgent
    );
    // Tier 1 — Primary: exact or starts-with
    const primary = suggestions.find(
      (s) => s.term === norm || s.term.startsWith(norm)
    );
    if (primary) return { ...primary, suggestionCount: suggestions.length, suggestions, stemMatch: false, wordBoundary: false };

    // Tier 2 — Stem: keyword and suggestion share a long common prefix (≥80%)
    // Catches plural/singular, -ing/-tion variants without language-specific rules
    const minShared = Math.ceil(norm.length * STEM_RATIO);
    const stem = suggestions.find((s) => {
      const limit = Math.min(norm.length, s.term.length);
      let shared = 0;
      while (shared < limit && norm[shared] === s.term[shared]) shared++;
      return shared >= minShared;
    });
    if (stem) return { ...stem, suggestionCount: suggestions.length, suggestions, stemMatch: true, wordBoundary: false };

    // Tier 3 — Word-boundary: keyword as a whole word inside a suggestion
    const secondary = suggestions.find((s) => wordBoundaryRe.test(s.term));
    if (secondary) return { ...secondary, suggestionCount: suggestions.length, suggestions, stemMatch: false, wordBoundary: true };

    return null;
  }

  // Binary search: find the shortest prefix where the keyword appears
  let lo = 1;
  let hi = totalLen;
  let bestMatch = null;

  // First check full length — if it never appears at all, exit early
  const fullMatch = await check(totalLen);
  if (!fullMatch) return null;

  bestMatch = { ...fullMatch, prefixLength: totalLen };

  // Binary search for shorter prefix
  lo = 1;
  hi = totalLen - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    let match;
    try {
      match = await check(mid);
    } catch (err) {
      if (err instanceof RateLimitError) {
        // Rate limited while trying to find an even shorter prefix.
        // Return the best match we already have rather than discarding it.
        console.warn(
          `[popularity] Rate limited at prefix length ${mid} for "${norm}", returning best match so far (prefixLength=${bestMatch.prefixLength})`
        );
        break;
      }
      throw err;
    }
    if (match) {
      bestMatch = { ...match, prefixLength: mid };
      hi = mid - 1; // try even shorter
    } else {
      lo = mid + 1; // need longer prefix
    }
  }

  return bestMatch;
}

// ── Signal 4: Apple Search Ads Popularity API ────────────────────────────────

/**
 * Fetch popularity scores for a batch of keywords from Apple Search Ads.
 * Returns a Map<normTerm, popularityScore>.
 *
 * Results are cached per-term for 24 hours.
 *
 * @param {string[]} terms
 * @param {string} storefront
 * @param {string} cookie        - full Apple Ads session cookie string
 * @param {string} xsrfToken     - x-xsrf-token-cm header value
 * @param {string} adamId        - your app's Apple ID (in the URL)
 * @param {object} redis
 */
async function fetchAppleAdsPopularity(
  terms,
  storefront,
  cookie,
  xsrfToken,
  adamId,
  redis
) {
  const cache = new CacheService(redis);
  const storeUpper = storefront.toUpperCase();
  const resultMap = new Map();

  // Split into which terms need fresh fetch vs. which are already cached
  const uncached = [];
  for (const term of terms) {
    const cacheKey = `apple-pop:${storefront}:${term.toLowerCase().trim()}`;
    const cached = await cache.get(cacheKey);
    if (cached !== null) {
      resultMap.set(term.toLowerCase().trim(), cached);
      continue;
    }
    uncached.push(term);
  }

  if (!uncached.length) return resultMap;

  // Batch in groups of APPLE_ADS_BATCH_SIZE
  for (let i = 0; i < uncached.length; i += APPLE_ADS_BATCH_SIZE) {
    const batch = uncached.slice(i, i + APPLE_ADS_BATCH_SIZE);
    const url = `https://app-ads.apple.com/cm/api/v2/keywords/popularities?adamId=${adamId}`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en_US",
          Cookie: cookie,
          "x-xsrf-token-cm": xsrfToken,
          "User-Agent": USER_AGENT,
          Origin: "https://app-ads.apple.com",
        },
        body: JSON.stringify({ storefronts: [storeUpper], terms: batch }),
      });

      if (!response.ok) {
        throw new Error(`Apple Ads API HTTP ${response.status}`);
      }

      const data = await response.json();
      for (const item of data?.data ?? []) {
        const normTerm = item.name.toLowerCase().trim();
        const score = item.popularity ?? null;
        resultMap.set(normTerm, score);
        await cache.set(
          `apple-pop:${storefront}:${normTerm}`,
          score,
          config.cacheTtlApplePop
        );
      }
    } catch (err) {
      console.warn(`[popularity] Apple Ads batch ${i} failed: ${err.message}`);
      // Continue — missing terms will just have no bonus
    }
  }

  return resultMap;
}

// ── Main scoring function ────────────────────────────────────────────────────

/**
 * Calculate popularity score (1-100) for a single keyword.
 *
 * @param {string} keyword
 * @param {string} storefront
 * @param {string} platform
 * @param {object} deps
 * @param {object} deps.redis
 * @param {string} [deps.mediaApiToken]
 * @param {string} [deps.appleAdsCookie]
 * @param {string} [deps.appleAdsXsrfToken]
 * @param {string} [deps.appleAdsAdamId]
 * @returns {Promise<number>} score 1-100
 */
export async function calculatePopularity(keyword, storefront, platform, deps) {
  const {
    redis,
    mediaApiToken,
    appleAdsCookie,
    appleAdsXsrfToken,
    appleAdsAdamId,
    httpsAgent = null,
  } = deps;
  const norm = keyword.toLowerCase().trim();
  const totalLen = norm.length;

  let prefixScore = 0;
  let positionScore = 0;
  let appearance = null;
  let isSparse = false;
  let ambiguityRatio = 1;
  let ambiguityMultiplier = 1;

  try {
    // Signal 1 & 2: prefix depth + position (requires APPLE_MEDIA_API_TOKEN)
    if (mediaApiToken) {
      let _appearance;
      try {
        _appearance = await findFirstAppearance(
          norm,
          storefront,
          platform,
          mediaApiToken,
          redis,
          httpsAgent
        );
      } catch (err) {
        if (err instanceof RateLimitError) {
          // Suggest API is rate-limited — fall through to Apple Ads-only score,
          // or return null if Ads are also unavailable.
          console.warn(
            `[popularity] Suggest API rate limited for "${keyword}", falling back to Apple Ads only`
          );
          _appearance = "rate_limited";
        } else {
          throw err;
        }
      }

      if (_appearance === "rate_limited") {
        // Fall back to Apple Ads score only, or null if unavailable
        if (appleAdsCookie && appleAdsXsrfToken && appleAdsAdamId) {
          const popMap = await fetchAppleAdsPopularity(
            [keyword],
            storefront,
            appleAdsCookie,
            appleAdsXsrfToken,
            appleAdsAdamId,
            redis
          );
          const appleRawScore = popMap.get(norm) ?? null;
          if (appleRawScore === null) return { score: null, breakdown: { rateLimited: true, appleAdsUnavailable: true } };
          const score = Math.max(1, Math.min(100, Math.round(appleRawScore)));
          return { score, breakdown: { rateLimited: true, appleRawScore, score } };
        }
        return { score: null, breakdown: { rateLimited: true, appleAdsUnavailable: true } };
      }

      appearance = _appearance;
      if (!appearance) return { score: 5, breakdown: { notFoundInSuggest: true } };

      const ratio = appearance.prefixLength / totalLen;
      // Absolute: each extra char needed costs 15 points (1 char=100, 2=85, 3=70, …)
      // Ratio: what fraction of the word was needed (favours long phrases)
      // Take the higher — short words benefit from absolute, long phrases from ratio
      const ratioScore = Math.round((1 - ratio) * 100);
      const absoluteScore = Math.max(0, 100 - (appearance.prefixLength - 1) * 15);
      prefixScore = Math.max(absoluteScore, ratioScore);

      // Ambiguity penalty: if the matching prefix is shared by many unrelated
      // suggestions, the early appearance reflects prefix popularity (brand
      // families, common words) rather than specific keyword demand.
      if (appearance.suggestions && appearance.suggestions.length > 1) {
        const kwTokens = norm.split(/\s+/).filter(t => t.length > 0);
        if (kwTokens.length > 0) {
          const wordRe = /[a-z0-9]+/g;
          const relatedCount = appearance.suggestions.filter(s => {
            const sWords = s.term.match(wordRe) || [];
            const matched = kwTokens.filter(t =>
              sWords.some(w => w.startsWith(t) || t.startsWith(w))
            );
            return matched.length === kwTokens.length;
          }).length;

          ambiguityRatio = relatedCount / appearance.suggestions.length;
          const depthRatio = appearance.prefixLength / totalLen;
          // High ambiguity + early prefix → strong penalty
          // High ambiguity + late prefix → mild penalty (intent already specific)
          // Low ambiguity → no penalty regardless of depth
          ambiguityMultiplier = Math.max(0.2, 1 - (1 - ambiguityRatio) * (1 - depthRatio));
          prefixScore = Math.round(prefixScore * ambiguityMultiplier);
        }
      }

      // Stem matches (e.g. "subscriptions" via "subscription manager") —
      // same intent, slight discount (15%) for inexact morphological match
      if (appearance.stemMatch) {
        prefixScore = Math.round(prefixScore * 0.85);
      }
      // Word-boundary matches (keyword found inside a suggestion, not as prefix)
      // are a weaker signal — apply 40% discount
      if (appearance.wordBoundary) {
        prefixScore = Math.round(prefixScore * 0.6);
      }
      positionScore = Math.max(
        0,
        Math.round(100 - (appearance.position - 1) * 15)
      );

      // Density check: if very few suggestions appeared at the matching prefix,
      // this is likely an app-name auto-completion, not a real search query.
      // Zero out prefix/position to prevent inflation of brand/unique terms.
      isSparse = appearance.suggestionCount <= config.popLowDensityThreshold;
      if (isSparse) {
        prefixScore = 0;
        positionScore = 0;
      }
    } else {
      prefixScore = 50;
      positionScore = 50;
    }

    let appleRawScore = 5; // default
    let appleAdsDataAvailable = false;
    const hasAppleAds = !!(appleAdsCookie && appleAdsXsrfToken && appleAdsAdamId);

    // Signal 4: Apple Ads popularity bonus
    if (hasAppleAds) {
      const popMap = await fetchAppleAdsPopularity(
        [keyword],
        storefront,
        appleAdsCookie,
        appleAdsXsrfToken,
        appleAdsAdamId,
        redis
      );
      const fetched = popMap.get(norm);
      if (fetched != null) {
        appleRawScore = fetched;
        appleAdsDataAvailable = true;
      }
      // If fetched is null, Apple Ads API failed (e.g. 403) — don't use default as signal
    }

    // Calculate additive Apple Ads bonus (max +5 points)
    const appleAdd =
      appleRawScore > 5
        ? Math.min(5, Math.round(((appleRawScore - 5) * 5) / 55))
        : 0;

    // Weighted sum: prefix 80%, position 15%, apple ads up to +5
    const weightedSum = prefixScore * 0.8 + positionScore * 0.15 + appleAdd;

    // Apple Ads validation gate: only cap when Apple Ads actually returned a score.
    // If the API failed (403, network error), appleAdsDataAvailable=false and we
    // must not cap — the default appleRawScore of 5 is not a real signal.
    const cappedByAppleAds = appleAdsDataAvailable && appleRawScore <= config.popAppleAdsLowThreshold;
    let finalScore;
    if (cappedByAppleAds) {
      finalScore = Math.max(5, Math.min(appleRawScore, Math.round(weightedSum)));
    } else {
      finalScore = Math.max(5, Math.min(95, Math.round(weightedSum)));
    }

    return {
      score: finalScore,
      breakdown: {
        prefixScore,
        prefixAbsoluteScore: appearance ? Math.max(0, 100 - (appearance.prefixLength - 1) * 15) : null,
        prefixRatioScore: appearance ? Math.round((1 - appearance.prefixLength / totalLen) * 100) : null,
        prefixLength: appearance?.prefixLength ?? null,
        ambiguityRatio: Math.round(ambiguityRatio * 100) / 100,
        ambiguityMultiplier: Math.round(ambiguityMultiplier * 100) / 100,
        stemMatch: appearance?.stemMatch ?? false,
        wordBoundary: appearance?.wordBoundary ?? false,
        positionScore,
        suggestionCount: appearance?.suggestionCount ?? null,
        isSparse,
        appleRawScore,
        appleAdd,
        cappedByAppleAds,
        weightedSum: Math.round(weightedSum * 10) / 10,
        finalScore,
      },
    };
  } catch (err) {
    console.warn(
      `[popularity] calculatePopularity error for "${keyword}": ${err.message}`
    );
    return { score: 5, breakdown: { error: err.message } };
  }
}

/**
 * Batch popularity calculation for the worker.
 * Prefetches all Apple Ads scores in one batched request, then processes
 * each keyword's prefix crawl with configurable delays.
 *
 * @param {Array<{keyword, store, platform}>} keywords
 * @param {object} deps
 */
export async function calculatePopularityBatch(keywords, deps) {
  const {
    redis,
    mediaApiToken,
    appleAdsCookie,
    appleAdsXsrfToken,
    appleAdsAdamId,
  } = deps;

  // Group by store for Apple Ads batch call (each store is a separate request)
  const byStore = new Map();
  for (const kw of keywords) {
    const key = kw.store;
    if (!byStore.has(key)) byStore.set(key, []);
    byStore.get(key).push(kw);
  }

  // Prefetch Apple Ads popularity for all terms grouped by store
  const adsPopByStoreTerm = new Map();
  if (appleAdsCookie && appleAdsXsrfToken && appleAdsAdamId) {
    for (const [store, kwList] of byStore) {
      const terms = kwList.map((k) => k.keyword);
      const popMap = await fetchAppleAdsPopularity(
        terms,
        store,
        appleAdsCookie,
        appleAdsXsrfToken,
        appleAdsAdamId,
        redis
      );
      for (const [term, score] of popMap) {
        adsPopByStoreTerm.set(`${store}:${term}`, score);
      }
    }
  }

  // Calculate per-keyword scores (prefix crawl with delays)
  const results = [];
  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];
    let score = 5;
    try {
      ({ score } = await calculatePopularity(kw.keyword, kw.store, kw.platform, {
        redis,
        mediaApiToken,
        // Pass pre-fetched Apple Ads scores as null to skip re-fetching —
        // the cache will already have them from the prefetch above.
        appleAdsCookie,
        appleAdsXsrfToken,
        appleAdsAdamId,
      }));
    } catch (err) {
      console.warn(
        `[popularity] batch score failed for "${kw.keyword}": ${err.message}`
      );
    }
    results.push({ ...kw, score });

    // Delay between prefix crawls (except after last item)
    if (i < keywords.length - 1) {
      await new Promise((r) => setTimeout(r, config.workerSuggestDelayMs));
    }
  }

  return results;
}
