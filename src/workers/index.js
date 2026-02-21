/**
 * Worker orchestrator.
 * - Creates BullMQ queues and workers
 * - Sets up node-cron schedules that enqueue jobs at the right times
 * - Handles graceful shutdown via Fastify's onClose hook
 *
 * Schedule:
 *   keyword-rankings  every 1 hour  (0 * * * *)
 *   app-ratings       daily 03:00   (0 3 * * *)
 *   popularity-update daily 04:00   (0 4 * * *)
 */

import cron from "node-cron";
import { parseRedisUrl, createQueues } from "./queues.js";
import { createKeywordRankingsWorker } from "./keywordRankingsWorker.js";
import { createAppRatingsWorker } from "./appRatingsWorker.js";
import { createPopularityWorker } from "./popularityWorker.js";

export function initWorkers(fastify) {
  const redisOpts = parseRedisUrl(process.env.REDIS_URL);
  const queues = createQueues(redisOpts);

  // Create workers (they start listening immediately)
  const workers = [
    createKeywordRankingsWorker(redisOpts, fastify.pg, fastify.redis, fastify.log),
    createAppRatingsWorker(redisOpts, fastify.pg, fastify.redis, fastify.log),
    createPopularityWorker(redisOpts, fastify.pg, fastify.redis, fastify.log),
  ];

  // ── Cron: keyword rankings every hour ──────────────────────────────────
  cron.schedule("0 * * * *", async () => {
    // Time-bucketed jobId prevents duplicate jobs within the same hour
    const bucket = new Date().toISOString().slice(0, 13); // "2026-02-19T14"
    try {
      await queues.keywordRankings.add(
        "update-all-tracked",
        { triggeredAt: new Date().toISOString() },
        { jobId: `keyword-rankings-${bucket}`, removeOnComplete: 10, removeOnFail: 20 }
      );
      fastify.log.info(`[Cron] Enqueued keyword-rankings job (${bucket})`);
    } catch (err) {
      fastify.log.error(`[Cron] Failed to enqueue keyword-rankings: ${err.message}`);
    }
  });

  // ── Cron: app ratings daily at 03:00 UTC ───────────────────────────────
  cron.schedule("0 3 * * *", async () => {
    const bucket = new Date().toISOString().slice(0, 10); // "2026-02-19"
    try {
      await queues.appRatings.add(
        "update-all-tracked",
        { triggeredAt: new Date().toISOString() },
        { jobId: `app-ratings-${bucket}`, removeOnComplete: 10, removeOnFail: 20 }
      );
      fastify.log.info(`[Cron] Enqueued app-ratings job (${bucket})`);
    } catch (err) {
      fastify.log.error(`[Cron] Failed to enqueue app-ratings: ${err.message}`);
    }
  });

  // ── Cron: popularity/comp daily at 04:00 UTC ───────────────────────────
  cron.schedule("0 4 * * *", async () => {
    const bucket = new Date().toISOString().slice(0, 10); // "2026-02-19"
    try {
      await queues.popularity.add(
        "update-top-demanded",
        { triggeredAt: new Date().toISOString() },
        { jobId: `popularity-${bucket}`, removeOnComplete: 10, removeOnFail: 20 }
      );
      fastify.log.info(`[Cron] Enqueued popularity job (${bucket})`);
    } catch (err) {
      fastify.log.error(`[Cron] Failed to enqueue popularity: ${err.message}`);
    }
  });

  fastify.log.info("[Workers] Scheduled: keyword-rankings (hourly), app-ratings (03:00 UTC), popularity (04:00 UTC)");

  // ── Graceful shutdown ───────────────────────────────────────────────────
  fastify.addHook("onClose", async () => {
    fastify.log.info("[Workers] Shutting down...");
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all(Object.values(queues).map((q) => q.close()));
  });
}
