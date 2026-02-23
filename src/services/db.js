/**
 * All PostgreSQL persistence and query logic for the ASO engine.
 * Functions receive `pg` (fastify.pg pool) as first argument.
 */

// ── Upserts ──────────────────────────────────────────────────────────────────

export async function upsertStorefront(pg, code) {
  const { rows } = await pg.query(
    `INSERT INTO storefronts (code, country)
     VALUES ($1, $1)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
     RETURNING id, code, country`,
    [code.toLowerCase()]
  );
  return rows[0];
}

export async function upsertWord(pg, text) {
  const normText = text.toLowerCase().trim();
  const { rows } = await pg.query(
    `INSERT INTO words (text, norm_text)
     VALUES ($1, $2)
     ON CONFLICT (norm_text) DO UPDATE SET text = EXCLUDED.text
     RETURNING id, text, norm_text`,
    [text, normText]
  );
  return rows[0];
}

export async function upsertKeyword(pg, wordId, storefrontId, platform) {
  const { rows } = await pg.query(
    `INSERT INTO keywords (word_id, storefront_id, platform)
     VALUES ($1, $2, $3)
     ON CONFLICT (word_id, storefront_id, platform) DO UPDATE SET word_id = EXCLUDED.word_id
     RETURNING id`,
    [wordId, storefrontId, platform]
  );
  return rows[0];
}

/**
 * Batch upsert apps in a single round-trip using unnest.
 * Returns Map<appleId, dbId>.
 */
export async function upsertApps(pg, appDataArray) {
  const appIdMap = new Map();
  if (!appDataArray.length) return appIdMap;

  const appleIds = appDataArray.map((a) => a.appleId);
  const bundleIds = appDataArray.map((a) => a.bundleId || null);
  const names = appDataArray.map((a) => a.name || null);
  const developers = appDataArray.map((a) => a.developer || null);
  const prices = appDataArray.map((a) => a.price || null);
  const genres = appDataArray.map((a) => a.genre || null);
  const iconUrls = appDataArray.map((a) => a.iconUrl || null);

  const { rows } = await pg.query(
    `INSERT INTO apps (apple_id, bundle_id, name, developer, price, genre, icon_url, updated_at)
     SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::text[]),
            unnest($4::text[]), unnest($5::text[]), unnest($6::text[]),
            unnest($7::text[]), NOW()
     ON CONFLICT (apple_id) DO UPDATE SET
       bundle_id  = COALESCE(NULLIF(EXCLUDED.bundle_id, ''),  apps.bundle_id),
       name       = COALESCE(NULLIF(EXCLUDED.name, ''),       apps.name),
       developer  = COALESCE(NULLIF(EXCLUDED.developer, ''),  apps.developer),
       price      = COALESCE(NULLIF(EXCLUDED.price, ''),      apps.price),
       genre      = COALESCE(NULLIF(EXCLUDED.genre, ''),      apps.genre),
       icon_url   = COALESCE(NULLIF(EXCLUDED.icon_url, ''),   apps.icon_url),
       updated_at = NOW()
     RETURNING id, apple_id`,
    [appleIds, bundleIds, names, developers, prices, genres, iconUrls]
  );

  for (const row of rows) appIdMap.set(row.apple_id, row.id);
  return appIdMap;
}

/**
 * Upsert a single app by apple_id. Returns { id, apple_id }.
 */
export async function upsertApp(
  pg,
  { appleId, bundleId, name, developer, price, genre, iconUrl }
) {
  const { rows } = await pg.query(
    `INSERT INTO apps (apple_id, bundle_id, name, developer, price, genre, icon_url, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (apple_id) DO UPDATE SET
       bundle_id  = COALESCE(NULLIF(EXCLUDED.bundle_id, ''), apps.bundle_id),
       name       = COALESCE(NULLIF(EXCLUDED.name, ''),      apps.name),
       developer  = COALESCE(NULLIF(EXCLUDED.developer, ''), apps.developer),
       price      = COALESCE(NULLIF(EXCLUDED.price, ''),     apps.price),
       genre      = COALESCE(NULLIF(EXCLUDED.genre, ''),     apps.genre),
       icon_url   = COALESCE(NULLIF(EXCLUDED.icon_url, ''),  apps.icon_url),
       updated_at = NOW()
     RETURNING id, apple_id`,
    [
      appleId,
      bundleId || null,
      name || null,
      developer || null,
      price || null,
      genre || null,
      iconUrl || null,
    ]
  );
  return rows[0];
}

