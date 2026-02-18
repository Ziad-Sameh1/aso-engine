// Import the framework and instantiate it
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config/index.js";
import { postgresPlugin } from "./plugins/postgres.js";
import { redisPlugin } from "./plugins/redis.js";

const app = Fastify({
  logger: {
    level: config.nodeEnv === "production" ? "info" : "debug",
  },
});

// Plugins
await app.register(cors, { origin: true });
await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });

// Database & Cache
await app.register(postgresPlugin);
await app.register(redisPlugin);

// Health check route
app.get("/api/health", async function (request, reply) {
  const health = { status: "ok", timestamp: new Date().toISOString() };

  // Test Postgres
  try {
    const result = await app.pg.query("SELECT NOW()");
    health.postgres = { status: "connected", time: result.rows[0].now };
  } catch (err) {
    health.postgres = { status: "error", message: err.message };
    health.status = "degraded";
  }

  // Test Redis
  try {
    await app.redis.set("health:ping", "pong", "EX", 10);
    const pong = await app.redis.get("health:ping");
    health.redis = { status: "connected", ping: pong };
  } catch (err) {
    health.redis = { status: "error", message: err.message };
    health.status = "degraded";
  }

  return health;
});

// Start
try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`ASO Engine running on port ${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
