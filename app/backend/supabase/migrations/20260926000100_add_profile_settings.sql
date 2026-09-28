ALTER TABLE usernames
  ADD COLUMN IF NOT EXISTS profile_primary_color TEXT NOT NULL DEFAULT '#6366f1',
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS twitter_handle TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS discord_handle TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS github_handle TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS profile_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE usernames
  ADD CONSTRAINT usernames_profile_color_format
    CHECK (profile_primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  ADD CONSTRAINT usernames_profile_bio_length
    CHECK (char_length(bio) <= 160),
  ADD CONSTRAINT usernames_profile_version_positive
    CHECK (profile_version > 0);