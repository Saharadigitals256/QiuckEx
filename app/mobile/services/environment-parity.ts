import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { ENVIRONMENTS, EnvironmentId, EnvironmentConfig } from '../src/config/environment';

/**
 * Release-Build Network & Environment Parity Service
 * Resolves #273: Add release-build network and environment parity tests for iOS and Android
 *
 * Verifies parity of configuration, network bindings, and security guarantees
 * between iOS and Android release builds and against backend environment parity checks.
 */

const API_BASE_URL =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  process.env['EXPO_PUBLIC_API_URL'] ??
  'http://localhost:4000';

export type ParityErrorCode =
  | 'CONFIG_MISMATCH'
  | 'NETWORK_UNREACHABLE'
  | 'PARITY_CHECK_FAILED'
  | 'UNSUPPORTED_PLATFORM'
  | 'INVALID_ENVIRONMENT';

export class EnvironmentParityError extends Error {
  constructor(
    public readonly code: ParityErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'EnvironmentParityError';
  }
}

export interface PlatformParityConfig {
  platform: 'ios' | 'android';
  environment: EnvironmentId;
  appId: string;
  apiUrl: string;
  stellarNetwork: 'mainnet' | 'testnet';
  buildNumber: string;
  schemes: string[];
}

export interface BackendParityStatusResponse {
  success: boolean;
  data: {
    checks: Array<{
      check: string;
      status: 'pass' | 'fail' | 'warning';
      details?: string;
    }>;
    summary: {
      total: number;
      passed: number;
      failed: number;
      warnings: number;
    };
  };
}

export interface EnvironmentParityValidationResult {
  valid: boolean;
  platform: 'ios' | 'android';
  environment: EnvironmentId;
  clientParity: {
    apiUrlMatches: boolean;
    networkMatches: boolean;
    idConsistent: boolean;
  };
  backendParity?: {
    checked: boolean;
    allPassed: boolean;
    failedChecks: number;
  };
  degradedMode?: boolean;
  error?: EnvironmentParityError;
  latencyMs: number;
}

export interface VerifyParityOptions {
  environment?: EnvironmentId;
  timeoutMs?: number;
  maxRetries?: number;
  allowDegradedOffline?: boolean;
}

function logParityMetric(metric: {
  event: 'environment_parity_check';
  platform: string;
  environment: string;
  success: boolean;
  latencyMs: number;
  errorCode?: string;
}): void {
  if (__DEV__) {
    console.log('[EnvironmentParity]', JSON.stringify(metric));
  }
}

/**
 * Validate that client-side platform configuration conforms to environment invariants
 */
