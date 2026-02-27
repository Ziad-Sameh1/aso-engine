/**
 * Keyword Discovery Engine
 *
 * Finds 2-word keyword pairs the target app actually ranks for in Apple's App Store,
 * by generating all permutations of tokens extracted from the app's own metadata and
 * checking each pair against live Apple search results — in parallel, no iTunes Lookup.
 *
 * Stage 1 — Gemini: Extract unique tokens + synonyms from app metadata (cached 24h)
 * Stage 2 — Generate all ordered 2-word permutations (A B and B A)
 * Stage 3 — Parallel lightweight Apple rank-check: HTML scrape only, no iTunes Lookup
 * Stage 4 — Enrich top N ranking pairs with popularity + competitiveness (DB-first)
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { CacheService } from "./cache.js";
import { config } from "../config/index.js";
import {
  fetchAppMetadata,
  fetchSearchHtmlViaProxy,
  extractSearchResults,
  lookupAppMetadata,
} from "./appstore.js";
import { calculatePopularity } from "./popularity.js";
import { calculateCompetitiveness } from "./competitiveness.js";
import {
  resolveKeyword,
  getKeywordCurrentPopularity,
  getKeywordCurrentCompetitiveness,
  upsertStorefront,
  upsertWord,
  upsertKeyword,
  upsertApps,
  insertPopularity,
  insertCompetitiveness,
  insertAppRankings,
  insertSearchSnapshot,
} from "./db.js";

// ── Concurrency limiter (avoids adding p-limit dependency) ───────────────────

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

// ── Stage 1: Gemini token + synonym extraction ───────────────────────────────

async function extractTokens(appMeta, redis) {
  const cache = new CacheService(redis);
  const cacheKey = `discovery:tokens:${appMeta.appleId}`;

  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  if (!config.geminiApiKey)
    throw new Error("GEMINI_API_KEY is not configured.");

  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const descriptionSnippet = appMeta.description?.slice(0, 1000) ?? "N/A";

  const prompt = `You are an App Store Optimization expert. Analyze this iOS app's metadata and extract important single-word keyword tokens.

App Name: ${appMeta.name}
App Subtitle: ${appMeta.subtitle ?? "N/A"}
App Description (first 1000 chars): ${descriptionSnippet}
Genre: ${appMeta.genre ?? "N/A"}

Instructions:
1. Extract 30-50 unique, important single-word tokens. The app name and subtitle are highest priority; the description is secondary.
2. Exclude: the app's unique brand or product name, common stop words (the, a, an, is, for, with, and, or, to, in, on, of, my, your, this, that, it, app, by, at, be, do, go, get), and single characters.
3. All tokens must be lowercase.
4. For each token, provide 2-3 single-word synonyms that real users might search for instead. Synonyms must be real English words relevant to the app's context.

Return ONLY a JSON object in this exact format, nothing else. No markdown, no explanation:
{
  "tokens": [
    { "word": "budget", "synonyms": ["spending", "expense", "money"] },
    { "word": "tracker", "synonyms": ["monitor", "logger"] }
  ]
}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  const json = text
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Gemini returned invalid JSON for token extraction.");
  }

  if (!Array.isArray(parsed?.tokens)) {
    throw new Error("Gemini response missing 'tokens' array.");
  }

  const tokenData = {
    tokens: parsed.tokens,
    tokensExtracted: 0,
    synonymsGenerated: 0,
    uniqueTerms: [],
  };

  // Flatten and deduplicate: original words first, then synonyms
  const seen = new Set();
  const allTerms = [];

  for (const entry of parsed.tokens) {
    const word = String(entry.word ?? "")
      .toLowerCase()
      .trim();
    if (word && !seen.has(word)) {
      seen.add(word);
      allTerms.push(word);
      tokenData.tokensExtracted++;
    }
  }

  for (const entry of parsed.tokens) {
    for (const syn of entry.synonyms ?? []) {
      const s = String(syn).toLowerCase().trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        allTerms.push(s);
        tokenData.synonymsGenerated++;
      }
    }
  }

  // Cap total terms
  tokenData.uniqueTerms = allTerms.slice(0, config.discoveryMaxTerms);

  await cache.set(cacheKey, tokenData, config.cacheTtlSuggestions);
  return tokenData;
}

// ── Stage 2: Generate ordered 2-word permutations ───────────────────────────

function generatePairs(terms, maxPairs) {
  const pairs = [];
  for (let i = 0; i < terms.length; i++) {
    for (let j = 0; j < terms.length; j++) {
      if (i === j) continue;
      pairs.push(`${terms[i]} ${terms[j]}`);
      if (pairs.length >= maxPairs) return pairs;
    }
  }
  return pairs;
}

// ── Stage 3: Lightweight Apple rank check ───────────────────────────────────

function categorizeError(err) {
  const msg = err.message || String(err);
  if (
    err.name === "TimeoutError" ||
    msg.includes("timed out") ||
    msg.includes("abort")
  )
    return "timeout";
  if (msg.includes("HTTP 429")) return "http_429";
  if (msg.includes("HTTP 4"))
    return msg.includes("403") ? "http_403" : "http_4xx";
  if (msg.includes("HTTP 5")) return "http_5xx";
  if (
    msg.includes("fetch failed") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ENOTFOUND")
  )
    return "network";
  if (msg.includes("serialized-server-data") || msg.includes("JSON"))
    return "parse";
  return "unknown";
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function isHttp429(err) {
  const msg = err?.message || String(err);
  return msg.includes("HTTP 429");
}

function jitter(maxMs) {
  if (!maxMs || maxMs <= 0) return 0;
  return Math.floor(Math.random() * maxMs);
}

async function waitForNextSlot(rateState, baseDelayMs) {
  if (!rateState) {
    await sleep(baseDelayMs + jitter(config.discoverySearchJitterMs));
    return;
  }

  const now = Date.now();
  const waitMs = Math.max(0, rateState.nextAllowedAt - now);
  if (waitMs > 0) await sleep(waitMs);

  const spacingMs = baseDelayMs + jitter(config.discoverySearchJitterMs);
  rateState.nextAllowedAt = Date.now() + spacingMs;
}

async function checkRank(pair, appleId, store, platform, rateState) {
  const maxRetries = Math.max(0, config.discovery429MaxRetries);
  const baseBackoffMs = Math.max(0, config.discovery429BaseBackoffMs);
  const maxBackoffMs = Math.max(baseBackoffMs, config.discovery429MaxBackoffMs);
  const baseDelayMs = Math.max(0, config.discoverySearchDelayMs);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await waitForNextSlot(rateState, baseDelayMs);

    try {
      const html = await fetchSearchHtmlViaProxy(pair, store, platform);
      const results = extractSearchResults(html);
      const match = results.find((r) => r.id === String(appleId));
      if (!match) {
        if (rateState) rateState.consecutive429 = 0;
        return { status: "not_found", keyword: pair };
      }
      // Carry top-10 IDs so Stage 4 can compute competitiveness without re-fetching
      const top10Ids = results.slice(0, 10).map((r) => r.id);
      console.log(`[discovery] Found ${match.rank} rank for ${pair}`);
      if (rateState) rateState.consecutive429 = 0;
      // Carry full results so persistence can create a snapshot with all ranked apps
      return {
        status: "found",
        keyword: pair,
        rank: match.rank,
        totalResults: results.length,
        top10Ids,
        searchResults: results,
      };
    } catch (err) {
      if (isHttp429(err) && attempt < maxRetries) {
        const streak = (rateState?.consecutive429 ?? 0) + 1;
        const backoffMs = Math.min(
          maxBackoffMs,
          baseBackoffMs * 2 ** Math.max(0, streak - 1),
        );
        const cooldownMs = backoffMs + jitter(config.discoverySearchJitterMs);

        if (rateState) {
          rateState.consecutive429 = streak;
          rateState.nextAllowedAt = Date.now() + cooldownMs;
        }

        console.warn(
          `[discovery] 429 for "${pair}" (attempt ${attempt + 1}/${maxRetries + 1}) -> retrying in ${cooldownMs}ms`,
        );
        continue;
      }

      console.error(`[discovery] Error checking rank for ${pair}: ${err.message}`);
      const category = categorizeError(err);
      return {
        status: "failed",
        keyword: pair,
        error: err.message || String(err),
        category,
      };
    }
  }

  return {
    status: "failed",
    keyword: pair,
    error: "Exhausted retry attempts.",
    category: "http_429",
  };
}

// ── Stage 4: Enrich ranking pairs with popularity + competitiveness ──────────

async function enrichPair(item, pg, redis, store, platform, appleId, appMeta) {
  const normKeyword = item.keyword.toLowerCase().trim();

  let popularity = null;
  let competitiveness = null;

  // DB-first: avoids redundant Apple API calls if keyword was previously searched
  const kw = await resolveKeyword(pg, normKeyword, store, platform);
  if (kw) {
    const [popRow, compRow] = await Promise.all([
      getKeywordCurrentPopularity(pg, kw.id),
      getKeywordCurrentCompetitiveness(pg, kw.id),
    ]);
    popularity = popRow?.popularity ?? null;
    competitiveness = compRow?.competitiveness ?? null;
  }

  // Calculate fresh popularity if not in DB
  if (popularity === null) {
    try {
      const popResult = await calculatePopularity(
        normKeyword,
        store,
        platform,
        {
          redis,
          mediaApiToken: config.appleMediaApiToken,
          appleAdsCookie: config.appleAdsCookie,
          appleAdsXsrfToken: config.appleAdsXsrfToken,
          appleAdsAdamId: config.appleAdsAdamId,
        },
      );
      popularity = popResult?.score ?? null;
    } catch {
      // Non-fatal — leave as null
    }
  }

  // Calculate fresh competitiveness if not in DB
  // Requires rating data for top-10 apps — do a small iTunes Lookup using the IDs
  // carried from Stage 3's rank-check (no extra HTML fetch needed)
  if (competitiveness === null && item.top10Ids?.length) {
    try {
      const metadata = await lookupAppMetadata(item.top10Ids, store);
      const top10Results = item.top10Ids.map((id) => metadata[id] ?? {});
      competitiveness = calculateCompetitiveness(top10Results);
    } catch {
      // Non-fatal — leave as null
    }
  }

  // Lightweight fire-and-forget persistence (with snapshot for neighbor lookups)
  (async () => {
    try {
      // Upsert all apps from the search results so neighbor data exists
      const allAppData = item.searchResults.map((r) => ({
        appleId: r.id,
        bundleId: r.bundleId || null,
        name: r.name || null,
        developer: null,
        price: null,
        genre: null,
        iconUrl: null,
      }));
      const [storefront, word, appIdMap] = await Promise.all([
        upsertStorefront(pg, store),
        upsertWord(pg, normKeyword),
        upsertApps(pg, allAppData),
      ]);
      const kwRow = await upsertKeyword(pg, word.id, storefront.id, platform);
      if (popularity !== null) {
        await insertPopularity(pg, kwRow.id, popularity);
      }
      if (competitiveness !== null) {
        await insertCompetitiveness(pg, kwRow.id, competitiveness);
      }
      // Create a search snapshot so getRankNeighborsBulk can find above/below
      const snapshot = await insertSearchSnapshot(
        pg,
        kwRow.id,
        item.searchResults.length,
        item.searchResults,
      );
      await insertAppRankings(
        pg,
        kwRow.id,
        snapshot.id,
        item.searchResults
          .filter((r) => appIdMap.has(r.id))
          .map((r) => ({ appDbId: appIdMap.get(r.id), rank: r.rank })),
      );
    } catch {
      // Non-fatal
    }
  })();

  return {
    keyword: item.keyword,
    rank: item.rank,
    popularity,
    competitiveness,
  };
}

// ── Main orchestrator ────────────────────────────────────────────────────────

/**
 * Discover 2-word keyword pairs the app actually ranks for in the App Store.
 *
 * @param {object} pg        - fastify.pg pool
 * @param {object} redis     - fastify.redis client
 * @param {string} appleId   - target app's Apple ID
 * @param {object} opts
 * @param {string} [opts.store="us"]
 * @param {string} [opts.platform="iphone"]
 * @returns {Promise<object>}
 */
