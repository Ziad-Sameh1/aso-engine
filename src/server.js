// Import the framework and instantiate it
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config/index.js';
import { postgresPlugin } from './plugins/postgres.js';
import { redisPlugin } from './plugins/redis.js';


const app = Fastify({
    logger: {
      level: config.nodeEnv === 'production' ? 'info' : 'debug',
    },
  });
  
  // Plugins
  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  
  // Database & Cache
  await app.register(postgresPlugin);
  await app.register(redisPlugin);

// Declare a route
app.get('/', async function handler (request, reply) {
  return { hello: 'world' }
})

// Start
try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`ASO Engine running on port ${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }