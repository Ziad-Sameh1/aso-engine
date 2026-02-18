import fp from 'fastify-plugin';
import Redis from 'ioredis';

async function redisPlugin(fastify) {
  const redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      const delay = Math.min(times * 500, 5000);
      return delay;
    },
    lazyConnect: true,
  });

  redis.on('connect', () => fastify.log.info('Redis connected'));
  redis.on('error', (err) => fastify.log.error('Redis error: %s', err.message));

  // Try to connect but don't block startup
  try {
    await redis.connect();
  } catch (err) {
    fastify.log.warn('Redis initial connection failed, will retry: %s', err.message);
  }

  fastify.decorate('redis', redis);
  fastify.addHook('onClose', () => redis.quit());
}

export default fp(redisPlugin);
export { redisPlugin };