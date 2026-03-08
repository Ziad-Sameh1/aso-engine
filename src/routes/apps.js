import { CacheService } from "../services/cache.js";
import { processAllStores } from "../../extract-keyword-token.js";
import { config } from "../config/index.js";
import { runSearch } from "../services/searchService.js";
import {
  fetchAppMetadata,
  scrapeAppPageMetadata,
  fetchSearchHtml,
  extractSearchResults,
  lookupAppMetadata,
} from "../services/appstore.js";
import { HttpsProxyAgent } from "https-proxy-agent";
import axios from "axios";
import { calculateCompetitiveness } from "../services/competitiveness.js";
import { calculatePopularity } from "../services/popularity.js";
import { getKeywordSuggestions } from "../services/suggestionService.js";
import { discoverKeywords } from "../services/discoveryService.js";
import { getOpportunities } from "../services/opportunityService.js";
import {
  resolveKeyword,
  getAppCurrentRank,
  getAppRankHistory,
  getAppCurrentRating,
  getAppRatingHistory,
  getAppByAppleId,
  getAppsByAppleIds,
  getLatestRatingsBulk,
  getLatestRankingsByStoreBulk,
  getRankNeighborsBulk,
  getKeywordCurrentPopularity,
  getKeywordCurrentCompetitiveness,
  upsertApp,
  insertSingleAppRating,
  incrementKeywordDemand,
  periodToDate,
  VALID_PERIODS,
} from "../services/db.js";

