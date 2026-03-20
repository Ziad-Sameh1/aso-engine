import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  scrapeAppPageMetadata,
  scrapeAppNameSubtitle,
  fetchSearchHtmlViaProxy,
  fetchSearchHtml,
  extractSearchResults,
  getProxyAgent,
} from "./appstore.js";
import axios from "axios";
import { config } from "../config/index.js";

/** Max concurrency for bulk parallel operations. */
const BULK_CONCURRENCY = 100;

/**
 * Use Gemini to generate 25 localized user intents (search keywords)
 * based on app metadata in the context of a specific storefront.
 */
async function generateIntents(metadata, store) {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY is not configured.");

  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `You are an App Store Optimization expert. Given this iOS app listing from the "${store}" App Store:

- Name: ${metadata.name}
- Subtitle: ${metadata.subtitle || "N/A"}
- Description: ${metadata.description || "N/A"}
- Genre: ${metadata.genre || "N/A"}
- Developer: ${metadata.developer || "N/A"}
- Price: ${metadata.isFree ? "Free" : metadata.price || "N/A"}

Generate exactly 25 search intents that a real user in the "${store}" storefront would type into the App Store search bar when looking for an app like this.

Rules:
- Each intent should be 2-4 words
- Intents must be localized to the "${store}" storefront language and culture
- Include a mix of: generic category searches, feature-specific searches, problem/use-case searches, and competitor-adjacent searches
- All lowercase
- No duplicates
- Do NOT include the app's brand name or developer name
- Return ONLY a JSON array of exactly 25 strings, nothing else. No markdown, no explanation.`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  const json = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  let intents = JSON.parse(json);

  if (!Array.isArray(intents)) throw new Error("Gemini did not return an array.");

  const seen = new Set();
  intents = intents
    .map((k) => String(k).toLowerCase().trim())
    .filter((k) => k.length > 0 && !seen.has(k) && seen.add(k));

  return intents;
}

// ── Hybrid relevance scoring ─────────────────────────────────────────────────

/**
 * Tokenize text into lowercase words. Language-agnostic: no stop word list.
 * Relies on downstream signals (bigrams, function-match) to filter noise naturally.
 * Supports Latin, CJK, Cyrillic, Arabic, Devanagari, and other Unicode scripts.
 */
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/** Extract bigrams from tokens → Set of "word1 word2" strings. */
function extractBigrams(tokens) {
  const bigrams = new Set();
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return bigrams;
}

/**
 * Extract functional tokens from the target app's subtitle + name (excluding brand).
 * These are the core "what this app does" descriptors.
 * Only brand tokens are excluded — no filler list, to stay language-agnostic.
 */
function extractFunctionTokens(name, subtitle) {
  const text = [name, subtitle].filter(Boolean).join(" ");
  const tokens = tokenize(text);
  const brandCandidates = new Set();
  if (name) {
    const colonIdx = name.indexOf(":");
    if (colonIdx > 0) {
      for (const t of tokenize(name.slice(0, colonIdx))) {
        const subtitleLower = (subtitle || "").toLowerCase();
        if (!subtitleLower.includes(t)) brandCandidates.add(t);
      }
    } else if (subtitle) {
      const firstToken = tokenize(name)[0];
      if (firstToken && !(subtitle || "").toLowerCase().includes(firstToken)) {
        brandCandidates.add(firstToken);
      }
    }
  }
  return tokens.filter((t) => !brandCandidates.has(t));
}

/**
 * Score relevance of each competitor against the target app.
 *
 * Three signals:
 * 1. **Feature-function match (40%)**: What fraction of the target's functional phrases
 *    (from name+subtitle, brand excluded) appear in the competitor's name+description.
 *    This catches "expense tracker", "budget planner", "bill reminder" etc.
 *
 * 2. **Description bigram overlap (30%)**: Overlap coefficient on bigrams between
 *    target and competitor text. Uses min(|A|,|B|) as denominator instead of union,
 *    so long keyword-heavy descriptions don't crush the score. Bigrams capture
 *    meaningful phrases ("track expenses", "monthly budget") that single tokens miss.
 *
 * 3. **appearedIn normalized (30%)**: Fraction of total intent count. Apps co-ranking
 *    in the same App Store searches are actual competitors by Apple's algorithm.
 *    Uses intent count as denominator (not max) to avoid outlier skew.
 *
 * Returns a Map of appleId → score (0-100). Runs locally in milliseconds.
 */
