import { fetchSessionBootstrap } from '../services/session-bootstrap';
import { getWalletSession } from '../services/wallet-session';

jest.mock('../services/wallet-session', () => ({
  getWalletSession: jest.fn(),
}));

describe('fetchSessionBootstrap', () => {
  const apiUrl = 'http://localhost:4000';

  beforeEach(() => {
    jest.resetAllMocks();
    global.fetch = jest.fn();
  });

  it('fetches authenticated data when wallet session exists', async () => {
    (getWalletSession as jest.Mock).mockResolvedValue({ publicKey: 'TEST_KEY' });
    
    const mockResponse = {
      metadata: { version: '1.0.0' },
      unreadCount: 5,
      featureFlags: { newFeature: true },
      accountContext: { publicKey: 'TEST_KEY' },
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await fetchSessionBootstrap(apiUrl);

    expect(global.fetch).toHaveBeenCalledWith(`${apiUrl}/session/bootstrap`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer TEST_KEY',
      },
    });
    expect(result).toEqual(mockResponse);
  });

  it('fetches guest data when wallet session does not exist', async () => {
    (getWalletSession as jest.Mock).mockResolvedValue(null);
    
    const mockResponse = {
      metadata: { version: '1.0.0' },
      unreadCount: 0,
      featureFlags: { newFeature: false },
      accountContext: null,
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await fetchSessionBootstrap(apiUrl);

    expect(global.fetch).toHaveBeenCalledWith(`${apiUrl}/session/bootstrap`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
    expect(result).toEqual(mockResponse);
  });

  it('throws an error on non-ok response when degraded mode is disabled', async () => {
    (getWalletSession as jest.Mock).mockResolvedValue(null);
    
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ message: 'Server error' }),
    });

    await expect(fetchSessionBootstrap(apiUrl, { allowDegraded: false })).rejects.toThrow('Server error');
  });

  it('falls back to degraded payload on non-ok response when allowDegraded is true', async () => {
    (getWalletSession as jest.Mock).mockResolvedValue({
      publicKey: 'GAMOSFOKEYHFDGMXIEFEYBUYK3ZMFYN3PFLOTBRXFGBFGRKBKLQSLGLP',
      network: 'testnet',
    });

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ message: 'Service Unavailable' }),
    });

    const result = await fetchSessionBootstrap(apiUrl, {
      allowDegraded: true,
      currentEnvironmentId: 'testnet',
    });

    expect(result.degraded).toBe(true);
    expect(result.unreadCount).toBe(0);
    expect(result.accountContext?.publicKey).toBe(
      'GAMOSFOKEYHFDGMXIEFEYBUYK3ZMFYN3PFLOTBRXFGBFGRKBKLQSLGLP',
    );
    expect(result.metadata.environment).toBe('testnet');
  });

  it('falls back to degraded payload on network fetch exception when allowDegraded is true', async () => {
    (getWalletSession as jest.Mock).mockResolvedValue(null);
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network request failed'));

    const result = await fetchSessionBootstrap(apiUrl, { allowDegraded: true });

    expect(result.degraded).toBe(true);
    expect(result.accountContext).toBeNull();
    expect(result.unreadCount).toBe(0);
  });
});

