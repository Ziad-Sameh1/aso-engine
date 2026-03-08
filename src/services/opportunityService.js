/**
 * Opportunity Service
 *
 * Discovers high-value keyword opportunities for an app across multiple storefronts.
 *
 * Pipeline:
 *   1. Scrape app metadata (name, subtitle, description, category)
 *   2. Gemini generates 20-25 category-level keywords + synonyms (~60-75 terms)
 *   3. For each Tier 1 English store:
 *      a. Expand keywords via Apple autocomplete (first-word prefix → discover real search terms)
 *      b. Score every expanded keyword via binary-search popularity
 *   4. Return per-store keyword+popularity data (competitiveness + opportunity score come later)
 *
 * 429 handling: queue-based rotation (like discoverKeywordsDirect in /analyze).
 * On first 429, the prefix/keyword is moved to a retry queue instead of
 * retrying inline. After the main pass, queued items are retried with
 * increasing backoff — giving the API time to cool down.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config/index.js";
import { scrapeAppPageMetadata, getSearchRankingsLite } from "./appstore.js";
import { calculateCompetitiveness } from "./competitiveness.js";
import { CacheService } from "./cache.js";

// TODO: restore full tier after testing
const TIER1_STORES = ["gb", "au", "ca", "in", "sg", "us"];

const KEYWORD_DELAY_MS = 150;
const RETRY_BACKOFFS = [5000, 15000, 30000];
const ENRICH_CONCURRENCY = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/144.0.0.0 Safari/537.36";

// ── Non-retrying suggest fetch (returns null on 429 for queue rotation) ──────

/**
 * Single-attempt suggestion fetch. Checks Redis cache first.
 * Returns suggestions array on success, or `null` on 429 (caller queues for retry).
 */
