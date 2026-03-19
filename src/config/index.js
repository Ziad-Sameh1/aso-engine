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
  // Discovery engine
  discoverySearchConcurrency: ttl(process.env.DISCOVERY_SEARCH_CONCURRENCY, 30),
  discoveryPopularityConcurrency: ttl(
    process.env.DISCOVERY_POPULARITY_CONCURRENCY,
    5,
  ),
  discoveryMaxTerms: ttl(process.env.DISCOVERY_MAX_TERMS, 30),
  discoveryMaxPairs: ttl(process.env.DISCOVERY_MAX_PAIRS, 500),
  discoverySearchTimeoutMs: ttl(process.env.DISCOVERY_SEARCH_TIMEOUT_MS, 10000),
  discoverySearchDelayMs: ttl(process.env.DISCOVERY_SEARCH_DELAY_MS, 250),
  discoverySearchJitterMs: ttl(process.env.DISCOVERY_SEARCH_JITTER_MS, 150),
  discovery429BaseBackoffMs: ttl(
    process.env.DISCOVERY_429_BASE_BACKOFF_MS,
    3000,
  ),
  discovery429MaxBackoffMs: ttl(process.env.DISCOVERY_429_MAX_BACKOFF_MS, 30000),
  discovery429MaxRetries: ttl(process.env.DISCOVERY_429_MAX_RETRIES, 4),
  discoveryTopNEnrich: ttl(process.env.DISCOVERY_TOP_N_ENRICH, 20),
  discoveryMaxCorePairs: ttl(process.env.DISCOVERY_MAX_CORE_PAIRS, 500),
  discoverySuggestTopN: ttl(process.env.DISCOVERY_SUGGEST_TOP_N, 7),
  discoveryEnrichMaxRank: ttl(process.env.DISCOVERY_ENRICH_MAX_RANK, 80),
  discoveryEarlyTermGoodCount: ttl(process.env.DISCOVERY_EARLY_TERM_GOOD_COUNT, 15),
  discoveryEarlyTermGoodRank: ttl(process.env.DISCOVERY_EARLY_TERM_GOOD_RANK, 50),
  discoverySuggestConcurrency: ttl(process.env.DISCOVERY_SUGGEST_CONCURRENCY, 3),
  cacheTtlDiscovery: ttl(process.env.CACHE_TTL_DISCOVERY, 3600),
  popLowDensityThreshold: ttl(process.env.POP_LOW_DENSITY_THRESHOLD, 3),
  popAppleAdsLowThreshold: ttl(process.env.POP_APPLE_ADS_LOW_THRESHOLD, 10),
  suggestMaxRetries: ttl(process.env.SUGGEST_MAX_RETRIES, 5),
  suggestBaseDelayMs: ttl(process.env.SUGGEST_BASE_DELAY_MS, 1000),
  suggestMaxDelayMs: ttl(process.env.SUGGEST_MAX_DELAY_MS, 30000),
  apiKey: process.env.API_KEY,
  apiKeyPrevious: process.env.API_KEY_PREVIOUS,
  proxyUrl: process.env.PROXY_URL,
  proxyMaxSockets: ttl(process.env.PROXY_MAX_SOCKETS, 100),
  // Setup ranking
  setupRankConcurrency: ttl(process.env.SETUP_RANK_CONCURRENCY, 100),
  setupMaxPermutations: ttl(process.env.SETUP_MAX_PERMUTATIONS, 800),
  setupMaxSeedPermutations: ttl(process.env.SETUP_MAX_SEED_PERMUTATIONS, 400),
  setupSuggestConcurrency: ttl(process.env.SETUP_SUGGEST_CONCURRENCY, 100),
  miningConcurrency: ttl(process.env.MINING_CONCURRENCY, 50),
  cacheTtlItunesMeta: ttl(process.env.CACHE_TTL_ITUNES_META, 86400), // 24h
  // ShipLift (cold email pipeline)
  shipliftApiUrl: process.env.SHIPLIFT_API_URL,
  shipliftClaimApiKey: process.env.SHIPLIFT_CLAIM_API_KEY,
  coldEmailMaxKeywords: ttl(process.env.COLD_EMAIL_MAX_KEYWORDS, 20),
};
