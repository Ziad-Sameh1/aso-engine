import { prepareColdEmailLead } from "../services/coldEmailService.js";

export async function coldEmailRoutes(fastify) {
  fastify.post(
    "/api/cold-email/prepare",
    {
      schema: {
        body: {
          type: "object",
          required: ["storeUrl"],
          properties: {
            storeUrl: { type: "string", minLength: 1 },
            store: { type: "string", default: "us" },
            utmSource: { type: "string" },
            utmCampaign: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { storeUrl, store = "us", utmSource, utmCampaign } = request.body;

      try {
        const result = await prepareColdEmailLead(
          fastify.pg,
          fastify.redis,
          storeUrl,
          { store, utmSource, utmCampaign },
        );

        return {
          lead: result.lead,
          discovery: result.discovery
            ? {
                stats: result.discovery.stats,
                timings: result.discovery.timings,
              }
            : null,
          cached: result.cached,
        };
      } catch (err) {
        fastify.log.error(err, "Cold email prepare failed");
        return reply
          .code(500)
          .send({ error: err.message || "Cold email prepare failed" });
      }
    },
  );
}
