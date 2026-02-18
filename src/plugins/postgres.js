import fp from 'fastify-plugin';
import pg from 'pg';

async function postgresPlugin(fastify) {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
  });

  // Test connection
  const client = await pool.connect();
  client.release();
  fastify.log.info('PostgreSQL connected');

  fastify.decorate('pg', pool);
  fastify.addHook('onClose', () => pool.end());
}

export default fp(postgresPlugin);
export { postgresPlugin };