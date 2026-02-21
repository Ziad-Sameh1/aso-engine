import {
  upsertStorefront,
  upsertWord,
  upsertKeyword,
  setKeywordTracking,
  getTrackedKeywords,
} from "../services/db.js";

export async function keywordTrackingRoutes(fastify) {
  // ── POST /api/keywords/track ─────────────────────────────────────────────
  fastify.post(
    "/api/keywords/track",
    {
      schema: {
        body: {
          type: "object",
          required: ["keyword"],
          properties: {
            keyword:  { type: "string", minLength: 1 },
            store:    { type: "string", default: "us" },
            platform: { type: "string", enum: ["iphone", "ipad"], default: "iphone" },
          },
        },
      },
    },
    async (request) => {
      const { keyword, store = "us", platform = "iphone" } = request.body;

      const [storefront, word] = await Promise.all([
        upsertStorefront(fastify.pg, store),
        upsertWord(fastify.pg, keyword),
      ]);
      const kw = await upsertKeyword(fastify.pg, word.id, storefront.id, platform);
      await setKeywordTracking(fastify.pg, kw.id, true);

      return { id: kw.id, keyword, store, platform, trackingEnabled: true };
    }
  );

  // ── GET /api/keywords/tracked ────────────────────────────────────────────
  fastify.get("/api/keywords/tracked", async () => {
    const keywords = await getTrackedKeywords(fastify.pg);
    return { total: keywords.length, keywords };
  });

  // ── PATCH /api/keywords/:keywordId/track ─────────────────────────────────
  fastify.patch(
    "/api/keywords/:keywordId/track",
    {
      schema: {
        params: {
          type: "object",
          required: ["keywordId"],
          properties: { keywordId: { type: "integer" } },
        },
        body: {
          type: "object",
          required: ["trackingEnabled"],
          properties: { trackingEnabled: { type: "boolean" } },
        },
      },
    },
    async (request, reply) => {
      const { keywordId } = request.params;
      const { trackingEnabled } = request.body;
      const row = await setKeywordTracking(fastify.pg, keywordId, trackingEnabled);
      if (!row) return reply.code(404).send({ error: "Keyword not found." });
      return { id: row.id, trackingEnabled: row.tracking_enabled };
    }
  );

  // ── DELETE /api/keywords/:keywordId/track ────────────────────────────────
  fastify.delete(
    "/api/keywords/:keywordId/track",
    {
      schema: {
        params: {
          type: "object",
          required: ["keywordId"],
          properties: { keywordId: { type: "integer" } },
        },
      },
    },
    async (request, reply) => {
      const { keywordId } = request.params;
      const row = await setKeywordTracking(fastify.pg, keywordId, false);
      if (!row) return reply.code(404).send({ error: "Keyword not found." });
      return { id: row.id, trackingEnabled: false };
    }
  );
}
