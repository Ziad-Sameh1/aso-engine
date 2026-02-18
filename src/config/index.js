import "dotenv/config";

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  cacheTtlSearch: Number(process.env.CACHE_TTL_SEARCH) || 3600,
  cacheTtlPopularity: Number(process.env.CACHE_TTL_POPULARITY) || 86400,
  asoApiKey: process.env.ASO_API_KEY,
  asoApiBaseUrl: process.env.ASO_API_BASE_URL,
};
