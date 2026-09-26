CREATE OR REPLACE FUNCTION enforce_marketplace_active_listing_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_count INTEGER;
BEGIN
  IF NEW.status = 'active' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('marketplace-seller:' || NEW.seller_public_key, 0));
    SELECT count(*) INTO active_count
      FROM username_marketplace
     WHERE seller_public_key = NEW.seller_public_key
       AND status = 'active'
       AND id IS DISTINCT FROM NEW.id;
    IF active_count >= 5 THEN
      RAISE EXCEPTION 'MARKETPLACE_ACTIVE_LISTING_LIMIT: seller has reached the active listing limit'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS username_marketplace_active_limit ON username_marketplace;
CREATE TRIGGER username_marketplace_active_limit
  BEFORE INSERT OR UPDATE OF status ON username_marketplace
  FOR EACH ROW EXECUTE FUNCTION enforce_marketplace_active_listing_limit();

CREATE OR REPLACE FUNCTION enforce_marketplace_pending_bid_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  pending_count INTEGER;
BEGIN
  IF NEW.status = 'pending' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('marketplace-bid:' || NEW.listing_id::TEXT || ':' || NEW.bidder_public_key, 0));
    SELECT count(*) INTO pending_count
      FROM username_bids
     WHERE listing_id = NEW.listing_id
       AND bidder_public_key = NEW.bidder_public_key
       AND status = 'pending'
       AND id IS DISTINCT FROM NEW.id;
    IF pending_count >= 5 THEN
      RAISE EXCEPTION 'MARKETPLACE_PENDING_BID_LIMIT: bidder has reached the pending bid limit'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS username_bids_pending_limit ON username_bids;
CREATE TRIGGER username_bids_pending_limit
  BEFORE INSERT OR UPDATE OF status ON username_bids
  FOR EACH ROW EXECUTE FUNCTION enforce_marketplace_pending_bid_limit();