function scoreRelevance(targetMeta, competitors, intentCount) {
  // Target functional tokens (from name+subtitle, brand stripped)
  const targetFuncTokens = extractFunctionTokens(targetMeta.name, targetMeta.subtitle);
  const targetFuncSet = new Set(targetFuncTokens);

  // Target description bigrams
  const targetDescTokens = tokenize(targetMeta.description || "");
  const targetBigrams = extractBigrams(targetDescTokens);

  const scoreMap = new Map();

  for (const c of competitors) {
    const compText = [c.name, c.description].filter(Boolean).join(" ");
    const compTokens = tokenize(compText);
    const compTokenSet = new Set(compTokens);

    // 1. Feature-function match (0-1): how many target function words appear in competitor
    let funcMatches = 0;
    for (const t of targetFuncSet) {
      if (compTokenSet.has(t)) funcMatches++;
    }
    const funcScore = targetFuncSet.size > 0 ? funcMatches / targetFuncSet.size : 0;

    // 2. Description bigram overlap coefficient (0-1)
    const compBigrams = extractBigrams(compTokens);
    let bigramIntersection = 0;
    for (const bg of targetBigrams) {
      if (compBigrams.has(bg)) bigramIntersection++;
    }
    const minSetSize = Math.min(targetBigrams.size, compBigrams.size);
    const bigramScore = minSetSize > 0 ? bigramIntersection / minSetSize : 0;

    // 3. appearedIn normalized by total intent count (0-1)
    const appearedInNorm = intentCount > 0 ? Math.min(c.appearedIn / intentCount, 1) : 0;

    // Weighted combination → 0-100
    const raw = funcScore * 0.4 + bigramScore * 0.3 + appearedInNorm * 0.3;
    scoreMap.set(c.appleId, Math.max(0, Math.min(100, Math.round(raw * 100))));
  }

  return scoreMap;
}

/**
 * Search a single intent in a store, extract all result IDs (up to ~200),
 * and return the raw search results array. Throws on failure (caller handles retries).
 */
async function searchIntent(intent, store) {
  const html = config.proxyUrl
    ? await fetchSearchHtmlViaProxy(intent, store)
    : await fetchSearchHtml(intent, store);
  return extractSearchResults(html);
}

const LOOKUP_BATCH_SIZE = 200;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

/**
 * Lightweight iTunes lookup that returns only { name, description } per ID.
 * Batches in groups of LOOKUP_BATCH_SIZE. Fires all batches, retries failures in bulk.
 */
async function lookupNameAndDescription(appIds, country, log) {
  const result = new Map();
  const batches = [];
  for (let i = 0; i < appIds.length; i += LOOKUP_BATCH_SIZE) {
    batches.push(appIds.slice(i, i + LOOKUP_BATCH_SIZE));
  }

  log.info({ totalIds: appIds.length, batches: batches.length, country }, "iTunes lookup starting");

  const fetchBatch = async (batch) => {
    const url = `https://itunes.apple.com/lookup?id=${batch.join(",")}&country=${country}`;
    let data;
    if (config.proxyUrl) {
      const resp = await axios.get(url, {
        httpsAgent: getProxyAgent(),
        headers: { "User-Agent": USER_AGENT },
        timeout: 15000,
        responseType: "json",
      });
      data = resp.data;
    } else {
      const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      data = await resp.json();
    }
    const entries = [];
    for (const r of data.results ?? []) {
      const id = String(r.trackId ?? "");
      if (id) entries.push({ id, name: r.trackName ?? "", description: r.description ?? "" });
    }
    return entries;
  };

  // First pass: fire all batches
  const failed = [];
  const batchResults = await Promise.all(
    batches.map((batch, idx) =>
      fetchBatch(batch)
        .then((entries) => { log.info({ batch: idx + 1, ids: batch.length, resolved: entries.length }, "iTunes batch done"); return entries; })
        .catch(() => { failed.push(batch); return []; }),
    ),
  );

  for (const entries of batchResults) {
    for (const e of entries) {
      result.set(e.id, { name: e.name, description: e.description });
    }
  }

  // Retry pass: all failed batches in one go
  if (failed.length > 0) {
    log.info({ failedBatches: failed.length, country }, "Retrying failed iTunes batches");
    const retryResults = await Promise.all(
      failed.map((batch) =>
        fetchBatch(batch)
          .then((entries) => { log.info({ ids: batch.length, resolved: entries.length }, "iTunes retry batch done"); return entries; })
          .catch((err) => { log.warn({ ids: batch.length, err: err.message }, "iTunes retry batch failed"); return []; }),
      ),
    );
    for (const entries of retryResults) {
      for (const e of entries) {
        result.set(e.id, { name: e.name, description: e.description });
      }
    }
  }

  return result;
}

