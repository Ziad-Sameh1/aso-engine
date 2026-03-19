import { GoogleGenerativeAI } from "@google/generative-ai";
import { scrapeAppPageMetadata, fetchSearchHtml, extractSearchResults, getSearchRankings } from "./appstore.js";
import { scorePopularity } from "./resultsPopularityService.js";
import { calculateDifficultyScore } from "./resultsDifficultyService.js";
import { storeToLocale, relevanceMultiplier, hydrateSubtitles } from "./resultsShared.js";
import { calculateOpportunity } from "./opportunity.js";

import { config } from "../config/index.js";

export const DEFAULT_STORES = [
  // English-speaking
  "us", // United States
  "gb", // United Kingdom
  "ca", // Canada
  "au", // Australia
  "nz", // New Zealand
  "ie", // Ireland
  // Asia-Pacific
  "sg", // Singapore
  "jp", // Japan
  "kr", // South Korea
  // Western Europe
  "de", // Germany
  "fr", // France
  "nl", // Netherlands
  "ch", // Switzerland
  "se", // Sweden
  "no", // Norway
  "dk", // Denmark
  // Emerging markets
  "in", // India
  "br", // Brazil
  "mx", // Mexico
  "id", // Indonesia
  "tr", // Turkey
  "th", // Thailand
  "vn", // Vietnam
  // Rest of Europe
  "be", // Belgium
  "at", // Austria
  "fi", // Finland
  "pl", // Poland
  "pt", // Portugal
  "it", // Italy
  "es", // Spain
];

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "for", "nor", "so", "yet",
  "at", "by", "in", "of", "on", "to", "up", "as", "is", "it",
  "its", "be", "do", "if", "my", "no", "we", "he", "she", "they",
  "you", "me", "us", "him", "her", "with", "from", "into", "onto",
  "than", "that", "this", "your", "our", "their", "was", "are",
  "has", "had", "have", "not", "can", "all", "any", "also",
]);

/**
 * Deterministically extract all single-word tokens from a text string.
 * Splits on whitespace/punctuation, lowercases, filters stop words.
 */
function extractTokens(text) {
  if (!text) return [];
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[\s\-–—\/\|&,.:;!?()[\]{}'"]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2 && !STOP_WORDS.has(t))
    ),
  ];
}

/**
 * Extract seed keywords from intentTopApps results for a single store.
 * Tokenizes all app names and subtitles, counts frequency across all results,
 * and returns tokens sorted by frequency descending.
 *
 * @param {Array<{ results: Array<{ name: string, subtitle: string|null }> }>} intentTopApps
 * @returns {Array<{ token: string, frequency: number }>}
 */
function extractSeedKeywords(intentTopApps) {
  const freq = new Map();

  for (const { results } of intentTopApps) {
    for (const { name, subtitle } of results) {
      const tokens = [
        ...extractTokens(name),
        ...extractTokens(subtitle),
      ];
      for (const token of tokens) {
        freq.set(token, (freq.get(token) ?? 0) + 1);
      }
    }
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([token, frequency]) => ({ token, frequency }));
}

/**
 * Single Gemini call using only the US (or first found) store metadata.
 * Gemini infers the app's core functionality from that, then for each requested
 * store code generates localized intents using its own knowledge of regional vocabulary.
 * Also extracts description tokens from the US metadata (used across all stores).
 *
 * usMeta: { name, subtitle, description } — English reference metadata
 * usTitleTokens: string[], usSubtitleTokens: string[] — already indexed tokens to exclude
 * storeCodes: string[] — all store codes to generate localized intents for
 * Returns: { descriptionTokens: string[], storeIntents: Array<{ store, localizedIntents }> }
 */
