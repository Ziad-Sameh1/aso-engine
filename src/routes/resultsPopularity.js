import { getResultsPopularity } from "../services/resultsPopularityService.js";

export async function resultsPopularityRoutes(fastify) {
  fastify.get(
    "/api/results-popularity",
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
      return getResultsPopularity(fastify.redis, { keyword, store, platform });
    }
  );
}
