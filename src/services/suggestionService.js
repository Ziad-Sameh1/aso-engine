/**
 * Keyword suggestion service.
 *
 * Stage 1 — Gemini Flash 2.5 generates exactly 20 three-word keywords from app metadata (cached 24h)
 *           Each keyword contains at least 2 title words (excluding brand) + 1 feature/use-case word
 * Stage 2 — runSearch for all 20 in parallel: populates DB + calculates pop/comp as side effect
 * Stage 3 — Read metrics from DB (rank up to 200, popularity, competitiveness) — no extra API calls
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { CacheService } from "./cache.js";
import { config } from "../config/index.js";
import { fetchAppMetadata } from "./appstore.js";
import { runSearch } from "./searchService.js";
import {
  getAppByAppleId,
  resolveKeyword,
  getAppCurrentRank,
  getKeywordCurrentPopularity,
  getKeywordCurrentCompetitiveness,
} from "./db.js";

const MAX_RANK = 200;

/**
 * Call Gemini Flash 2.5 to generate 20 structured keywords. Cached 24h.
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

Generate exactly 20 search keywords. Every keyword must be exactly 3 words.

Step 1 — Identify the primary keywords: extract the generic/descriptive words from the app title, excluding the app's unique brand or product name. These are the "primary keywords."

Step 2 — Build keywords: every keyword must contain at least 2 of the primary keywords. The remaining word should be a relevant feature, use case, or category term.
Example: if the title is "BrandName Budget Tracker Pro", the primary keywords are "budget", "tracker", "pro". A valid keyword would be "budget tracker daily" or "pro budget planner". An invalid keyword would be "daily expense log" (only 0 primary keywords).

Rules:
- Every keyword is exactly 3 words
- Every keyword contains at least 2 primary keywords from the title
- No duplicates
- All lowercase
- No competitor names
- NEVER include the app's brand or product name in any keyword
- Return ONLY a JSON array of exactly 20 strings, nothing else. No markdown, no explanation.`;

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

  // ── Stage 2: runSearch for all 20 keywords in parallel — populates DB ────
  // runSearch calculates + stores popularity and competitiveness as a side effect
  t = Date.now();

  await Promise.all(
    candidates.map((keyword) =>
      runSearch(pg, redis, { keyword, store, platform, limit: MAX_RANK }).catch(() => {})
    )
  );

  timings.stage2_persist_ms = Date.now() - t;

  // ── Stage 3: Read metrics from DB (rank up to 200, no extra API calls) ───
  // popularity + competitiveness are already in DB from stage 2's runSearch
  t = Date.now();

  const results = await Promise.all(
    candidates.map(async (keyword) => {
      try {
        const normKeyword = keyword.toLowerCase().trim();
        const kw = await resolveKeyword(pg, normKeyword, store, platform);
        if (!kw) return { keyword, rank: null, error: "Could not resolve keyword." };

        const [rankRow, popularityRow, competitivenessRow] = await Promise.all([
          getAppCurrentRank(pg, appleId, kw.id),
          getKeywordCurrentPopularity(pg, kw.id),
          getKeywordCurrentCompetitiveness(pg, kw.id),
        ]);

        return {
          keyword,
          rank:            rankRow?.rank ?? null,
          popularity:      popularityRow?.popularity ?? null,
          competitiveness: competitivenessRow?.competitiveness ?? null,
        };
      } catch (err) {
        return { keyword, rank: null, error: err.message };
      }
    })
  );

  timings.stage3_enrich_ms = Date.now() - t;

  return {
    app: {
      name:      appMeta.name,
      developer: appMeta.developer,
      bundleId:  appMeta.bundleId,
      genre:     appMeta.genre,
      price:     appMeta.price,
    },
    totalGenerated: candidates.length,
    results,
    timings,
  };
}
