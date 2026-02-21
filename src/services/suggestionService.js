/**
 * Keyword suggestion service.
 *
 * Stage 1 — Gemini Flash 2.5 generates 50 keyword candidates from app metadata (cached 24h)
 * Stage 2 — getSearchRankings (fast ~300ms, no DB) filters to keywords where app ranks ≤ 50
 * Stage 3 — runSearch for top 20 in parallel: populates DB + calculates pop/comp as side effect
 * Stage 4 — Read metrics from DB (rank, popularity, competitiveness) — no extra API calls
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { CacheService } from "./cache.js";
import { config } from "../config/index.js";
import { getSearchRankings, fetchAppMetadata } from "./appstore.js";
import { runSearch } from "./searchService.js";
import {
  getAppByAppleId,
  resolveKeyword,
  getAppCurrentRank,
  getKeywordCurrentPopularity,
  getKeywordCurrentCompetitiveness,
} from "./db.js";

const STAGE2_CONCURRENT = 10;
const MAX_RESULTS = 20;
const MAX_RANK = 50;

/**
 * Call Gemini Flash 2.5 to generate 50 keyword candidates. Cached 24h.
 */
async function generateKeywordSuggestions(appMeta, redis) {
  const cache = new CacheService(redis);
  const cacheKey = `suggestions:raw:${appMeta.appleId}`;

  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY is not configured.");

  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `You are an App Store Optimization expert. Given this iOS app:
- Name: ${appMeta.name}
- Developer: ${appMeta.developer}
- Genre: ${appMeta.genre}
- Price: ${appMeta.price}
- Bundle ID: ${appMeta.bundleId}

Generate exactly 50 search keywords that real users would type to find this app.

Rules:
- First keyword must be the app's brand name
- Include generic category keywords (e.g., "photo editor", "weather app") — 1-2 words
- Include specific feature keywords (e.g., "face filter", "rain forecast") — 1-3 words
- Include 2-3 competitor app names that target the same audience
- Include long-tail keywords combining the app name or unique feature with a use case (e.g., "halo journal anxiety", "collagekit instagram story", "daily self care tracker") — these help new apps get discovered before they rank for competitive terms
- No duplicates
- Return ONLY a JSON array of strings, nothing else. No markdown, no explanation.`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  const json = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  let keywords = JSON.parse(json);

  if (!Array.isArray(keywords)) throw new Error("Gemini did not return an array.");

  const seen = new Set();
  keywords = keywords
    .map((k) => String(k).toLowerCase().trim())
    .filter((k) => k.length > 0 && !seen.has(k) && seen.add(k));

  await cache.set(cacheKey, keywords, config.cacheTtlSuggestions);
  return keywords;
}

/**
 * Main orchestrator.
 */
export async function getKeywordSuggestions(pg, redis, appleId, { store = "us", platform = "iphone" } = {}) {
  const timings = {};

  // ── Stage 1: App metadata + Gemini suggestions ───────────────────────────
  let t = Date.now();

  let appRow = await getAppByAppleId(pg, appleId);
  let appMeta;

  if (appRow) {
    appMeta = {
      appleId,
      name:      appRow.name,
      developer: appRow.developer,
      genre:     appRow.genre,
      price:     appRow.price,
      bundleId:  appRow.bundle_id,
    };
  } else {
    const fetched = await fetchAppMetadata(appleId, store);
    if (!fetched) throw new Error(`App ${appleId} not found on App Store.`);
    appMeta = { appleId, ...fetched };
  }

  const candidates = await generateKeywordSuggestions(appMeta, redis);
  timings.stage1_gemini_ms = Date.now() - t;

  // ── Stage 2: Fast rank filter — getSearchRankings only (no DB writes) ────
  // 10 concurrent, 150ms delay between batches
  t = Date.now();
  const ranked = [];

  for (let i = 0; i < candidates.length; i += STAGE2_CONCURRENT) {
    const batch = candidates.slice(i, i + STAGE2_CONCURRENT);

    const batchResults = await Promise.all(
      batch.map(async (keyword) => {
        try {
          const results = await getSearchRankings({ keyword, country: store, platform, limit: 50 });
          const hit = results.find((r) => r.id === appleId);
          if (!hit || hit.rank > MAX_RANK) return null;
          return { keyword, rank: hit.rank };
        } catch {
          return null;
        }
      })
    );

    ranked.push(...batchResults.filter(Boolean));
  }

  const top20 = ranked.sort((a, b) => a.rank - b.rank).slice(0, MAX_RESULTS);
  timings.stage2_filter_ms = Date.now() - t;

  // ── Stage 3: runSearch for top 20 in parallel — populates DB ─────────────
  // runSearch calculates + stores popularity and competitiveness as a side effect
  t = Date.now();

  await Promise.all(
    top20.map(({ keyword }) =>
      runSearch(pg, redis, { keyword, store, platform, limit: 100 }).catch(() => {})
    )
  );

  timings.stage3_persist_ms = Date.now() - t;

  // ── Stage 4: Read metrics from DB (no extra API calls) ───────────────────
  // popularity + competitiveness are already in DB from stage 3's runSearch
  t = Date.now();

  const results = await Promise.all(
    top20.map(async ({ keyword, rank: filterRank }) => {
      try {
        const normKeyword = keyword.toLowerCase().trim();
        const kw = await resolveKeyword(pg, normKeyword, store, platform);
        if (!kw) return { keyword, rank: filterRank, error: "Could not resolve keyword." };

        const [rankRow, popularityRow, competitivenessRow] = await Promise.all([
          getAppCurrentRank(pg, appleId, kw.id),
          getKeywordCurrentPopularity(pg, kw.id),
          getKeywordCurrentCompetitiveness(pg, kw.id),
        ]);

        return {
          keyword,
          rank:            rankRow?.rank ?? filterRank,
          popularity:      popularityRow?.popularity ?? null,
          competitiveness: competitivenessRow?.competitiveness ?? null,
        };
      } catch (err) {
        return { keyword, rank: filterRank, error: err.message };
      }
    })
  );

  timings.stage4_enrich_ms = Date.now() - t;

  return {
    app: {
      name:      appMeta.name,
      developer: appMeta.developer,
      bundleId:  appMeta.bundleId,
      genre:     appMeta.genre,
      price:     appMeta.price,
    },
    totalGenerated: candidates.length,
    totalRanked:    ranked.length,
    results,
    timings,
  };
}