const MAX_ROUNDS = 3;
const MAX_BIGRAMS_PER_ROUND = 50;

/**
 * Generate 2-word bigrams from competitor names+subtitles.
 * Only consecutive word pairs (no skip-grams). Deduplicated, lowercased.
 */
function generateBigramsFromCompetitors(competitors) {
  const bigrams = new Set();
  for (const c of competitors) {
    const text = [c.name, c.subtitle].filter(Boolean).join(" ");
    const tokens = tokenize(text);
    for (let i = 0; i < tokens.length - 1; i++) {
      bigrams.add(`${tokens[i]} ${tokens[i + 1]}`);
    }
  }
  return [...bigrams];
}

/**
 * Search intents in parallel, return Map of appId → Set<intent>.
 * Skips IDs in `excludeIds`.
 * Fires all at BULK_CONCURRENCY, collects failures, retries failed in one bulk pass.
 */
async function searchIntentsParallel(intents, store, appleId, excludeIds, log) {
  const appIntents = new Map();

  const collectResults = (results) => {
    for (const { intent, results: hits } of results) {
      if (!hits) continue;
      for (const r of hits) {
        if (!r.id || r.id === appleId || excludeIds.has(r.id)) continue;
        if (!appIntents.has(r.id)) appIntents.set(r.id, new Set());
        appIntents.get(r.id).add(intent);
      }
    }
  };

  // First pass: fire all in waves of BULK_CONCURRENCY
  const failed = [];
  for (let i = 0; i < intents.length; i += BULK_CONCURRENCY) {
    const wave = intents.slice(i, i + BULK_CONCURRENCY);
    const waveResults = await Promise.all(
      wave.map((intent) =>
        searchIntent(intent, store)
          .then((results) => ({ intent, results }))
          .catch(() => { failed.push(intent); return null; }),
      ),
    );
    collectResults(waveResults.filter(Boolean));
  }

  // Retry pass: all failures in one bulk wave
  if (failed.length > 0) {
    log.info({ store, failedCount: failed.length }, "Retrying failed intent searches");
    const retryResults = await Promise.all(
      failed.map((intent) =>
        searchIntent(intent, store)
          .then((results) => ({ intent, results }))
          .catch((err) => { log.warn({ intent, store, err: err.message }, "Search retry failed"); return null; }),
      ),
    );
    collectResults(retryResults.filter(Boolean));
  }

  return appIntents;
}

/**
 * Bulk lookup IDs → { name, description }, score relevance, filter ≥25,
 * scrape subtitles, return enriched competitors.
 */
