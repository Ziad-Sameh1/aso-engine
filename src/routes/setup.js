import { setupApp } from "../services/setupService.js";

export async function setupRoutes(fastify) {
  // ── POST /api/apps/setup ──────────────────────────────────────────────────
  fastify.post(
    "/api/apps/setup",
    {
      schema: {
        body: {
          type: "object",
          required: ["appleId"],
          properties: {
            appleId: { type: "string", minLength: 1 },
            stores: {
              type: "array",
              items: { type: "string" },
              default: [],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId, stores = [] } = request.body;

      const result = await setupApp(fastify.pg, { appleId, stores });

      if (!result) {
        return reply.code(404).send({ error: "App not found on the App Store." });
      }

      return { appleId, callsCount: result.callsCount, stores: result.stores };
    }
  );
}
