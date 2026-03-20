import { mineApp, generateLocalizedIntentsV2, generateCompetitorSearchTerms, createLimiter } from "../services/miningService.js";
import { config } from "../config/index.js";
import {
  fetchSearchHtmlViaProxy,
  extractSearchResults,
  scrapeAppNameSubtitle,
} from "../services/appstore.js";
import { scoreMinedKeywords } from "../services/keywordSuggestionService.js";
import {
  upsertApp,
  upsertApps,
  upsertStorefront,
  upsertAppMinedKeywords,
  replaceAppCompetitors,
  getAppCompetitors,
  getAppMinedKeywords,
  getAppsByAppleIds,
  insertAppRatings,
} from "../services/db.js";

export async function miningRoutes(fastify) {
  /**
   * POST /api/apps/:appleId/mine/v2
   *
   * Simplified competitor discovery across storefronts.
   *   Phase 1 — scrape app metadata per store in parallel (done)
   *   Phase 2 — Gemini generates 10 localized intents per store (done)
   *   Phase 3 — search intents, count competitor appearances (done)
   *
   * Body:
   *   stores  {string[]}  Two-letter country codes (default: ["us"])
   */
  fastify.post(
    "/api/apps/:appleId/mine/v2",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: {
            appleId: { type: "string", minLength: 1 },
          },
        },
        body: {
          type: "object",
          properties: {
            stores: {
              type: "array",
              items: { type: "string", pattern: "^[a-z]{2}$" },
              default: ["us"],
            },
          },
        },
        response: {
          200: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const { appleId } = request.params;
      const { stores = ["us"] } = request.body ?? {};

      const t0 = performance.now();

      // Phase 1: scrape metadata across stores in parallel
      const { scrapeAppPageMetadata } = await import("../services/appstore.js");
      const scraped = await Promise.all(
        stores.map(async (store) => {
          const t0 = performance.now();
          const meta = await scrapeAppPageMetadata(appleId, store);
          const ms = Math.round(performance.now() - t0);
          return { store, meta, ms };
        })
      );

      const found = scraped.filter((r) => r.meta !== null);
      if (found.length === 0) {
        return reply.code(404).send({ error: "App not found on the App Store." });
      }

      // Phase 2: single Gemini call — 10 localized intents per store
      const usEntry = found.find((r) => r.store === "us") ?? found[0];
      const geminiT0 = performance.now();
      const intentsArray = await generateLocalizedIntentsV2({
        meta: usEntry.meta,
        storeCodes: found.map((r) => r.store),
      });
      const geminiMs = Math.round(performance.now() - geminiT0);

      const intentsMap = Object.fromEntries(
        intentsArray.map((r) => [r.store, r.intents])
      );

      // Phase 4: search all intents per store, count competitor appearances
      const searchT0 = performance.now();

      const storeResults = await Promise.all(
        found.map(async ({ store, meta, ms: metadataMs }) => {
          const intents = intentsMap[store] ?? [];
          if (intents.length === 0) {
            return { store, found: true, name: meta.name, subtitle: meta.subtitle, intents: [], competitors: [], metadataMs };
          }

          // Search all 10 intents concurrently (concurrency 30)
          const limit = createLimiter(30);
          const intentResults = await Promise.all(
            intents.map((intent) =>
              limit(async () => {
                try {
                  const html = await fetchSearchHtmlViaProxy(intent, store);
                  return extractSearchResults(html).slice(0, 50);
                } catch {
                  return [];
                }
              })
            )
          );

          // Count appearances
          const countMap = new Map(); // appleId → { count, name, bundleId, subtitle }
          for (const results of intentResults) {
            for (const r of results) {
              const entry = countMap.get(r.id);
              if (entry) {
                entry.count++;
              } else {
                countMap.set(r.id, { count: 1, name: null, subtitle: null });
              }
            }
          }

          // Resolve name + subtitle for all competitors via scrapeAppNameSubtitle (via proxy)
          const scrapeLimit = createLimiter(100);
          const allIds = [...countMap.keys()];

          const runScrape = (ids) =>
            Promise.all(
              ids.map((id) =>
                scrapeLimit(async () => {
                  try {
                    const result = await scrapeAppNameSubtitle(id, store, config.proxyUrl);
                    if (result) {
                      const entry = countMap.get(id);
                      entry.name = result.name;
                      entry.subtitle = result.subtitle;
                    }
                  } catch {
                    // non-fatal — will be caught by retry pass
                  }
                })
              )
            );

          await runScrape(allIds);

          // Retry pass: re-scrape any that still have no name (429 failures)
          const failed = [...countMap.keys()].filter((id) => !countMap.get(id).name);
          if (failed.length > 0) {
            console.log(`[mine-v2] ${store}: retrying ${failed.length} failed scrapes`);
            await runScrape(failed);
          }

          // Filter out the target app itself, sort by count desc
          const competitors = [...countMap.entries()]
            .filter(([id]) => String(id) !== String(appleId))
            .map(([id, e]) => ({ id, name: e.name, subtitle: e.subtitle, count: e.count }))
            .sort((a, b) => b.count - a.count);

          return {
            store,
            found: true,
            name: meta.name,
            subtitle: meta.subtitle,
            intents,
            competitors,
            competitorCount: competitors.length,
            metadataMs,
          };
        })
      );

      // Attach not-found stores
      for (const { store } of scraped.filter((r) => r.meta === null)) {
        storeResults.push({ store, found: false });
      }

      const searchMs = Math.round(performance.now() - searchT0);

      // Phase 5: per store (all parallel), Gemini generates search terms for every competitor
      const phase5T0 = performance.now();

      await Promise.all(
        storeResults
          .filter((r) => r.found && r.competitors?.length > 0)
          .map(async (storeResult) => {
            const eligible = storeResult.competitors.filter((c) => c.name);
            if (eligible.length === 0) return;

            const termsMap = await generateCompetitorSearchTerms(eligible);
            for (const competitor of storeResult.competitors) {
              competitor.searchTerms = termsMap.get(String(competitor.id)) ?? [];
            }
          })
      );

      const phase5Ms = Math.round(performance.now() - phase5T0);
      const totalMs = Math.round(performance.now() - t0);

      return {
        appleId,
        stores: storeResults,
        timings: {
          metadataMs: Math.max(...scraped.map((r) => r.ms)),
          geminiMs,
          searchMs,
          phase5Ms,
          totalMs,
        },
      };
    }
  );

  /**
   * POST /api/apps/:appleId/mine
   *
   * Mines App Store data for an app across one or more storefronts.
   * Persists mined keywords (add-only dictionary) and top 100 competitors per store.
   *
   * Body:
   *   stores  {string[]}  List of two-letter country codes (default: ["us"])
   */
  fastify.post(
    "/api/apps/:appleId/mine",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: {
            appleId: { type: "string", minLength: 1 },
          },
        },
        body: {
          type: "object",
          properties: {
            stores: {
              type: "array",
              items: { type: "string", pattern: "^[a-z]{2}$" },
              default: ["us"],
            },
          },
        },
        response: {
          200: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const { appleId } = request.params;
      const { stores = ["us"] } = request.body ?? {};

      const result = await mineApp(appleId, stores);
      if (!result) return reply.code(404).send({ error: "App not found on the App Store." });

      // Persist mined keywords + competitors in background (don't block response)
      persistMiningResults(fastify.pg, appleId, result).catch((err) =>
        fastify.log.error({ err, appleId }, "Failed to persist mining results")
      );

      return result;
    }
  );

  /**
   * GET /api/apps/:appleId/competitors
   *
   * Returns persisted competitors for an app aggregated across all mined stores,
   * ranked by total appearance count.
   */
  fastify.get(
    "/api/apps/:appleId/competitors",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: {
            appleId: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request) => {
      const { appleId } = request.params;

      const competitors = await getAppCompetitors(fastify.pg, appleId);
      if (!competitors.length) return { appleId, competitors: [], count: 0 };

      // Enrich with live ratings via iTunes Lookup API (up to 200 per batch)
      const appleIds = competitors.map((c) => c.apple_id);
      const firstStore = competitors[0].stores[0] ?? "us";
      const metadata = await lookupAppMetadata(appleIds, firstStore, fastify.redis);

      const enriched = competitors.map((c) => {
        const m = metadata[c.apple_id];
        return {
          ...c,
          rating: m?.rating ?? null,
          ratings_count: m?.ratingCount ?? null,
        };
      });

      // Persist ratings to app_ratings in background (change-detected, won't duplicate)
      persistCompetitorRatings(fastify.pg, enriched, firstStore).catch((err) =>
        fastify.log.error({ err }, "Failed to persist competitor ratings")
      );

      return { appleId, competitors: enriched, count: enriched.length };
    }
  );

  /**
   * GET /api/apps/:appleId/keywords/suggestions
   *
   * Returns mined keywords scored by suggest popularity (> 10 only).
   * Scores are fetched in parallel (100 concurrent via proxy) and cached 24h.
   * Failed keywords are retried in a second pass without backoff.
   *
   * Query:
   *   store     {string}  Two-letter country code (default: "us")
   *   platform  {string}  "iphone" | "ipad" (default: "iphone")
   */
  fastify.get(
    "/api/apps/:appleId/keywords/suggestions",
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
            store: { type: "string", pattern: "^[a-z]{2}$", default: "us" },
            platform: { type: "string", enum: ["iphone", "ipad"], default: "iphone" },
          },
        },
      },
    },
    async (request) => {
      const { appleId } = request.params;
      const { store = "us", platform = "iphone" } = request.query ?? {};
      const t0 = performance.now();

      // Fetch mined keywords from the dictionary
      const mined = await getAppMinedKeywords(fastify.pg, appleId, store);
      if (!mined.length) {
        return { appleId, store, platform, keywords: [], count: 0, minedCount: 0, ms: 0 };
      }

      // Score all keywords in parallel via suggest API
      const scored = await scoreMinedKeywords(mined, store, platform, {
        redis: fastify.redis,
      });

      const ms = Math.round(performance.now() - t0);

      return {
        appleId,
        store,
        platform,
        keywords: scored,
        count: scored.length,
        minedCount: mined.length,
        ms,
      };
    }
  );
}