async function resolveAndFilter(fastify, allIds, appIntents, targetMeta, intentCount, store, roundTimings) {
  // Lookup
  let t = Date.now();
  let lookupMap = new Map();
  try {
    lookupMap = await lookupNameAndDescription(allIds, store, fastify.log);
  } catch (err) {
    fastify.log.error({ store, err: err.message }, "iTunes bulk lookup failed");
  }
  roundTimings.itunesLookup_ms = Date.now() - t;

  let competitors = allIds.map((id) => {
    const meta = lookupMap.get(id);
    return {
      appleId: id,
      name: meta?.name || null,
      description: meta?.description || null,
      appearedIn: appIntents.get(id).size,
    };
  });

  // Score
  t = Date.now();
  const relevanceMap = scoreRelevance(targetMeta, competitors, intentCount);
  roundTimings.relevanceScoring_ms = Date.now() - t;

  const scored = competitors.map((c) => ({ ...c, relevanceScore: relevanceMap.get(c.appleId) ?? 0 }));
  competitors = scored.filter((c) => c.relevanceScore >= 25);

  // Collect top 20 rejected apps (highest scores below threshold) for validation
  const rejected = scored
    .filter((c) => c.relevanceScore > 0 && c.relevanceScore < 25)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 20)
    .map((c) => ({ appleId: c.appleId, name: c.name, relevanceScore: c.relevanceScore, appearedIn: c.appearedIn }));

  roundTimings.filteredCount = competitors.length;
  roundTimings.rejectedSample = rejected;

  // Scrape subtitles: fire all in waves, collect failures, retry in bulk
  t = Date.now();
  const subtitleMap = new Map();
  const subtitleFailed = [];

  for (let i = 0; i < competitors.length; i += BULK_CONCURRENCY) {
    const wave = competitors.slice(i, i + BULK_CONCURRENCY);
    await Promise.all(
      wave.map((c) =>
        scrapeAppNameSubtitle(c.appleId, store, config.proxyUrl)
          .then((result) => { subtitleMap.set(c.appleId, result?.subtitle || null); })
          .catch(() => { subtitleFailed.push(c.appleId); }),
      ),
    );
  }

  // Retry failed subtitle scrapes in one bulk pass
  if (subtitleFailed.length > 0) {
    await Promise.all(
      subtitleFailed.map((appleId) =>
        scrapeAppNameSubtitle(appleId, store, config.proxyUrl)
          .then((result) => { subtitleMap.set(appleId, result?.subtitle || null); })
          .catch(() => { subtitleMap.set(appleId, null); }),
      ),
    );
  }

  for (const c of competitors) {
    c.subtitle = subtitleMap.get(c.appleId) || null;
  }
  roundTimings.subtitleScrape_ms = Date.now() - t;

  // Drop description
  return competitors.map(({ description, ...rest }) => rest);
}

/**
 * Full discovery loop for a single store:
 *
 * Round 0: Gemini intents → search → lookup → score → filter → subtitle scrape
 * Round 1..N: Generate bigrams from discovered competitors → search (excluding known IDs)
 *             → lookup → score → filter → subtitle scrape
 * Stops when no new relevant apps found or MAX_ROUNDS reached.
 */
async function discoverCompetitorsForStore(fastify, appleId, targetMeta, intents, store, timings) {
  const allCompetitors = new Map(); // appleId → competitor object
  const knownIds = new Set();
  const rounds = [];

  // ── Round 0: initial Gemini intents ──
  const round0 = { round: 0, intents: intents.length };
  let t = Date.now();

  const appIntents = await searchIntentsParallel(intents, store, appleId, knownIds, fastify.log);
  round0.intentSearch_ms = Date.now() - t;
  round0.uniqueAppIds = appIntents.size;

  if (appIntents.size > 0) {
    const allIds = [...appIntents.keys()];
    const resolved = await resolveAndFilter(
      fastify, allIds, appIntents, targetMeta, intents.length, store, round0,
    );
    for (const c of resolved) {
      allCompetitors.set(c.appleId, c);
      knownIds.add(c.appleId);
    }
    // Also add filtered-out IDs to knownIds so we don't re-lookup them
    for (const id of allIds) knownIds.add(id);
  }

  let lastNewCompetitors = [...allCompetitors.values()];
  round0.newRelevant = lastNewCompetitors.length;
  rounds.push(round0);

  // ── Rounds 1..N: bigram expansion (only from newly discovered apps) ──
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let bigrams = generateBigramsFromCompetitors(lastNewCompetitors);

    if (bigrams.length === 0) break;

    // Cap bigrams per round
    if (bigrams.length > MAX_BIGRAMS_PER_ROUND) {
      bigrams = bigrams.slice(0, MAX_BIGRAMS_PER_ROUND);
    }

    const roundInfo = { round, intents: bigrams.length };
    t = Date.now();

    const newAppIntents = await searchIntentsParallel(bigrams, store, appleId, knownIds, fastify.log);
    roundInfo.intentSearch_ms = Date.now() - t;
    roundInfo.uniqueAppIds = newAppIntents.size;

    if (newAppIntents.size === 0) {
      roundInfo.newRelevant = 0;
      rounds.push(roundInfo);
      break;
    }

    const newIds = [...newAppIntents.keys()];
    const resolved = await resolveAndFilter(
      fastify, newIds, newAppIntents, targetMeta, bigrams.length, store, roundInfo,
    );

    lastNewCompetitors = [];
    for (const c of resolved) {
      if (!allCompetitors.has(c.appleId)) {
        allCompetitors.set(c.appleId, c);
        lastNewCompetitors.push(c);
      }
    }
    // Mark all searched IDs as known
    for (const id of newIds) knownIds.add(id);

    roundInfo.newRelevant = lastNewCompetitors.length;
    rounds.push(roundInfo);

    if (lastNewCompetitors.length === 0) break;
  }

  // Aggregate timings
  timings.rounds = rounds;
  timings.totalRounds = rounds.length;
  timings.intentSearch_ms = rounds.reduce((s, r) => s + (r.intentSearch_ms || 0), 0);
  timings.itunesLookup_ms = rounds.reduce((s, r) => s + (r.itunesLookup_ms || 0), 0);
  timings.relevanceScoring_ms = rounds.reduce((s, r) => s + (r.relevanceScoring_ms || 0), 0);
  timings.subtitleScrape_ms = rounds.reduce((s, r) => s + (r.subtitleScrape_ms || 0), 0);
  timings.uniqueAppIds = rounds.reduce((s, r) => s + (r.uniqueAppIds || 0), 0);
  timings.filteredCount = allCompetitors.size;

  // Collect top 20 rejected across all rounds (highest scores just below threshold)
  const allRejected = rounds
    .flatMap((r) => r.rejectedSample || [])
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 20);
  // Clean rejectedSample from round timings (keep response lean)
  for (const r of rounds) delete r.rejectedSample;

  // Final sort
  const competitors = [...allCompetitors.values()];
  competitors.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
    return b.appearedIn - a.appearedIn;
  });

  return { competitors, rejectedSample: allRejected };
}

