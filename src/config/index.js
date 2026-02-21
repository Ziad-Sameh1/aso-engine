import "dotenv/config";

/** Parses TTL; returns default only when value is missing or invalid. Accepts 0. */
function ttl(val, def) {
  const n = Number(val);
  return Number.isNaN(n) ? def : n;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  cacheTtlSearch: ttl(process.env.CACHE_TTL_SEARCH, 3600),
  cacheTtlRank: ttl(process.env.CACHE_TTL_RANK, 3600),
  cacheTtlRating: ttl(process.env.CACHE_TTL_RATING, 3600),
  cacheTtlPopularity: ttl(process.env.CACHE_TTL_POPULARITY, 86400),
  cacheTtlCompetitiveness: ttl(process.env.CACHE_TTL_COMPETITIVENESS, 86400),
  asoApiKey: process.env.ASO_API_KEY,
  asoApiBaseUrl: process.env.ASO_API_BASE_URL,
  // Worker config
  workerKeywordDelayMs: ttl(process.env.WORKER_KEYWORD_DELAY_MS, 3000),
  workerAppDelayMs: ttl(process.env.WORKER_APP_DELAY_MS, 1000),
  workerTopDemandLimit: ttl(process.env.WORKER_TOP_DEMAND_LIMIT, 50),
  // Popularity scoring
  appleMediaApiToken: process.env.APPLE_MEDIA_API_TOKEN,
  appleAdsCookie: process.env.APPLE_ADS_COOKIE,
  appleAdsXsrfToken: process.env.APPLE_ADS_XSRF_TOKEN,
  appleAdsAdamId: process.env.APPLE_ADS_ADAM_ID,
  cacheTtlSuggest: ttl(process.env.CACHE_TTL_SUGGEST, 172800), // 48h
  cacheTtlApplePop: ttl(process.env.CACHE_TTL_APPLE_POP, 86400), // 24h
  workerSuggestDelayMs: ttl(process.env.WORKER_SUGGEST_DELAY_MS, 200),
  geminiApiKey: process.env.GEMINI_API_KEY,
  cacheTtlSuggestions: ttl(process.env.CACHE_TTL_SUGGESTIONS, 86400), // 24h
  apiKey: process.env.API_KEY,
  apiKeyPrevious: process.env.API_KEY_PREVIOUS,
};
