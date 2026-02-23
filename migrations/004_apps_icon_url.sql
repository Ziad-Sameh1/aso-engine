-- Add icon_url to apps table (populated from iTunes artworkUrl512)
ALTER TABLE apps ADD COLUMN IF NOT EXISTS icon_url TEXT;