export async function extractStoreDataFromUSMeta({ usMeta, usTitleTokens, usSubtitleTokens, storeCodes }) {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY is not configured.");

  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `You are an App Store Optimization expert. Use the following US App Store metadata to understand this app's core functionality and user goals.

App name: ${usMeta.name ?? ""}
Subtitle: ${usMeta.subtitle ?? ""}
Description: ${usMeta.description ?? ""}

Task 1 — descriptionTokens:
Extract the 10 most search-relevant SINGLE-WORD tokens from the description above.
- Rank by: (1) frequency, (2) prominence in feature/benefit headers, (3) search intent.
- Single words only — no phrases, no hyphenated compounds. Skip stop words.
- Do NOT include any of these already-indexed tokens: ${[...usTitleTokens, ...usSubtitleTokens].join(", ")}
- Lowercase, no duplicates.

Task 2 — localizedIntents per store:
For each of the following store codes, generate 3–5 short phrases (1–3 words) that real users in THAT market type into the App Store search to find this kind of app.

Rules:
- Start with the most direct, obvious search terms — what the app name and subtitle already tell you users want (e.g. if the app is "Calorie Tracker", then "calorie tracker" MUST be the first intent for English stores).
- Then add close variants that reflect regional vocabulary (e.g. "calorie counter" in GB, "maths tutor" vs "math tutor"). Do not just translate — adapt naturally.
- Non-English storefronts: use the local language.
- Prioritize high-volume, obvious terms over creative or niche ones.
- Lowercase, no duplicates.

Stores: ${storeCodes.join(", ")}

Return ONLY a valid JSON object — nothing else:
{
  "descriptionTokens": [],
  "storeIntents": [
    { "store": "<store_code>", "localizedIntents": [] }
  ]
}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  const json = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  return JSON.parse(json);
}

/**
 * Sets up an app by Apple ID: scrapes all stores in parallel, then calls
 * Gemini once for all stores to extract keyword tokens.
 *
 * Returns a list of objects, one per store:
 *   { store, meta, tokens: { titleTokens, subtitleTokens, descriptionTokens } }
 *
 * Returns null if the app is not found in any store.
 */
/**
 * For each intent string, fetch the App Store search results for the given store
 * and return the top 10 apps (name + subtitle) ranked by their search position.
 *
 * Searches are run with a small concurrency limit to avoid rate limiting.
 *
 * @param {string[]} intents  — list of search phrases
 * @param {string}   store    — App Store storefront code (e.g. "us", "gb")
 * @returns {Promise<Array<{ intent: string, results: Array<{ rank: number, name: string, subtitle: string|null }> }>>}
 */
export async function searchIntentTopApps(intents, store = "us") {
  const TOP_N = 10;
  const MAX_RETRIES = 4;
  const BASE_DELAY_MS = 1500;

  async function runOne(intent) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const html = await fetchSearchHtml(intent, store);
        const allResults = extractSearchResults(html);
        return {
          intent,
          results: allResults.slice(0, TOP_N).map(({ rank, name, subtitle }) => ({ rank, name, subtitle })),
        };
      } catch (err) {
        const isLast = attempt === MAX_RETRIES;
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        if (isLast) {
          console.warn(`[setup] "${intent}" (${store}) failed after ${MAX_RETRIES + 1} attempts: ${err.message}`);
          return { intent, results: [] };
        }
        console.warn(`[setup] "${intent}" (${store}) attempt ${attempt + 1} failed, retrying in ${delay}ms: ${err.message}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // Serial — avoids rate limiting Apple across concurrent requests
  const results = [];
  for (const intent of intents) {
    results.push(await runOne(intent));
  }
  return results;
}

export async function setupApp(_pg, _redis, { appleId, stores = [] }) {
  const setupStartMs = performance.now();
  const targetStores = stores.length > 0 ? stores : DEFAULT_STORES;
  const storeTimings = Object.fromEntries(targetStores.map((s) => [s, {}]));

  // Scrape all stores in parallel
  const scraped = await Promise.all(
    targetStores.map(async (store) => {
      const t0 = performance.now();
      const meta = await scrapeAppPageMetadata(appleId, store);
      storeTimings[store].scrapeMs = Math.round(performance.now() - t0);
      return { store, meta };
    })
  );

  const found = scraped.filter((r) => r.meta !== null);
  if (found.length === 0) return null;

  // Deterministically extract title + subtitle tokens per store
  const foundWithTokens = found.map(({ store, meta }) => ({
    store,
    meta,
    titleTokens: extractTokens(meta.name),
    subtitleTokens: extractTokens(meta.subtitle),
  }));

  // Single Gemini call using only US metadata — Gemini infers localized intents per store from its own knowledge
  const usEntry = foundWithTokens.find((r) => r.store === "us") ?? foundWithTokens[0];
  const geminiT0 = performance.now();
  const geminiResult = await extractStoreDataFromUSMeta({
    usMeta: usEntry.meta,
    usTitleTokens: usEntry.titleTokens,
    usSubtitleTokens: usEntry.subtitleTokens,
    storeCodes: foundWithTokens.map((r) => r.store),
  });
  const geminiMs = Math.round(performance.now() - geminiT0);

  const intentsMap = Object.fromEntries(
    geminiResult.storeIntents.map((r) => [r.store, r.localizedIntents])
  );

  // Search top apps per intent for every found store, in parallel across stores
  const intentTopAppsMap = Object.fromEntries(
    await Promise.all(
      foundWithTokens.map(async ({ store }) => {
        const t0 = performance.now();
        const intents = intentsMap[store] ?? [];
        const topApps = intents.length > 0 ? await searchIntentTopApps(intents, store) : [];
        storeTimings[store].intentSearchMs = Math.round(performance.now() - t0);
        console.log(`[setup] ${store}: intent top apps done (${intents.length} intents)`);
        return [store, topApps];
      })
    )
  );

  // Build a lookup for the enriched found stores
  const foundMap = Object.fromEntries(foundWithTokens.map((r) => [r.store, r]));

  const storeResults = scraped.map(({ store, meta }) => {
    const f = foundMap[store];
    const tokens = f
      ? { titleTokens: f.titleTokens, subtitleTokens: f.subtitleTokens, descriptionTokens: geminiResult.descriptionTokens ?? [] }
      : null;

    const intentTopApps = intentTopAppsMap[store] ?? [];
    const seedKeywords = extractSeedKeywords(intentTopApps);

    return {
      store,
      tokens,
      localizedIntents: intentsMap[store] ?? [],
      intentTopApps,
      seedKeywords,
    };
  });

  const setupMs = Math.round(performance.now() - setupStartMs);

  return {
    stores: storeResults,
    timings: { setupMs, geminiMs, stores: storeTimings },
  };
}