/**
 * Insert a single app rating row (no snapshot, e.g. from direct iTunes Lookup).
 */
export async function insertSingleAppRating(
  pg,
  appDbId,
  rating,
  ratingsCount,
  store = "us",
  platform = "iphone"
) {
  if (rating == null) return;
  await pg.query(
    `INSERT INTO app_ratings (app_id, rating, ratings_count, store, platform)
     SELECT $1, $2, $3, $4, $5
     WHERE ROW($2::numeric, $3::int) IS DISTINCT FROM (
       SELECT r.rating, r.ratings_count FROM app_ratings r
       WHERE r.app_id = $1 AND r.store = $4 AND r.platform = $5
       ORDER BY r.recorded_at DESC LIMIT 1
     )`,
    [appDbId, rating, ratingsCount ?? null, store, platform]
  );
}

export async function insertSearchSnapshot(
  pg,
  keywordId,
  totalResults,
  rawResponse
) {
  const { rows } = await pg.query(
    `INSERT INTO search_snapshots (keyword_id, total_results, raw_response)
     VALUES ($1, $2, $3)
     RETURNING id, snapshot_at`,
    [keywordId, totalResults, JSON.stringify(rawResponse)]
  );
  return rows[0];
}

/**
 * Batch insert app rankings using unnest for a single-query bulk insert.
 * rankings = [{ appDbId, rank }]
 */
export async function insertAppRankings(pg, keywordId, snapshotId, rankings) {
  if (!rankings.length) return;
  const appIds = rankings.map((r) => r.appDbId);
  const ranks = rankings.map((r) => r.rank);
  await pg.query(
    `WITH input AS (
       SELECT $1::bigint AS keyword_id,
              unnest($2::bigint[]) AS app_id,
              unnest($3::smallint[]) AS rank
     )
     INSERT INTO app_rankings (keyword_id, app_id, rank, search_snapshot_id)
     SELECT i.keyword_id, i.app_id, i.rank, $4
     FROM input i
     WHERE i.rank IS DISTINCT FROM (
       SELECT ar.rank FROM app_rankings ar
       WHERE ar.app_id = i.app_id AND ar.keyword_id = i.keyword_id
       ORDER BY ar.ranked_at DESC LIMIT 1
     )`,
    [keywordId, appIds, ranks, snapshotId]
  );
}

/**
 * Batch insert app ratings using unnest, skipping entries with no rating.
 * ratings = [{ appDbId, rating, ratingsCount }]
 */
export async function insertAppRatings(
  pg,
  snapshotId,
  ratings,
  store = "us",
  platform = "iphone"
) {
  const valid = ratings.filter((r) => r.rating != null);
  if (!valid.length) return;
  const appIds = valid.map((r) => r.appDbId);
  const ratingVals = valid.map((r) => r.rating);
  const counts = valid.map((r) => r.ratingsCount ?? null);
  await pg.query(
    `WITH input AS (
       SELECT unnest($1::bigint[]) AS app_id,
              unnest($2::numeric[]) AS rating,
              unnest($3::int[]) AS ratings_count
     )
     INSERT INTO app_ratings (app_id, rating, ratings_count, search_snapshot_id, store, platform)
     SELECT i.app_id, i.rating, i.ratings_count, $4, $5, $6
     FROM input i
     WHERE ROW(i.rating, i.ratings_count) IS DISTINCT FROM (
       SELECT r.rating, r.ratings_count FROM app_ratings r
       WHERE r.app_id = i.app_id AND r.store = $5 AND r.platform = $6
       ORDER BY r.recorded_at DESC LIMIT 1
     )`,
    [appIds, ratingVals, counts, snapshotId, store, platform]
  );
}

