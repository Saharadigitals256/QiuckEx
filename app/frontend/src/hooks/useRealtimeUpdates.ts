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

class MockWebSocket {
  private listeners: ((update: BidUpdate) => void)[] = [];
  private subscribedListings: Set<string> = new Set();
  private intervalId: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnected = false;
  private reconnectBackoffMs = 1000;
  private maxReconnectBackoffMs = 15000;
  private lastEventAt = 0;

  connect() {
    this.isConnected = true;
    this.reconnectBackoffMs = 1000;
    console.log('🔌 Connected to marketplace WebSocket');

    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    this.intervalId = setInterval(() => {
      if (this.subscribedListings.size > 0 && Math.random() < 0.3) {
        this.simulateBidUpdate();
      }
    }, 5000);
  }

  disconnect() {
    this.isConnected = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    console.log('🔌 Disconnected from marketplace WebSocket');
    this.scheduleReconnect();
  }

  subscribe(listingId: string) {
    this.subscribedListings.add(listingId);
  }

  unsubscribe(listingId: string) {
    this.subscribedListings.delete(listingId);
  }

  onBidUpdate(callback: (update: BidUpdate) => void) {
    this.listeners.push(callback);
    return () => {
      const index = this.listeners.indexOf(callback);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
      this.reconnectBackoffMs = Math.min(this.reconnectBackoffMs * 2, this.maxReconnectBackoffMs);
    }, this.reconnectBackoffMs);
  }

  private simulateBidUpdate() {
    const subscribedArray = Array.from(this.subscribedListings);
    if (subscribedArray.length === 0) return;

    const randomListingId = subscribedArray[Math.floor(Math.random() * subscribedArray.length)];
    const baseIncrease = Math.floor(Math.random() * 100) + 50;
    const newBid = Math.floor(Math.random() * 5000) + 1000 + baseIncrease;
    const timestamp = new Date();

    const update: BidUpdate = {
      listingId: randomListingId,
      username: `user${Math.floor(Math.random() * 1000)}`,
      newBid,
      bidderAddress: `G${Math.random().toString(36).substring(2, 15).toUpperCase()}...${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      timestamp,
    };

    if (timestamp.getTime() <= this.lastEventAt) {
      update.timestamp = new Date(this.lastEventAt + 1);
    }
    this.lastEventAt = update.timestamp.getTime();

    this.listeners.forEach((listener) => listener(update));
  }

  get connectionStatus() {
    return this.isConnected;
  }
}

const mockWebSocket = new MockWebSocket();

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
    return mockWebSocket.onBidUpdate((update) => {
      setLastUpdate((previous) => {
        if (!previous || update.timestamp.getTime() >= previous.getTime()) {
          return update.timestamp;
        }
        return previous;
      });
      callback(update);
    });
  }, []);

  return {
    isConnected,
    lastUpdate,
    subscribeToListing,
    unsubscribeFromListing,
    onBidUpdate,
  };
}

export type { BidUpdate };