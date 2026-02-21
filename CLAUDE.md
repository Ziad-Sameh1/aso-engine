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

- **BullMQ** and **node-cron** are installed but not yet wired up — intended for background job scheduling (ranking updates, etc.)
- **PostgreSQL** and **Redis** are hosted externally (Coolify). Connection strings come from env vars.
- **`migrations/`**: Directory exists but is empty — schema migrations go here.

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
