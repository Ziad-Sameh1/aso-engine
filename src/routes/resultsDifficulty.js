import { getResultsDifficulty } from "../services/resultsDifficultyService.js";

export async function resultsDifficultyRoutes(fastify) {
  fastify.get(
    "/api/results-difficulty",
    {
      schema: {
        querystring: {
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
      const { keyword, store, platform } = request.query;
      return getResultsDifficulty(fastify.redis, { keyword, store, platform });
    }
  );
}
