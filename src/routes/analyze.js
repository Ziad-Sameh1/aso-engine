import {
  analyzeApp,
  fetchMultiStoreRatings,
  checkStorefrontAvailability,
  APPLE_STOREFRONTS,
  MAJOR_STOREFRONTS,
} from "../services/analyzeService.js";
import { discoverKeywordsDirect } from "../services/discoveryService.js";
import { CacheService } from "../services/cache.js";
import { config } from "../config/index.js";

export async function analyzeRoutes(fastify) {
  const cache = new CacheService(fastify.redis);

  /**
   * GET /api/apps/:appleId/analyze
   *
   * Returns comprehensive metadata for a single app by Apple ID, combined
   * with keyword ranking discovery.
   *
   * Combines:
   *   - iTunes Lookup API  (screenshots, file size, languages, per-version rating, IAP flag, etc.)
   *   - App Store HTML     (subtitle, per-star %, in-app purchase list, copyright, developer links)
   *   - Keyword discovery  (keywords the app actually ranks for, with popularity + competitiveness)
   *
   * Query params:
   *   store    {string}   Two-letter storefront code for the primary analysis (default: "us")
   *   platform {string}   "iphone" or "ipad" (default: "iphone")
   *   stores   {string}   Comma-separated country codes to compare ratings across storefronts.
   *                       Use "major" for the top ~50 markets, "all" for every known storefront,
   *                       or a custom list like "us,jp,gb,de,fr".
   *                       When provided, the response includes a `storeRatings` map so you can
   *                       spot localisation issues (e.g. Japan averaging 1 star).
   *                       NOTE: keyword discovery is skipped when `stores` is specified.
   */
  fastify.get(
    "/api/apps/:appleId/analyze",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: {
            appleId: { type: "string", minLength: 1 },
          },
        },
        querystring: {
          type: "object",
          properties: {
            store:    { type: "string", default: "us", pattern: "^[a-z]{2}$" },
            platform: { type: "string", enum: ["iphone", "ipad"], default: "iphone" },
            stores:   { type: "string" },
          },
        },
        response: {
          200: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const { appleId } = request.params;
      const { store = "us", platform = "iphone", stores } = request.query;

      let targetCountries = null;
      if (stores) {
        if (stores === "all") {
          targetCountries = APPLE_STOREFRONTS;
        } else if (stores === "major") {
          targetCountries = MAJOR_STOREFRONTS;
        } else {
          targetCountries = [
            ...new Set(
              stores
                .split(",")
                .map((c) => c.trim().toLowerCase())
                .filter((c) => /^[a-z]{2}$/.test(c))
            ),
          ];
        }
      }

      const cacheKey = `analyze:${appleId}:${store}:${platform}:${stores ?? ""}`;
      const cached = await cache.get(cacheKey);
      if (cached) return { ...cached, cached: true };

      // Fetch app metadata first (shared with discovery to avoid duplicate Apple calls)
      const [appData, storeRatings] = await Promise.all([
        analyzeApp(appleId, store),
        targetCountries ? fetchMultiStoreRatings(appleId, targetCountries) : Promise.resolve(null),
      ]);

      if (!appData) {
        return reply
          .code(404)
          .send({ error: "App not found on the App Store." });
      }

      // Run discovery after analyzeApp — reuse its metadata to avoid a second Apple fetch
      const discoveryData = await discoverKeywordsDirect(
        fastify.pg, fastify.redis, appleId,
        { store, platform, appMeta: appData },
      ).catch((err) => {
        fastify.log.warn({ err, appleId }, "[analyze] keyword discovery failed, skipping");
        return null;
      });

      const result = {
        ...appData,
        ...(storeRatings ? { storeRatings: storeRatings.stores, storeRatingsSummary: storeRatings.statusSummary } : {}),
        keywords: discoveryData
          ? {
              results: discoveryData.results,
              stats: discoveryData.stats,
              timings: discoveryData.timings,
            }
          : null,
      };

      await cache.set(cacheKey, result, config.cacheTtlDiscovery);
      return { ...result, cached: false };
    }
  );

  /**
   * GET /api/apps/:appleId/availability
   *
   * Checks the app's availability across every known Apple App Store storefront
   * (~175 countries) by making parallelised HTTP requests and recording the
   * actual HTTP status code for each one.
   *
   * Query params:
   *   concurrency  {number}  Max parallel requests (default: 30, max: 50)
   *
   * Response shape:
   *   totalStorefronts  — number of storefronts checked
   *   durationMs        — wall-clock time for all requests
   *   summary           — { "200": N, "404": N, "timeout": N, ... } sorted by code
   *   byStatus          — { "200": ["us","gb",...], "404": [...], ... }
   */
  fastify.get(
    "/api/apps/:appleId/availability",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: {
            appleId: { type: "string", minLength: 1 },
          },
        },
        querystring: {
          type: "object",
          properties: {
            concurrency: { type: "integer", minimum: 1, maximum: 50, default: 30 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              appleId: { type: "string" },
              totalStorefronts: { type: "number" },
              durationMs: { type: "number" },
              summary: { type: "object", additionalProperties: true },
              byStatus: { type: "object", additionalProperties: true },
              checkedAt: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId } = request.params;
      const { concurrency = 30 } = request.query;

      const data = await checkStorefrontAvailability(appleId, { concurrency });
      return data;
    }
  );
}
