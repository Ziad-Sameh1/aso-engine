/**
 * Worker 1: Update rankings for all tracked keywords.
 * Runs every hour, triggered by node-cron via BullMQ queue.
 */

import { Worker } from "bullmq";
import { config } from "../config/index.js";
import { getTrackedKeywords } from "../services/db.js";
import { runSearch } from "../services/searchService.js";

export function createKeywordRankingsWorker(redisOpts, pg, redis, log) {
  const worker = new Worker(
    "keyword-rankings",
    async (job) => {
      const keywords = await getTrackedKeywords(pg);
      log.info(`[Worker:keyword-rankings] Processing ${keywords.length} tracked keywords`);

      for (let i = 0; i < keywords.length; i++) {
        const kw = keywords[i];
        try {
          await runSearch(pg, redis, {
            keyword:   kw.keyword,
            store:     kw.store,
            platform:  kw.platform,
            skipCache: true,  // Always fetch fresh data, bypass cache
          });
          log.info(
            `[Worker:keyword-rankings] ${i + 1}/${keywords.length}: "${kw.keyword}" (${kw.store}/${kw.platform})`
          );
        } catch (err) {
          log.error(
            `[Worker:keyword-rankings] Failed "${kw.keyword}" (${kw.store}/${kw.platform}): ${err.message}`
          );
          // Continue with next keyword — don't abort the whole job
        }

        if (i < keywords.length - 1) {
          await job.updateProgress(Math.round(((i + 1) / keywords.length) * 100));
          await new Promise((r) => setTimeout(r, config.workerKeywordDelayMs));
        }
      }

      await job.updateProgress(100);
      log.info("[Worker:keyword-rankings] Job complete");
    },
    {
      connection: redisOpts,
      concurrency: 1,
    }
  );

  worker.on("failed", (job, err) => {
    log.error(`[Worker:keyword-rankings] Job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}
