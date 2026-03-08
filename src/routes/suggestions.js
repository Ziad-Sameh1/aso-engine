import { mineSuggestions } from "../services/miningService.js";

export async function suggestionsRoutes(fastify) {
  // ── POST /api/suggestions/mine ────────────────────────────────────────────
  fastify.post(
    "/api/suggestions/mine",
    {
      schema: {
        body: {
          type: "object",
          required: ["seed"],
          properties: {
            seed: {
              type: "array",
              items: { type: "string", minLength: 1 },
              minItems: 1,
            },
            store: { type: "string", default: "us" },
            appMeta: {
              type: "object",
              properties: {
                name:        { type: "string" },
                subtitle:    { type: "string" },
                description: { type: "string" },
                category:    { type: "string" },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { seed, store = "us", appMeta } = request.body;

      const { searchTerms, tree } = await mineSuggestions(seed, store, fastify.redis, appMeta);

      const totalSearchTerms = searchTerms.L1.length + searchTerms.L2.length + searchTerms.L3.length;

      return { seed, store, totalSearchTerms, searchTerms, tree };
    }
  );
}
