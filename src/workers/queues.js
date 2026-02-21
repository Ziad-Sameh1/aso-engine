/**
 * BullMQ Queue factory.
 * BullMQ requires its own Redis connection (cannot share the ioredis instance).
 * We parse REDIS_URL into the { host, port, password, db } format BullMQ expects.
 */

import { Queue } from "bullmq";

/**
 * Parse a Redis URL into a BullMQ-compatible connection options object.
 * Supports: redis://:password@host:port/db
 */
export function parseRedisUrl(redisUrl) {
  const url = new URL(redisUrl);
  const opts = {
    host: url.hostname,
    port: Number(url.port) || 6379,
  };
  if (url.password) opts.password = decodeURIComponent(url.password);
  if (url.pathname && url.pathname !== "/") {
    opts.db = Number(url.pathname.slice(1)) || 0;
  }
  return opts;
}

export function createQueues(redisOpts) {
  return {
    keywordRankings: new Queue("keyword-rankings", { connection: redisOpts }),
    appRatings:      new Queue("app-ratings",       { connection: redisOpts }),
    popularity:      new Queue("popularity-update",  { connection: redisOpts }),
  };
}
