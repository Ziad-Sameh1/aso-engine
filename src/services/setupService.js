import { GoogleGenerativeAI } from "@google/generative-ai";
import { scrapeAppPageMetadata, fetchSearchHtml, fetchSearchHtmlViaProxy, extractSearchResults, lookupAppMetadata } from "./appstore.js";
import { mineSuggestions } from "./miningService.js";
import { config } from "../config/index.js";

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
        .filter((t) => t.length > 0 && !STOP_WORDS.has(t))
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
async function extractStoreDataFromUSMeta({ usMeta, usTitleTokens, usSubtitleTokens, storeCodes }) {
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

export async function setupApp(_pg, redis, { appleId, stores = [] }) {
  const setupStartMs = performance.now();
  const targetStores = stores.length > 0 ? stores : ["us"];
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

  // Mine Apple Suggest (3 levels, Gemini-cleaned) for top seed keywords per store
  const SEED_LIMIT = 25;
  const minedMap = Object.fromEntries(
    await Promise.all(
      foundWithTokens.map(async ({ store }) => {
        const t0 = performance.now();
        const intentTopApps = intentTopAppsMap[store] ?? [];
        const seeds = extractSeedKeywords(intentTopApps);
        const seedTokens = seeds.slice(0, SEED_LIMIT).map((s) => s.token);

        if (seedTokens.length === 0) {
          storeTimings[store].miningMs = Math.round(performance.now() - t0);
          return [store, { seeds, minedTerms: { L1: [], L2: [], L3: [] } }];
        }

        console.log(`[setup] ${store}: mining Apple Suggest (3 levels) for ${seedTokens.length} seed tokens`);
        const { searchTerms: minedTerms } = await mineSuggestions(seedTokens, store, redis, usEntry.meta);
        storeTimings[store].miningMs = Math.round(performance.now() - t0);
        const totalMined = minedTerms.L1.length + minedTerms.L2.length + minedTerms.L3.length;
        console.log(`[setup] ${store}: mined ${totalMined} cleaned terms (L1: ${minedTerms.L1.length}, L2: ${minedTerms.L2.length}, L3: ${minedTerms.L3.length})`);
        return [store, { seeds, minedTerms }];
      })
    )
  );

  let callsCount = 0;
  let searchHtmlCount = 0;
  let suggestionApiCount = 0;

  // Count search HTML calls from intent searches
  for (const [, topApps] of Object.entries(intentTopAppsMap)) {
    searchHtmlCount += topApps.length;
  }

  // Count suggestion API calls from mined terms (each seed/L1/L2 term = 1 Apple Suggest call)
  for (const [, { seeds, minedTerms }] of Object.entries(minedMap)) {
    const seedCount = seeds.slice(0, SEED_LIMIT).length;
    const l1Count = minedTerms.L1.length;
    const l2Count = minedTerms.L2.length;
    suggestionApiCount += seedCount + l1Count + l2Count;
  }

  const storeResults = scraped.map(({ store, meta }) => {
    const f = foundMap[store];
    const tokens = f
      ? { titleTokens: f.titleTokens, subtitleTokens: f.subtitleTokens, descriptionTokens: geminiResult.descriptionTokens ?? [] }
      : null;

    // Blind 2-token permutations from title/subtitle/description tokens (priority-ordered, capped)
    const permutationTerms = tokens ? buildSearchTerms(tokens, config.setupMaxPermutations) : [];

    // Mined terms from Apple Suggest (3 levels, Gemini-cleaned)
    const { seeds = [], minedTerms = { L1: [], L2: [], L3: [] } } = minedMap[store] ?? {};
    const allMinedFlat = [...minedTerms.L1, ...minedTerms.L2, ...minedTerms.L3];

    // 2-token permutations from seed keywords with frequency > 1 (capped separately)
    const seedTokens = seeds.filter((s) => s.frequency > 1).map((s) => s.token);
    const seedPermutations = buildSearchTerms({ titleTokens: seedTokens, subtitleTokens: [], descriptionTokens: [] }, config.setupMaxSeedPermutations);

    // Merge all: token permutations + seed permutations + mined, deduplicated
    const searchTerms = [...new Set([...permutationTerms, ...seedPermutations, ...allMinedFlat])];
    callsCount += searchTerms.length;

    const intentTopApps = intentTopAppsMap[store] ?? [];

    return {
      store,
      meta,
      tokens,
      searchTerms,
      localizedIntents: intentsMap[store] ?? [],
      intentTopApps,
      seedKeywords: seeds,
    };
  });

  const setupMs = Math.round(performance.now() - setupStartMs);

  return {
    stores: storeResults,
    callsCount,
    searchHtmlCount,
    suggestionApiCount,
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

// ── Popularity scoring ──────────────────────────────────────────────────────

/**
 * Calculate popularity score (0–100) from top-10 rating counts.
 *
 * Step 1: Zero check — if 5+ of 10 have 0 reviews → score = 0 (dead keyword).
 * Step 2: Trimmed mean — drop rank #1 (super-app) and ranks #9-10 (filler),
 *         average ranks #2–#8 to get "typical top-10 app" rating count.
 * Step 3: Concentration penalty (HHI) — penalize if 1–2 apps hold all reviews.
 * Step 4: Log-scale to 0–100.
 */
function calculatePopularityScore(ratingCounts) {
  const counts = [...ratingCounts];
  while (counts.length < 10) counts.push(0);

  // Step 1 — Dead keyword check
  const zeroCount = counts.filter((c) => c === 0 || c == null).length;
  if (zeroCount >= 5) return 0;

  // Safe values — avoid log(0) edge cases
  const safe = counts.map((c) => Math.max(c ?? 0, 1));

  // Step 2 — Trimmed mean: ranks #2–#8 (indices 1–7)
  const trimmed = safe.slice(1, 8);
  const trimmedMean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;

  // Step 3 — HHI concentration penalty (pre-log, floor 0.5)
  const total = safe.reduce((a, b) => a + b, 0);
  const hhi = safe.reduce((sum, r) => sum + (r / total) ** 2, 0);
  const penalty = Math.max(0.5, 1 - 0.5 * ((hhi - 0.1) / 0.9));

  // Step 4 — Log-scale to 0–100
  const LOG_MAX = Math.log10(50_000_000); // ~7.7
  const raw = (Math.log10(trimmedMean * penalty) / LOG_MAX) * 100;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

// ── Rank & score all search terms for one store ─────────────────────────────

const RANK_CONCURRENCY = config.setupRankConcurrency;
const RANK_BACKOFF_BASE_MS = 3000;
const RANK_BACKOFF_MAX_MS = 30000;
const RANK_BACKOFF_MAX_ROUNDS = 4;

/**
 * Attempt a single fetch for one search term — no inline retry.
 * Returns { term, rank, top10Ids } on success, or throws on failure.
 */
async function fetchTermRanking(term, appleId, store) {
  const html = await fetchSearchHtmlViaProxy(term, store, "iphone");
  const results = extractSearchResults(html);
  const top10 = results.slice(0, 10);
  const match = results.find((r) => r.id === String(appleId));
  return {
    term,
    rank: match?.rank ?? null,
    top10Ids: top10.map((r) => r.id),
  };
}

/**
 * Rank all search terms for a single store.
 *
 * Phase 1: All terms fetched in parallel (concurrency 50).
 *          Failures collected into a retry queue — no inline waiting.
 * Phase 2: Retry queue processed with exponential backoff (parallel each round).
 *          Up to RANK_BACKOFF_MAX_ROUNDS rounds. Exhausted terms marked failed.
 *
 * After all fetches, batch-resolves top-10 rating counts via iTunes Lookup
 * and calculates popularity scores.
 *
 * @param {string} appleId
 * @param {string} store
 * @param {string[]} searchTerms
 * @returns {Promise<{ keywords: Array, liveKeywords: number }>}
 */
export async function rankStore(appleId, store, searchTerms, redis = null) {
  console.log(`[setup:rank] ${store}: ranking ${searchTerms.length} search terms (concurrency: ${RANK_CONCURRENCY})`);
  const rankStartMs = performance.now();

  const limit = createLimiter(RANK_CONCURRENCY);
  const resolved = new Map(); // term → { rank, top10Ids }
  const retryQueue = [];

  // ── Phase 1: Parallel fetch, collect failures ──────────────────────────
  const fetchT0 = performance.now();
  await Promise.all(
    searchTerms.map((term) =>
      limit(async () => {
        try {
          resolved.set(term, await fetchTermRanking(term, appleId, store));
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
            resolved.set(term, await fetchTermRanking(term, appleId, store));
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
    resolved.set(term, { term, rank: null, top10Ids: [], failed: true });
  }

  const rawResults = searchTerms.map((term) => ({ term, ...resolved.get(term) }));

  // Collect all unique top-10 app IDs for batch lookup
  const allTop10Ids = new Set();
  for (const r of rawResults) {
    for (const id of r.top10Ids) allTop10Ids.add(id);
  }

  console.log(`[setup:rank] ${store}: resolving metadata for ${allTop10Ids.size} unique apps`);
  const metaT0 = performance.now();
  const metadata = await lookupAppMetadata([...allTop10Ids], store, redis);
  const metadataLookupMs = Math.round(performance.now() - metaT0);

  // Score each term
  const keywords = [];
  let liveKeywords = 0;

  for (const r of rawResults) {
    if (r.failed) {
      keywords.push({ term: r.term, rank: null, popularity: null, failed: true });
      continue;
    }

    // Get rating counts for the top 10 from resolved metadata
    const ratingCounts = r.top10Ids.map((id) => metadata[id]?.ratingCount ?? 0);
    const popularity = calculatePopularityScore(ratingCounts);

    if (popularity > 0) liveKeywords++;

    keywords.push({
      term: r.term,
      rank: r.rank,
      popularity,
    });
  }

  const rankTotalMs = Math.round(performance.now() - rankStartMs);
  console.log(`[setup:rank] ${store}: done — ${liveKeywords} live keywords out of ${searchTerms.length}`);
  return {
    keywords,
    liveKeywords,
    timings: { totalMs: rankTotalMs, fetchMs, retryMs, metadataLookupMs },
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
export async function rankAllStores(appleId, storeResults, redis = null) {
  const rankingStartMs = performance.now();
  const totalTerms = storeResults.reduce((s, r) => s + r.searchTerms.length, 0);
  console.log(`[setup:rank] Starting ranking phase: ${storeResults.length} stores, ${totalTerms} total search terms`);

  // Process all stores in parallel
  const rankedStores = await Promise.all(
    storeResults.map(async ({ store, searchTerms }) => {
      if (searchTerms.length === 0) {
        return { store, keywords: [], liveKeywords: 0, timings: { totalMs: 0, fetchMs: 0, retryMs: 0, metadataLookupMs: 0 } };
      }
      const result = await rankStore(appleId, store, searchTerms, redis);
      return { store, ...result };
    })
  );

  const totalLiveKeywords = rankedStores.reduce((s, r) => s + r.liveKeywords, 0);
  const rankingMs = Math.round(performance.now() - rankingStartMs);
  console.log(`[setup:rank] Ranking complete: ${totalLiveKeywords} live keywords across ${storeResults.length} stores`);
  return { stores: rankedStores, totalLiveKeywords, rankingMs };
}