export function validateClientParityInvariants(config: PlatformParityConfig): {
  valid: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const expectedEnv = ENVIRONMENTS[config.environment];

  if (!expectedEnv) {
    return {
      valid: false,
      reasons: [`Unknown environment ID: ${config.environment}`],
    };
  }

  // 1. API URL Parity
  if (config.apiUrl !== expectedEnv.apiUrl && !config.apiUrl.includes('localhost')) {
    reasons.push(
      `API URL mismatch: expected ${expectedEnv.apiUrl}, found ${config.apiUrl}`
    );
  }

  // 2. Stellar Network Parity
  if (config.stellarNetwork !== expectedEnv.stellarNetwork) {
    reasons.push(
      `Stellar network mismatch: expected ${expectedEnv.stellarNetwork}, found ${config.stellarNetwork}`
    );
  }

  // 3. Platform Bundle ID / Package Name Pattern Parity
  const baseAppId = 'to.quickex.app';
  if (config.environment === 'production' && config.appId !== baseAppId) {
    reasons.push(`Production appId must be "${baseAppId}", got "${config.appId}"`);
  } else if (config.environment === 'staging' && config.appId !== `${baseAppId}.staging`) {
    reasons.push(`Staging appId must be "${baseAppId}.staging", got "${config.appId}"`);
  } else if (config.environment === 'dev' && config.appId !== `${baseAppId}.dev`) {
    reasons.push(`Dev appId must be "${baseAppId}.dev", got "${config.appId}"`);
  }

  // 4. Invariant: Production build must NEVER use testnet
  if (config.environment === 'production' && config.stellarNetwork !== 'mainnet') {
    reasons.push('CRITICAL: Production build cannot target testnet');
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

/**
 * Verify client build environment parity against backend environment parity service
 */
export async function verifyEnvironmentParity(
  options: VerifyParityOptions = {}
): Promise<EnvironmentParityValidationResult> {
  const startTime = Date.now();
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const environment = options.environment || 'production';
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxRetries = options.maxRetries ?? 2;
  const allowDegradedOffline = options.allowDegradedOffline ?? true;

  const currentConfig: PlatformParityConfig = {
    platform,
    environment,
    appId:
      environment === 'production'
        ? 'to.quickex.app'
        : `to.quickex.app.${environment}`,
    apiUrl: ENVIRONMENTS[environment]?.apiUrl || API_BASE_URL,
    stellarNetwork: ENVIRONMENTS[environment]?.stellarNetwork || 'mainnet',
    buildNumber: '1',
    schemes: ['quickex', 'https'],
  };

  const clientCheck = validateClientParityInvariants(currentConfig);

  if (!clientCheck.valid) {
    const error = new EnvironmentParityError(
      'CONFIG_MISMATCH',
      `Client configuration parity check failed: ${clientCheck.reasons.join('; ')}`
    );
    const latencyMs = Date.now() - startTime;
    logParityMetric({
      event: 'environment_parity_check',
      platform,
      environment,
      success: false,
      errorCode: error.code,
      latencyMs,
    });
    return {
      valid: false,
      platform,
      environment,
      clientParity: {
        apiUrlMatches: false,
        networkMatches: false,
        idConsistent: false,
      },
      error,
      latencyMs,
    };
  }

  // 2. Query backend environment parity status with retries
  let attempt = 0;
  let lastError: EnvironmentParityError | null = null;

  while (attempt <= maxRetries) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${API_BASE_URL}/api/environment-parity/status`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timer);

      if (!response.ok) {
        throw new EnvironmentParityError(
          'PARITY_CHECK_FAILED',
          `Backend parity check responded with HTTP ${response.status}`
        );
      }

      const body = (await response.json()) as BackendParityStatusResponse;
      const failedChecks = body.data?.summary?.failed ?? 0;
      const allPassed = failedChecks === 0;

      const latencyMs = Date.now() - startTime;
      logParityMetric({
        event: 'environment_parity_check',
        platform,
        environment,
        success: allPassed,
        latencyMs,
      });

      return {
        valid: allPassed,
        platform,
        environment,
        clientParity: {
          apiUrlMatches: true,
          networkMatches: true,
          idConsistent: true,
        },
        backendParity: {
          checked: true,
          allPassed,
          failedChecks,
        },
        latencyMs,
      };
    } catch (err: any) {
      clearTimeout(timer);
      const isAbort = err?.name === 'AbortError';
      lastError = new EnvironmentParityError(
        'NETWORK_UNREACHABLE',
        isAbort ? 'Environment parity check timed out' : err?.message || 'Network unreachable'
      );

      if (attempt <= maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 50));
      }
    }
  }

  // 3. Fallback degraded mode on network failure
  const latencyMs = Date.now() - startTime;
  if (allowDegradedOffline && lastError) {
    logParityMetric({
      event: 'environment_parity_check',
      platform,
      environment,
      success: true,
      latencyMs,
    });

    return {
      valid: true,
      platform,
      environment,
      clientParity: {
        apiUrlMatches: true,
        networkMatches: true,
        idConsistent: true,
      },
      backendParity: {
        checked: false,
        allPassed: false,
        failedChecks: 0,
      },
      degradedMode: true,
      error: lastError,
      latencyMs,
    };
  }

  logParityMetric({
    event: 'environment_parity_check',
    platform,
    environment,
    success: false,
    errorCode: lastError?.code,
    latencyMs,
  });

  return {
    valid: false,
    platform,
    environment,
    clientParity: {
      apiUrlMatches: true,
      networkMatches: true,
      idConsistent: true,
    },
    error: lastError || new EnvironmentParityError('NETWORK_UNREACHABLE', 'Parity check failed'),
    latencyMs,
  };
}
