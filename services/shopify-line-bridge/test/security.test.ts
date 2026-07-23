import { describe, expect, it } from 'vitest';
import {
  base64UrlEncode,
  bytesToBase64,
  canonicalShopifyQuery,
  decryptSecret,
  encryptSecret,
  hmacSha256,
  verifyLinkTicket,
  verifyShopifyQuery,
  verifyShopifyWebhook,
} from '../src/security.js';

describe('Shopify signatures', () => {
  it('verifies webhook HMAC over the untouched raw body', async () => {
    const body = '{"id":123,"name":"#1001"}';
    const secret = 'test-secret';
    const signature = bytesToBase64(await hmacSha256(secret, body));
    await expect(verifyShopifyWebhook(body, signature, secret)).resolves.toBe(true);
    await expect(verifyShopifyWebhook(`${body}\n`, signature, secret)).resolves.toBe(false);
  });

  it('sorts OAuth query parameters and omits hmac', async () => {
    const secret = 'oauth-secret';
    const url = new URL('https://example.test/callback?timestamp=1337&shop=shuuka.myshopify.com&code=abc');
    expect(canonicalShopifyQuery(url)).toBe('code=abc&shop=shuuka.myshopify.com&timestamp=1337');
    const digest = await hmacSha256(secret, canonicalShopifyQuery(url));
    const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    url.searchParams.set('hmac', hex);
    await expect(verifyShopifyQuery(url, secret)).resolves.toBe(true);
  });
});

describe('LINE link tickets', () => {
  it('accepts a signed ticket for the intended audience', async () => {
    const secret = 'link-secret-with-enough-entropy-for-test';
    const payload = {
      v: 1 as const,
      aud: 'https://bridge.example.com',
      friendId: 'friend-1',
      lineUserId: 'U123',
      userId: 'user-1',
      nonce: 'nonce-1',
      exp: 2_000_000_000,
    };
    const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
    const ticket = `${encoded}.${base64UrlEncode(await hmacSha256(secret, encoded))}`;
    await expect(verifyLinkTicket(ticket, secret, payload.aud, 1_900_000_000)).resolves.toEqual(payload);
    await expect(verifyLinkTicket(ticket, secret, 'https://evil.example', 1_900_000_000)).rejects.toThrow();
  });
});

describe('stored token encryption', () => {
  it('round-trips with AES-GCM and rejects a different key', async () => {
    const key = '1'.repeat(64);
    const encrypted = await encryptSecret('shpat_test', key);
    await expect(decryptSecret(encrypted, key)).resolves.toBe('shpat_test');
    await expect(decryptSecret(encrypted, '2'.repeat(64))).rejects.toThrow();
  });
});