export async function appsRoutes(fastify) {
  const cache = new CacheService(fastify.redis);

  /**
   * Resolve a keyword from the DB. If not found, trigger a search to populate it,
   * then resolve again.
   */
  async function resolveOrSearch(
    normKeyword,
    keyword,
    store,
    platform,
    { limit = 50 } = {},
  ) {
    let kw = await resolveKeyword(fastify.pg, normKeyword, store, platform);
    if (!kw) {
      const result = await runSearch(fastify.pg, fastify.redis, {
        keyword,
        store,
        platform,
        limit,
      });
      kw = result.keywordId
        ? { id: result.keywordId }
        : await resolveKeyword(fastify.pg, normKeyword, store, platform);
    }
    if (kw) incrementKeywordDemand(fastify.pg, kw.id).catch(() => {});
    return kw;
  }

  // ── GET /api/apps/:appleId/metadata ─────────────────────────────────────
  fastify.get(
    "/api/apps/:appleId/metadata",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: { appleId: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: {
            store: { type: "string", default: "us" },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId } = request.params;
      const { store } = request.query;
      const cacheKey = `metadata:${appleId}:${store}`;

      const cached = await cache.get(cacheKey);
      if (cached) return { ...cached, cached: true };

      const meta = await scrapeAppPageMetadata(appleId, store);
      if (!meta)
        return reply
          .code(404)
          .send({ error: "App not found on the App Store." });

      const result = { appleId, store, ...meta };
      await cache.set(cacheKey, result, config.cacheTtlSearch);
      return { ...result, cached: false };
    },
  );

  // ── GET /api/apps/:appleId/rank ──────────────────────────────────────────
  fastify.get(
    "/api/apps/:appleId/rank",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: { appleId: { type: "string" } },
        },
        querystring: {
          type: "object",
          required: ["keyword"],
          properties: {
            keyword: { type: "string", minLength: 1 },
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
      const { appleId } = request.params;
      const { keyword, store, platform } = request.query;
      const normKeyword = keyword.toLowerCase().trim();
      const cacheKey = `rank:${appleId}:${store}:${platform}:${normKeyword}`;

      const cached = await cache.get(cacheKey);
      if (cached) return { ...cached, cached: true };

      const kw = await resolveOrSearch(normKeyword, keyword, store, platform);
      if (!kw)
        return reply
          .code(404)
          .send({ error: "Could not resolve keyword after search." });

      const row = await getAppCurrentRank(fastify.pg, appleId, kw.id);
      if (!row)
        return reply
          .code(404)
          .send({ error: "App not found in search results for this keyword." });

      const result = {
        appleId,
        keyword,
        store,
        platform,
        rank: row.rank,
        rankedAt: row.ranked_at,
      };
      await cache.set(cacheKey, result, config.cacheTtlRank);
      return { ...result, cached: false };
    },
  );

  // ── GET /api/apps/:appleId/rank/history ─────────────────────────────────
  fastify.get(
    "/api/apps/:appleId/rank/history",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: { appleId: { type: "string" } },
        },
        querystring: {
          type: "object",
          required: ["keyword"],
          properties: {
            keyword: { type: "string", minLength: 1 },
            store: { type: "string", default: "us" },
            platform: {
              type: "string",
              enum: ["iphone", "ipad"],
              default: "iphone",
            },
            period: { type: "string", enum: VALID_PERIODS, default: "7d" },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId } = request.params;
      const { keyword, store, platform, period } = request.query;
      const normKeyword = keyword.toLowerCase().trim();

      const kw = await resolveOrSearch(normKeyword, keyword, store, platform);
      if (!kw)
        return reply
          .code(404)
          .send({ error: "Could not resolve keyword after search." });

      const since = periodToDate(period);
      const history = await getAppRankHistory(
        fastify.pg,
        appleId,
        kw.id,
        since,
      );
      return { appleId, keyword, store, platform, period, history };
    },
  );

  // ── POST /api/apps/summary (bulk: ratings + latest rankings by store, no cache) ─
  fastify.post(
    "/api/apps/summary",
    {
      schema: {
        body: {
          type: "object",
          required: ["appleIds", "store"],
          properties: {
            appleIds: {
              type: "array",
              items: { type: "string", minLength: 1 },
              minItems: 1,
            },
            store: { type: "string", minLength: 1 },
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
      const { appleIds, store, platform = "iphone" } = request.body;

      const apps = await getAppsByAppleIds(fastify.pg, appleIds);
      if (!apps.length)
        return reply
          .code(400)
          .send({ error: "No apps found for the given apple IDs." });

      const appIdList = apps.map((a) => Number(a.id));
      const [ratingsRows, rankingsRows] = await Promise.all([
        getLatestRatingsBulk(fastify.pg, appIdList, store, platform),
        getLatestRankingsByStoreBulk(fastify.pg, appIdList, store, platform),
      ]);

      // Fetch rank neighbors (above/below) in one bulk query using snapshot context
      const validRankings = rankingsRows.filter(
        (r) => r.search_snapshot_id != null,
      );
      const neighborsRows = await getRankNeighborsBulk(
        fastify.pg,
        validRankings.map((r) => Number(r.keyword_id)),
        validRankings.map((r) => Number(r.search_snapshot_id)),
        validRankings.map((r) => r.current_rank),
      );

      // Build lookup: "keywordId:originalRank" -> { above, below }
      const neighborMap = new Map();
      for (const n of neighborsRows) {
        const key = `${n.keyword_id}:${n.original_rank}`;
        const entry = neighborMap.get(key) ?? { above: null, below: null };
        const meta = {
          appleId: n.apple_id,
          name: n.name,
          developer: n.developer,
          genre: n.genre,
          iconUrl: n.icon_url,
        };
        if (n.neighbor_rank < n.original_rank) entry.above = meta;
        else entry.below = meta;
        neighborMap.set(key, entry);
      }

      const ratingByAppId = new Map(
        ratingsRows.map((r) => [Number(r.app_id), r]),
      );
      const rankingsByAppId = new Map();
      for (const row of rankingsRows) {
        const id = Number(row.app_id);
        const list = rankingsByAppId.get(id) ?? [];
        const neighborKey = `${row.keyword_id}:${row.current_rank}`;
        const neighbors = neighborMap.get(neighborKey) ?? {
          above: null,
          below: null,
        };
        list.push({
          keyword: row.keyword,
          rank: row.current_rank,
          previousRank: row.previous_rank ?? null,
          rankedAt: row.current_ranked_at,
          above: neighbors.above,
          below: neighbors.below,
        });
        rankingsByAppId.set(id, list);
      }

      const results = apps.map((app) => {
        const appId = Number(app.id);
        const rating = ratingByAppId.get(appId);
        const keywords = rankingsByAppId.get(appId) ?? [];
        return {
          appleId: app.apple_id,
          store,
          platform,
          ratingsCount: rating?.ratings_count ?? null,
          latestRating: rating
            ? {
                rating: rating.rating,
                ratingsCount: rating.ratings_count,
                recordedAt: rating.recorded_at,
              }
            : null,
          keywords,
        };
      });

      return { total: results.length, store, platform, apps: results };
    },
  );

  // ── GET /api/apps/:appleId/rating ────────────────────────────────────────
  fastify.get(
    "/api/apps/:appleId/rating",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: { appleId: { type: "string" } },
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
      const { appleId } = request.params;
      const { store, platform } = request.query;
      const cacheKey = `rating:${appleId}:${store}:${platform}`;

      const cached = await cache.get(cacheKey);
      if (cached) return { ...cached, cached: true };

      // Try DB first (populated by search results)
      let row = await getAppCurrentRating(fastify.pg, appleId, store, platform);

      // On miss, hit iTunes Lookup directly and persist
      if (!row) {
        const meta = await fetchAppMetadata(appleId, store);
        if (!meta)
          return reply
            .code(404)
            .send({ error: "App not found on the App Store." });

        const app = await upsertApp(fastify.pg, { appleId, ...meta });
        await insertSingleAppRating(
          fastify.pg,
          app.id,
          meta.rating,
          meta.ratingCount,
          store,
          platform,
        );

        row = {
          rating: meta.rating,
          ratings_count: meta.ratingCount,
          recorded_at: new Date(),
        };
      }

      const result = {
        appleId,
        store,
        platform,
        rating: row.rating,
        ratingsCount: row.ratings_count,
        recordedAt: row.recorded_at,
      };
      await cache.set(cacheKey, result, config.cacheTtlRating);
      return { ...result, cached: false };
    },
  );

  // ── GET /api/apps/:appleId/keywords/:keyword ─────────────────────────────
  fastify.get(
    "/api/apps/:appleId/keywords/:keyword",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId", "keyword"],
          properties: {
            appleId: { type: "string" },
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
        response: {
          200: {
            type: "object",
            properties: {
              appleId: { type: "string" },
              app: {
                type: "object",
                properties: {
                  name: { type: ["string", "null"] },
                  developer: { type: ["string", "null"] },
                  bundleId: { type: ["string", "null"] },
                  price: { type: ["string", "null"] },
                  genre: { type: ["string", "null"] },
                },
              },
              keyword: { type: "string" },
              store: { type: "string" },
              platform: { type: "string" },
              rank: { type: ["number", "null"] },
              rankedAt: { type: ["string", "null"] },
              popularity: { type: ["number", "null"] },
              competitiveness: { type: ["number", "null"] },
              cached: { type: "boolean" },
              popularityBreakdown: {
                type: ["object", "null"],
                additionalProperties: true,
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId, keyword } = request.params;
      const { store, platform } = request.query;
      const normKeyword = keyword.toLowerCase().trim();
      const cacheKey = `app-keyword:${appleId}:${store}:${platform}:${normKeyword}`;

      const cached = await cache.get(cacheKey);
      if (cached) return { ...cached, cached: true };

      const kw = await resolveOrSearch(normKeyword, keyword, store, platform, {
        limit: 100,
      });
      if (!kw)
        return reply
          .code(404)
          .send({ error: "Could not resolve keyword after search." });

      let [app, rankRow, popularityRow, competitivenessRow, popularityResult] =
        await Promise.all([
          getAppByAppleId(fastify.pg, appleId),
          getAppCurrentRank(fastify.pg, appleId, kw.id),
          getKeywordCurrentPopularity(fastify.pg, kw.id),
          getKeywordCurrentCompetitiveness(fastify.pg, kw.id),
          calculatePopularity(normKeyword, store, platform, {
            redis: fastify.redis,
            mediaApiToken: config.appleMediaApiToken,
            appleAdsCookie: config.appleAdsCookie,
            appleAdsXsrfToken: config.appleAdsXsrfToken,
            appleAdsAdamId: config.appleAdsAdamId,
          }),
        ]);

      // If no rank in DB, the cached search may be stale — force a fresh
      // search to update app_rankings, then re-query.
      if (!rankRow) {
        await runSearch(fastify.pg, fastify.redis, {
          keyword,
          store,
          platform,
          limit: 100,
          skipCache: true,
        });
        rankRow = await getAppCurrentRank(fastify.pg, appleId, kw.id);
      }

      if (!app) return reply.code(404).send({ error: "App not found." });

      const result = {
        appleId,
        app: {
          name: app.name,
          developer: app.developer,
          bundleId: app.bundle_id,
          price: app.price,
          genre: app.genre,
        },
        keyword,
        store,
        platform,
        rank: rankRow?.rank ?? null,
        rankedAt: rankRow?.ranked_at ?? null,
        popularity: popularityRow?.popularity ?? null,
        competitiveness: competitivenessRow?.competitiveness ?? null,
        popularityBreakdown: popularityResult?.breakdown ?? null,
      };

      // Only cache when we have a rank — avoids persisting stale null results.
      if (result.rank !== null) {
        await cache.set(cacheKey, result, config.cacheTtlRank);
      }
      return { ...result, cached: false };
    },
  );

  // ── POST /api/apps/:appleId/keywords ──────────────────────────────────────
  fastify.post(
    "/api/apps/:appleId/keywords",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: {
            appleId: { type: "string" },
          },
        },
        body: {
          type: "object",
          required: ["keywords"],
          properties: {
            keywords: {
              type: "array",
              items: { type: "string", minLength: 1 },
              minItems: 1,
              maxItems: 20,
            },
            store: { type: "string", default: "us", pattern: "^[a-z]{2}$" },
            platform: {
              type: "string",
              enum: ["iphone", "ipad"],
              default: "iphone",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              appleId: { type: "string" },
              app: { type: ["object", "null"], additionalProperties: true },
              store: { type: "string" },
              platform: { type: "string" },
              results: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId } = request.params;
      const { keywords, store = "us", platform = "iphone" } = request.body;

      // Fetch app once (shared across all keywords)
      const app = await getAppByAppleId(fastify.pg, appleId);
      if (!app) return reply.code(404).send({ error: "App not found." });

      // Process all keywords in parallel
      const results = await Promise.all(
        keywords.map(async (keyword) => {
          const normKeyword = keyword.toLowerCase().trim();
          const cacheKey = `app-keyword:${appleId}:${store}:${platform}:${normKeyword}`;

          // Check cache first
          const cached = await cache.get(cacheKey);
          if (cached) return { ...cached, cached: true };

          try {
            const kw = await resolveOrSearch(
              normKeyword,
              keyword,
              store,
              platform,
              { limit: 100 },
            );
            if (!kw) return { keyword, error: "Could not resolve keyword." };

            let rankRow = await getAppCurrentRank(fastify.pg, appleId, kw.id);

            // If no rank in DB, the cached search may be stale — force a fresh
            // search to update app_rankings, then re-query.
            if (!rankRow) {
              await runSearch(fastify.pg, fastify.redis, {
                keyword,
                store,
                platform,
                limit: 100,
                skipCache: true,
              });
              rankRow = await getAppCurrentRank(fastify.pg, appleId, kw.id);
            }

            const [popularityRow, competitivenessRow, popularityResult] =
              await Promise.all([
                getKeywordCurrentPopularity(fastify.pg, kw.id),
                getKeywordCurrentCompetitiveness(fastify.pg, kw.id),
                calculatePopularity(normKeyword, store, platform, {
                  redis: fastify.redis,
                  mediaApiToken: config.appleMediaApiToken,
                  appleAdsCookie: config.appleAdsCookie,
                  appleAdsXsrfToken: config.appleAdsXsrfToken,
                  appleAdsAdamId: config.appleAdsAdamId,
                }),
              ]);

            const result = {
              keyword,
              rank: rankRow?.rank ?? null,
              rankedAt: rankRow?.ranked_at ?? null,
              popularity: popularityRow?.popularity ?? null,
              competitiveness: competitivenessRow?.competitiveness ?? null,
              popularityBreakdown: popularityResult?.breakdown ?? null,
            };

            // Only cache when we have a rank — avoids persisting stale null results.
            if (result.rank !== null) {
              await cache.set(cacheKey, result, config.cacheTtlRank);
            }
            return { ...result, cached: false };
          } catch (err) {
            return { keyword, error: err.message };
          }
        }),
      );

      return {
        appleId,
        app: {
          name: app.name,
          developer: app.developer,
          bundleId: app.bundle_id,
          price: app.price,
          genre: app.genre,
        },
        store,
        platform,
        results,
      };
    },
  );

  // ── POST /api/apps/:appleId/keywords/suggest ─────────────────────────────
  fastify.post(
    "/api/apps/:appleId/keywords/suggest",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: {
            appleId: { type: "string" },
          },
        },
        body: {
          type: "object",
          properties: {
            store: { type: "string", default: "us", pattern: "^[a-z]{2}$" },
            platform: {
              type: "string",
              enum: ["iphone", "ipad"],
              default: "iphone",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              appleId: { type: "string" },
              app: { type: "object", additionalProperties: true },
              store: { type: "string" },
              platform: { type: "string" },
              totalGenerated: { type: "number" },
              cached: { type: "boolean" },
              timings: { type: "object", additionalProperties: true },
              results: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId } = request.params;
      const { store = "us", platform = "iphone" } = request.body ?? {};
      const cacheKey = `suggestions:${appleId}:${store}:${platform}`;

      const cached = await cache.get(cacheKey);
      if (cached) return { ...cached, cached: true };

      try {
        const data = await getKeywordSuggestions(
          fastify.pg,
          fastify.redis,
          appleId,
          { store, platform },
        );
        const result = { appleId, store, platform, ...data };
        await cache.set(cacheKey, result, 3600); // 1h — rankings change more often than suggestions
        return { ...result, cached: false };
      } catch (err) {
        fastify.log.error(
          { err, appleId },
          "[POST /api/apps/:appleId/keywords/suggest] failed",
        );
        return reply.code(500).send({ error: err.message });
      }
    },
  );

  // ── POST /api/apps/:appleId/keywords/discover ────────────────────────────
  fastify.post(
    "/api/apps/:appleId/keywords/discover",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: { appleId: { type: "string" } },
        },
        body: {
          type: "object",
          properties: {
            store: { type: "string", default: "us", pattern: "^[a-z]{2}$" },
            platform: {
              type: "string",
              enum: ["iphone", "ipad"],
              default: "iphone",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              appleId: { type: "string" },
              store: { type: "string" },
              platform: { type: "string" },
              app: {
                type: "object",
                properties: {
                  name: { type: ["string", "null"] },
                  subtitle: { type: ["string", "null"] },
                  developer: { type: ["string", "null"] },
                  genre: { type: ["string", "null"] },
                },
              },
              stats: {
                type: "object",
                properties: {
                  tokensExtracted: { type: "number" },
                  synonymsGenerated: { type: "number" },
                  coreTerms: { type: "number" },
                  fillerTerms: { type: "number" },
                  uniqueTerms: { type: "number" },
                  brandTerms: { type: "number" },
                  suggestTerms: { type: "number" },
                  pairsGenerated: { type: "number" },
                  totalSearched: { type: "number" },
                  earlyTerminated: { type: "boolean" },
                  pairsRanking: { type: "number" },
                  pairsNotFound: { type: "number" },
                  pairsFailed: { type: "number" },
                  enrichedCount: { type: "number" },
                  skippedEnrichCount: { type: "number" },
                  failureBreakdown: {
                    type: ["object", "null"],
                    additionalProperties: true,
                  },
                },
              },
              timings: { type: "object", additionalProperties: true },
              debug: { type: "object", additionalProperties: true },
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    keyword: { type: "string" },
                    rank: { type: "number" },
                    popularity: { type: ["number", "null"] },
                    competitiveness: { type: ["number", "null"] },
                  },
                },
              },
              cached: { type: "boolean" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId } = request.params;
      const { store = "us", platform = "iphone" } = request.body ?? {};
      const cacheKey = `discovery:${appleId}:${store}:${platform}`;

      const cached = await cache.get(cacheKey);
      if (cached) return { ...cached, cached: true };

      try {
        const data = await discoverKeywords(
          fastify.pg,
          fastify.redis,
          appleId,
          { store, platform },
        );
        const result = { appleId, store, platform, ...data };
        await cache.set(cacheKey, result, config.cacheTtlDiscovery);
        return { ...result, cached: false };
      } catch (err) {
        fastify.log.error(
          { err, appleId },
          "[POST /api/apps/:appleId/keywords/discover] failed",
        );
        if (err.message?.includes("not found on App Store")) {
          return reply.code(404).send({ error: err.message });
        }
        return reply.code(500).send({ error: err.message });
      }
    },
  );

  // ── GET /api/apps/:appleId/rating/history ────────────────────────────────
  fastify.get(
    "/api/apps/:appleId/rating/history",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: { appleId: { type: "string" } },
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
            period: { type: "string", enum: VALID_PERIODS, default: "7d" },
          },
        },
      },
    },
    async (request) => {
      const { appleId } = request.params;
      const { store, platform, period } = request.query;
      const since = periodToDate(period);
      const history = await getAppRatingHistory(
        fastify.pg,
        appleId,
        store,
        platform,
        since,
      );
      return { appleId, store, platform, period, history };
    },
  );

  /**
   * GET /api/apps/:appleId/opportunities
   * Returns keyword opportunities for the given app.
   */
  fastify.get(
    "/api/apps/:appleId/opportunities",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: {
            appleId: { type: "string" },
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
    async (request) => {
      const { appleId } = request.params;
      const { store, platform } = request.query;

      const result = await getOpportunities(
        fastify.pg,
        fastify.redis,
        appleId,
        store,
        platform,
      );

      return { appleId, platform, ...result };
    },
  );

  // ── POST /api/apps/:appleId/init ─────────────────────────────────────────
  fastify.post(
    "/api/apps/:appleId/init",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: { appleId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["brandName"],
          properties: {
            brandName: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId } = request.params;
      const { brandName } = request.body;
      const platform = "iphone";

      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const DELAY_MS = 300;
      const RETRY_BACKOFFS = [5000, 15000, 30000];

      const STORES = [
        { code: "us", name: "United States" },
        { code: "cn", name: "China" },
        { code: "jp", name: "Japan" },
        { code: "br", name: "Brazil" },
        { code: "gb", name: "United Kingdom" },
        { code: "de", name: "Germany" },
        { code: "fr", name: "France" },
        { code: "in", name: "India" },
        { code: "ca", name: "Canada" },
        { code: "au", name: "Australia" },
        { code: "kr", name: "South Korea" },
        { code: "ru", name: "Russia" },
        { code: "mx", name: "Mexico" },
        { code: "it", name: "Italy" },
        { code: "es", name: "Spain" },
        { code: "tr", name: "Turkey" },
        { code: "sa", name: "Saudi Arabia" },
        { code: "nl", name: "Netherlands" },
        { code: "se", name: "Sweden" },
        { code: "ch", name: "Switzerland" },
        { code: "id", name: "Indonesia" },
        { code: "tw", name: "Taiwan" },
        { code: "th", name: "Thailand" },
        { code: "vn", name: "Vietnam" },
        { code: "pl", name: "Poland" },
        { code: "ae", name: "United Arab Emirates" },
        { code: "no", name: "Norway" },
        { code: "dk", name: "Denmark" },
        { code: "at", name: "Austria" },
        { code: "za", name: "South Africa" },
      ];

      const totalStart = Date.now();

      // ── Phase 1: Scrape metadata from all 30 stores (parallel) ──────────
      const phase1Start = Date.now();
      const storeResults = await Promise.all(
        STORES.map(async ({ code, name }) => {
          try {
            const meta = await scrapeAppPageMetadata(appleId, code);
            if (!meta) return { store: code, country: name, available: false };
            return {
              store: code,
              country: name,
              available: true,
              title: meta.name ?? null,
              subtitle: meta.subtitle ?? null,
              description: meta.description ?? null,
            };
          } catch {
            return {
              store: code,
              country: name,
              available: false,
              error: true,
            };
          }
        }),
      );
      const phase1Ms = Date.now() - phase1Start;
      fastify.log.info(
        `[init] Phase 1 (metadata): ${phase1Ms}ms — ${storeResults.filter((s) => s.available).length}/${STORES.length} stores available`,
      );

      // ── Phase 2: Extract keyword tokens per store (Gemini LLM) ─────────
      const tokenData = await processAllStores(
        { appleId, stores: storeResults },
        brandName,
        config.geminiApiKey,
      );

      // ── Phase 3: Serial search — fetchSearchHtml for every (store, term) pair ──
      const phase3Start = Date.now();

      const searchTasks = [];
      for (const storeData of tokenData.stores) {
        const allKeywords = [...storeData.singles, ...storeData.pairs];
        for (const term of allKeywords) {
          searchTasks.push({
            store: storeData.storefront,
            country: storeData.country,
            term,
          });
        }
      }

      fastify.log.info(
        `[init] Phase 3: ${searchTasks.length} search tasks across ${tokenData.stores.length} stores`,
      );

      const found = [];
      const notFound = [];
      const failed = [];
      let retryQueue = [];

      for (let i = 0; i < searchTasks.length; i++) {
        const { store, country, term } = searchTasks[i];
        try {
          const html = await fetchSearchHtml(term, store, platform);
          const results = extractSearchResults(html);
          const match = results.find((r) => r.id === String(appleId));
          if (!match) {
            notFound.push({ store, country, keyword: term });
          } else {
            const top10Ids = results.slice(0, 10).map((r) => r.id);
            found.push({
              store,
              country,
              keyword: term,
              rank: match.rank,
              totalResults: results.length,
              top10Ids,
            });
          }
        } catch (err) {
          if (err?.message?.includes("HTTP 429")) {
            retryQueue.push(searchTasks[i]);
          } else {
            failed.push({ store, country, keyword: term, error: err.message });
          }
        }
        if (i < searchTasks.length - 1) await sleep(DELAY_MS);
      }

      fastify.log.info(
        `[init] First pass done: ${found.length} found, ${notFound.length} not found, ${retryQueue.length} queued, ${failed.length} failed`,
      );

      // ── Phase 4: Retry 429 queue with increasing backoff ────────────────
      for (
        let pass = 0;
        pass < RETRY_BACKOFFS.length && retryQueue.length > 0;
        pass++
      ) {
        const backoffMs = RETRY_BACKOFFS[pass];
        fastify.log.info(
          `[init] Retry pass ${pass + 1}/${RETRY_BACKOFFS.length}: ${retryQueue.length} terms, waiting ${backoffMs}ms`,
        );
        await sleep(backoffMs);

        const nextQueue = [];
        for (let i = 0; i < retryQueue.length; i++) {
          const { store, country, term } = retryQueue[i];
          try {
            const html = await fetchSearchHtml(term, store, platform);
            const results = extractSearchResults(html);
            const match = results.find((r) => r.id === String(appleId));
            if (!match) {
              notFound.push({ store, country, keyword: term });
            } else {
              const top10Ids = results.slice(0, 10).map((r) => r.id);
              found.push({
                store,
                country,
                keyword: term,
                rank: match.rank,
                totalResults: results.length,
                top10Ids,
              });
            }
          } catch (err) {
            if (err?.message?.includes("HTTP 429")) {
              nextQueue.push(retryQueue[i]);
            } else {
              failed.push({
                store,
                country,
                keyword: term,
                error: err.message,
              });
            }
          }
          if (i < retryQueue.length - 1) await sleep(DELAY_MS);
        }
        retryQueue = nextQueue;
      }

      for (const { store, country, term } of retryQueue) {
        failed.push({
          store,
          country,
          keyword: term,
          error: "Exhausted 429 retry passes.",
        });
      }

      const phase3Ms = Date.now() - phase3Start;
      fastify.log.info(
        `[init] Phase 3+4 (search): ${phase3Ms}ms — ${found.length} found, ${failed.length} failed`,
      );

      // ── Phase 5: Enrich — batch lookupAppMetadata per store, calculate competitiveness ──
      const phase5Start = Date.now();

      const byStore = {};
      for (const item of found) {
        (byStore[item.store] ??= []).push(item);
      }

      for (const [store, items] of Object.entries(byStore)) {
        const allIds = [...new Set(items.flatMap((i) => i.top10Ids))];
        let metadata = {};
        try {
          metadata = await lookupAppMetadata(allIds, store);
        } catch (err) {
          fastify.log.warn(
            `[init] lookupAppMetadata failed for store ${store}: ${err.message}`,
          );
        }

        for (const item of items) {
          const top10Results = item.top10Ids.map((id) => metadata[id] ?? {});
          item.competitiveness = calculateCompetitiveness(top10Results);
          item.competitors = item.top10Ids.map((id) => {
            const meta = metadata[id];
            return meta ? { id, ...meta } : { id };
          });
          delete item.top10Ids;
        }
      }

      const phase5Ms = Date.now() - phase5Start;
      const totalMs = Date.now() - totalStart;
      fastify.log.info(`[init] Phase 5 (enrich): ${phase5Ms}ms`);
      fastify.log.info(`[init] Total: ${totalMs}ms`);

      // ── Build response grouped by store ─────────────────────────────────
      const storeKeywords = {};
      for (const item of found) {
        (storeKeywords[item.store] ??= {
          country: item.country,
          keywords: [],
        }).keywords.push({
          keyword: item.keyword,
          rank: item.rank,
          totalResults: item.totalResults,
          competitiveness: item.competitiveness,
          competitors: item.competitors,
        });
      }
      for (const items of Object.values(storeKeywords)) {
        items.keywords.sort((a, b) => a.rank - b.rank);
      }

      return reply.code(200).send({
        appleId,
        brandName,
        platform,
        stores: storeResults,
        tokens: tokenData.stores,
        rankings: storeKeywords,
        stats: {
          totalSearches: searchTasks.length,
          found: found.length,
          notFound: notFound.length,
          failed: failed.length,
          retryExhausted: retryQueue.length,
          timings: {
            phase1_metadata_ms: phase1Ms,
            phase3_search_ms: phase3Ms,
            phase5_enrich_ms: phase5Ms,
            total_ms: totalMs,
          },
        },
      });
    },
  );

  fastify.get("/api/apps/test", async (request, reply) => {
    const proxyAgent = new HttpsProxyAgent(
      "http://sp7j3ej7di:3grdLKInoyZ9z7kf~8@dc.decodo.com:10000",
    );
    const response = await axios.get(
      "https://apps.apple.com/us/iphone/search?term=plan arch",
      {
        httpsAgent: proxyAgent,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        },
      },
    );
    return response.data;
  });

  // ── POST /api/apps/probe ─────────────────────────────────────────────────
  fastify.post(
    "/api/apps/probe",
    {
      schema: {
        body: {
          type: "object",
          required: ["appleId", "proxyUrl"],
          properties: {
            appleId: { type: "string", minLength: 1 },
            stores: {
              type: "array",
              items: { type: "string", minLength: 1 },
              minItems: 1,
              maxItems: 30,
            },
            store: { type: "string" },
            brandName: { type: "string" },
            proxyUrl: { type: "string", minLength: 1 },
            concurrency: {
              type: "integer",
              minimum: 1,
              maximum: 50,
              default: 10,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const {
        appleId,
        stores: storesParam,
        store: storeParam,
        brandName: brandNameParam,
        proxyUrl,
        concurrency = 10,
      } = request.body;

      // Support both `stores: ["us","de","it"]` and legacy `store: "us"`
      const storeCodes = storesParam ?? [storeParam ?? "us"];

      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const RETRY_BACKOFFS = [5000, 15000, 30000];
      const platform = "iphone";
      const totalStart = Date.now();

      // ── Phase 1: scrape metadata from all stores in parallel ───────────
      const phase1Start = Date.now();
      const storeResults = await Promise.all(
        storeCodes.map(async (code) => {
          try {
            const meta = await scrapeAppPageMetadata(appleId, code);
            if (!meta) return { store: code, available: false };
            return {
              store: code,
              available: true,
              name: meta.name ?? null,
              title: meta.name ?? null,
              subtitle: meta.subtitle ?? null,
              description: meta.description ?? null,
              genre: meta.genre ?? null,
              developer: meta.developer ?? null,
            };
          } catch {
            return { store: code, available: false, error: true };
          }
        }),
      );
      const phase1Ms = Date.now() - phase1Start;

      const available = storeResults.filter((s) => s.available);
      if (available.length === 0) {
        return reply.code(404).send({
          ok: false,
          appleId,
          error: "App not found in any of the requested stores.",
          stores: storeCodes,
          durationMs: Date.now() - totalStart,
        });
      }

      // Use first available store for brand name fallback
      const brandName = brandNameParam ?? available[0].name ?? "";

      // ── Phase 2: single Gemini call for all stores ─────────────────────
      const phase2Start = Date.now();
      const tokenData = await processAllStores(
        {
          appleId,
          stores: storeResults.map((s) => ({ ...s, country: s.store })),
        },
        brandName,
        config.geminiApiKey,
      );
      const phase2Ms = Date.now() - phase2Start;

      fastify.log.info(
        `[probe] ${appleId}: ${available.length} stores, ${tokenData.totalCalls} total keywords, concurrency=${concurrency}`,
      );

      // ── Proxy agent (shared across all stores) ─────────────────────────
      const proxyAgent = new HttpsProxyAgent(proxyUrl, {
        keepAlive: true,
        maxSockets: concurrency,
      });

      function fetchViaProxy(term, storeCode) {
        const url = `https://apps.apple.com/${storeCode}/${platform}/search?term=${encodeURIComponent(term)}`;
        return axios
          .get(url, {
            httpsAgent: proxyAgent,
            headers: {
              accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
              "accept-language": "en-US,en;q=0.9",
              "sec-fetch-dest": "document",
              "sec-fetch-mode": "navigate",
              "sec-fetch-site": "same-origin",
              "sec-fetch-user": "?1",
              "upgrade-insecure-requests": "1",
              "user-agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
              cookie: `geo=${storeCode.toUpperCase()}`,
            },
            timeout: 15000,
            responseType: "text",
          })
          .then((r) => r.data);
      }

      // ── Phase 3: concurrent searches across all stores via proxy ───────
      const phase3Start = Date.now();

      // Build search tasks: { store, term } for every store+keyword combo
      const searchTasks = [];
      for (const storeData of tokenData.stores) {
        const allKeywords = [...storeData.singles, ...storeData.pairs];
        for (const term of allKeywords) {
          searchTasks.push({ store: storeData.storefront, term });
        }
      }

      const found = [];
      const notFound = [];
      const failed = [];
      let retryQueue = [];

      function searchOne(task) {
        return fetchViaProxy(task.term, task.store)
          .then((html) => {
            const results = extractSearchResults(html);
            const match = results.find((r) => r.id === String(appleId));
            if (!match) {
              notFound.push({ store: task.store, keyword: task.term });
            } else {
              found.push({
                store: task.store,
                keyword: task.term,
                rank: match.rank,
                totalResults: results.length,
                top10Ids: results.slice(0, 10).map((r) => r.id),
              });
            }
          })
          .catch((err) => {
            const msg = err?.response?.status
              ? `HTTP ${err.response.status}`
              : (err?.message ?? String(err));
            if (msg.includes("429")) {
              retryQueue.push(task);
            } else {
              failed.push({
                store: task.store,
                keyword: task.term,
                error: msg,
              });
            }
          });
      }

      function runConcurrent(tasks) {
        let idx = 0;
        let active = 0;
        return new Promise((resolve) => {
          function next() {
            while (active < concurrency && idx < tasks.length) {
              active++;
              const task = tasks[idx++];
              searchOne(task).finally(() => {
                active--;
                next();
                if (active === 0 && idx >= tasks.length) resolve();
              });
            }
            if (active === 0 && idx >= tasks.length) resolve();
          }
          next();
        });
      }

      await runConcurrent(searchTasks);
      fastify.log.info(
        `[probe] First pass: ${found.length} found, ${notFound.length} not found, ${retryQueue.length} queued, ${failed.length} failed`,
      );

      // ── Phase 4: retry 429s (serial with backoff) ──────────────────────
      for (
        let pass = 0;
        pass < RETRY_BACKOFFS.length && retryQueue.length > 0;
        pass++
      ) {
        fastify.log.info(
          `[probe] Retry pass ${pass + 1}/${RETRY_BACKOFFS.length}: ${retryQueue.length} terms, waiting ${RETRY_BACKOFFS[pass]}ms`,
        );
        await sleep(RETRY_BACKOFFS[pass]);

        const nextQueue = [];
        for (const task of retryQueue) {
          try {
            const html = await fetchViaProxy(task.term, task.store);
            const results = extractSearchResults(html);
            const match = results.find((r) => r.id === String(appleId));
            if (!match)
              notFound.push({ store: task.store, keyword: task.term });
            else
              found.push({
                store: task.store,
                keyword: task.term,
                rank: match.rank,
                totalResults: results.length,
                top10Ids: results.slice(0, 10).map((r) => r.id),
              });
          } catch (err) {
            const msg = err?.response?.status
              ? `HTTP ${err.response.status}`
              : (err?.message ?? String(err));
            if (msg.includes("429")) nextQueue.push(task);
            else
              failed.push({
                store: task.store,
                keyword: task.term,
                error: msg,
              });
          }
        }
        retryQueue = nextQueue;
      }

      for (const task of retryQueue) {
        failed.push({
          store: task.store,
          keyword: task.term,
          error: "Exhausted 429 retry passes.",
        });
      }

      const phase3Ms = Date.now() - phase3Start;

      // ── Phase 5: enrich with competitiveness (per store) ───────────────
      const phase5Start = Date.now();
      if (found.length > 0) {
        // Group found results by store for metadata lookup
        const byStore = {};
        for (const item of found) {
          (byStore[item.store] ??= []).push(item);
        }

        for (const [storeCode, items] of Object.entries(byStore)) {
          const allIds = [...new Set(items.flatMap((i) => i.top10Ids))];
          let metadata = {};
          try {
            metadata = await lookupAppMetadata(allIds, storeCode);
          } catch (err) {
            fastify.log.warn(
              `[probe] lookupAppMetadata failed for ${storeCode}: ${err.message}`,
            );
          }
          for (const item of items) {
            const top10Results = item.top10Ids.map((id) => metadata[id] ?? {});
            item.competitiveness = calculateCompetitiveness(top10Results);
            item.competitors = item.top10Ids.map((id) =>
              metadata[id] ? { id, ...metadata[id] } : { id },
            );
            delete item.top10Ids;
          }
        }
      }

      found.sort((a, b) => a.rank - b.rank);

      // ── Build per-store response ───────────────────────────────────────
      const storeDetails = {};
      for (const storeData of tokenData.stores) {
        const code = storeData.storefront;
        const meta = storeResults.find((s) => s.store === code);
        storeDetails[code] = {
          name: meta?.name ?? null,
          subtitle: meta?.subtitle ?? null,
          category: meta?.genre ?? null,
          description: meta?.description ?? null,
          tokens: storeData.tokens,
          keywordCount: storeData.callCount,
          rankings: found.filter((r) => r.store === code),
        };
      }

      return reply.code(200).send({
        ok: true,
        appleId,
        stores: storeCodes,
        brandName,
        storeDetails,
        rankings: found,
        stats: {
          storesRequested: storeCodes.length,
          storesAvailable: available.length,
          totalKeywords: searchTasks.length,
          found: found.length,
          notFound: notFound.length,
          failed: failed.length,
          retryExhausted: retryQueue.length,
          timings: {
            phase1_metadata_ms: phase1Ms,
            phase2_gemini_ms: phase2Ms,
            phase3_search_ms: phase3Ms,
            phase5_enrich_ms: Date.now() - phase5Start,
            total_ms: Date.now() - totalStart,
          },
        },
      });
    },
  );
}
