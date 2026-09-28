-- Governance capabilities: asset listing policy (issue #306) and privacy
-- retention/deletion (issue #307).
--
-- Asset listing: adds policy status columns to the existing registry and the
-- append-only decision + evidence tables required by
-- docs/policies/ASSET-LISTING-POLICY.md.
-- Privacy: adds the deletion-request trail required by
-- docs/policies/DATA-RETENTION-PRIVACY-POLICY.md (salted subject hash only).

-- ── Asset listing policy ────────────────────────────────────────────────────

ALTER TABLE verified_assets
  ADD COLUMN IF NOT EXISTS listing_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS listing_tier VARCHAR(20),
  ADD COLUMN IF NOT EXISTS delisted_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP WITH TIME ZONE;

-- Backfill: rows verified under the pre-policy model enter as 'listed';
-- explicitly unverified rows are treated as 'rejected' (never served).
UPDATE verified_assets
   SET listing_status = CASE WHEN verified THEN 'listed' ELSE 'rejected' END
 WHERE listing_status = 'pending';

-- Tier seeding follows the published policy (docs/policies/data/asset-listing-policy.json).
UPDATE verified_assets SET listing_tier = 'native'   WHERE issuer IS NULL AND listing_tier IS NULL;
UPDATE verified_assets SET listing_tier = 'verified' WHERE code IN ('USDC', 'AQUA') AND listing_tier IS NULL;
UPDATE verified_assets SET listing_tier = 'community' WHERE code = 'yXLM' AND listing_tier IS NULL;
UPDATE verified_assets SET listing_tier = 'unlisted' WHERE listing_tier IS NULL;

-- Evidence grace seeding: rows verified under the pre-policy model get one
-- grace period per required evidence kind so enforcement starts as a *review*
-- deadline, not an instant delisting. Renewal (or suspension) follows the
-- documented max ages; grace expiry is evaluated at read time.
INSERT INTO asset_listing_evidence (asset_key, kind, expires_at, evidence_ref)
SELECT CASE WHEN a.issuer IS NULL THEN a.code ELSE a.code || ':' || a.issuer END,
       k.kind,
       CASE k.kind
         WHEN 'toml_document'          THEN now() + interval '92 days'
         WHEN 'attestation_of_reserve' THEN now() + interval '92 days'
         WHEN 'issuer_identity'        THEN now() + interval '365 days'
         WHEN 'sanctions_screen'       THEN now() + interval '365 days'
         WHEN 'security_review'        THEN now() + interval '730 days'
       END,
       'migration:pre-policy-grace'
FROM verified_assets a
JOIN (VALUES ('toml_document'), ('attestation_of_reserve'), ('issuer_identity'),
             ('sanctions_screen'), ('security_review')) AS k(kind)
  ON a.listing_tier IN ('verified', 'community')
ON CONFLICT (asset_key, kind) DO NOTHING;

-- Only the kinds required for the asset's tier may exist for the seeded grace.
DELETE FROM asset_listing_evidence e
 USING verified_assets a
 WHERE e.evidence_ref = 'migration:pre-policy-grace'
   AND e.asset_key = CASE WHEN a.issuer IS NULL THEN a.code ELSE a.code || ':' || a.issuer END
   AND (
     (a.listing_tier = 'community' AND e.kind <> 'toml_document')
     OR (a.listing_tier IN ('native', 'unlisted'))
   );


CREATE INDEX IF NOT EXISTS idx_verified_assets_listing_status
  ON verified_assets (listing_status);

CREATE TABLE IF NOT EXISTS asset_listing_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_key VARCHAR(70) NOT NULL, -- CODE or CODE:ISSUER
  kind VARCHAR(40) NOT NULL,      -- toml_document | attestation_of_reserve | ...
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  evidence_ref VARCHAR(120),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  UNIQUE (asset_key, kind)
);

CREATE INDEX IF NOT EXISTS idx_asset_listing_evidence_expiry
  ON asset_listing_evidence (expires_at);

CREATE TABLE IF NOT EXISTS asset_listing_decisions (
  id UUID PRIMARY KEY,
  idempotency_key VARCHAR(120) NOT NULL UNIQUE,
  asset_key VARCHAR(70) NOT NULL,
  action VARCHAR(20) NOT NULL,       -- list | reject | suspend | delist
  from_status VARCHAR(20) NOT NULL,
  to_status VARCHAR(20) NOT NULL,
  trigger VARCHAR(40),
  evidence_ref VARCHAR(120),
  actor VARCHAR(120) NOT NULL,
  reasons TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_asset_listing_decisions_asset
  ON asset_listing_decisions (asset_key, created_at DESC);

-- ── Privacy retention & deletion requests ──────────────────────────────────

CREATE TABLE IF NOT EXISTS privacy_deletion_challenges (
  id UUID PRIMARY KEY,
  subject_hash VARCHAR(80) NOT NULL,
  subject_kind VARCHAR(20) NOT NULL,
  public_key VARCHAR(56) NOT NULL,
  purpose VARCHAR(80) NOT NULL,
  issued_at TIMESTAMP WITH TIME ZONE NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  consumed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_privacy_deletion_challenges_expiry
  ON privacy_deletion_challenges (expires_at);

CREATE TABLE IF NOT EXISTS privacy_deletion_requests (
  id UUID PRIMARY KEY,
  idempotency_key VARCHAR(120) NOT NULL UNIQUE,
  payload_fingerprint VARCHAR(80) NOT NULL DEFAULT '',
  -- Salted hash of the verified subject reference; the raw public key is never stored here.
  subject_hash VARCHAR(80) NOT NULL,
  subject_kind VARCHAR(20) NOT NULL, -- public_key | username
  status VARCHAR(20) NOT NULL,       -- pending | executing | completed | cancelled
  cooling_off_ends_at TIMESTAMP WITH TIME ZONE NOT NULL,
  execute_by TIMESTAMP WITH TIME ZONE NOT NULL,
  cancelled_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  last_error VARCHAR(80),
  outcomes JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_privacy_deletion_requests_created
  ON privacy_deletion_requests (created_at DESC);

-- At most one live request per subject (pending/executing); completed and
-- cancelled rows remain for the 730-day compliance trail.
CREATE UNIQUE INDEX IF NOT EXISTS idx_privacy_deletion_requests_live_subject
  ON privacy_deletion_requests (subject_hash)
  WHERE status IN ('pending', 'executing');