/**
 * Persist keywords (add-only) and competitors (top 100, full replace) from mining results.
 */
async function persistMiningResults(pg, appleId, result) {
  for (const storeResult of result.stores) {
    if (!storeResult.found) continue;

    const store = storeResult.store;

    // Ensure app + storefront exist in DB
    const [appRow, sfRow] = await Promise.all([
      upsertApp(pg, { appleId, name: storeResult.name }),
      upsertStorefront(pg, store),
    ]);

    // ── Persist keywords (add-only dictionary) ──
    if (storeResult.keywords?.length) {
      const keywords = storeResult.keywords.map((k) => ({
        text: k.keyword,
        frequency: k.frequency,
      }));
      const newCount = await upsertAppMinedKeywords(pg, appRow.id, sfRow.id, keywords);
      console.log(
        `[mining:persist] ${appleId}/${store}: ${newCount} new keywords added (${keywords.length} total mined)`
      );
    }

    // ── Persist competitors (top 100, full replace) ──
    if (storeResult.searchResults?.length) {
      // Upsert all competitor apps first so they exist in apps table
      const competitorApps = storeResult.searchResults.slice(0, 100).map((c) => ({
        appleId: c.id,
        name: c.name || null,
      }));
      await upsertApps(
        pg,
        competitorApps.map((c) => ({
          appleId: c.appleId,
          name: c.name,
        }))
      );

      const competitors = storeResult.searchResults.slice(0, 100).map((c) => ({
        appleId: c.id,
        appearanceCount: c.count ?? 0,
      }));
      await replaceAppCompetitors(pg, appRow.id, sfRow.id, competitors);
      console.log(
        `[mining:persist] ${appleId}/${store}: ${competitors.length} competitors persisted`
      );
    }
  }
}

/**
 * Persist competitor ratings to app_ratings (change-detected, skips unchanged).
 */
async function persistCompetitorRatings(pg, competitors, store) {
  const withRatings = competitors.filter((c) => c.rating != null);
  if (!withRatings.length) return;

  const appRows = await getAppsByAppleIds(pg, withRatings.map((c) => c.apple_id));
  const appleToDbId = new Map(appRows.map((r) => [r.apple_id, r.id]));

  const ratings = withRatings
    .filter((c) => appleToDbId.has(c.apple_id))
    .map((c) => ({
      appDbId: appleToDbId.get(c.apple_id),
      rating: c.rating,
      ratingsCount: c.ratings_count,
    }));

  if (ratings.length) {
    await insertAppRatings(pg, null, ratings, store);
  }
}
