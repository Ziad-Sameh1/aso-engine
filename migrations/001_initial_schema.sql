-- ============================================================
-- Migration 001: Initial ASO Engine Schema
-- ============================================================

BEGIN;

-- ── Storefronts ──────────────────────────────────────────────────────────────
CREATE TABLE storefronts (
    id         BIGSERIAL    PRIMARY KEY,
    code       VARCHAR(5)   NOT NULL,
    country    VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (code)
);

INSERT INTO storefronts (code, country) VALUES
    ('us', 'United States'),
    ('gb', 'United Kingdom'),
    ('ca', 'Canada'),
    ('au', 'Australia'),
    ('de', 'Germany'),
    ('fr', 'France'),
    ('jp', 'Japan'),
    ('kr', 'South Korea'),
    ('cn', 'China'),
    ('in', 'India'),
    ('br', 'Brazil'),
    ('mx', 'Mexico'),
    ('it', 'Italy'),
    ('es', 'Spain'),
    ('nl', 'Netherlands'),
    ('se', 'Sweden'),
    ('no', 'Norway'),
    ('dk', 'Denmark'),
    ('fi', 'Finland'),
    ('sa', 'Saudi Arabia'),
    ('ae', 'United Arab Emirates'),
    ('eg', 'Egypt'),
    ('ru', 'Russia'),
    ('tr', 'Turkey'),
    ('pl', 'Poland'),
    ('ar', 'Argentina'),
    ('cl', 'Chile'),
    ('co', 'Colombia'),
    ('th', 'Thailand'),
    ('id', 'Indonesia'),
    ('my', 'Malaysia'),
    ('sg', 'Singapore'),
    ('ph', 'Philippines'),
    ('pk', 'Pakistan'),
    ('ng', 'Nigeria'),
    ('za', 'South Africa')
ON CONFLICT (code) DO NOTHING;

-- ── Words ─────────────────────────────────────────────────────────────────────
-- A word represents a search term across all storefronts/platforms.
-- norm_text is the canonical lookup key (lowercase + trimmed).
CREATE TABLE words (
    id         BIGSERIAL    PRIMARY KEY,
    text       VARCHAR(500) NOT NULL,
    norm_text  VARCHAR(500) NOT NULL,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (norm_text)
);

-- ── Keywords ──────────────────────────────────────────────────────────────────
-- A keyword is the trackable unit: word + storefront + platform.
CREATE TABLE keywords (
    id               BIGSERIAL   PRIMARY KEY,
    word_id          BIGINT      NOT NULL REFERENCES words(id),
    storefront_id    BIGINT      NOT NULL REFERENCES storefronts(id),
    platform         VARCHAR(10) NOT NULL DEFAULT 'iphone',
    tracking_enabled BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (word_id, storefront_id, platform)
);

CREATE INDEX idx_keywords_word_id      ON keywords(word_id);
CREATE INDEX idx_keywords_storefront   ON keywords(storefront_id);
CREATE INDEX idx_keywords_tracking     ON keywords(tracking_enabled) WHERE tracking_enabled = TRUE;

-- ── Keyword Popularity ────────────────────────────────────────────────────────
CREATE TABLE keyword_popularity (
    id         BIGSERIAL   PRIMARY KEY,
    keyword_id BIGINT      NOT NULL REFERENCES keywords(id),
    popularity SMALLINT    NOT NULL CHECK (popularity BETWEEN 1 AND 100),
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_kp_keyword_latest ON keyword_popularity(keyword_id, fetched_at DESC);
CREATE INDEX idx_kp_keyword_time   ON keyword_popularity(keyword_id, fetched_at);

-- ── Keyword Competitiveness ───────────────────────────────────────────────────
CREATE TABLE keyword_competitiveness (
    id                BIGSERIAL   PRIMARY KEY,
    keyword_id        BIGINT      NOT NULL REFERENCES keywords(id),
    competitiveness   SMALLINT    NOT NULL CHECK (competitiveness BETWEEN 1 AND 100),
    fetched_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_kc_keyword_latest ON keyword_competitiveness(keyword_id, fetched_at DESC);
CREATE INDEX idx_kc_keyword_time   ON keyword_competitiveness(keyword_id, fetched_at);

-- ── Apps ──────────────────────────────────────────────────────────────────────
CREATE TABLE apps (
    id               BIGSERIAL    PRIMARY KEY,
    apple_id         VARCHAR(20)  NOT NULL,
    bundle_id        VARCHAR(500),
    name             VARCHAR(500),
    developer        VARCHAR(500),
    price            VARCHAR(50),
    genre            VARCHAR(200),
    tracking_enabled BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (apple_id)
);

CREATE INDEX idx_apps_bundle_id ON apps(bundle_id) WHERE bundle_id IS NOT NULL;
CREATE INDEX idx_apps_tracking  ON apps(tracking_enabled) WHERE tracking_enabled = TRUE;

-- ── Search Snapshots ──────────────────────────────────────────────────────────
-- One row per /api/search call that actually scraped (cache miss).
CREATE TABLE search_snapshots (
    id            BIGSERIAL   PRIMARY KEY,
    keyword_id    BIGINT      NOT NULL REFERENCES keywords(id),
    total_results INT         NOT NULL DEFAULT 0,
    snapshot_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw_response  JSONB
);

CREATE INDEX idx_ss_keyword_latest ON search_snapshots(keyword_id, snapshot_at DESC);

-- ── App Rankings ──────────────────────────────────────────────────────────────
CREATE TABLE app_rankings (
    id                 BIGSERIAL   PRIMARY KEY,
    keyword_id         BIGINT      NOT NULL REFERENCES keywords(id),
    app_id             BIGINT      NOT NULL REFERENCES apps(id),
    rank               SMALLINT    NOT NULL CHECK (rank BETWEEN 1 AND 200),
    search_snapshot_id BIGINT      REFERENCES search_snapshots(id),
    ranked_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Latest search results for a keyword
CREATE INDEX idx_ar_keyword_latest     ON app_rankings(keyword_id, ranked_at DESC);
-- App rank for a specific keyword over time
CREATE INDEX idx_ar_app_keyword_time   ON app_rankings(app_id, keyword_id, ranked_at DESC);
-- All keywords an app ranks for
CREATE INDEX idx_ar_app_latest         ON app_rankings(app_id, ranked_at DESC);
-- Top movers analysis (index-only scan covers rank comparison)
CREATE INDEX idx_ar_keyword_app_rank   ON app_rankings(keyword_id, app_id, ranked_at DESC, rank);
-- Snapshot-based lookups
CREATE INDEX idx_ar_snapshot           ON app_rankings(search_snapshot_id);

-- ── App Ratings ───────────────────────────────────────────────────────────────
CREATE TABLE app_ratings (
    id                 BIGSERIAL    PRIMARY KEY,
    app_id             BIGINT       NOT NULL REFERENCES apps(id),
    rating             NUMERIC(3,2),
    ratings_count      INT,
    search_snapshot_id BIGINT       REFERENCES search_snapshots(id),
    recorded_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ratings_app_latest ON app_ratings(app_id, recorded_at DESC);
CREATE INDEX idx_ratings_app_time   ON app_ratings(app_id, recorded_at);

COMMIT;
