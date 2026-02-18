import fp from 'fastify-plugin';
import Redis from 'ioredis';

async function redisPlugin(fastify) {
  const redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 100,
    tls: process.env.REDIS_URL?.startsWith('rediss://') ? {} : undefined,
  });

  redis.on('connect', () => fastify.log.info('Redis connected'));
  redis.on('error', (err) => fastify.log.error('Redis error:', err));

  fastify.decorate('redis', redis);
  fastify.addHook('onClose', () => redis.quit());
}

export default fp(redisPlugin);
export { redisPlugin };