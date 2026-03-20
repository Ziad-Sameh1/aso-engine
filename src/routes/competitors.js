import { findCompetitors } from "../services/competitorsService.js";

const postCompetitorsSchema = {
  body: {
    type: "object",
    required: ["appleId", "stores"],
    properties: {
      appleId: { type: "string" },
      stores: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
      },
    },
  },
};

export async function competitorsRoutes(fastify) {
  fastify.post("/api/competitors", { schema: postCompetitorsSchema }, async (request, reply) => {
    const { appleId, stores } = request.body;

    const competitors = await findCompetitors(fastify, appleId, stores);

    return {
      appleId,
      stores,
      competitors,
    };
  });
}
