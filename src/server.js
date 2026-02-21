// Import the framework and instantiate it
import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config/index.js";

/** Constant-time string comparison to prevent timing attacks. */
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA); // burn same CPU time
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// --- Startup guard ---
if (config.nodeEnv === "production" && !config.apiKey) {
  console.error("FATAL: API_KEY must be set in production. Exiting.");
  process.exit(1);
}
if (config.nodeEnv !== "production" && !config.apiKey) {
  console.warn("WARNING: API_KEY not set — auth disabled (dev mode).");
}
import { postgresPlugin } from "./plugins/postgres.js";
import { redisPlugin } from "./plugins/redis.js";
import { searchRoutes } from "./routes/search.js";
import { appsRoutes } from "./routes/apps.js";
import { keywordsRoutes } from "./routes/keywords.js";
import { keywordTrackingRoutes } from "./routes/keywordTracking.js";
import { appTrackingRoutes } from "./routes/appTracking.js";
import adminRoutes from "./routes/admin.js";
import { initWorkers } from "./workers/index.js";

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

await app.register(searchRoutes);
await app.register(appsRoutes);
await app.register(keywordsRoutes);
await app.register(keywordTrackingRoutes);
await app.register(appTrackingRoutes);
await app.register(adminRoutes);

app.get("/", async function (request, reply) {
  return { message: "Welcome to the ASO Engine :D" };
});

// Health check route
app.get("/api/health", async function (request, reply) {
  const health = { status: "ok", timestamp: new Date().toISOString(), environment: config.nodeEnv };

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

// --- API key auth hook ---
app.addHook("onRequest", async (request, reply) => {
  // Skip auth for health check and root
  if (request.url === "/api/health" || request.url === "/") return;

  // Skip if no API_KEY configured (dev mode)
  if (!config.apiKey) return;

  const key = request.headers["x-api-key"];
  if (!key) {
    reply.code(401).send({ error: "Unauthorized", message: "Missing x-api-key header" });
    return;
  }

  const matchesCurrent = safeEqual(key, config.apiKey);
  const matchesPrevious = config.apiKeyPrevious
    ? safeEqual(key, config.apiKeyPrevious)
    : false;

  if (!matchesCurrent && !matchesPrevious) {
    reply.code(403).send({ error: "Forbidden", message: "Invalid API key" });
    return;
  }
});

// Init background workers before listen (addHook must be called before server starts)
initWorkers(app);

// Start
try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`ASO Engine running on port ${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
