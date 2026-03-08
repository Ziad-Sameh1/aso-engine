/**
 * Keyword Discovery Engine
 *
 * Finds keyword phrases the target app actually ranks for in Apple's App Store.
 *
 * Stage 1 — Gemini: Extract tokens classified as "core" (functional) vs "filler" (generic)
 * Stage 2 — Brand terms: Always check app name, subtitle phrases, developer name
 * Stage 3 — Apple Suggest: Expand top core tokens into real user search phrases
 * Stage 4 — Rank check: Search brand + suggest + core-only pairs with early termination
 * Stage 5 — Enrich: Popularity + competitiveness for ranked keywords with rank < threshold
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { CacheService } from "./cache.js";
import { config } from "../config/index.js";
import {
  fetchAppMetadata,
  fetchSearchHtml,
  fetchSearchHtmlViaProxy,
  extractSearchResults,
  lookupAppMetadata,
} from "./appstore.js";
import { calculatePopularity, fetchSuggestions } from "./popularity.js";
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

// ── Stage 1: Gemini token extraction with core/filler classification ─────────

async function extractTokens(appMeta, redis) {
  const cache = new CacheService(redis);
  // v2 cache key — busts old unclassified cache
  const cacheKey = `discovery:tokens:v2:${appMeta.appleId}`;

  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  if (!config.geminiApiKey)
    throw new Error("GEMINI_API_KEY is not configured.");

  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const descriptionSnippet = appMeta.description?.slice(0, 1000) ?? "N/A";

  const prompt = `You are an App Store Optimization expert. Analyze this iOS app's metadata and extract important single-word keyword tokens, classifying each as "core" or "filler".

App Name: ${appMeta.name}
App Subtitle: ${appMeta.subtitle ?? "N/A"}
App Description (first 1000 chars): ${descriptionSnippet}
Genre: ${appMeta.genre ?? "N/A"}

Classification rules:
- "core" tokens describe the app's actual function, specific features, or what users search for when looking for this type of app. Examples for a video loop app: loop, video, reverse, playback, boomerang, maker, editor, recorder, gif, animation.
- "filler" tokens are generic/vague words that apply to many unrelated apps and rarely form useful search pairs. Examples: fun, creativity, content, tools, options, amazing, easy, best, free, simple, great, perfect, beautiful, powerful, ultimate, customize, create, make, use.

Instructions:
1. Extract 20-40 unique, important single-word tokens. The app name and subtitle are highest priority; the description is secondary.
2. Classify each token as "core" or "filler".
3. Exclude: the app's unique brand or product name, common stop words (the, a, an, is, for, with, and, or, to, in, on, of, my, your, this, that, it, app, by, at, be, do, go, get), and single characters.
4. All tokens must be lowercase.
5. For each token, provide 2-3 single-word synonyms. Classify synonyms as "core" or "filler" too.

Return ONLY a JSON object in this exact format, nothing else. No markdown, no explanation:
{
  "tokens": [
    { "word": "video", "classification": "core", "synonyms": [{"word": "clip", "classification": "core"}, {"word": "footage", "classification": "core"}] },
    { "word": "creativity", "classification": "filler", "synonyms": [{"word": "creative", "classification": "filler"}] }
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
    coreTerms: [],
    fillerTerms: [],
    uniqueTerms: [], // all terms combined (backwards compat)
  };

  const seen = new Set();

  // First pass: original token words
  for (const entry of parsed.tokens) {
    const word = String(entry.word ?? "").toLowerCase().trim();
    const isFiller = entry.classification !== "core";
    if (word && !seen.has(word)) {
      seen.add(word);
      if (isFiller) tokenData.fillerTerms.push(word);
      else tokenData.coreTerms.push(word);
      tokenData.tokensExtracted++;
    }
  }

  // Second pass: synonyms
  for (const entry of parsed.tokens) {
    for (const syn of entry.synonyms ?? []) {
      // Handle both new object format {word, classification} and old plain string format
      const s = (typeof syn === "object"
        ? String(syn.word ?? "")
        : String(syn)
      ).toLowerCase().trim();
      const isFiller = typeof syn === "object"
        ? syn.classification !== "core"
        : true; // plain string synonyms default to filler
      if (s && !seen.has(s)) {
        seen.add(s);
        if (isFiller) tokenData.fillerTerms.push(s);
        else tokenData.coreTerms.push(s);
        tokenData.synonymsGenerated++;
      }
    }
  }

  // uniqueTerms = core first, then filler (backwards compat, capped at discoveryMaxTerms)
  tokenData.uniqueTerms = [...tokenData.coreTerms, ...tokenData.fillerTerms].slice(
    0,
    config.discoveryMaxTerms,
  );

  await cache.set(cacheKey, tokenData, config.cacheTtlSuggestions);
  return tokenData;
}

// ── Stage 2: Extract brand/name terms ────────────────────────────────────────

const STOP_WORDS = new Set([
  "the","a","an","is","for","with","and","or","to","in","on","of",
  "my","your","this","that","it","app","by","at","be","do","go","get",
]);

function extractBrandTerms(appMeta) {
  const terms = new Set();

  // Full app name as a search phrase
  if (appMeta.name) terms.add(appMeta.name.toLowerCase().trim());

  // Full subtitle as a phrase
  if (appMeta.subtitle) terms.add(appMeta.subtitle.toLowerCase().trim());

  // Individual subtitle words (skip stop words and short tokens)
  if (appMeta.subtitle) {
    for (const word of appMeta.subtitle.toLowerCase().split(/\s+/)) {
      const w = word.replace(/[^a-z0-9]/g, "");
      if (w.length >= 2 && !STOP_WORDS.has(w)) terms.add(w);
    }
  }

  // Developer name
  if (appMeta.developer) terms.add(appMeta.developer.toLowerCase().trim());

  return [...terms].filter(Boolean);
}

// ── Stage 3: Apple Suggest expansion ─────────────────────────────────────────

async function expandViaSuggest(coreTerms, store, platform, redis) {
  if (!config.appleMediaApiToken) {
    console.log("[discovery] APPLE_MEDIA_API_TOKEN not set — skipping suggest expansion");
    return { suggestTerms: [], suggestRaw: {} };
  }

  const topCore = coreTerms.slice(0, config.discoverySuggestTopN);

  // Build prefix list: top individual core tokens + 2-word combos of first 4
  const prefixes = [...topCore];
  const comboBase = coreTerms.slice(0, 4);
  for (let i = 0; i < comboBase.length; i++) {
    for (let j = i + 1; j < comboBase.length; j++) {
      prefixes.push(`${comboBase[i]} ${comboBase[j]}`);
    }
  }

  const suggestLimit = createLimiter(config.discoverySuggestConcurrency);
  const suggestRaw = {};
  const suggestTerms = new Set();

  await Promise.all(
    prefixes.map((prefix) =>
      suggestLimit(async () => {
        try {
          const suggestions = await fetchSuggestions(
            prefix,
            store,
            platform,
            config.appleMediaApiToken,
            redis,
          );
          const terms = suggestions.map((s) => s.term).filter(Boolean);
          suggestRaw[prefix] = terms;
          for (const t of terms) suggestTerms.add(t);
        } catch {
          suggestRaw[prefix] = [];
        }
      }),
    ),
  );

  console.log(`[discovery] Suggest expansion: ${prefixes.length} prefixes → ${suggestTerms.size} unique terms`);
  return { suggestTerms: [...suggestTerms], suggestRaw };
}

// ── Generate ordered 2-word permutations ─────────────────────────────────────

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

// ── Rank check helpers ────────────────────────────────────────────────────────

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

async function checkRank(term, appleId, store, platform, rateState) {
  const maxRetries = Math.max(0, config.discovery429MaxRetries);
  const baseBackoffMs = Math.max(0, config.discovery429BaseBackoffMs);
  const maxBackoffMs = Math.max(baseBackoffMs, config.discovery429MaxBackoffMs);
  const baseDelayMs = Math.max(0, config.discoverySearchDelayMs);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await waitForNextSlot(rateState, baseDelayMs);

    try {
      const html = await fetchSearchHtmlViaProxy(term, store, platform);
      const results = extractSearchResults(html);
      const match = results.find((r) => r.id === String(appleId));
      if (!match) {
        if (rateState) rateState.consecutive429 = 0;
        return { status: "not_found", keyword: term };
      }
      const top10Ids = results.slice(0, 10).map((r) => r.id);
      console.log(`[discovery] Found ${match.rank} rank for ${term}`);
      if (rateState) rateState.consecutive429 = 0;
      return {
        status: "found",
        keyword: term,
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
          `[discovery] 429 for "${term}" (attempt ${attempt + 1}/${maxRetries + 1}) -> retrying in ${cooldownMs}ms`,
        );
        continue;
      }

      console.error(`[discovery] Error checking rank for ${term}: ${err.message}`);
      const category = categorizeError(err);
      return {
        status: "failed",
        keyword: term,
        error: err.message || String(err),
        category,
      };
    }
  }

  return {
    status: "failed",
    keyword: term,
    error: "Exhausted retry attempts.",
    category: "http_429",
  };
}

// ── Enrich a ranking result with popularity + competitiveness ─────────────────

async function enrichPair(item, pg, redis, store, platform) {
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

  if (competitiveness === null && item.top10Ids?.length) {
    try {
      const metadata = await lookupAppMetadata(item.top10Ids, store);
      const top10Results = item.top10Ids.map((id) => metadata[id] ?? {});
      competitiveness = calculateCompetitiveness(top10Results);
    } catch {
      // Non-fatal — leave as null
    }
  }

  // Fire-and-forget persistence
  (async () => {
    try {
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
      if (popularity !== null) await insertPopularity(pg, kwRow.id, popularity);
      if (competitiveness !== null) await insertCompetitiveness(pg, kwRow.id, competitiveness);
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
 * Discover keyword phrases the app actually ranks for in the App Store.
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

  // ── Stage 1: Fetch metadata + Gemini token extraction with classification ──
  let t = Date.now();

  const appMeta = await fetchAppMetadata(appleId, store);
  if (!appMeta) throw new Error(`App ${appleId} not found on App Store.`);
  appMeta.appleId = appleId;

  const tokenData = await extractTokens(appMeta, redis);
  console.log(`[discovery] Extracted ${tokenData.tokensExtracted} tokens (${tokenData.coreTerms.length} core, ${tokenData.fillerTerms.length} filler)`);
  console.log(`[discovery] Generated ${tokenData.synonymsGenerated} synonyms`);
  timings.stage1_gemini_ms = Date.now() - t;

  // ── Stage 2: Brand/name standalone search terms ───────────────────────────
  t = Date.now();
  const brandTerms = extractBrandTerms(appMeta);
  console.log(`[discovery] Brand terms: ${brandTerms.length} (${brandTerms.join(", ")})`);
  timings.stage2_brand_ms = Date.now() - t;

  // ── Stage 3: Apple Suggest expansion on core tokens ───────────────────────
  t = Date.now();
  const { suggestTerms, suggestRaw } = await expandViaSuggest(
    tokenData.coreTerms,
    store,
    platform,
    redis,
  );
  timings.stage3_suggest_ms = Date.now() - t;

  // ── Stage 4: Core-only permutations + rank check with early termination ───
  t = Date.now();
  // Cap core terms used for pairing so every term gets representation.
  // With N terms the loop generates N*(N-1) pairs; if N is too large the cap is
  // hit before terms past index 1 ever appear as a starting word.
  // Formula: largest N where N*(N-1) <= discoveryMaxCorePairs * 2 (allow ~2x coverage)
  const maxCoreForPairing = Math.floor(
    (1 + Math.sqrt(1 + 4 * config.discoveryMaxCorePairs)) / 2,
  );
  const coreTermsForPairing = tokenData.coreTerms.slice(0, maxCoreForPairing);
  const pairs = generatePairs(coreTermsForPairing, config.discoveryMaxCorePairs);
  console.log(`[discovery] Core permutations: ${pairs.length} pairs from ${coreTermsForPairing.length}/${tokenData.coreTerms.length} core terms (cap: ${maxCoreForPairing})`);

  // Build final deduplicated search list: brand first (high priority), then suggest, then core pairs
  // Only keep 1-2 word terms — longer phrases are too specific and rarely rank
  const seenTerms = new Set();
  const allSearchTerms = [];
  for (const term of [...brandTerms, ...suggestTerms, ...pairs]) {
    const norm = term.toLowerCase().trim();
    if (!norm || seenTerms.has(norm)) continue;
    const wordCount = norm.split(/\s+/).length;
    if (wordCount > 2) continue;
    seenTerms.add(norm);
    allSearchTerms.push(term);
  }
  console.log(`[discovery] Total search terms: ${allSearchTerms.length} (${brandTerms.length} brand + ${suggestTerms.length} suggest + ${pairs.length} core pairs, deduped)`);

  const searchLimit = createLimiter(config.discoverySearchConcurrency);
  const rateState = { nextAllowedAt: Date.now(), consecutive429: 0 };

  const found = [];
  const notFound = [];
  const failed = [];
  let earlyTerminated = false;
  let totalSearched = 0;

  // Process in chunks for early termination check after each batch
  const CHUNK_SIZE = config.discoverySearchConcurrency;
  for (let i = 0; i < allSearchTerms.length; i += CHUNK_SIZE) {
    const chunk = allSearchTerms.slice(i, i + CHUNK_SIZE);
    const chunkResults = await Promise.all(
      chunk.map((term) =>
        searchLimit(() => checkRank(term, appleId, store, platform, rateState)),
      ),
    );

    totalSearched += chunk.length;

    for (const r of chunkResults) {
      if (!r) continue;
      if (r.status === "found") found.push(r);
      else if (r.status === "failed") failed.push(r);
      else notFound.push(r);
    }

    // Early termination: enough good-quality keywords found
    const goodCount = found.filter((r) => r.rank <= config.discoveryEarlyTermGoodRank).length;
    if (goodCount >= config.discoveryEarlyTermGoodCount) {
      earlyTerminated = true;
      console.log(
        `[discovery] Early termination: ${goodCount} good keywords (rank ≤ ${config.discoveryEarlyTermGoodRank}) after ${totalSearched}/${allSearchTerms.length} searches`,
      );
      break;
    }
  }

  // Log failure breakdown
  if (failed.length > 0) {
    const byCat = {};
    for (const f of failed) byCat[f.category] = (byCat[f.category] || 0) + 1;
    const breakdown = Object.entries(byCat)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `${cat}=${count}`)
      .join(", ");

    const seenCats = new Set();
    const samples = [];
    for (const f of failed) {
      if (!seenCats.has(f.category)) {
        seenCats.add(f.category);
        samples.push(`[${f.category}] "${f.keyword}": ${f.error}`);
      }
      if (seenCats.size >= 6) break;
    }

    console.log(`[discovery] Search summary: ${found.length} found | ${notFound.length} not_found | ${failed.length} failed (of ${totalSearched} searched)`);
    console.log(`[discovery] Failure breakdown: ${breakdown}`);
    console.log(`[discovery] Error samples:\n  ${samples.join("\n  ")}`);
  }

  const rankingPairs = found.sort((a, b) => a.rank - b.rank);
  timings.stage4_search_ms = Date.now() - t;

  // ── Stage 5: Filter by rank threshold, then enrich top N ─────────────────
  t = Date.now();
  const enrichCandidates = rankingPairs
    .filter((item) => item.rank <= config.discoveryEnrichMaxRank)
    .slice(0, config.discoveryTopNEnrich);

  const enrichLimit = createLimiter(config.discoveryPopularityConcurrency);
  const enriched = await Promise.all(
    enrichCandidates.map((item) =>
      enrichLimit(() => enrichPair(item, pg, redis, store, platform)),
    ),
  );

  // Unenriched = all ranked results that didn't make the cut
  const enrichedKeywords = new Set(enrichCandidates.map((i) => i.keyword));
  const unenriched = rankingPairs
    .filter((item) => !enrichedKeywords.has(item.keyword))
    .map((item) => ({
      keyword: item.keyword,
      rank: item.rank,
      popularity: null,
      competitiveness: null,
    }));

  // Fire-and-forget: persist snapshots for unenriched pairs
  (async () => {
    try {
      const storefront = await upsertStorefront(pg, store);
      for (const item of rankingPairs.filter((i) => !enrichedKeywords.has(i.keyword))) {
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

  timings.stage5_enrich_ms = Date.now() - t;
  timings.total_ms = Date.now() - totalStart;

  return {
    app: {
      name: appMeta.name,
      subtitle: appMeta.subtitle ?? null,
      developer: appMeta.developer ?? null,
      genre: appMeta.genre ?? null,
    },
    stats: {
      tokensExtracted: tokenData.tokensExtracted,
      synonymsGenerated: tokenData.synonymsGenerated,
      coreTerms: tokenData.coreTerms.length,
      fillerTerms: tokenData.fillerTerms.length,
      uniqueTerms: tokenData.uniqueTerms.length,
      brandTerms: brandTerms.length,
      suggestTerms: suggestTerms.length,
      pairsGenerated: pairs.length,
      totalSearched,
      earlyTerminated,
      pairsRanking: rankingPairs.length,
      pairsNotFound: notFound.length,
      pairsFailed: failed.length,
      enrichedCount: enrichCandidates.length,
      skippedEnrichCount: rankingPairs.length - enrichCandidates.length,
      failureBreakdown:
        failed.length > 0
          ? Object.entries(
              failed.reduce((acc, f) => {
                acc[f.category] = (acc[f.category] || 0) + 1;
                return acc;
              }, {}),
            )
              .sort((a, b) => b[1] - a[1])
              .reduce((obj, [k, v]) => { obj[k] = v; return obj; }, {})
          : null,
    },
    timings,
    debug: {
      tokens: tokenData.tokens,
      coreTerms: tokenData.coreTerms,
      fillerTerms: tokenData.fillerTerms,
      brandTerms,
      suggestExpanded: suggestRaw,
      suggestTerms,
      pairs,
      allSearchTerms,
    },
    results: [...enriched, ...unenriched],
  };
}

// ── Direct-IP sequential discovery (for /analyze — no proxy, queue-based 429 retry) ──

const DIRECT_DELAY_MS = 300; // spacing between sequential requests
const RETRY_BACKOFFS = [5000, 15000, 30000]; // 3 retry passes: 5s, 15s, 30s

/**
 * Check a single keyword rank using direct IP (no proxy).
 * Returns the result or a 429 marker for the retry queue.
 */
