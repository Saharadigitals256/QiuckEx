/**
 * Phishing-Resistant Payment Link Parser
 * Resolves #271: Mobile deep-link validation and phishing-resistant route handling
 */

const QUICKEX_HOSTS = ['quickex.to', 'www.quickex.to'];
const QUICKEX_SCHEME = 'quickex';

const EXPIRES_PARAM = 'expires';
const NONCE_PARAM = 'nonce';

const ASSET_WHITELIST = ['XLM', 'USDC', 'AQUA', 'yXLM'] as const;
type AssetCode = (typeof ASSET_WHITELIST)[number];

const AMOUNT_MIN = 0.0000001;
const AMOUNT_MAX = 1_000_000;
const MEMO_MAX_LENGTH = 28;
const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;

// Track consumed nonces to prevent replay attacks
const consumedNonces = new Set<string>();

export function markNonceConsumed(nonce: string): void {
  consumedNonces.add(nonce);
}

export function isNonceConsumed(nonce: string): boolean {
  return consumedNonces.has(nonce);
}

export function resetConsumedNonces(): void {
  consumedNonces.clear();
}

export type ParseErrorCode =
  | 'EMPTY_LINK'
  | 'INVALID_URL'
  | 'PHISHING_SUSPECTED'
  | 'HOMOGLYPH_ATTACK'
  | 'OPEN_REDIRECT_ATTEMPT'
  | 'EXPIRED_LINK'
  | 'DUPLICATE_REPLAY'
  | 'INVALID_USERNAME'
  | 'MISSING_AMOUNT'
  | 'INVALID_AMOUNT'
  | 'UNSUPPORTED_ASSET'
  | 'MEMO_TOO_LONG';

export interface PaymentLinkData {
  username: string;
  amount: string;
  asset: AssetCode;
  memo: string | null;
  privacy: boolean;
  expires?: number;
  nonce?: string;
}

export type ParseResult =
  | { valid: true; data: PaymentLinkData }
  | { valid: false; error: string; code: ParseErrorCode };

const FORBIDDEN_REDIRECT_PARAMS = [
  'redirect',
  'redirect_uri',
  'callback',
  'return_to',
  'next',
  'dest',
  'target',
  'url',
];

function hasHomoglyphs(str: string): boolean {
  // Reject non-ASCII unicode homoglyphs (e.g. Cyrillic lookalikes like 'а', 'е', 'о', 'р')
  return /[^\u0020-\u007E]/.test(str);
}

function extractParts(
  raw: string
): { username: string; params: URLSearchParams } | { error: string; code: ParseErrorCode } | null {
  try {
    // Check for obvious path traversal before URL parsing
    if (raw.includes('..') || raw.includes('%2e%2e') || raw.includes('%2E%2E')) {
      return { error: 'Path traversal attempt detected', code: 'PHISHING_SUSPECTED' };
    }

    const url = new URL(raw);

    // Reject non-ASCII homoglyphs in hostname
    if (hasHomoglyphs(url.hostname)) {
      return { error: 'Homoglyph spoofing detected in domain', code: 'HOMOGLYPH_ATTACK' };
    }

    // Check for open redirect attempts in query parameters
    for (const forbidden of FORBIDDEN_REDIRECT_PARAMS) {
      const val = url.searchParams.get(forbidden);
      if (val && (val.startsWith('http://') || val.startsWith('https://') || val.startsWith('//'))) {
        return { error: 'External redirect query parameter detected', code: 'OPEN_REDIRECT_ATTEMPT' };
      }
    }

    if (url.protocol === `${QUICKEX_SCHEME}:`) {
      const username = url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0];
      return username ? { username, params: url.searchParams } : null;
    }

    if (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      QUICKEX_HOSTS.includes(url.hostname)
    ) {
      const segments = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
      if (segments.length === 0) return null;
      return { username: segments[0], params: url.searchParams };
    }
  } catch {
    // Invalid URL syntax
  }
  return null;
}

export function parsePaymentLink(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: false, error: 'Empty link', code: 'EMPTY_LINK' };
  }

  const parts = extractParts(trimmed);
  if (!parts) {
    return { valid: false, error: 'Not a valid QuickEx link', code: 'INVALID_URL' };
  }

  if ('error' in parts) {
    return { valid: false, error: parts.error, code: parts.code };
  }

  const rawUsername = parts.username;
  const params = parts.params;
  let username: string;
  try {
    username = decodeURIComponent(rawUsername);
  } catch {
    username = rawUsername;
  }

  if (hasHomoglyphs(username)) {
    return {
      valid: false,
      error: 'Username contains invalid characters or homoglyph spoofing',
      code: 'HOMOGLYPH_ATTACK',
    };
  }

  if (!USERNAME_PATTERN.test(username)) {
    return { valid: false, error: `Invalid username "${username}"`, code: 'INVALID_USERNAME' };
  }

  // Expiration check
  const rawExpires = params.get(EXPIRES_PARAM);
  let expiresEpochMs: number | undefined;
  if (rawExpires) {
    const num = Number(rawExpires);
    if (!Number.isNaN(num)) {
      expiresEpochMs = num < 10000000000 ? num * 1000 : num;
    } else {
      expiresEpochMs = new Date(rawExpires).getTime();
    }

    if (!Number.isNaN(expiresEpochMs) && expiresEpochMs < Date.now()) {
      return {
        valid: false,
        error: 'Payment link has expired',
        code: 'EXPIRED_LINK',
      };
    }
  }

  // Nonce and duplicate replay protection
  const nonce = params.get(NONCE_PARAM);
  if (nonce) {
    if (isNonceConsumed(nonce)) {
      return {
        valid: false,
        error: 'Payment link has already been used (duplicate replay)',
        code: 'DUPLICATE_REPLAY',
      };
    }
  }

  const rawAmount = params.get('amount');
  if (!rawAmount) {
    return { valid: false, error: 'Missing amount', code: 'MISSING_AMOUNT' };
  }
  const amount = Number(rawAmount);
  if (Number.isNaN(amount) || amount < AMOUNT_MIN || amount > AMOUNT_MAX) {
    return {
      valid: false,
      error: `Amount must be between ${AMOUNT_MIN} and ${AMOUNT_MAX}`,
      code: 'INVALID_AMOUNT',
    };
  }
  const formattedAmount = amount.toFixed(7);

  const rawAsset = (params.get('asset') ?? 'XLM').toUpperCase();
  if (!ASSET_WHITELIST.includes(rawAsset as AssetCode)) {
    return {
      valid: false,
      error: `Unsupported asset "${rawAsset}". Supported: ${ASSET_WHITELIST.join(', ')}`,
      code: 'UNSUPPORTED_ASSET',
    };
  }
  const asset = rawAsset as AssetCode;

  let memo: string | null = null;
  const rawMemo = params.get('memo');
  if (rawMemo) {
    const decoded = decodeURIComponent(rawMemo).trim();
    if (decoded.length > MEMO_MAX_LENGTH) {
      return {
        valid: false,
        error: `Memo exceeds ${MEMO_MAX_LENGTH} characters`,
        code: 'MEMO_TOO_LONG',
      };
    }
    if (decoded.length > 0) {
      memo = decoded;
    }
  }

  const privacy = params.get('privacy') === 'true';

  return {
    valid: true,
    data: {
      username,
      amount: formattedAmount,
      asset,
      memo,
      privacy,
      expires: expiresEpochMs,
      nonce: nonce || undefined,
    },
  };
}