/**
 * Full competitor discovery pipeline:
 * 1. Scrape app metadata per store
 * 2. Generate 25 localized intents per store (Gemini)
 * 3. Search each intent, collect all result IDs (up to ~200 per search)
 * 4. Bulk-resolve via iTunes Lookup, deduplicate, return per store
 *
 * @param {object} fastify - Fastify instance
 * @param {string} appleId - Apple app ID
 * @param {string[]} stores - List of storefront country codes
 * @returns {Promise<object[]>} Per-store competitor results
 */
export async function findCompetitors(fastify, appleId, stores) {
  const t0 = Date.now();

  const results = await Promise.all(
    stores.map(async (store) => {
      const timings = {};

      try {
        // Phase 2: Scrape app metadata
        let t = Date.now();
        const metadata = await scrapeAppPageMetadata(
          appleId,
          store,
          config.proxyUrl,
        );
        timings.scrapeMetadata_ms = Date.now() - t;

        if (!metadata) {
          return { store, timings, error: "not_found" };
        }

        // Phase 3: Generate intents via Gemini
        let intents = [];
        t = Date.now();
        try {
          intents = await generateIntents(metadata, store);
        } catch (err) {
          fastify.log.error(
            { appleId, store, err: err.message },
            "Failed to generate intents via Gemini",
          );
          timings.geminiIntents_ms = Date.now() - t;
          return {
            store,
            name: metadata.name,
            subtitle: metadata.subtitle,
            description: metadata.description,
            intents: [],
            competitors: [],
            timings,
            error: "intent_generation_failed",
          };
        }
        timings.geminiIntents_ms = Date.now() - t;

        // Phase 4+: Discovery loop (search → lookup → score → filter → subtitles → bigram expansion)
        let result = { competitors: [], rejectedSample: [] };
        t = Date.now();
        try {
          result = await discoverCompetitorsForStore(
            fastify, appleId, metadata, intents, store, timings,
          );
        } catch (err) {
          fastify.log.error(
            { appleId, store, err: err.message },
            "Failed to discover competitors for store",
          );
        }
        timings.discovery_ms = Date.now() - t;
        timings.total_ms = Date.now() - t0;

        return {
          store,
          name: metadata.name,
          subtitle: metadata.subtitle,
          description: metadata.description,
          intentCount: intents.length,
          competitorCount: result.competitors.length,
          competitors: result.competitors,
          rejectedSample: result.rejectedSample,
          timings,
        };
      } catch (err) {
        fastify.log.error(
          { appleId, store, err: err.message },
          "Failed to scrape app metadata for competitors",
        );
        timings.total_ms = Date.now() - t0;
        return { store, timings, error: err.message };
      }
    }),
  );

  return results;
}
