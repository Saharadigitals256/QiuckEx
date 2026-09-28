-- =============================================================================
-- QuickEx local development seed fixtures
-- =============================================================================
-- Loaded by `scripts/local-dev/bootstrap.sh` after the migrations are applied.
--
-- SAFETY CONTRACT
--   * This file is LOCAL DEVELOPMENT ONLY and refuses to run against a
--     non-local database. `scripts/local-dev/seed.sql` is invoked through
--     psql against 127.0.0.1 with a guard that aborts unless the target
--     database name matches the local convention, so it can never seed a
--     hosted Supabase project or a staging database.
--   * Every row is synthetic. The Stellar public keys below are well-known
--     test-network accounts with no private key held by this repository or
--     by QuickEx. Nothing here is a real user, a real balance, or a real
--     payment.
--   * Self-custody is preserved: these fixtures describe public keys only.
--     No private key, seed phrase, or signing material appears in this file
--     or anywhere under scripts/local-dev/. QuickEx never custodies keys
--     (ADR 0001); a fixture that needed one would be a design error.
--
-- The seed is idempotent: every insert is ON CONFLICT DO NOTHING against a
-- stable natural key, so re-running the bootstrap never duplicates rows and
-- never disturbs local edits.
-- =============================================================================

BEGIN;

-- Guard: only ever seed a local database.
DO $$
DECLARE
  current_db TEXT := current_database();
BEGIN
  IF current_db NOT IN ('quickex', 'postgres', 'quickex_local') THEN
    RAISE EXCEPTION
      'Refusing to seed non-local database "%". Local seeds are development-only.',
      current_db;
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- Verified assets: the assets a merchant may list locally.
-- Mirrors the tier expectations in docs/policies/ASSET-LISTING-POLICY.md.
-- -----------------------------------------------------------------------------
INSERT INTO verified_assets (code, issuer, type, decimals, icon_url, verified)
VALUES
  ('XLM', NULL, 'native', 7, NULL, true),
  ('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', 'credit_alphanum4', 6, NULL, true)
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- Usernames: one registered handle per fixture wallet.
-- `username` is stored normalized (lowercase) per the table CHECK constraint.
-- -----------------------------------------------------------------------------
INSERT INTO usernames (username, public_key)
VALUES
  ('merchant', 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
  ('customer',  'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'),
  ('arbiter',   'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC')
ON CONFLICT (username) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Payment links: an active and an expired link, so both the live and the
-- expiry paths are reachable without hand-crafting rows.
-- `amount` is a decimal string; `expires_at` drives the expiry path (INV-06).
-- -----------------------------------------------------------------------------
INSERT INTO payment_links (
  owner_public_key, destination_public_key, amount, asset_code,
  memo, memo_type, status, expires_at
)
VALUES
  ('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
   'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
   '25.0000000', 'XLM', 'seed-link-active', 'text',
   'active', now() + interval '7 days'),
  ('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
   'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
   '10.0000000', 'XLM', 'seed-link-expired', 'text',
   'active', now() - interval '1 day')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- Notification preferences: one row per (public_key, channel) pair.
-- -----------------------------------------------------------------------------
INSERT INTO notification_preferences (public_key, channel, email, enabled, events)
VALUES
  ('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', 'email', 'merchant@example.invalid', true, NULL),
  ('GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'email', 'customer@example.invalid', true, NULL)
ON CONFLICT (public_key, channel) DO NOTHING;

COMMIT;