/**
 * Build 2-token permutations across title, subtitle, description tokens.
 * Pairs are "tokenA tokenB" (space-joined). Both word orders are kept since
 * Apple Search treats order as significant (e.g. "money ai" vs "ai money" rank differently).
 *
 * Pairs are generated in priority order (highest-value cross-bucket pairs first):
 *   1. title × subtitle  2. title × title  3. title × desc
 *   4. subtitle × subtitle  5. subtitle × desc  6. desc × desc
 *
 * A maxTerms cap limits how far we go into lower-priority pairs.
 */
function buildSearchTerms({ titleTokens = [], subtitleTokens = [], descriptionTokens = [] }, maxTerms = Infinity) {
  const title = [...new Set(titleTokens)];
  const subtitle = [...new Set(subtitleTokens)];
  const desc = [...new Set(descriptionTokens)];

  const seen = new Set();
  const terms = [];

  function addPairs(listA, listB) {
    for (const a of listA) {
      for (const b of listB) {
        if (terms.length >= maxTerms) return;
        if (a === b) continue;
        const term = `${a} ${b}`;
        if (!seen.has(term)) {
          seen.add(term);
          terms.push(term);
        }
      }
    }
  }

  // Priority 1: title × subtitle (both directions — highest value cross-bucket)
  addPairs(title, subtitle);
  addPairs(subtitle, title);
  // Priority 2: within title
  addPairs(title, title);
  // Priority 3: title × desc (both directions)
  addPairs(title, desc);
  addPairs(desc, title);
  // Priority 4: within subtitle
  addPairs(subtitle, subtitle);
  // Priority 5: subtitle × desc (both directions)
  addPairs(subtitle, desc);
  addPairs(desc, subtitle);
  // Priority 6: within desc (lowest value)
  addPairs(desc, desc);

  return terms;
}

// ── Concurrency limiter ─────────────────────────────────────────────────────

function createLimiter(concurrency) {
  let active = 0;
  const queue = [];

  function next() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  }

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

// ── Rank & score all search terms for one store ─────────────────────────────

const RANK_CONCURRENCY = config.setupRankConcurrency;
const RANK_BACKOFF_BASE_MS = 3000;
const RANK_BACKOFF_MAX_MS = 30000;
const RANK_BACKOFF_MAX_ROUNDS = 4;

/**
 * Fetch search results once, then score both popularity and difficulty
 * from the same data. Fetches top 20 (popularity needs 20, difficulty uses first 10).
 */
async function fetchTermScores(term, appleId, store) {
  const results = await getSearchRankings({
    keyword: term,
    country: store,
    platform: "iphone",
    limit: 20,
    useProxy: true,
  });

  await hydrateSubtitles(results, store);

  const locale = storeToLocale(store);
  const tagged = results.map((app) => {
    const { multiplier, match } = relevanceMultiplier(term, app.name, app.subtitle, locale);
    const ratingCount = Math.max(app.ratingCount ?? 0, 1);
    return { ...app, relevance: { multiplier, match, ratingCount } };
  });

  const { popularity } = scorePopularity(tagged);
  const { difficulty } = calculateDifficultyScore(tagged);

  const appMatch = results.find((r) => String(r.id) === String(appleId));
  const rank = appMatch?.rank ?? null;

  return { term, rank, popularity, difficulty };
}

/**
 * Rank all search terms for a single store.
 *
 * Phase 1: All terms scored in parallel (concurrency-limited).
 *          Failures collected into a retry queue.
 * Phase 2: Retry queue processed with exponential backoff.
 *
 * Each term is scored via getResultsPopularity + getResultsDifficulty.
 *
 * @param {string} appleId
 * @param {string} store
 * @param {string[]} searchTerms
 * @returns {Promise<{ keywords: Array, liveKeywords: number }>}
 */
