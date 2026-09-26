import { describe, expect, it, vi } from 'vitest';
import {
  cacheInvalidator,
  notifyLinkCreated,
  notifyPaymentCompleted,
} from './cacheInvalidation';

describe('cacheInvalidation', () => {
  it('notifies subscribers when notifyLinkCreated is called', () => {
    const listener = vi.fn();
    const unsubscribe = cacheInvalidator.subscribe(listener);

    notifyLinkCreated({ linkId: 'link-123', username: 'alice' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'link_created',
        payload: { linkId: 'link-123', username: 'alice' },
      }),
    );

    unsubscribe();
  });

  it('notifies subscribers when notifyPaymentCompleted is called', () => {
    const listener = vi.fn();
    const unsubscribe = cacheInvalidator.subscribe(listener);

    notifyPaymentCompleted({
      txHash: '0xabc123',
      username: 'bob',
      amount: '50',
      asset: 'USDC',
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'payment_completed',
        payload: {
          txHash: '0xabc123',
          username: 'bob',
          amount: '50',
          asset: 'USDC',
        },
      }),
    );

    unsubscribe();
  });

  it('correctly tracks the last invalidation timestamp', () => {
    const before = Date.now();
    cacheInvalidator.invalidate('activity_feed_cleared');
    const after = Date.now();

    const timestamp = cacheInvalidator.getLastInvalidationTime('activity_feed_cleared');
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('unsubscribes cleanly', () => {
    const listener = vi.fn();
    const unsubscribe = cacheInvalidator.subscribe(listener);
    unsubscribe();

    notifyLinkCreated();
    expect(listener).not.toHaveBeenCalled();
  });
});