export async function discoverKeywords(
  pg,
  redis,
  appleId,
  { store = "us", platform = "iphone" } = {},
) {
  const totalStart = Date.now();
  const timings = {};

  // ── Stage 1: Fetch metadata + Gemini token/synonym extraction ────────────
  let t = Date.now();

  const appMeta = await fetchAppMetadata(appleId, store);
  if (!appMeta) throw new Error(`App ${appleId} not found on App Store.`);
  appMeta.appleId = appleId;

  const tokenData = await extractTokens(appMeta, redis);
  console.log(`[discovery] Extracted ${tokenData.tokensExtracted} tokens`);
  console.log(`[discovery] Extracted ${tokenData.synonymsGenerated} synonyms`);
  console.log(`[discovery] Extracted ${tokenData.uniqueTerms.length} unique terms`);
  timings.stage1_gemini_ms = Date.now() - t;

  const { uniqueTerms, tokensExtracted, synonymsGenerated } = tokenData;

  // ── Stage 2: Generate 2-word permutations ────────────────────────────────
  t = Date.now();
  const pairs = generatePairs(uniqueTerms, config.discoveryMaxPairs);
  timings.stage2_permutations_ms = Date.now() - t;
  console.log(`[discovery] Generated ${pairs.length} 2-word permutations`);

  // ── Stage 3: Parallel lightweight Apple rank-check ───────────────────────
  t = Date.now();
  const searchLimit = createLimiter(config.discoverySearchConcurrency);
  const rateState = { nextAllowedAt: Date.now(), consecutive429: 0 };

  const rankResults = await Promise.all(
    pairs.map((pair) =>
      searchLimit(() => checkRank(pair, appleId, store, platform, rateState)),
    ),
  );

  // Categorize results by status
  const found = [];
  const notFound = [];
  const failed = [];
  for (const r of rankResults) {
    if (!r) continue; // shouldn't happen now, but defensive
    if (r.status === "found") found.push(r);
    else if (r.status === "failed") failed.push(r);
    else notFound.push(r);
  }

  // Log failure breakdown for debugging
  if (failed.length > 0) {
    // Group by error category
    const byCat = {};
    for (const f of failed) {
      byCat[f.category] = (byCat[f.category] || 0) + 1;
    }
    const breakdown = Object.entries(byCat)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `${cat}=${count}`)
      .join(", ");

    // Sample one error per category for actual error messages
    const seenCats = new Set();
    const samples = [];
    for (const f of failed) {
      if (!seenCats.has(f.category)) {
        seenCats.add(f.category);
        samples.push(`[${f.category}] "${f.keyword}": ${f.error}`);
      }
      if (seenCats.size >= 6) break;
    }

    console.log(
      `[discovery] Stage 3 summary: ${found.length} found | ${notFound.length} not_found | ${failed.length} failed (of ${rankResults.length} total)`,
    );
    console.log(`[discovery] Stage 3 failure breakdown: ${breakdown}`);
    console.log(
      `[discovery] Stage 3 error samples:\n  ${samples.join("\n  ")}`,
    );
  }

  const rankingPairs = found.sort((a, b) => a.rank - b.rank);

  timings.stage3_search_ms = Date.now() - t;

  // ── Stage 4: Enrich top N ranking pairs ──────────────────────────────────
  t = Date.now();
  const topN = config.discoveryTopNEnrich;
  const enrichLimit = createLimiter(config.discoveryPopularityConcurrency);

  const enriched = await Promise.all(
    rankingPairs
      .slice(0, topN)
      .map((item) =>
        enrichLimit(() =>
          enrichPair(item, pg, redis, store, platform, appleId, appMeta),
        ),
      ),
  );

  // Append the remaining pairs without enrichment, persist their ranks
  const unenriched = rankingPairs.slice(topN).map((item) => ({
    keyword: item.keyword,
    rank: item.rank,
    popularity: null,
    competitiveness: null,
  }));

  // Fire-and-forget: persist rankings for unenriched pairs (with snapshots)
  (async () => {
    try {
      const storefront = await upsertStorefront(pg, store);
      for (const item of rankingPairs.slice(topN)) {
        const allAppData = item.searchResults.map((r) => ({
          appleId: r.id,
          bundleId: r.bundleId || null,
          name: r.name || null,
          developer: null,
          price: null,
          genre: null,
          iconUrl: null,
        }));
        const [word, appIdMap] = await Promise.all([
          upsertWord(pg, item.keyword.toLowerCase().trim()),
          upsertApps(pg, allAppData),
        ]);
        const kwRow = await upsertKeyword(pg, word.id, storefront.id, platform);
        const snapshot = await insertSearchSnapshot(
          pg,
          kwRow.id,
          item.searchResults.length,
          item.searchResults,
        );
        await insertAppRankings(
          pg,
          kwRow.id,
          snapshot.id,
          item.searchResults
            .filter((r) => appIdMap.has(r.id))
            .map((r) => ({ appDbId: appIdMap.get(r.id), rank: r.rank })),
        );
      }
    } catch {
      // Non-fatal
    }
  })();

  timings.stage4_enrich_ms = Date.now() - t;
  timings.total_ms = Date.now() - totalStart;

  return {
    app: {
      name: appMeta.name,
      subtitle: appMeta.subtitle ?? null,
      developer: appMeta.developer ?? null,
      genre: appMeta.genre ?? null,
    },
    stats: {
      tokensExtracted,
      synonymsGenerated,
      uniqueTerms: uniqueTerms.length,
      pairsGenerated: pairs.length,
      pairsRanking: rankingPairs.length,
      pairsNotFound: notFound.length,
      pairsFailed: failed.length,
      failureBreakdown:
        failed.length > 0
          ? Object.entries(
              failed.reduce((acc, f) => {
                acc[f.category] = (acc[f.category] || 0) + 1;
                return acc;
              }, {}),
            )
              .sort((a, b) => b[1] - a[1])
              .reduce((obj, [k, v]) => {
                obj[k] = v;
                return obj;
              }, {})
          : null,
    },
    timings,
    results: [...enriched, ...unenriched],
  };
}