export async function rankStore(appleId, store, searchTerms, sharedLimit = null) {
  console.log(`[setup:rank] ${store}: ranking ${searchTerms.length} search terms (concurrency: ${RANK_CONCURRENCY})`);
  const rankStartMs = performance.now();

  const limit = sharedLimit ?? createLimiter(RANK_CONCURRENCY);
  const resolved = new Map();
  const retryQueue = [];

  // ── Phase 1: Parallel fetch, collect failures ──────────────────────────
  const fetchT0 = performance.now();
  await Promise.all(
    searchTerms.map((term) =>
      limit(async () => {
        try {
          resolved.set(term, await fetchTermScores(term, appleId, store));
        } catch (err) {
          retryQueue.push(term);
        }
      })
    )
  );
  const fetchMs = Math.round(performance.now() - fetchT0);

  // ── Phase 2: Backoff retry rounds ──────────────────────────────────────
  const retryT0 = performance.now();
  for (let round = 1; round <= RANK_BACKOFF_MAX_ROUNDS && retryQueue.length > 0; round++) {
    const delay = Math.min(RANK_BACKOFF_BASE_MS * Math.pow(2, round - 1), RANK_BACKOFF_MAX_MS);
    console.warn(`[setup:rank] ${store}: ${retryQueue.length} failed — backoff round ${round}/${RANK_BACKOFF_MAX_ROUNDS} in ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));

    const thisRound = retryQueue.splice(0);
    await Promise.all(
      thisRound.map((term) =>
        limit(async () => {
          try {
            resolved.set(term, await fetchTermScores(term, appleId, store));
          } catch (err) {
            retryQueue.push(term);
          }
        })
      )
    );
  }
  const retryMs = Math.round(performance.now() - retryT0);

  // Mark anything still unresolved as failed
  for (const term of retryQueue) {
    console.warn(`[setup:rank] "${term}" (${store}) exhausted retries — skipped`);
    resolved.set(term, { term, rank: null, popularity: null, difficulty: null, failed: true });
  }

  // Build keywords with opportunity score
  const keywords = [];
  let liveKeywords = 0;

  for (const term of searchTerms) {
    const r = resolved.get(term);
    if (r.failed) {
      keywords.push({ ...r, opportunity: null });
      continue;
    }

    const opportunity = calculateOpportunity(r.popularity, r.difficulty);
    if (r.popularity > 5) liveKeywords++;

    keywords.push({ ...r, opportunity });
  }

  // Sort: popularity descending, then rank ascending (null ranks last)
  keywords.sort((a, b) => {
    const oppDiff = (b.opportunity ?? -Infinity) - (a.opportunity ?? -Infinity);
    if (oppDiff !== 0) return oppDiff;
    return (b.popularity ?? 0) - (a.popularity ?? 0);
  });

  const rankTotalMs = Math.round(performance.now() - rankStartMs);
  console.log(`[setup:rank] ${store}: done — ${liveKeywords} live keywords out of ${searchTerms.length}`);
  return {
    keywords,
    liveKeywords,
    timings: { totalMs: rankTotalMs, fetchMs, retryMs },
  };
}

/**
 * After setup, rank all search terms store-by-store (serial across stores).
 * For each store, fetches search HTML via proxy (concurrency 50),
 * resolves top-10 metadata, and calculates popularity scores.
 *
 * @param {string} appleId
 * @param {Array<{ store: string, searchTerms: string[] }>} storeResults - from setupApp()
 * @returns {Promise<{ stores: Array, totalLiveKeywords: number }>}
 */
export async function rankAllStores(appleId, storeResults) {
  const rankingStartMs = performance.now();
  const totalTerms = storeResults.reduce((s, r) => s + r.searchTerms.length, 0);
  console.log(`[setup:rank] Starting ranking phase: ${storeResults.length} stores, ${totalTerms} total search terms`);

  // Single shared limiter across all stores — prevents flooding the proxy
  const sharedRankLimit = createLimiter(RANK_CONCURRENCY);

  // Process all stores in parallel, sharing the concurrency budget
  const rankedStores = await Promise.all(
    storeResults.map(async ({ store, searchTerms }) => {
      if (searchTerms.length === 0) {
        return { store, keywords: [], liveKeywords: 0, timings: { totalMs: 0, fetchMs: 0, retryMs: 0 } };
      }
      const result = await rankStore(appleId, store, searchTerms, sharedRankLimit);
      return { store, ...result };
    })
  );

  const rankingMs = Math.round(performance.now() - rankingStartMs);
  const totalLiveKeywords = rankedStores.reduce((s, r) => s + r.liveKeywords, 0);
  console.log(`[setup:rank] Complete: ${totalLiveKeywords} live keywords across ${storeResults.length} stores`);
  return { stores: rankedStores, totalLiveKeywords, rankingMs };
}

