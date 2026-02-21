-- Migration 002: Add store + platform to app_ratings
-- Ratings differ by storefront and platform (e.g. iPhone vs iPad).

BEGIN;

ALTER TABLE app_ratings
  ADD COLUMN store    VARCHAR(5)  NOT NULL DEFAULT 'us',
  ADD COLUMN platform VARCHAR(10) NOT NULL DEFAULT 'iphone';

-- Drop old indexes and recreate with store+platform
DROP INDEX IF EXISTS idx_ratings_app_latest;
DROP INDEX IF EXISTS idx_ratings_app_time;

CREATE INDEX idx_ratings_app_latest ON app_ratings(app_id, store, platform, recorded_at DESC);
CREATE INDEX idx_ratings_app_time   ON app_ratings(app_id, store, platform, recorded_at);

COMMIT;