async function fetchSuggestionsOnce(prefix, storefront, platform, mediaApiToken, redis) {
  const cache = new CacheService(redis);
  const cacheKey = `suggest:${storefront}:${platform}:${prefix.toLowerCase()}`;

  if (config.cacheTtlSuggest > 0) {
    const cached = await cache.get(cacheKey);
    if (cached) return cached;
  }

  const url =
    `https://amp-api-edge.apps.apple.com/v1/catalog/${storefront}` +
    `/search/suggestions?term=${encodeURIComponent(prefix)}&kinds=terms&platform=${platform}&limit=10`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${mediaApiToken}`,
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      Origin: "https://apps.apple.com",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (response.status === 429) return null;

  if (!response.ok) {
    console.warn(`[opportunity] Suggest HTTP ${response.status} for "${prefix}"`);
    return [];
  }

  const data = await response.json();
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
}

// ── Stage 1: Gemini keyword generation ───────────────────────────────────────

async function generateCategoryKeywords(app) {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY is not configured.");

  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const briefDescription = app.subtitle ?? app.description?.slice(0, 120) ?? "N/A";

  const prompt = `You are an App Store search expert. For a ${app.category ?? "productivity"} app that ${briefDescription}, what are 20-25 keywords (1-2 words each) that real users type into the App Store search? Think like a user. Include the most common/popular search terms for this category, not just terms from this app's listing. Examples for an expense tracker: expense tracker, budget app, money manager, spending tracker, bill tracker, finance app, etc.

For each keyword also provide 2-3 synonyms or close variants (1-2 words each) that users also commonly search. Synonyms should be real alternative phrasings, not just word shuffles.

Return ONLY a JSON object in this exact format, nothing else. No markdown, no explanation:
{"keywords": [{"keyword": "expense tracker", "synonyms": ["spending tracker", "expense log"]}, {"keyword": "budget app", "synonyms": ["budgeting app", "budget planner"]}]}`;

  const result = await model.generateContent(prompt);
  const text = result.response
    .text()
    .trim()
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Gemini returned invalid JSON for keyword generation.");
  }

  if (!Array.isArray(parsed?.keywords)) {
    throw new Error("Gemini response missing 'keywords' array.");
  }

  const seen = new Set();
  const all = [];

  for (const entry of parsed.keywords) {
    const primary = String(entry.keyword ?? "").toLowerCase().trim();
    const synonyms = Array.isArray(entry.synonyms) ? entry.synonyms : [];

    for (const term of [primary, ...synonyms.map((s) => String(s).toLowerCase().trim())]) {
      if (term.length > 0 && !seen.has(term)) {
        seen.add(term);
        all.push(term);
      }
    }
  }

  return all;
}

// ── Stage 1b: LLM relevance filter ───────────────────────────────────────────

/**
 * Sends the expanded keyword list to Gemini and asks it to keep only keywords
 * relevant to the app's category. Language-agnostic — works for any storefront.
 * Falls back to the unfiltered list if the LLM returns invalid JSON.
 */
async function filterKeywordsWithLLM(app, keywords) {
  if (!config.geminiApiKey) {
    console.warn("[opportunity] GEMINI_API_KEY not set, skipping LLM relevance filter");
    return keywords;
  }

  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `You are an App Store keyword relevance expert.

App: "${app.name}"
Subtitle: ${app.subtitle ?? "N/A"}
Category: ${app.category ?? "Productivity"}
Description: ${app.description?.slice(0, 200) ?? "N/A"}

Below is a list of ${keywords.length} keywords discovered via App Store autocomplete. Many are irrelevant (brand names, unrelated apps, unrelated categories).

Return ONLY the keywords that a user searching for THIS type of app might actually type. Remove:
- Brand names of unrelated apps (e.g. "my fitness pal", "life 360")
- Keywords for completely different app categories
- Company or business names (e.g. "consistent shot, llc")
- Keywords with no semantic connection to this app's purpose

Return a JSON array of the relevant keywords strings only, nothing else. No markdown, no explanation.

Keywords:
${JSON.stringify(keywords)}`;

  const result = await model.generateContent(prompt);
  const text = result.response
    .text()
    .trim()
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  try {
    const filtered = JSON.parse(text);
    if (Array.isArray(filtered)) {
      return filtered.map((k) => String(k).toLowerCase().trim()).filter(Boolean);
    }
  } catch {
    // fall through to fallback
  }

  console.warn("[opportunity] LLM relevance filter returned invalid JSON, using unfiltered list");
  return keywords;
}

// ── Non-retrying search fetch (returns null on 429 for queue rotation) ────────

/**
 * Single-attempt search HTML fetch via getSearchRankingsLite.
 * Returns { allResults, topMetadata } on success, or `null` on 429.
 * On other errors, returns empty results (non-fatal).
 */
async function fetchSearchOnce(keyword, country, platform) {
  try {
    return await getSearchRankingsLite({ keyword, country, platform, limit: 50, topN: 10 });
  } catch (err) {
    if (err.message?.includes("429")) return null;
    console.warn(`[opportunity] Search failed for "${keyword}" store=${country}: ${err.message}`);
    return { allResults: [], topMetadata: {} };
  }
}

// ── Stage 2: Expand keywords via Apple autocomplete (queue-based 429) ────────

/**
 * For each keyword, take the first word as a prefix and fetch Apple's
 * autocomplete suggestions for that store. Uses single-attempt fetches
 * with queue-based retry rotation on 429.
 */
async function expandKeywordsViaAutocomplete(
  keywords,
  store,
  platform,
  mediaApiToken,
  redis
) {
  const expanded = new Set(keywords);

  const firstWords = [
    ...new Set(
      keywords
        .map((k) => k.split(/\s+/)[0])
        .filter((w) => w.length >= 2)
    ),
  ];

  console.log(
    `[opportunity] Expanding via autocomplete for store=${store}: ${firstWords.length} unique prefixes`
  );

  function collectSuggestions(suggestions) {
    for (const s of suggestions) {
      const term = s.term?.toLowerCase().trim();
      if (term && term.split(/\s+/).length <= 3) {
        expanded.add(term);
      }
    }
  }

  // ── First pass: rotate through all prefixes ────────────────────────────────
  let retryQueue = [];

  for (let i = 0; i < firstWords.length; i++) {
    try {
      const suggestions = await fetchSuggestionsOnce(
        firstWords[i], store, platform, mediaApiToken, redis
      );
      if (suggestions === null) {
        retryQueue.push(firstWords[i]);
      } else {
        collectSuggestions(suggestions);
      }
    } catch (err) {
      console.warn(
        `[opportunity] Autocomplete failed for prefix="${firstWords[i]}" store=${store}: ${err.message}`
      );
    }

    console.log(
      `[opportunity] store=${store} expand: ${i + 1}/${firstWords.length} prefixes (${expanded.size} terms so far)`
    );

    if (i < firstWords.length - 1) {
      await sleep(KEYWORD_DELAY_MS);
    }
  }

  if (retryQueue.length > 0) {
    console.log(
      `[opportunity] store=${store} expansion: ${retryQueue.length} prefixes queued for retry`
    );
  }

  // ── Retry passes with increasing backoff ───────────────────────────────────
  for (let pass = 0; pass < RETRY_BACKOFFS.length && retryQueue.length > 0; pass++) {
    const backoffMs = RETRY_BACKOFFS[pass];
    console.log(
      `[opportunity] store=${store} expansion retry ${pass + 1}/${RETRY_BACKOFFS.length}: ${retryQueue.length} prefixes, waiting ${backoffMs}ms`
    );
    await sleep(backoffMs);

    const nextQueue = [];
    for (let i = 0; i < retryQueue.length; i++) {
      try {
        const suggestions = await fetchSuggestionsOnce(
          retryQueue[i], store, platform, mediaApiToken, redis
        );
        if (suggestions === null) {
          nextQueue.push(retryQueue[i]);
        } else {
          collectSuggestions(suggestions);
        }
      } catch (err) {
        console.warn(
          `[opportunity] Retry failed for prefix="${retryQueue[i]}" store=${store}: ${err.message}`
        );
      }

      if (i < retryQueue.length - 1) {
        await sleep(KEYWORD_DELAY_MS);
      }
    }
    retryQueue = nextQueue;
  }

  if (retryQueue.length > 0) {
    console.warn(
      `[opportunity] store=${store} expansion: ${retryQueue.length} prefixes exhausted all retries: ${retryQueue.join(", ")}`
    );
  }

  const allExpanded = [...expanded];

  console.log(
    `[opportunity] store=${store}: ${keywords.length} seed → ${allExpanded.length} expanded (LLM relevance filter applied later)`
  );

  return allExpanded;
}

// ── Stage 3: Non-retrying binary-search popularity (queue-based 429) ─────────

/**
 * Binary-search over prefix lengths using fetchSuggestionsOnce.
 * Returns { status: "ok", appearance } or { status: "retry" } on any 429.
 * Never blocks on inline retries — 429 bails immediately.
 */
async function findFirstAppearanceOnce(keyword, storefront, platform, mediaApiToken, redis) {
  const norm = keyword.toLowerCase().trim();
  const totalLen = norm.length;
  if (totalLen === 0) return { status: "ok", appearance: null };

  const wordBoundaryRe = new RegExp(
    `(?:^|\\s)${norm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`
  );

  async function check(prefixLen) {
    const prefix = norm.slice(0, prefixLen);
    const suggestions = await fetchSuggestionsOnce(
      prefix, storefront, platform, mediaApiToken, redis
    );
    if (suggestions === null) return "rate_limited";

    const primary = suggestions.find(
      (s) => s.term === norm || s.term.startsWith(norm)
    );
    if (primary) return { ...primary, suggestionCount: suggestions.length, wordBoundary: false };

    const secondary = suggestions.find((s) => wordBoundaryRe.test(s.term));
    if (secondary) return { ...secondary, suggestionCount: suggestions.length, wordBoundary: true };

    return null;
  }

  const fullMatch = await check(totalLen);
  if (fullMatch === "rate_limited") return { status: "retry" };
  if (!fullMatch) return { status: "ok", appearance: null };

  let bestMatch = { ...fullMatch, prefixLength: totalLen };

  let lo = 1;
  let hi = totalLen - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const match = await check(mid);
    if (match === "rate_limited") {
      return { status: "retry", appearance: bestMatch };
    }
    if (match) {
      bestMatch = { ...match, prefixLength: mid };
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  return { status: "ok", appearance: bestMatch };
}

/**
 * Score a single keyword using the non-retrying binary search.
 * Returns { status: "ok", score } or { status: "retry" }.
 */
function scoreFromAppearance(appearance, totalLen) {
  if (!appearance) return 5;

  let prefixScore;
  const ratioScore = Math.round((1 - appearance.prefixLength / totalLen) * 100);
  const absoluteScore = Math.max(0, 100 - (appearance.prefixLength - 1) * 15);
  prefixScore = Math.max(absoluteScore, ratioScore);

  if (appearance.wordBoundary) {
    prefixScore = Math.round(prefixScore * 0.6);
  }

  const positionScore = Math.max(0, Math.round(100 - (appearance.position - 1) * 15));

  const isSparse = appearance.suggestionCount <= (config.popLowDensityThreshold ?? 3);
  if (isSparse) return 5;

  const weightedSum = prefixScore * 0.8 + positionScore * 0.15;
  return Math.max(5, Math.min(95, Math.round(weightedSum)));
}

async function scoreKeywordOnce(keyword, store, platform, mediaApiToken, redis) {
  const norm = keyword.toLowerCase().trim();
  const result = await findFirstAppearanceOnce(norm, store, platform, mediaApiToken, redis);

  if (result.status === "retry") {
    if (result.appearance) {
      return { status: "ok", score: scoreFromAppearance(result.appearance, norm.length) };
    }
    return { status: "retry" };
  }

  return { status: "ok", score: scoreFromAppearance(result.appearance, norm.length) };
}

/**
 * Score all keywords for a store. Keywords that 429 during binary search are
 * rotated to the retry queue (no inline blocking).
 */
async function scoreKeywordsForStore(keywords, store, platform, redis) {
  const mediaApiToken = config.appleMediaApiToken;
  const results = [];
  let retryQueue = [];

  // ── First pass ─────────────────────────────────────────────────────────────
  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i];
    try {
      const { status, score } = await scoreKeywordOnce(keyword, store, platform, mediaApiToken, redis);
      if (status === "retry") {
        retryQueue.push(keyword);
      } else if (score > 5) {
        results.push({ keyword, popularity: score });
      }
    } catch (err) {
      console.warn(
        `[opportunity] Popularity failed for "${keyword}" store=${store}: ${err.message}`
      );
    }

    console.log(
      `[opportunity] store=${store} score: ${i + 1}/${keywords.length} "${keyword}" → ${results.length} popular so far`
    );

    if (i < keywords.length - 1) {
      await sleep(KEYWORD_DELAY_MS);
    }
  }

  if (retryQueue.length > 0) {
    console.log(
      `[opportunity] store=${store} scoring: ${retryQueue.length} keywords queued for retry`
    );
  }

  // ── Retry passes ───────────────────────────────────────────────────────────
  for (let pass = 0; pass < RETRY_BACKOFFS.length && retryQueue.length > 0; pass++) {
    const backoffMs = RETRY_BACKOFFS[pass];
    console.log(
      `[opportunity] store=${store} scoring retry ${pass + 1}/${RETRY_BACKOFFS.length}: ${retryQueue.length} keywords, waiting ${backoffMs}ms`
    );
    await sleep(backoffMs);

    const nextQueue = [];
    for (let i = 0; i < retryQueue.length; i++) {
      const keyword = retryQueue[i];
      try {
        const { status, score } = await scoreKeywordOnce(keyword, store, platform, mediaApiToken, redis);
        if (status === "retry") {
          nextQueue.push(keyword);
        } else if (score > 5) {
          results.push({ keyword, popularity: score });
        }
      } catch (err) {
        console.warn(
          `[opportunity] Retry scoring failed for "${keyword}" store=${store}: ${err.message}`
        );
      }

      if (i < retryQueue.length - 1) {
        await sleep(KEYWORD_DELAY_MS);
      }
    }
    retryQueue = nextQueue;
  }

  if (retryQueue.length > 0) {
    console.warn(
      `[opportunity] store=${store} scoring: ${retryQueue.length} keywords exhausted all retries`
    );
  }

  return results.sort((a, b) => b.popularity - a.popularity);
}

// ── Stage 4: Enrich keywords with difficulty + competitors (queue-based 429) ──

/**
 * For each scored keyword, fetch search results once to derive:
 *   - difficulty (competitiveness score via calculateCompetitiveness)
 *   - opportunityScore (popularity × (1 - difficulty/100))
 *   - numberOfResults (total search results)
 *   - appRank (position of target app, or null)
 *   - top10 (top 10 competitor apps with name, icon, rating, ratingCount)
 *
 * 429s are queued for retry — same pattern as expansion/scoring stages.
 */
async function enrichKeywordsForStore(scoredKeywords, appleId, store, platform) {
  const enriched = [];
  let retryQueue = [];

  function processSearchResult(kwObj, searchResult) {
    const { allResults, topMetadata } = searchResult;
    const top10 = allResults.slice(0, 10).map((r) => {
      const m = topMetadata[r.id] ?? {};
      return {
        rank: r.rank,
        id: r.id,
        name: r.name || m.name || "",
        iconUrl: m.iconUrl ?? null,
        rating: m.rating ?? null,
        ratingCount: m.ratingCount ?? null,
      };
    });

    const forCompetitiveness = top10.map((r) => ({
      rank: r.rank,
      rating: r.rating,
      ratingCount: r.ratingCount,
    }));

    // ── Difficulty: suppress avgRating component when competition is negligible ──
    // If fewer than 3 apps have meaningful presence (ratingCount >= 10),
    // the star-rating average of a few new apps inflates the score. Force 5.
    const meaningfulApps = top10.filter((r) => (r.ratingCount ?? 0) >= 10).length;
    const difficulty = meaningfulApps < 3 ? 5 : calculateCompetitiveness(forCompetitiveness);

    // ── Popularity: cap based on median ratingCount of top 10 ──────────────────
    // High prefix-depth scores can be inflated for niche terms. Top apps' rating
    // counts are ground-truth evidence of actual search volume.
    const ratingCounts = top10.map((r) => r.ratingCount ?? 0).sort((a, b) => a - b);
    const mid = Math.floor(ratingCounts.length / 2);
    const medianRatingCount =
      ratingCounts.length % 2 === 0
        ? (ratingCounts[mid - 1] + ratingCounts[mid]) / 2
        : ratingCounts[mid];

    let popularityCap;
    if (medianRatingCount === 0) popularityCap = 15;
    else if (medianRatingCount <= 50) popularityCap = 35;
    else if (medianRatingCount <= 500) popularityCap = 55;
    else if (medianRatingCount <= 5000) popularityCap = 75;
    else popularityCap = 100;

    const popularity = Math.min(kwObj.popularity, popularityCap);

    const appRank = allResults.find((r) => String(r.id) === String(appleId))?.rank ?? null;
    const opportunityScore = Math.round(popularity * (1 - difficulty / 100));

    return {
      keyword: kwObj.keyword,
      popularity,
      difficulty,
      opportunityScore,
      numberOfResults: allResults.length,
      appRank,
      top10,
    };
  }

  // ── Process a batch of keywords with concurrency ─────────────────────────
  async function processBatch(items, label) {
    const queued = [];
    let done = 0;

    for (let i = 0; i < items.length; i += ENRICH_CONCURRENCY) {
      const chunk = items.slice(i, i + ENRICH_CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map((kwObj) =>
          fetchSearchOnce(kwObj.keyword, store, platform).then((result) => ({
            kwObj,
            result,
          }))
        )
      );

      for (const settled of results) {
        done++;
        if (settled.status === "rejected") {
          console.warn(
            `[opportunity] Enrichment ${label} failed store=${store}: ${settled.reason?.message}`
          );
          continue;
        }
        const { kwObj, result } = settled.value;
        if (result === null) {
          queued.push(kwObj);
        } else {
          enriched.push(processSearchResult(kwObj, result));
        }
      }

      console.log(
        `[opportunity] store=${store} enrich ${label}: ${done}/${items.length} (${enriched.length} done)`
      );

      if (i + ENRICH_CONCURRENCY < items.length) {
        await sleep(KEYWORD_DELAY_MS);
      }
    }

    return queued;
  }

  // ── First pass ─────────────────────────────────────────────────────────────
  retryQueue = await processBatch(scoredKeywords, "pass");

  if (retryQueue.length > 0) {
    console.log(
      `[opportunity] store=${store} enrichment: ${retryQueue.length} keywords queued for retry`
    );
  }

  // ── Retry passes with increasing backoff ───────────────────────────────────
  for (let pass = 0; pass < RETRY_BACKOFFS.length && retryQueue.length > 0; pass++) {
    const backoffMs = RETRY_BACKOFFS[pass];
    console.log(
      `[opportunity] store=${store} enrichment retry ${pass + 1}/${RETRY_BACKOFFS.length}: ${retryQueue.length} keywords, waiting ${backoffMs}ms`
    );
    await sleep(backoffMs);

    retryQueue = await processBatch(retryQueue, `retry-${pass + 1}`);
  }

  if (retryQueue.length > 0) {
    console.warn(
      `[opportunity] store=${store} enrichment: ${retryQueue.length} keywords exhausted all retries`
    );
  }

  return enriched.sort((a, b) => b.opportunityScore - a.opportunityScore);
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * @param {import('pg').Pool} pg
 * @param {object} redis  - ioredis client
 * @param {string} appleId
 * @param {string} store  - used for metadata fetch storefront
 * @param {string} platform
 */
export async function getOpportunities(pg, redis, appleId, store, platform) {
  const timings = {};
  let t = Date.now();

  // ── 1. App metadata ────────────────────────────────────────────────────────
  const page = await scrapeAppPageMetadata(appleId, store);

  const app = page
    ? {
        name: page.name,
        subtitle: page.subtitle,
        description: page.description,
        category: page.genre,
      }
    : null;

  if (!app) {
    return { app: null, seedKeywords: [], storeResults: {}, timings: {} };
  }

  timings.metadata_ms = Date.now() - t;

  // ── 2. Gemini keyword generation ───────────────────────────────────────────
  t = Date.now();
  const seedKeywords = await generateCategoryKeywords(app);
  timings.gemini_ms = Date.now() - t;

  console.log(
    `[opportunity] App "${app.name}" (${appleId}): ${seedKeywords.length} seed keywords from Gemini`
  );

  // ── 3. Per-store: expand → score ───────────────────────────────────────────
  const storeResults = {};

  for (const s of TIER1_STORES) {
    const storeT = Date.now();

    const expanded = await expandKeywordsViaAutocomplete(
      seedKeywords,
      s,
      platform,
      config.appleMediaApiToken,
      redis
    );

    const filterT = Date.now();
    const relevant = await filterKeywordsWithLLM(app, expanded);
    timings[`filter_${s}_ms`] = Date.now() - filterT;

    console.log(
      `[opportunity] store=${s}: ${expanded.length} expanded → ${relevant.length} after LLM relevance filter (${timings[`filter_${s}_ms`]}ms)`
    );

    const scored = await scoreKeywordsForStore(relevant, s, platform, redis);

    const enrichT = Date.now();
    const enriched = await enrichKeywordsForStore(scored, appleId, s, platform);
    timings[`enrich_${s}_ms`] = Date.now() - enrichT;

    storeResults[s] = {
      totalExpanded: expanded.length,
      totalRelevant: relevant.length,
      totalWithVolume: scored.length,
      keywords: enriched,
    };

    timings[`store_${s}_ms`] = Date.now() - storeT;

    console.log(
      `[opportunity] store=${s} done: ${scored.length} scored → ${enriched.length} enriched (${timings[`store_${s}_ms`]}ms)`
    );
  }

  return { app, seedKeywords, storeResults, timings };
}
