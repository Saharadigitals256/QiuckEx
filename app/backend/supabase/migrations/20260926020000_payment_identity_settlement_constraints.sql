-- Enforce backend-side payment identity and settlement invariants when the
-- payment table is present in the Supabase baseline.
DO $$
DECLARE
  identity_column text;
BEGIN
  IF to_regclass('public.payment_records') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payment_records'
      AND column_name = 'stellar_tx_hash'
  ) THEN
    identity_column := 'stellar_tx_hash';
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payment_records'
      AND column_name = 'tx_hash'
  ) THEN
    identity_column := 'tx_hash';
  END IF;

  IF identity_column IS NOT NULL THEN
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS payment_records_%I_unique_idx ON public.payment_records (%I) WHERE %I IS NOT NULL',
      identity_column, identity_column, identity_column
    );

    EXECUTE format($fn$
      CREATE OR REPLACE FUNCTION public.prevent_payment_identity_update()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF OLD.%I IS DISTINCT FROM NEW.%I THEN
          RAISE EXCEPTION 'transaction identity is immutable';
        END IF;
        RETURN NEW;
      END;
      $body$;
    $fn$, identity_column, identity_column);

    EXECUTE 'DROP TRIGGER IF EXISTS payment_records_identity_immutable ON public.payment_records';
    EXECUTE 'CREATE TRIGGER payment_records_identity_immutable BEFORE UPDATE ON public.payment_records FOR EACH ROW EXECUTE FUNCTION public.prevent_payment_identity_update()';
  END IF;

  ALTER TABLE public.payment_records
    ADD COLUMN IF NOT EXISTS settlement_state text NOT NULL DEFAULT 'pending';

  ALTER TABLE public.payment_records
    DROP CONSTRAINT IF EXISTS payment_records_settlement_state_check;
  ALTER TABLE public.payment_records
    ADD CONSTRAINT payment_records_settlement_state_check
    CHECK (settlement_state IN ('pending', 'settled', 'refunded', 'disputed', 'failed'));

  CREATE OR REPLACE FUNCTION public.enforce_payment_settlement_state()
  RETURNS trigger LANGUAGE plpgsql AS $state$
  BEGIN
    IF OLD.settlement_state IN ('settled', 'refunded', 'failed')
       AND NEW.settlement_state IS DISTINCT FROM OLD.settlement_state THEN
      RAISE EXCEPTION 'terminal settlement state is immutable';
    END IF;
    RETURN NEW;
  END;
  $state$;

  DROP TRIGGER IF EXISTS payment_records_settlement_state_immutable ON public.payment_records;
  CREATE TRIGGER payment_records_settlement_state_immutable
    BEFORE UPDATE ON public.payment_records
    FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_settlement_state();

  COMMENT ON COLUMN public.payment_records.settlement_state IS
    'Monotonic backend settlement state; terminal states cannot be changed by application updates.';
END $$;