/**
 * Admin endpoints (use cautiously in production)
 */

export default async function adminRoutes(fastify) {
  // DELETE /api/admin/cache - flush entire Redis cache
  fastify.delete("/api/admin/cache", async (request, reply) => {
    await fastify.redis.flushdb();
    return { success: true, message: "Cache flushed" };
  });

  // DELETE /api/admin/cache/:pattern - flush keys matching pattern
  fastify.delete("/api/admin/cache/:pattern", async (request, reply) => {
    const { pattern } = request.params;
    const keys = await fastify.redis.keys(pattern);
    if (keys.length > 0) {
      await fastify.redis.del(...keys);
    }
    return { success: true, deleted: keys.length, pattern };
  });

  // DELETE /api/admin/popularity - truncate keywords (cascades to popularity, competitiveness, rankings, snapshots)
  fastify.delete("/api/admin/popularity", async (request, reply) => {
    await fastify.pg.query("TRUNCATE keywords CASCADE");
    return { success: true, message: "Keywords and all related data cleared (popularity, competitiveness, rankings, snapshots)" };
  });

  // DELETE /api/admin/competitiveness - truncate keyword_competitiveness table
  fastify.delete("/api/admin/competitiveness", async (request, reply) => {
    const result = await fastify.pg.query("TRUNCATE keyword_competitiveness CASCADE");
    return { success: true, message: "Competitiveness data cleared" };
  });
}
