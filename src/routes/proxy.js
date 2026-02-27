import { fetchSearchHtmlViaProxy } from "../services/appstore.js";

export async function proxyRoutes(fastify) {
  fastify.get("/api/proxy/test", async (request, reply) => {
    const term = request.query.term;
    const html = await fetchSearchHtmlViaProxy(term);
    return { term, responseLength: html.length };
  });
}
