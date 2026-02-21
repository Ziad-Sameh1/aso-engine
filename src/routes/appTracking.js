import { fetchAppMetadata } from "../services/appstore.js";
import {
  upsertApp,
  setAppTracking,
  getTrackedApps,
  getAppByAppleId,
} from "../services/db.js";

export async function appTrackingRoutes(fastify) {
  // ── POST /api/apps/track ─────────────────────────────────────────────────
  fastify.post(
    "/api/apps/track",
    {
      schema: {
        body: {
          type: "object",
          required: ["appleId"],
          properties: {
            appleId: { type: "string", minLength: 1 },
            store:   { type: "string", default: "us" },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId, store = "us" } = request.body;

      let app = await getAppByAppleId(fastify.pg, appleId);
      if (!app) {
        const meta = await fetchAppMetadata(appleId, store);
        if (!meta) return reply.code(404).send({ error: "App not found on the App Store." });
        app = await upsertApp(fastify.pg, { appleId, ...meta });
      }

      await setAppTracking(fastify.pg, appleId, true);
      return { ...app, trackingEnabled: true };
    }
  );

  // ── GET /api/apps/tracked ────────────────────────────────────────────────
  fastify.get("/api/apps/tracked", async () => {
    const apps = await getTrackedApps(fastify.pg);
    return { total: apps.length, apps };
  });

  // ── PATCH /api/apps/:appleId/track ───────────────────────────────────────
  fastify.patch(
    "/api/apps/:appleId/track",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: { appleId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["trackingEnabled"],
          properties: { trackingEnabled: { type: "boolean" } },
        },
      },
    },
    async (request, reply) => {
      const { appleId } = request.params;
      const { trackingEnabled } = request.body;
      const row = await setAppTracking(fastify.pg, appleId, trackingEnabled);
      if (!row) return reply.code(404).send({ error: "App not found." });
      return { appleId: row.apple_id, name: row.name, trackingEnabled: row.tracking_enabled };
    }
  );

  // ── DELETE /api/apps/:appleId/track ──────────────────────────────────────
  fastify.delete(
    "/api/apps/:appleId/track",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: { appleId: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const { appleId } = request.params;
      const row = await setAppTracking(fastify.pg, appleId, false);
      if (!row) return reply.code(404).send({ error: "App not found." });
      return { appleId: row.apple_id, trackingEnabled: false };
    }
  );
}
