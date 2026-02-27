# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Start development server (with auto-reload)
npm run dev

# Start production server
npm start

# Run Python scraper
python3 appstore_search_rankings.py "search term" [--country us] [--platform iphone] [--top 50] [--format table|json|csv] [--no-resolve]

# Check server health
curl http://localhost:3000/api/health
```

## Architecture

**ASO Engine** is a Fastify (Node.js) API server for App Store Optimization, paired with a standalone Python scraper for Apple App Store search rankings.

### Node.js Server (`src/`)

- **Framework**: Fastify v5 with ES modules (`"type": "module"`)
- **`src/server.js`**: Entry point. Registers plugins (CORS, rate-limit, postgres, redis) and defines routes. Rate limited to 100 req/min.
- **`src/config/index.js`**: Centralizes all env var access — import `config` from here rather than reading `process.env` directly.
- **`src/plugins/postgres.js`**: Registers a `pg.Pool` (max 20 connections) as `fastify.pg`. Uses `fastify-plugin` so it's available globally.
- **`src/plugins/redis.js`**: Registers an `ioredis` client as `fastify.redis`. Uses lazy connect with exponential backoff — startup does NOT fail if Redis is unavailable.
- **`src/services/cache.js`**: `CacheService` wraps Redis with `get`/`set`/`invalidate(pattern)` methods. Handles JSON serialization. Instantiate with `new CacheService(fastify.redis)`.

### Infrastructure

- **PostgreSQL** and **Redis** are hosted externally (Coolify). Connection strings come from env vars.
- **`migrations/`**: SQL migration files (001–004) defining storefronts, words, keywords, apps, search_snapshots, app_rankings, app_ratings, keyword_popularity, keyword_competitiveness tables.

### Python Scraper (`appstore_search_rankings.py`)

Standalone script using only Python stdlib. Fetches Apple App Store SSR HTML to extract exact search ranking order, then optionally resolves metadata via the iTunes Lookup API (batches of 150 IDs, 0.5s delay between batches). This file is currently untracked in git.

### Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `PORT` | Server port (default: 3000) |
| `HOST` | Bind address (default: 0.0.0.0) |
| `CACHE_TTL_SEARCH` | Search result cache TTL in seconds (default: 3600) |
| `CACHE_TTL_POPULARITY` | Popularity score cache TTL in seconds (default: 86400) |
| `ASO_API_KEY` | External ASO data provider key (not yet used) |
| `ASO_API_BASE_URL` | External ASO data provider base URL (not yet used) |

### Docker

```bash
docker build -t aso-engine .
docker run -p 3000:3000 -e DATABASE_URL="..." -e REDIS_URL="..." aso-engine
```

Health check is built into the Dockerfile: `GET /api/health` must return 200.

### Workers (`src/workers/`)

BullMQ workers with node-cron scheduling:
- **Keyword Rankings Worker** (hourly): Refreshes rankings for all tracked keywords via `runSearch()` with `skipCache: true`
- **App Ratings Worker** (daily 03:00 UTC): Fetches fresh ratings for tracked apps, inserts if changed, busts cache
- **Popularity Worker** (daily 04:00 UTC): Updates popularity scores for top N most-demanded keywords

Workers run sequentially (concurrency: 1) with configurable delays between items to respect Apple rate limits.

### Key Services (`src/services/`)

- **`searchService.js`**: Central orchestrator — scrapes App Store, upserts DB records, calculates popularity/competitiveness, caches response
- **`appstore.js`**: Apple App Store HTML scraping + iTunes Lookup API batching (150 IDs/batch, 500ms delay)
- **`popularity.js`**: Scores keywords 5-100 using prefix depth in Apple Suggest (80%), position (15%), and Apple Ads bonus (+5)
- **`competitiveness.js`**: Scores keywords 5-100 from top-10 apps' review counts (70%), ratings (20%), result density (10%)
- **`suggestionService.js`**: Gemini Flash 2.5 generates 20 three-word keywords → parallel search → return with metrics
- **`discoveryService.js`**: Token extraction + 2-word permutation testing to find keywords an app actually ranks for
- **`db.js`**: All PostgreSQL queries; uses LATERAL joins for efficient "latest N per group" queries and `unnest()` for bulk inserts
- **`cache.js`**: Redis wrapper with `get`/`set`/`invalidate(pattern)`
