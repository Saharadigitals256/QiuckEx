"use client";

import { useState, useEffect, useCallback } from 'react';
import { fetchListingDetail } from './marketplaceApi';

type BidUpdate = {
  listingId: string;
  username: string;
  newBid: number;
  bidderAddress: string;
  timestamp: Date;
};

type RealtimeUpdatesHook = {
  isConnected: boolean;
  lastUpdate: Date | null;
  subscribeToListing: (listingId: string) => void;
  unsubscribeFromListing: (listingId: string) => void;
  onBidUpdate: (callback: (update: BidUpdate) => void) => () => void;
};

export function useRealtimeUpdates(): RealtimeUpdatesHook {
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [subscriptions, setSubscriptions] = useState<Set<string>>(new Set());
  const [listeners, setListeners] = useState<((update: BidUpdate) => void)[]>([]);

  useEffect(() => {
    if (subscriptions.size === 0) return;
    let cancelled = false;
    const poll = async () => {
      for (const listingId of subscriptions) {
        const detail = await fetchListingDetail(listingId).catch(() => null);
        if (cancelled || !detail) continue;
        const latest = detail.bids[0];
        if (!latest) continue;
        const update: BidUpdate = {
          listingId,
          username: detail.listing.username,
          newBid: Number(latest.bid_amount),
          bidderAddress: latest.bidder_public_key,
          timestamp: new Date(latest.created_at),
        };
        setLastUpdate(update.timestamp);
        listeners.forEach((listener) => listener(update));
      }
      if (!cancelled) setIsConnected(true);
    };
    void poll();
    const interval = setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [listeners, subscriptions]);

  const subscribeToListing = useCallback((listingId: string) => {
    setSubscriptions((current) => new Set(current).add(listingId));
  }, []);

  const unsubscribeFromListing = useCallback((listingId: string) => {
    setSubscriptions((current) => {
      const next = new Set(current);
      next.delete(listingId);
      return next;
    });
  }, []);

  const onBidUpdate = useCallback((callback: (update: BidUpdate) => void) => {
    setListeners((current) => [...current, callback]);
    return () => setListeners((current) => current.filter((listener) => listener !== callback));
  }, []);

  return {
    isConnected,
    lastUpdate,
    subscribeToListing,
    unsubscribeFromListing,
    onBidUpdate
  };
}

export type { BidUpdate };