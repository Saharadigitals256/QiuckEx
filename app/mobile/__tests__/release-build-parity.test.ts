import appConfig from '../app.config';
import {
  validateClientParityInvariants,
  verifyEnvironmentParity,
  PlatformParityConfig,
} from '../services/environment-parity';

describe('Release-Build Network & Environment Parity (#273)', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  describe('Configuration Matrix Parity (iOS vs Android)', () => {
    const environments = ['dev', 'staging', 'production'] as const;

    environments.forEach((env) => {
      it(`verifies iOS and Android configuration parity for "${env}" environment`, () => {
        process.env.APP_ENV = env;
        delete process.env.STELLAR_NETWORK;

        const config = appConfig({ config: {} });
        const expo = config.expo;

        // 1. App name parity
        expect(expo.name).toBeDefined();

        // 2. Identifier parity (iOS bundleIdentifier vs Android package)
        const iosId = expo.ios?.bundleIdentifier;
        const androidPkg = expo.android?.package;

        expect(iosId).toBeDefined();
        expect(androidPkg).toBeDefined();
        expect(iosId).toBe(androidPkg); // Invariants require exact identifier parity

        if (env === 'production') {
          expect(iosId).toBe('to.quickex.app');
          expect(androidPkg).toBe('to.quickex.app');
        } else {
          expect(iosId).toBe(`to.quickex.app.${env}`);
          expect(androidPkg).toBe(`to.quickex.app.${env}`);
        }

        // 3. Network and API URL parity
        const expectedNetwork = env === 'production' ? 'mainnet' : 'testnet';
        expect(expo.extra.stellarNetwork).toBe(expectedNetwork);

        if (env === 'production') {
          expect(expo.extra.apiUrl).toBe('https://api.quickex.to');
        } else if (env === 'staging') {
          expect(expo.extra.apiUrl).toBe('https://staging-api.quickex.to');
        }

        // 4. Scheme and intent filter parity
        expect(expo.scheme).toBe('quickex');
        const intentFilters = expo.android?.intentFilters;
        expect(Array.isArray(intentFilters)).toBe(true);

        const httpsFilter = intentFilters.find((f: any) =>
          f.data?.some((d: any) => d.scheme === 'https' && d.host === 'quickex.to')
        );
        expect(httpsFilter).toBeDefined();
      });
    });

    it('enforces financial and security invariants on production configuration', () => {
      process.env.APP_ENV = 'production';
      const config = appConfig({ config: {} });

      // Production must NEVER target testnet
      expect(config.expo.extra.stellarNetwork).toBe('mainnet');
      // Production must point to canonical secure API
      expect(config.expo.extra.apiUrl).toBe('https://api.quickex.to');
    });
  });

  describe('Client-side Invariant Validation', () => {
    it('passes for a valid production configuration', () => {
      const validConfig: PlatformParityConfig = {
        platform: 'ios',
        environment: 'production',
        appId: 'to.quickex.app',
        apiUrl: 'https://api.quickex.to',
        stellarNetwork: 'mainnet',
        buildNumber: '1',
        schemes: ['quickex', 'https'],
      };

      const result = validateClientParityInvariants(validConfig);
      expect(result.valid).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it('rejects critical production invariant violation when network is testnet', () => {
      const invalidConfig: PlatformParityConfig = {
        platform: 'android',
        environment: 'production',
        appId: 'to.quickex.app',
        apiUrl: 'https://api.quickex.to',
        stellarNetwork: 'testnet', // CRITICAL VIOLATION
        buildNumber: '1',
        schemes: ['quickex'],
      };

      const result = validateClientParityInvariants(invalidConfig);
      expect(result.valid).toBe(false);
      expect(result.reasons.some((r) => r.includes('CRITICAL'))).toBe(true);
    });

    it('rejects configuration mismatch when bundle ID is wrong', () => {
      const invalidConfig: PlatformParityConfig = {
        platform: 'ios',
        environment: 'staging',
        appId: 'to.quickex.app.wrong',
        apiUrl: 'https://staging-api.quickex.to',
        stellarNetwork: 'testnet',
        buildNumber: '1',
        schemes: ['quickex'],
      };

      const result = validateClientParityInvariants(invalidConfig);
      expect(result.valid).toBe(false);
      expect(result.reasons.some((r) => r.includes('Staging appId'))).toBe(true);
    });
  });

  describe('Backend Environment Parity Verification Integration', () => {
    it('successfully confirms parity when backend reports all checks pass', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            checks: [
              { check: 'environment-name', status: 'pass' },
              { check: 'stellar-network', status: 'pass' },
            ],
            summary: { total: 2, passed: 2, failed: 0, warnings: 0 },
          },
        }),
      });

      const result = await verifyEnvironmentParity({
        environment: 'production',
      });

      expect(result.valid).toBe(true);
      expect(result.backendParity?.allPassed).toBe(true);
      expect(result.backendParity?.failedChecks).toBe(0);
    });

    it('flags parity failure when backend reports failing checks', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            checks: [
              { check: 'environment-name', status: 'pass' },
              { check: 'stellar-network', status: 'fail', details: 'Network drift' },
            ],
            summary: { total: 2, passed: 1, failed: 1, warnings: 0 },
          },
        }),
      });

      const result = await verifyEnvironmentParity({
        environment: 'production',
      });

      expect(result.valid).toBe(false);
      expect(result.backendParity?.allPassed).toBe(false);
      expect(result.backendParity?.failedChecks).toBe(1);
    });

    it('supports degraded offline mode when network is unreachable', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Connection refused'));

      const result = await verifyEnvironmentParity({
        environment: 'production',
        maxRetries: 1,
        allowDegradedOffline: true,
      });

      expect(result.valid).toBe(true);
      expect(result.degradedMode).toBe(true);
    });
  });
});
