import { describe, expect, it } from 'vitest';
import {
  MAX_MEMO_LENGTH,
  getVerifiedAssetOptions,
  readDraftLinks,
  saveDraftLink,
  validateAmountInput,
  validateAssetCode,
  validateMemoInput,
  validatePaymentLinkPreview,
} from './linkGenerator';

describe('validateAmountInput', () => {
  it('accepts positive numbers', () => {
    expect(validateAmountInput('12.5')).toEqual({ valid: true });
    expect(validateAmountInput('0.0000001')).toEqual({ valid: true });
  });

  it('rejects empty, zero and invalid values', () => {
    expect(validateAmountInput('')).toEqual({
      valid: false,
      message: 'Amount must be greater than 0.',
    });
    expect(validateAmountInput('0')).toEqual({
      valid: false,
      message: 'Amount must be greater than 0.',
    });
    expect(validateAmountInput('abc')).toEqual({
      valid: false,
      message: 'Enter a valid number.',
    });
  });

  it('rejects amounts exceeding 7 decimal places (Stellar stroop precision)', () => {
    const res = validateAmountInput('1.12345678');
    expect(res.valid).toBe(false);
    expect(res.message).toContain('7 decimal places');
  });

  it('rejects amounts exceeding Stellar max limits', () => {
    const res = validateAmountInput('9999999999999999999');
    expect(res.valid).toBe(false);
    expect(res.message).toContain('maximum');
  });
});

describe('validateMemoInput', () => {
  it('accepts empty memo', () => {
    expect(validateMemoInput('')).toEqual({ valid: true, byteLength: 0 });
  });

  it('accepts memos within 28 bytes', () => {
    const res = validateMemoInput('Order-12345');
    expect(res.valid).toBe(true);
    expect(res.byteLength).toBe(11);
  });

  it('rejects memos exceeding 28 bytes', () => {
    const longMemo = 'This is a memo that is definitely longer than 28 bytes';
    const res = validateMemoInput(longMemo);
    expect(res.valid).toBe(false);
    expect(res.message).toContain('exceeds maximum limit of 28 bytes');
  });

  it('accurately counts multi-byte UTF-8 characters', () => {
    // 🚀 is 4 bytes
    const emojiMemo = '🚀🚀🚀🚀🚀🚀🚀🚀'; // 8 emojis * 4 bytes = 32 bytes
    const res = validateMemoInput(emojiMemo);
    expect(res.valid).toBe(false);
    expect(res.byteLength).toBe(32);
  });
});

describe('validateAssetCode', () => {
  it('accepts valid asset codes', () => {
    expect(validateAssetCode('XLM')).toEqual({ valid: true, normalized: 'XLM' });
    expect(validateAssetCode('usdc')).toEqual({ valid: true, normalized: 'USDC' });
    expect(validateAssetCode('EURC123')).toEqual({ valid: true, normalized: 'EURC123' });
  });

  it('rejects invalid asset codes', () => {
    expect(validateAssetCode('')).toEqual({
      valid: false,
      message: 'Asset code is required.',
    });
    expect(validateAssetCode('TOOLONGASSETCODE123')).toEqual({
      valid: false,
      message: 'Asset code must be 1-12 uppercase alphanumeric characters.',
    });
    expect(validateAssetCode('BAD-CODE')).toEqual({
      valid: false,
      message: 'Asset code must be 1-12 uppercase alphanumeric characters.',
    });
  });
});

describe('validatePaymentLinkPreview', () => {
  it('validates a complete valid payment link preview', () => {
    const res = validatePaymentLinkPreview({
      amount: '25.50',
      asset: 'USDC',
      memo: 'Invoice 101',
      username: 'alice',
    });
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual({});
  });

  it('validates valid destination G-address', () => {
    const res = validatePaymentLinkPreview({
      amount: '10',
      asset: 'XLM',
      destination: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    });
    expect(res.valid).toBe(true);
  });

  it('rejects missing recipient', () => {
    const res = validatePaymentLinkPreview({
      amount: '10',
      asset: 'XLM',
    });
    expect(res.valid).toBe(false);
    expect(res.errors.recipient).toBeDefined();
  });

  it('collects multiple validation errors across amount, asset, and memo', () => {
    const res = validatePaymentLinkPreview({
      amount: '-5',
      asset: 'INVALID_ASSET_TOOLONG',
      memo: 'This memo is excessively long and will fail Stellar 28 byte limit',
      username: 'bob',
    });
    expect(res.valid).toBe(false);
    expect(res.errors.amount).toBeDefined();
    expect(res.errors.asset).toBeDefined();
    expect(res.errors.memo).toBeDefined();
  });
});

describe('getVerifiedAssetOptions', () => {
  it('returns only verified assets and falls back to all assets when needed', () => {
    expect(
      getVerifiedAssetOptions([
        { code: 'USDC', verified: true },
        { code: 'XLM', verified: false },
        { code: 'EURC', verified: true },
      ]).map((asset) => asset.code),
    ).toEqual(['USDC', 'EURC']);

    expect(
      getVerifiedAssetOptions([
        { code: 'TEST', verified: false },
        { code: 'MOCK', verified: false },
      ]).map((asset) => asset.code),
    ).toEqual(['TEST', 'MOCK']);
  });
});

describe('draft storage', () => {
  it('saves and reads draft links in order', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem(key: string) {
        return data.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        data.set(key, value);
      },
      removeItem(key: string) {
        data.delete(key);
      },
    } as unknown as Storage;

    const draft = {
      id: 'draft-1',
      amount: '25',
      asset: 'USDC',
      destination: 'GABC',
      memo: 'invoice-123',
      createdAt: '2026-08-30T00:00:00.000Z',
    };

    const saved = saveDraftLink(draft, storage);
    expect(saved[0]).toMatchObject(draft);
    expect(readDraftLinks(storage)).toHaveLength(1);
    expect(MAX_MEMO_LENGTH).toBeGreaterThan(0);
  });
});
