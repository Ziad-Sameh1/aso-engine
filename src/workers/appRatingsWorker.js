/**
 * Worker 2: Update ratings for all tracked apps.
 * Runs every 24 hours, triggered by node-cron via BullMQ queue.
 */

import { Worker } from "bullmq";
import { config } from "../config/index.js";
import { CacheService } from "../services/cache.js";
import { fetchAppMetadata } from "../services/appstore.js";
import { getTrackedApps, insertSingleAppRating } from "../services/db.js";

export function createAppRatingsWorker(redisOpts, pg, redis, log) {
  const worker = new Worker(
    "app-ratings",
    async (job) => {
      const apps = await getTrackedApps(pg);
      const cache = new CacheService(redis);
      log.info(`[Worker:app-ratings] Processing ${apps.length} tracked apps`);

      for (let i = 0; i < apps.length; i++) {
        const app = apps[i];
        try {
          // Fetch fresh rating from iTunes Lookup
          const meta = await fetchAppMetadata(app.apple_id, "us");
          if (meta && meta.rating != null) {
            await insertSingleAppRating(pg, app.id, meta.rating, meta.ratingCount, "us", "iphone");
            // Bust cached rating so next read gets fresh data
            await cache.invalidate(`rating:${app.apple_id}:*`);
          }
          log.info(
            `[Worker:app-ratings] ${i + 1}/${apps.length}: ${app.name ?? app.apple_id} — ${meta?.rating ?? "no rating"}`
          );
        } catch (err) {
          log.error(`[Worker:app-ratings] Failed ${app.apple_id}: ${err.message}`);
        }

        if (i < apps.length - 1) {
          await job.updateProgress(Math.round(((i + 1) / apps.length) * 100));
          await new Promise((r) => setTimeout(r, config.workerAppDelayMs));
        }
      }

      await job.updateProgress(100);
      log.info("[Worker:app-ratings] Job complete");
    },
    {
      connection: redisOpts,
      concurrency: 1,
    }
  );

  worker.on("failed", (job, err) => {
    log.error(`[Worker:app-ratings] Job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}