export async function insertPopularity(pg, keywordId, popularity) {
  await pg.query(
    `INSERT INTO keyword_popularity (keyword_id, popularity)
     SELECT $1, $2
     WHERE $2 IS DISTINCT FROM (
       SELECT kp.popularity FROM keyword_popularity kp
       WHERE kp.keyword_id = $1 ORDER BY kp.fetched_at DESC LIMIT 1
     )`,
    [keywordId, popularity]
  );
}

export async function insertCompetitiveness(pg, keywordId, competitiveness) {
  await pg.query(
    `INSERT INTO keyword_competitiveness (keyword_id, competitiveness)
     SELECT $1, $2
     WHERE $2 IS DISTINCT FROM (
       SELECT kc.competitiveness FROM keyword_competitiveness kc
       WHERE kc.keyword_id = $1 ORDER BY kc.fetched_at DESC LIMIT 1
     )`,
    [keywordId, competitiveness]
  );
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Resolve keyword row from normalized text + store code + platform.
 */
export async function resolveKeyword(pg, normText, storeCode, platform) {
  const { rows } = await pg.query(
    `SELECT k.id
     FROM keywords k
     JOIN words w ON w.id = k.word_id
     JOIN storefronts s ON s.id = k.storefront_id
     WHERE w.norm_text = $1 AND s.code = $2 AND k.platform = $3`,
    [normText, storeCode.toLowerCase(), platform]
  );
  return rows[0] || null;
}

export async function getAppCurrentRank(pg, appleId, keywordId) {
  const { rows } = await pg.query(
    `SELECT ar.rank, ar.ranked_at
     FROM app_rankings ar
     JOIN apps a ON a.id = ar.app_id
     WHERE a.apple_id = $1 AND ar.keyword_id = $2
     ORDER BY ar.ranked_at DESC
     LIMIT 1`,
    [appleId, keywordId]
  );
  return rows[0] || null;
}

export async function getAppRankHistory(pg, appleId, keywordId, since) {
  const { rows } = await pg.query(
    `SELECT ar.rank, ar.ranked_at
     FROM app_rankings ar
     JOIN apps a ON a.id = ar.app_id
     WHERE a.apple_id = $1 AND ar.keyword_id = $2 AND ar.ranked_at >= $3
     ORDER BY ar.ranked_at ASC`,
    [appleId, keywordId, since]
  );
  return rows;
}

export async function getAppCurrentRating(
  pg,
  appleId,
  store = "us",
  platform = "iphone"
) {
  const { rows } = await pg.query(
    `SELECT r.rating, r.ratings_count, r.recorded_at
     FROM app_ratings r
     JOIN apps a ON a.id = r.app_id
     WHERE a.apple_id = $1 AND r.store = $2 AND r.platform = $3
     ORDER BY r.recorded_at DESC
     LIMIT 1`,
    [appleId, store, platform]
  );
  return rows[0] || null;
}

export async function getAppRatingHistory(
  pg,
  appleId,
  store = "us",
  platform = "iphone",
  since
) {
  const { rows } = await pg.query(
    `SELECT r.rating, r.ratings_count, r.recorded_at
     FROM app_ratings r
     JOIN apps a ON a.id = r.app_id
     WHERE a.apple_id = $1 AND r.store = $2 AND r.platform = $3 AND r.recorded_at >= $4
     ORDER BY r.recorded_at ASC`,
    [appleId, store, platform, since]
  );
  return rows;
}

export async function getKeywordCurrentPopularity(pg, keywordId) {
  const { rows } = await pg.query(
    `SELECT popularity, fetched_at
     FROM keyword_popularity
     WHERE keyword_id = $1
     ORDER BY fetched_at DESC
     LIMIT 1`,
    [keywordId]
  );
  return rows[0] || null;
}

export async function getKeywordPopularityHistory(pg, keywordId, since) {
  const { rows } = await pg.query(
    `SELECT popularity, fetched_at
     FROM keyword_popularity
     WHERE keyword_id = $1 AND fetched_at >= $2
     ORDER BY fetched_at ASC`,
    [keywordId, since]
  );
  return rows;
}

export async function getKeywordCurrentCompetitiveness(pg, keywordId) {
  const { rows } = await pg.query(
    `SELECT competitiveness, fetched_at
     FROM keyword_competitiveness
     WHERE keyword_id = $1
     ORDER BY fetched_at DESC
     LIMIT 1`,
    [keywordId]
  );
  return rows[0] || null;
}

export async function getKeywordCompetitivenessHistory(pg, keywordId, since) {
  const { rows } = await pg.query(
    `SELECT competitiveness, fetched_at
     FROM keyword_competitiveness
     WHERE keyword_id = $1 AND fetched_at >= $2
     ORDER BY fetched_at ASC`,
    [keywordId, since]
  );
  return rows;
}

// ── Tracking CRUD ────────────────────────────────────────────────────────────

export async function setKeywordTracking(pg, keywordId, enabled) {
  const { rows } = await pg.query(
    `UPDATE keywords SET tracking_enabled = $2 WHERE id = $1
     RETURNING id, tracking_enabled`,
    [keywordId, enabled]
  );
  return rows[0] || null;
}

export async function setAppTracking(pg, appleId, enabled) {
  const { rows } = await pg.query(
    `UPDATE apps SET tracking_enabled = $2, updated_at = NOW() WHERE apple_id = $1
     RETURNING id, apple_id, name, tracking_enabled`,
    [appleId, enabled]
  );
  return rows[0] || null;
}

export async function getTrackedKeywords(pg) {
  const { rows } = await pg.query(
    `SELECT k.id, w.text AS keyword, s.code AS store, k.platform,
            k.query_count, k.last_queried_at, k.created_at
     FROM keywords k
     JOIN words w ON w.id = k.word_id
     JOIN storefronts s ON s.id = k.storefront_id
     WHERE k.tracking_enabled = TRUE
     ORDER BY k.created_at DESC`
  );
  return rows;
}

export async function getTrackedApps(pg) {
  const { rows } = await pg.query(
    `SELECT id, apple_id, bundle_id, name, developer, price, genre, created_at, updated_at
     FROM apps
     WHERE tracking_enabled = TRUE
     ORDER BY updated_at DESC`
  );
  return rows;
}

export async function getAppByAppleId(pg, appleId) {
  const { rows } = await pg.query(
    `SELECT id, apple_id, bundle_id, name, developer, price, genre, tracking_enabled
     FROM apps WHERE apple_id = $1`,
    [appleId]
  );
  return rows[0] || null;
}

/**
 * Resolve multiple apple_ids to app rows. Returns [{ id, apple_id }].
 */
export async function getAppsByAppleIds(pg, appleIds) {
  if (!appleIds?.length) return [];
  const { rows } = await pg.query(
    `SELECT id, apple_id FROM apps WHERE apple_id = ANY($1::text[])`,
    [appleIds]
  );
  return rows;
}

/**
 * Latest app_rating per app for given store/platform. Returns [{ app_id, rating, ratings_count, recorded_at }].
 * Uses LATERAL join for index-friendly per-app lookup instead of DISTINCT ON over the full set.
 */
export async function getLatestRatingsBulk(
  pg,
  appIds,
  store = "us",
  platform = "iphone"
) {
  if (!appIds?.length) return [];
  const { rows } = await pg.query(
    `SELECT lr.app_id, lr.rating, lr.ratings_count, lr.recorded_at
     FROM unnest($1::bigint[]) AS a(id)
     JOIN LATERAL (
       SELECT r.app_id, r.rating, r.ratings_count, r.recorded_at
       FROM app_ratings r
       WHERE r.app_id = a.id AND r.store = $2 AND r.platform = $3
       ORDER BY r.recorded_at DESC
       LIMIT 1
     ) lr ON true`,
    [appIds, store, platform]
  );
  return rows;
}

/**
 * Latest app_ranking per (app, keyword) for keywords in the given storefront; includes previous rank.
 * Returns [{ app_id, keyword_id, search_snapshot_id, keyword, current_rank, current_ranked_at, previous_rank }].
 *
 * Uses LATERAL joins to fetch only the 2 most recent rankings per (app, keyword) pair,
 * avoiding full-table window functions over all historical data.
 */
export async function getLatestRankingsByStoreBulk(
  pg,
  appIds,
  storeCode = "us",
  platform = "iphone"
) {
  if (!appIds?.length) return [];
  const { rows } = await pg.query(
    `SELECT latest.app_id,
            latest.keyword_id,
            latest.search_snapshot_id,
            w.text AS keyword,
            latest.rank AS current_rank,
            latest.ranked_at AS current_ranked_at,
            prev.rank AS previous_rank
     FROM unnest($3::bigint[]) AS a(id)
     CROSS JOIN LATERAL (
       SELECT DISTINCT ar.keyword_id
       FROM app_rankings ar
       JOIN keywords k ON k.id = ar.keyword_id
       JOIN storefronts s ON s.id = k.storefront_id
       WHERE ar.app_id = a.id AND s.code = $1 AND k.platform = $2
     ) kw
     JOIN LATERAL (
       SELECT ar.app_id, ar.keyword_id, ar.rank, ar.ranked_at, ar.search_snapshot_id
       FROM app_rankings ar
       WHERE ar.app_id = a.id AND ar.keyword_id = kw.keyword_id
       ORDER BY ar.ranked_at DESC
       LIMIT 1
     ) latest ON true
     LEFT JOIN LATERAL (
       SELECT ar.rank
       FROM app_rankings ar
       WHERE ar.app_id = a.id AND ar.keyword_id = kw.keyword_id
         AND ar.ranked_at < latest.ranked_at
       ORDER BY ar.ranked_at DESC
       LIMIT 1
     ) prev ON true
     JOIN keywords k ON k.id = latest.keyword_id
     JOIN words w ON w.id = k.word_id
     ORDER BY latest.app_id, latest.rank ASC`,
    [storeCode.toLowerCase(), platform, appIds]
  );
  return rows;
}

/**
 * For a batch of (keyword_id, snapshot_id, rank) tuples, returns the app at rank-1 and rank+1
 * within the same snapshot. Returns [{ keyword_id, original_rank, neighbor_rank, apple_id, name, developer, genre }].
 */
export async function getRankNeighborsBulk(pg, keywordIds, snapshotIds, ranks) {
  if (!keywordIds?.length) return [];
  const { rows } = await pg.query(
    `WITH input AS (
       SELECT unnest($1::bigint[])   AS keyword_id,
              unnest($2::bigint[])   AS snapshot_id,
              unnest($3::smallint[]) AS rank
     )
     SELECT i.keyword_id, i.rank AS original_rank,
            ar.rank AS neighbor_rank,
            a.apple_id, a.name, a.developer, a.genre, a.icon_url
     FROM input i
     JOIN app_rankings ar
       ON ar.keyword_id = i.keyword_id
      AND ar.search_snapshot_id = i.snapshot_id
      AND ar.rank IN (i.rank - 1, i.rank + 1)
     JOIN apps a ON a.id = ar.app_id`,
    [keywordIds, snapshotIds, ranks]
  );
  return rows;
}

export async function incrementKeywordDemand(pg, keywordId) {
  await pg.query(
    `UPDATE keywords
     SET query_count = query_count + 1, last_queried_at = NOW()
     WHERE id = $1`,
    [keywordId]
  );
}

export async function getTopDemandKeywords(pg, limit = 50) {
  const { rows } = await pg.query(
    `SELECT k.id, w.text AS keyword, s.code AS store, k.platform, k.query_count
     FROM keywords k
     JOIN words w ON w.id = k.word_id
     JOIN storefronts s ON s.id = k.storefront_id
     WHERE k.tracking_enabled = TRUE
     ORDER BY k.query_count DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const PERIOD_DAYS = {
  "7d": 7,
  "2w": 14,
  "1m": 30,
  "3m": 90,
  "6m": 180,
  "1y": 365,
  "2y": 730,
};

export function periodToDate(period) {
  const days = PERIOD_DAYS[period] ?? 7;
  return new Date(Date.now() - days * 86_400_000);
}

export const VALID_PERIODS = Object.keys(PERIOD_DAYS);
