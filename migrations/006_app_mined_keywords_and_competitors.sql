-- Migration 006: App mined keywords dictionary + competitors
-- Persists keywords and competitor apps discovered during /mine

-- ── App Mined Keywords (the "dictionary") ────────────────────────────────────
-- Each row links an app to a keyword it was mined for in a specific store.
-- On re-mine, only new keywords are inserted (existing rows untouched).
CREATE TABLE IF NOT EXISTS app_mined_keywords (
  id            BIGSERIAL   PRIMARY KEY,
  app_id        BIGINT      NOT NULL REFERENCES apps(id),
  storefront_id BIGINT      NOT NULL REFERENCES storefronts(id),
  word_id       BIGINT      NOT NULL REFERENCES words(id),
  frequency     INT         NOT NULL DEFAULT 1,
  mined_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, storefront_id, word_id)
);

CREATE INDEX idx_app_mined_keywords_app_store
  ON app_mined_keywords (app_id, storefront_id);

-- ── App Competitors ──────────────────────────────────────────────────────────
-- Stores top 100 competitor apple_ids per app per store from /mine results.
-- Replaced on each mine run (full refresh per app+store).
CREATE TABLE IF NOT EXISTS app_competitors (
  id                BIGSERIAL   PRIMARY KEY,
  app_id            BIGINT      NOT NULL REFERENCES apps(id),
  competitor_app_id BIGINT      NOT NULL REFERENCES apps(id),
  storefront_id     BIGINT      NOT NULL REFERENCES storefronts(id),
  rank              SMALLINT    NOT NULL CHECK (rank BETWEEN 1 AND 100),
  appearance_count  INT         NOT NULL DEFAULT 0,
  mined_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, storefront_id, competitor_app_id)
);

CREATE INDEX idx_app_competitors_app_store
  ON app_competitors (app_id, storefront_id, rank);
