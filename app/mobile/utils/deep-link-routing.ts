import { parsePaymentLink, ParseErrorCode } from './parse-payment-link';

const QUICKEX_HOSTS = ['quickex.to', 'www.quickex.to'];
const QUICKEX_SCHEME = 'quickex';

export interface DeepLinkRoute {
  pathname: string;
  params: Record<string, string>;
}

export type DeepLinkResolution =
  | { route: DeepLinkRoute }
  | { error: string; code?: ParseErrorCode | 'UNAUTHORIZED_PATH' | 'UNSUPPORTED_SCHEME' | 'PHISHING_SUSPECTED' }
  | { ignored: true };

export interface DeepLinkResolutionMetrics {
  event: 'deep_link_resolution';
  success: boolean;
  pathname?: string;
  errorCode?: string;
  latencyMs: number;
}

function logResolutionMetric(metric: DeepLinkResolutionMetrics): void {
  if (__DEV__) {
    console.log('[DeepLinkRouter]', JSON.stringify(metric));
  }
}

export function parseTransactionDeepLink(
  raw: string,
): { id: string; params: Record<string, string> } | null {
  try {
    const url = new URL(raw);

    // Prevent path traversal or invalid host
    if (url.pathname.includes('..') || url.pathname.includes('%2e%2e')) {
      return null;
    }

    if (url.protocol === `${QUICKEX_SCHEME}:`) {
      const segments = url.pathname
        .replace(/^\/+/, '')
        .split('/')
        .filter(Boolean);
      const isTransactionPath = url.hostname === 'transaction';
      if (isTransactionPath && segments.length >= 1) {
        const params: Record<string, string> = {};
        url.searchParams.forEach((value, key) => {
          // Exclude any redirect / external URLs
          if (!key.toLowerCase().includes('redirect') && !key.toLowerCase().includes('callback')) {
            params[key] = value;
          }
        });
        return { id: segments[0], params };
      }
    }

    if (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      QUICKEX_HOSTS.includes(url.hostname)
    ) {
      const segments = url.pathname
        .replace(/^\/+/, '')
        .split('/')
        .filter(Boolean);
      if (segments.length >= 2 && segments[0] === 'transaction') {
        const params: Record<string, string> = {};
        url.searchParams.forEach((value, key) => {
          if (!key.toLowerCase().includes('redirect') && !key.toLowerCase().includes('callback')) {
            params[key] = value;
          }
        });
        return { id: segments[1], params };
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function isQuickExLink(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === `${QUICKEX_SCHEME}:` ||
      ((url.protocol === 'https:' || url.protocol === 'http:') &&
        QUICKEX_HOSTS.includes(url.hostname))
    );
  } catch {
    return false;
  }
}

function looksLikePaymentLink(raw: string): boolean {
  try {
    const url = new URL(raw);

    if (url.protocol === `${QUICKEX_SCHEME}:`) {
      if (url.hostname === 'transaction') {
        return false;
      }
      const segments = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
      return segments.length === 0 || url.hostname !== 'transaction';
    }

    if ((url.protocol === 'https:' || url.protocol === 'http:') && QUICKEX_HOSTS.includes(url.hostname)) {
      const segments = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
      return segments.length === 0 || segments[0] !== 'transaction';
    }

    return false;
  } catch {
    return false;
  }
}

export function resolveDeepLink(raw: string): DeepLinkResolution {
  const startTime = Date.now();
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ignored: true };
  }

  // 1. Phishing & Scheme Pre-validation
  try {
    const parsedUrl = new URL(trimmed);
    const validSchemes = [`${QUICKEX_SCHEME}:`, 'https:', 'http:'];
    if (!validSchemes.includes(parsedUrl.protocol)) {
      const latencyMs = Date.now() - startTime;
      logResolutionMetric({
        event: 'deep_link_resolution',
        success: false,
        errorCode: 'UNSUPPORTED_SCHEME',
        latencyMs,
      });
      return {
        error: `Unsupported scheme: ${parsedUrl.protocol}`,
        code: 'UNSUPPORTED_SCHEME',
      };
    }
  } catch {
    // Fall through if not a standard parseable URL
  }

  const paymentResult = parsePaymentLink(trimmed);
  if (paymentResult.valid) {
    const latencyMs = Date.now() - startTime;
    logResolutionMetric({
      event: 'deep_link_resolution',
      success: true,
      pathname: '/payment-confirmation',
      latencyMs,
    });

    return {
      route: {
        pathname: '/payment-confirmation',
        params: {
          username: paymentResult.data.username,
          amount: paymentResult.data.amount,
          asset: paymentResult.data.asset,
          ...(paymentResult.data.memo ? { memo: paymentResult.data.memo } : {}),
          privacy: String(paymentResult.data.privacy),
          ...(paymentResult.data.expires ? { expires: String(paymentResult.data.expires) } : {}),
          ...(paymentResult.data.nonce ? { nonce: paymentResult.data.nonce } : {}),
        },
      },
    };
  }

  const transactionResult = parseTransactionDeepLink(trimmed);
  if (transactionResult) {
    const latencyMs = Date.now() - startTime;
    logResolutionMetric({
      event: 'deep_link_resolution',
      success: true,
      pathname: '/transaction/[id]',
      latencyMs,
    });

    return {
      route: {
        pathname: '/transaction/[id]',
        params: {
          id: transactionResult.id,
          ...transactionResult.params,
        },
      },
    };
  }

  if (isQuickExLink(trimmed)) {
    const latencyMs = Date.now() - startTime;
    const isPayment = looksLikePaymentLink(trimmed);
    const errorCode = isPayment && !paymentResult.valid ? paymentResult.code : 'UNAUTHORIZED_PATH';
    const errorMessage = isPayment && !paymentResult.valid
      ? (paymentResult.code === 'INVALID_URL' ? 'Unsupported or expired QuickEx link.' : paymentResult.error)
      : 'Unsupported or expired QuickEx link.';

    logResolutionMetric({
      event: 'deep_link_resolution',
      success: false,
      errorCode,
      latencyMs,
    });

    if (errorMessage === 'Unsupported or expired QuickEx link.') {
      return { error: errorMessage };
    }

    return {
      error: errorMessage,
      code: errorCode,
    };
  }

  return { ignored: true };
}
