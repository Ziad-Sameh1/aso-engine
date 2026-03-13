import {
  setupApp,
  rankAllStores,
  calculatePopularityScore,
} from "../services/setupService.js";
import { getSearchRankingsLite } from "../services/appstore.js";
import { calculatePopularity } from "../services/popularity.js";
import { calculateCompetitiveness } from "../services/competitiveness.js";
import { calculateOpportunity } from "../services/opportunity.js";
import { config } from "../config/index.js";

export async function setupRoutes(fastify) {
  // ── POST /api/apps/setup ──────────────────────────────────────────────────
  fastify.post(
    "/api/apps/setup",
    {
      schema: {
        body: {
          type: "object",
          required: ["appleId"],
          properties: {
            appleId: { type: "string", minLength: 1 },
            stores: {
              type: "array",
              items: { type: "string" },
              default: [],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId, stores = [] } = request.body;
      const totalT0 = performance.now();

      const result = await setupApp(fastify.pg, fastify.redis, {
        appleId,
        stores,
      });

      if (!result) {
        return reply
          .code(404)
          .send({ error: "App not found on the App Store." });
      }

      // Log call counts before starting ranking phase
      console.log(
        `[setup] Setup complete. Calls count: ${result.callsCount}, Search HTML: ${result.searchHtmlCount}, Suggestion API: ${result.suggestionApiCount}`,
      );

      // Rank all search terms for all stores in parallel
      const rankResult = await rankAllStores(
        appleId,
        result.stores,
        fastify.redis,
      );

      // Merge ranking data into store results
      const rankMap = Object.fromEntries(
        rankResult.stores.map((r) => [r.store, r]),
      );

      const mergedStores = result.stores.map((s) => {
        const ranked = rankMap[s.store];
        return {
          store: s.store,
          meta: s.meta,
          tokens: s.tokens,
          localizedIntents: s.localizedIntents,
          intentTopApps: s.intentTopApps,
          seedKeywords: s.seedKeywords,
          keywords: ranked?.keywords ?? [],
          liveKeywords: ranked?.liveKeywords ?? 0,
        };
      });

      const totalMs = Math.round(performance.now() - totalT0);

      // Build per-store combined timings (setup phases + ranking phases)
      const perStoreTimings = {};
      for (const s of mergedStores) {
        const setup = result.timings.stores[s.store] ?? {};
        const ranking = rankMap[s.store]?.timings ?? {};
        perStoreTimings[s.store] = {
          scrapeMs: setup.scrapeMs ?? 0,
          intentSearchMs: setup.intentSearchMs ?? 0,
          miningMs: setup.miningMs ?? 0,
          ranking: {
            totalMs: ranking.totalMs ?? 0,
            fetchMs: ranking.fetchMs ?? 0,
            retryMs: ranking.retryMs ?? 0,
            metadataLookupMs: ranking.metadataLookupMs ?? 0,
          },
          totalMs:
            (setup.scrapeMs ?? 0) +
            (setup.intentSearchMs ?? 0) +
            (setup.miningMs ?? 0) +
            (ranking.totalMs ?? 0),
        };
      }

      return {
        appleId,
        callsCount: result.callsCount,
        searchHtmlCount: result.searchHtmlCount,
        suggestionApiCount: result.suggestionApiCount,
        totalLiveKeywords: rankResult.totalLiveKeywords,
        timings: {
          totalMs,
          setupMs: result.timings.setupMs,
          geminiMs: result.timings.geminiMs,
          rankingMs: rankResult.rankingMs,
          suggestMs: rankResult.suggestMs,
          stores: perStoreTimings,
        },
        stores: mergedStores,
      };
    },
  );

  // ── GET /api/apps/:appleId/keywords/:keyword/score ──────────────────────────
  // Single-keyword scoring: computes all signals (result popularity, suggest
  // popularity, difficulty, opportunity) without running the full setup pipeline.
  fastify.get(
    "/api/apps/:appleId/keywords/:keyword/score",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId", "keyword"],
          properties: {
            appleId: { type: "string", minLength: 1 },
            keyword: { type: "string", minLength: 1 },
          },
        },
        querystring: {
          type: "object",
          properties: {
            store: { type: "string", default: "us" },
            platform: {
              type: "string",
              enum: ["iphone", "ipad"],
              default: "iphone",
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId, keyword } = request.params;
      const { store = "us", platform = "iphone" } = request.query;
      const totalT0 = performance.now();

      // ── 1. Search results + top-10 metadata ────────────────────────────────
      const searchT0 = performance.now();
      let searchData;
      try {
        searchData = await getSearchRankingsLite({
          keyword,
          country: store,
          platform,
          limit: 50,
          topN: 10,
        });
      } catch (err) {
        return reply.code(502).send({ error: `Search failed: ${err.message}` });
      }
      const searchMs = Math.round(performance.now() - searchT0);

      const { allResults, topMetadata } = searchData;
      const top10 = allResults.slice(0, 10).map((r) => {
        const m = topMetadata[r.id] ?? {};
        return {
          rank: r.rank,
          id: r.id,
          name: r.name || m.name || "",
          subtitle: r.subtitle ?? null,
          iconUrl: m.iconUrl ?? null,
          rating: m.rating ?? null,
          ratingCount: m.ratingCount ?? null,
        };
      });

      const appMatch = allResults.find((r) => String(r.id) === String(appleId));
      const appRank = appMatch?.rank ?? null;

      // ── 2. Bucket split: relevant vs filler (with relevance strength) ────

      const kwTokens = keyword
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0);
      const wordRe = /[a-z0-9]+/g;

      const tokenMatchesText = (token, text) => {
        const words = text.match(wordRe) || [];
        return words.some((w) => w.startsWith(token) || token.startsWith(w));
      };

      const relevant = [];
      const filler = [];

      for (const app of top10) {
        const name = (app.name || "").toLowerCase();
        const subtitle = (app.subtitle || "").toLowerCase();
        const combined = name + " " + subtitle;

        // Count how many keyword tokens match
        const matchedTokens = kwTokens.filter((token) =>
          tokenMatchesText(token, combined),
        );
        const matchRatio = matchedTokens.length / kwTokens.length;

        // For multi-word keywords, require >50% token match
        // For single-word keywords, any match counts
        const threshold = kwTokens.length === 1 ? 0.99 : 0.5;

        if (matchRatio >= threshold) {
          // relevanceStrength: 1.0 = all tokens match name,
          // lower if only subtitle or partial match
          const nameMatched = kwTokens.filter((t) =>
            tokenMatchesText(t, name),
          ).length;
          const relevanceStrength = Math.min(
            1,
            (nameMatched / kwTokens.length) * 0.8 + matchRatio * 0.2,
          );

          relevant.push({ ...app, matchRatio, relevanceStrength });
        } else {
          filler.push({ ...app, matchRatio, relevanceStrength: 0 });
        }
      }

      // ── 3. Result popularity — trimmed mean of upper half of relevant bucket ──
      // Sort relevant apps by ratingCount, drop the bottom half (copycats/spam
      // with near-zero ratings), average the upper half. Stable across bucket
      // sizes without special-casing like P75 needs for tiny buckets.
      const resultPopT0 = performance.now();
      const relevantCounts = relevant.map((r) => r.ratingCount ?? 0);
      let resultPopularity = 0;
      let upperHalfMean = 0;
      if (relevantCounts.length > 0) {
        const sorted = [...relevantCounts].sort((a, b) => a - b);
        const upperStart = Math.floor(sorted.length / 2);
        const upperHalf = sorted.slice(upperStart);
        upperHalfMean = upperHalf.reduce((a, b) => a + b, 0) / upperHalf.length;
        const LOG_MAX = Math.log10(50_000_000);
        resultPopularity = Math.max(
          0,
          Math.min(
            100,
            Math.round(
              (Math.log10(Math.max(upperHalfMean, 1)) / LOG_MAX) * 100,
            ),
          ),
        );
      }
      const resultPopMs = Math.round(performance.now() - resultPopT0);

      // ── 4. Suggest popularity (prefix-depth binary search + Apple Ads) ─────
      const suggestPopT0 = performance.now();
      const suggestResult = await calculatePopularity(
        keyword,
        store,
        platform,
        {
          redis: fastify.redis,
          mediaApiToken: config.appleMediaApiToken,
          appleAdsCookie: config.appleAdsCookie,
          appleAdsXsrfToken: config.appleAdsXsrfToken,
          appleAdsAdamId: config.appleAdsAdamId,
        },
      );
      const suggestPopMs = Math.round(performance.now() - suggestPopT0);

      // ── 5. Difficulty — weighted by relevance strength ───────────────────

      const relevantForComp = relevant.map((r) => ({
        rank: r.rank,
        rating: r.rating,
        // Scale down ratingCount by relevance strength
        // A budget app with 23K ratings but 0.4 relevance
        // counts as ~9.2K for difficulty purposes
        ratingCount: Math.round((r.ratingCount ?? 0) * r.relevanceStrength),
        relevanceStrength: r.relevanceStrength,
      }));

      const rawDifficulty = calculateCompetitiveness(relevantForComp);

      // "Meaningful" = strong relevance AND decent ratings
      const meaningfulApps = relevant.filter(
        (r) => (r.ratingCount ?? 0) >= 10 && r.relevanceStrength >= 0.6,
      ).length;

      const weakSlots = relevant.filter(
        (r) => (r.ratingCount ?? 0) < 50 || r.relevanceStrength < 0.5,
      ).length;

      let difficulty;
      if (meaningfulApps === 0) {
        difficulty = 5;
      } else if (meaningfulApps <= 2) {
        const scale = meaningfulApps === 1 ? 0.4 : 0.65;
        difficulty = Math.max(8, Math.round(rawDifficulty * scale));
      } else {
        difficulty = rawDifficulty;
      }

      // ── 6. Popularity cap — how much can suggest inflate based on outcome evidence ──
      let popularityCap;
      if (upperHalfMean === 0) popularityCap = 15;
      else if (upperHalfMean <= 100) popularityCap = 30;
      else if (upperHalfMean <= 1000) popularityCap = 45;
      else if (upperHalfMean <= 10000) popularityCap = 65;
      else popularityCap = 95;

      const cappedSuggestPopularity = Math.min(
        suggestResult.score ?? 5,
        popularityCap,
      );

      // ── 7. Overall popularity (5-95) ──────────────────────────────────────
      // resultPopularity gates the suggest signal. The ramp requires stronger
      // result evidence (resultPop ≥ 60) before suggest passes through fully.
      // This prevents weak outcome evidence (e.g. 222 mean ratings) from
      // letting a strong suggest score inflate the overall popularity.
      let popularity;
      if (resultPopularity <= 5) {
        popularity = 5;
      } else {
        const resultFactor = Math.min(1, resultPopularity / 60);
        popularity = Math.max(
          5,
          Math.min(95, Math.round(cappedSuggestPopularity * resultFactor)),
        );
      }

      // ── 8. Opportunity ─────────────────────────────────────────────────────
      const opportunity = calculateOpportunity(popularity, difficulty);

      const totalMs = Math.round(performance.now() - totalT0);

      return {
        keyword,
        store,
        platform,
        appRank,
        numberOfResults: allResults.length,
        buckets: {
          relevant: relevant.length,
          filler: filler.length,
        },
        popularity,
        resultPopularity: {
          score: resultPopularity,
          upperHalfMean: Math.round(upperHalfMean),
        },
        suggestPopularity: {
          score: suggestResult.score,
          cappedScore: cappedSuggestPopularity,
          popularityCap,
          breakdown: suggestResult.breakdown,
        },
        difficulty: {
          score: difficulty,
          rawScore: rawDifficulty,
          meaningfulApps,
          weakSlots,
          suppressed: meaningfulApps < 3,
          scale: meaningfulApps === 0 ? 0 : meaningfulApps === 1 ? 0.4 : meaningfulApps === 2 ? 0.65 : 1,
        },
        opportunity,
        top10: (() => {
          const bucketMap = new Map();
          for (const r of relevant) bucketMap.set(r.id, r);
          for (const f of filler) bucketMap.set(f.id, f);
          return top10.map((app) => {
            const b = bucketMap.get(app.id);
            return {
              ...app,
              matchRatio: b?.matchRatio ?? 0,
              relevanceStrength: b?.relevanceStrength ?? 0,
              relevant: (b?.relevanceStrength ?? 0) > 0,
            };
          });
        })(),
        timings: {
          totalMs,
          searchMs,
          resultPopularityMs: resultPopMs,
          suggestPopularityMs: suggestPopMs,
        },
      };
    },
  );
}
