/**
 * Worker 3: Update popularity for top-demand keywords using real scoring.
 * Runs every 24 hours, triggered by node-cron via BullMQ queue.
 */

import { Worker } from "bullmq";
import { config } from "../config/index.js";
import { getTopDemandKeywords, insertPopularity } from "../services/db.js";
import { calculatePopularityBatch } from "../services/popularity.js";

export function createPopularityWorker(redisOpts, pg, redis, log) {
  const worker = new Worker(
    "popularity-update",
    async (job) => {
      const keywords = await getTopDemandKeywords(pg, config.workerTopDemandLimit);
      log.info(`[Worker:popularity] Processing ${keywords.length} top-demand keywords`);

      const scored = await calculatePopularityBatch(keywords, {
        redis,
        mediaApiToken:     config.appleMediaApiToken,
        appleAdsCookie:    config.appleAdsCookie,
        appleAdsXsrfToken: config.appleAdsXsrfToken,
        appleAdsAdamId:    config.appleAdsAdamId,
      });

      for (let i = 0; i < scored.length; i++) {
        const kw = scored[i];
        try {
          if (kw.score === null) {
            log.warn(
              `[Worker:popularity] ${i + 1}/${scored.length}: "${kw.keyword}" skipped — score unavailable (rate limited)`
            );
          } else {
            await insertPopularity(pg, kw.id, kw.score);
            log.info(
              `[Worker:popularity] ${i + 1}/${scored.length}: "${kw.keyword}" (${kw.store}/${kw.platform}) score=${kw.score} demand=${kw.query_count}`
            );
          }
        } catch (err) {
          log.error(`[Worker:popularity] DB insert failed for "${kw.keyword}": ${err.message}`);
        }
        await job.updateProgress(Math.round(((i + 1) / scored.length) * 100));
      }

      log.info("[Worker:popularity] Job complete");
    },
    {
      connection: redisOpts,
      concurrency: 1,
    }
  );

  worker.on("failed", (job, err) => {
    log.error(`[Worker:popularity] Job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}
