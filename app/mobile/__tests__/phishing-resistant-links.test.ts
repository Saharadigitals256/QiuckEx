import {
  parsePaymentLink,
  markNonceConsumed,
  resetConsumedNonces,
} from '../utils/parse-payment-link';
import { resolveDeepLink } from '../utils/deep-link-routing';

describe('Phishing-Resistant Deep Link Validation (#271)', () => {
  beforeEach(() => {
    resetConsumedNonces();
  });

  describe('Homoglyph attack protection', () => {
    it('detects and rejects homoglyphs in domain name', () => {
      // Cyrillic 'а' replacing latin 'a' or dotless i
      const spoofedDomain = 'https://qu\u0131ckex.to/alice?amount=10';
      const result = parsePaymentLink(spoofedDomain);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('HOMOGLYPH_ATTACK');
      }
    });

    it('detects and rejects homoglyphs in username', () => {
      // Cyrillic 'о' in username 'bоb'
      const spoofedUsername = 'https://quickex.to/b\u043Eb?amount=10';
      const result = parsePaymentLink(spoofedUsername);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('HOMOGLYPH_ATTACK');
      }
    });
  });

  describe('Open redirect protection', () => {
    it('rejects payment links with external redirect query parameters', () => {
      const maliciousLink =
        'https://quickex.to/alice?amount=10&redirect=https://evil-phishing.com/steal-keys';
      const result = parsePaymentLink(maliciousLink);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('OPEN_REDIRECT_ATTEMPT');
      }
    });

    it('rejects protocol-relative redirect urls', () => {
      const maliciousLink =
        'https://quickex.to/alice?amount=10&redirect_uri=//evil-site.com';
      const result = parsePaymentLink(maliciousLink);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('OPEN_REDIRECT_ATTEMPT');
      }
    });
  });

  describe('Expiration verification', () => {
    it('rejects payment links where expires timestamp has passed', () => {
      const pastTimestamp = Math.floor((Date.now() - 60000) / 1000); // 1 minute ago
      const expiredLink = `https://quickex.to/alice?amount=10&expires=${pastTimestamp}`;
      const result = parsePaymentLink(expiredLink);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('EXPIRED_LINK');
        expect(result.error).toBe('Payment link has expired');
      }
    });

    it('accepts payment links with valid future expiration', () => {
      const futureTimestamp = Math.floor((Date.now() + 3600000) / 1000); // 1 hour ahead
      const activeLink = `https://quickex.to/alice?amount=10&expires=${futureTimestamp}`;
      const result = parsePaymentLink(activeLink);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.data.expires).toBe(futureTimestamp * 1000);
      }
    });
  });

  describe('Replay and Duplicate prevention', () => {
    it('rejects replay when nonce was already consumed', () => {
      const nonce = 'test-nonce-12345';
      const link = `https://quickex.to/alice?amount=10&nonce=${nonce}`;

      const firstAttempt = parsePaymentLink(link);
      expect(firstAttempt.valid).toBe(true);

      markNonceConsumed(nonce);

      const replayAttempt = parsePaymentLink(link);
      expect(replayAttempt.valid).toBe(false);
      if (!replayAttempt.valid) {
        expect(replayAttempt.code).toBe('DUPLICATE_REPLAY');
      }
    });
  });

  describe('Path traversal defense', () => {
    it('rejects path traversal attempts', () => {
      const traversalLink = 'https://quickex.to/../etc/passwd?amount=10';
      const result = parsePaymentLink(traversalLink);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('PHISHING_SUSPECTED');
      }
    });
  });

  describe('Scheme validation', () => {
    it('rejects dangerous javascript: schemes', () => {
      const dangerousLink = 'javascript:alert(1)';
      const result = resolveDeepLink(dangerousLink);
      expect(result).toHaveProperty('error');
      if ('code' in result) {
        expect(result.code).toBe('UNSUPPORTED_SCHEME');
      }
    });
  });
});
