-- Migration 003: Add demand tracking columns to keywords

BEGIN;

ALTER TABLE keywords
  ADD COLUMN query_count     INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN last_queried_at TIMESTAMPTZ;

-- Used by Worker 3 to find the most-demanded keywords for pop/comp updates
CREATE INDEX idx_keywords_demand ON keywords(query_count DESC)
  WHERE tracking_enabled = TRUE;

COMMIT;
