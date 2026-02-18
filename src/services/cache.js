export class CacheService {
  constructor(redis) {
    this.redis = redis;
  }

  async get(key) {
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  async set(key, value, ttlSeconds = 3600) {
    await this.redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  }

  async invalidate(pattern) {
    const keys = await this.redis.keys(pattern);
    if (keys.length) await this.redis.del(...keys);
  }
}
