BEGIN;

CREATE TABLE cold_email_leads (
  id                SERIAL PRIMARY KEY,
  apple_id          TEXT NOT NULL,
  store_url         TEXT NOT NULL,
  app_name          TEXT,
  category          TEXT,
  icon_url          TEXT,
  seller_email      TEXT,
  claim_url         TEXT NOT NULL,
  claim_token       TEXT NOT NULL,
  claim_expires_at  TIMESTAMPTZ NOT NULL,
  shiplift_app_id   INTEGER NOT NULL,
  keywords_discovered JSONB,
  utm_source        TEXT,
  utm_campaign      TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ
);

CREATE UNIQUE INDEX uq_cold_email_leads_apple_id ON cold_email_leads (apple_id);
CREATE INDEX idx_cold_email_leads_status ON cold_email_leads (status);

COMMIT;
