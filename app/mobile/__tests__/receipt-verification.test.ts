import {
  verifyReceiptAgainstApi,
  ReceiptVerificationError,
  NativeReceiptVerificationResult,
} from '../services/receipts';
import { mockReceiptSuccess } from '../src/data/mockReceipt';

const activeReceipt = {
  ...mockReceiptSuccess,
  metadata: {
    ...mockReceiptSuccess.metadata,
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  },
};

describe('ReceiptVerificationService (#270)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('successfully verifies a valid receipt against the receipts API (happy path)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        computedHash: 'rch_abc123',
        providedHash: 'rch_abc123',
      }),
    });

    const result = await verifyReceiptAgainstApi({
      receipt: activeReceipt,
    });

    expect(result.verified).toBe(true);
    expect(result.status).toBe('valid');
    expect(result.metrics.status).toBe('success');
    expect(result.metrics.network).toBe('testnet');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired receipt with stable EXPIRED error', async () => {
    const expiredReceipt = {
      ...mockReceiptSuccess,
      metadata: {
        ...mockReceiptSuccess.metadata,
        expiresAt: new Date(Date.now() - 100000).toISOString(),
      },
    };

    const result = await verifyReceiptAgainstApi({
      receipt: expiredReceipt,
    });

    expect(result.verified).toBe(false);
    expect(result.status).toBe('invalid');
    expect(result.error?.code).toBe('EXPIRED');
    expect(result.metrics.errorCode).toBe('EXPIRED');
  });

  it('rejects malformed receipts with invalid amount or missing metadata', async () => {
    const malformedReceipt = {
      ...activeReceipt,
      amount: 'not-a-number',
    };

    const result = await verifyReceiptAgainstApi({
      receipt: malformedReceipt,
    });

    expect(result.verified).toBe(false);
    expect(result.error?.code).toBe('MALFORMED');
  });

  it('handles unauthorized (401/403) responses with stable UNAUTHORIZED error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Invalid API key' }),
    });

    const result = await verifyReceiptAgainstApi({
      receipt: activeReceipt,
      allowDegradedOffline: false,
    });

    expect(result.verified).toBe(false);
    expect(result.error?.code).toBe('UNAUTHORIZED');
  });

  it('handles duplicate conflict (409) with stable DUPLICATE error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: 'Receipt conflict' }),
    });

    const result = await verifyReceiptAgainstApi({
      receipt: activeReceipt,
      allowDegradedOffline: false,
    });

    expect(result.verified).toBe(false);
    expect(result.error?.code).toBe('DUPLICATE');
  });

  it('retries on dependency failure (500) and recovers on retry', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: async () => ({ message: 'Service Unavailable' }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ valid: true, computedHash: 'rch_abc123' }),
      });
    });

    const result = await verifyReceiptAgainstApi({
      receipt: activeReceipt,
      maxRetries: 2,
    });

    expect(result.verified).toBe(true);
    expect(callCount).toBe(2);
    expect(result.metrics.retries).toBe(1);
    expect(result.metrics.status).toBe('success');
  });

  it('falls back to degraded mode on network failure when allowDegradedOffline is true', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Failed to connect to host'));

    const result = await verifyReceiptAgainstApi({
      receipt: activeReceipt,
      maxRetries: 1,
      allowDegradedOffline: true,
    });

    expect(result.verified).toBe(true);
    expect(result.degradedMode).toBe(true);
    expect(result.metrics.status).toBe('degraded');
  });

  it('fails cleanly without degraded mode when allowDegradedOffline is false', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network offline'));

    const result = await verifyReceiptAgainstApi({
      receipt: activeReceipt,
      maxRetries: 1,
      allowDegradedOffline: false,
    });

    expect(result.verified).toBe(false);
    expect(result.degradedMode).toBeUndefined();
    expect(result.error?.code).toBe('NETWORK_ERROR');
  });
});