async function checkRankDirect(term, appleId, store, platform) {
  try {
    const html = await fetchSearchHtml(term, store, platform);
    const results = extractSearchResults(html);
    const match = results.find((r) => r.id === String(appleId));
    if (!match) return { status: "not_found", keyword: term };
    const top10Ids = results.slice(0, 10).map((r) => r.id);
    console.log(`[discovery-direct] Found rank ${match.rank} for "${term}"`);
    return {
      status: "found",
      keyword: term,
      rank: match.rank,
      totalResults: results.length,
      top10Ids,
      searchResults: results,
    };
  } catch (err) {
    if (isHttp429(err)) {
      return { status: "retry", keyword: term };
    }
    console.error(`[discovery-direct] Error for "${term}": ${err.message}`);
    return {
      status: "failed",
      keyword: term,
      error: err.message || String(err),
      category: categorizeError(err),
    };
  }
}

/**
 * Discover keywords using direct IP, sequential execution, and queue-based
 * retry for 429s. Designed for /analyze endpoint (24/7 scraping, no rush).
 *
 * Stages 1-3 and 5 are identical to discoverKeywords().
 * Stage 4 is rewritten: sequential with 429 retry queue.
 */
export async function discoverKeywordsDirect(
  pg,
  redis,
  appleId,
  { store = "us", platform = "iphone", appMeta: externalMeta } = {},
) {
  const totalStart = Date.now();
  const timings = {};

  // ── Stage 1: Fetch metadata + Gemini token extraction ──────────────────────
  let t = Date.now();
  let appMeta;
  if (externalMeta) {
    // Reuse metadata already fetched by the caller (e.g. analyzeApp)
    appMeta = {
      name: externalMeta.name,
      subtitle: externalMeta.subtitle ?? null,
      developer: externalMeta.developer ?? externalMeta.developerDisplayName ?? null,
      genre: externalMeta.category ?? null,
      description: externalMeta.description ?? null,
      appleId,
    };
  } else {
    appMeta = await fetchAppMetadata(appleId, store);
    if (!appMeta) throw new Error(`App ${appleId} not found on App Store.`);
    appMeta.appleId = appleId;
  }

  const tokenData = await extractTokens(appMeta, redis);
  console.log(`[discovery-direct] Extracted ${tokenData.tokensExtracted} tokens (${tokenData.coreTerms.length} core, ${tokenData.fillerTerms.length} filler)`);
  timings.stage1_gemini_ms = Date.now() - t;

  // ── Stage 2: Brand terms ───────────────────────────────────────────────────
  t = Date.now();
  const brandTerms = extractBrandTerms(appMeta);
  console.log(`[discovery-direct] Brand terms: ${brandTerms.length}`);
  timings.stage2_brand_ms = Date.now() - t;

  // ── Stage 3: Apple Suggest expansion ───────────────────────────────────────
  t = Date.now();
  const { suggestTerms, suggestRaw } = await expandViaSuggest(
    tokenData.coreTerms,
    store,
    platform,
    redis,
  );
  timings.stage3_suggest_ms = Date.now() - t;

  // ── Stage 4: Sequential rank check with queue-based 429 retry ──────────────
  t = Date.now();

  const maxCoreForPairing = Math.floor(
    (1 + Math.sqrt(1 + 4 * config.discoveryMaxCorePairs)) / 2,
  );
  const coreTermsForPairing = tokenData.coreTerms.slice(0, maxCoreForPairing);
  const pairs = generatePairs(coreTermsForPairing, config.discoveryMaxCorePairs);

  // Build deduplicated search list (same as original)
  const seenTerms = new Set();
  const allSearchTerms = [];
  for (const term of [...brandTerms, ...suggestTerms, ...pairs]) {
    const norm = term.toLowerCase().trim();
    if (!norm || seenTerms.has(norm)) continue;
    if (norm.split(/\s+/).length > 2) continue;
    seenTerms.add(norm);
    allSearchTerms.push(term);
  }
  console.log(`[discovery-direct] Total search terms: ${allSearchTerms.length}`);

  const found = [];
  const notFound = [];
  const failed = [];
  let retryQueue = [];

  // ── First pass: sequential, one request at a time ──────────────────────────
  for (let i = 0; i < allSearchTerms.length; i++) {
    const result = await checkRankDirect(allSearchTerms[i], appleId, store, platform);
    if (result.status === "found") found.push(result);
    else if (result.status === "retry") retryQueue.push(allSearchTerms[i]);
    else if (result.status === "failed") failed.push(result);
    else notFound.push(result);

    if (i < allSearchTerms.length - 1) {
      await sleep(DIRECT_DELAY_MS);
    }
  }

  console.log(`[discovery-direct] First pass: ${found.length} found, ${notFound.length} not found, ${retryQueue.length} queued for retry, ${failed.length} failed`);

  // ── Retry passes: process 429 queue with increasing backoff ────────────────
  for (let pass = 0; pass < RETRY_BACKOFFS.length && retryQueue.length > 0; pass++) {
    const backoffMs = RETRY_BACKOFFS[pass];
    console.log(`[discovery-direct] Retry pass ${pass + 1}/${RETRY_BACKOFFS.length}: ${retryQueue.length} terms, waiting ${backoffMs}ms`);
    await sleep(backoffMs);

    const nextQueue = [];
    for (let i = 0; i < retryQueue.length; i++) {
      const result = await checkRankDirect(retryQueue[i], appleId, store, platform);
      if (result.status === "found") found.push(result);
      else if (result.status === "retry") nextQueue.push(retryQueue[i]);
      else if (result.status === "failed") failed.push(result);
      else notFound.push(result);

      if (i < retryQueue.length - 1) {
        await sleep(DIRECT_DELAY_MS);
      }
    }
    retryQueue = nextQueue;
  }

  // Any remaining in retry queue → mark as failed
  for (const term of retryQueue) {
    failed.push({
      status: "failed",
      keyword: term,
      error: "Exhausted 429 retry passes.",
      category: "http_429",
    });
  }

  const totalSearched = allSearchTerms.length;
  const rankingPairs = found.sort((a, b) => a.rank - b.rank);
  timings.stage4_search_ms = Date.now() - t;

  // ── Stage 5: Enrich (same as original) ─────────────────────────────────────
  t = Date.now();
  const enrichCandidates = rankingPairs
    .filter((item) => item.rank <= config.discoveryEnrichMaxRank)
    .slice(0, config.discoveryTopNEnrich);

  const enrichLimit = createLimiter(config.discoveryPopularityConcurrency);
  const enriched = await Promise.all(
    enrichCandidates.map((item) =>
      enrichLimit(() => enrichPair(item, pg, redis, store, platform)),
    ),
  );

  const enrichedKeywords = new Set(enrichCandidates.map((i) => i.keyword));
  const unenriched = rankingPairs
    .filter((item) => !enrichedKeywords.has(item.keyword))
    .map((item) => ({
      keyword: item.keyword,
      rank: item.rank,
      popularity: null,
      competitiveness: null,
    }));

  // Fire-and-forget: persist snapshots for unenriched pairs
  (async () => {
    try {
      const storefront = await upsertStorefront(pg, store);
      for (const item of rankingPairs.filter((i) => !enrichedKeywords.has(i.keyword))) {
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

  timings.stage5_enrich_ms = Date.now() - t;
  timings.total_ms = Date.now() - totalStart;

  // Log summary
  if (failed.length > 0) {
    const byCat = {};
    for (const f of failed) byCat[f.category] = (byCat[f.category] || 0) + 1;
    console.log(`[discovery-direct] Failures: ${JSON.stringify(byCat)}`);
  }
  console.log(`[discovery-direct] Done in ${timings.total_ms}ms: ${found.length} found, ${notFound.length} not found, ${failed.length} failed`);

  return {
    app: {
      name: appMeta.name,
      subtitle: appMeta.subtitle ?? null,
      developer: appMeta.developer ?? null,
      genre: appMeta.genre ?? null,
    },
    stats: {
      tokensExtracted: tokenData.tokensExtracted,
      synonymsGenerated: tokenData.synonymsGenerated,
      coreTerms: tokenData.coreTerms.length,
      fillerTerms: tokenData.fillerTerms.length,
      uniqueTerms: tokenData.uniqueTerms.length,
      brandTerms: brandTerms.length,
      suggestTerms: suggestTerms.length,
      pairsGenerated: pairs.length,
      totalSearched,
      earlyTerminated: false,
      pairsRanking: rankingPairs.length,
      pairsNotFound: notFound.length,
      pairsFailed: failed.length,
      retryQueueExhausted: retryQueue.length,
      enrichedCount: enrichCandidates.length,
      skippedEnrichCount: rankingPairs.length - enrichCandidates.length,
      failureBreakdown:
        failed.length > 0
          ? Object.entries(
              failed.reduce((acc, f) => {
                acc[f.category] = (acc[f.category] || 0) + 1;
                return acc;
              }, {}),
            )
              .sort((a, b) => b[1] - a[1])
              .reduce((obj, [k, v]) => { obj[k] = v; return obj; }, {})
          : null,
    },
    timings,
    debug: {
      tokens: tokenData.tokens,
      coreTerms: tokenData.coreTerms,
      fillerTerms: tokenData.fillerTerms,
      brandTerms,
      suggestExpanded: suggestRaw,
      suggestTerms,
      pairs,
      allSearchTerms,
    },
    results: [...enriched, ...unenriched],
  };
}
