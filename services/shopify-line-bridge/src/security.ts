import type { LinkTicketPayload } from './types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return base64ToBytes(padded);
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign('HMAC', await importHmacKey(secret), encoder.encode(message));
  return new Uint8Array(signature);
}

export function timingSafeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index % Math.max(a.length, 1)] ?? 0) ^ (b[index % Math.max(b.length, 1)] ?? 0);
  }
  return mismatch === 0;
}

export async function verifyShopifyWebhook(rawBody: string, provided: string, secret: string): Promise<boolean> {
  const expected = bytesToBase64(await hmacSha256(secret, rawBody));
  return timingSafeEqual(expected, provided);
}

export function canonicalShopifyQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .filter(([key]) => key !== 'hmac' && key !== 'signature')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

export async function verifyShopifyQuery(url: URL, secret: string): Promise<boolean> {
  const provided = url.searchParams.get('hmac');
  if (!provided) return false;
  const bytes = await hmacSha256(secret, canonicalShopifyQuery(url));
  const expected = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(expected, provided);
}

export function isValidShopDomain(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(value);
}

export function randomToken(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function verifyLinkTicket(
  ticket: string,
  secret: string,
  expectedAudience: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<LinkTicketPayload> {
  const [encodedPayload, encodedSignature, extra] = ticket.split('.');
  if (!encodedPayload || !encodedSignature || extra) throw new Error('invalid_ticket');
  const expected = base64UrlEncode(await hmacSha256(secret, encodedPayload));
  if (!timingSafeEqual(expected, encodedSignature)) throw new Error('invalid_ticket_signature');

  let payload: LinkTicketPayload;
  try {
    payload = JSON.parse(decoder.decode(base64UrlDecode(encodedPayload))) as LinkTicketPayload;
  } catch {
    throw new Error('invalid_ticket_payload');
  }
  if (payload.v !== 1 || payload.aud !== expectedAudience || payload.exp < nowSeconds) {
    throw new Error('expired_or_wrong_audience');
  }
  if (!payload.friendId || !payload.lineUserId || !payload.userId || !payload.nonce) {
    throw new Error('invalid_ticket_claims');
  }
  return payload;
}

function encryptionKeyBytes(value: string): Uint8Array {
  if (/^[a-f0-9]{64}$/i.test(value)) {
    return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  }
  const bytes = base64ToBytes(value);
  if (bytes.length !== 32) throw new Error('SHOPIFY_TOKEN_ENCRYPTION_KEY must be 32 bytes');
  return bytes;
}

export async function encryptSecret(plaintext: string, keyValue: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(encryptionKeyBytes(keyValue)), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext)));
  return `${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}`;
}

export async function decryptSecret(encrypted: string, keyValue: string): Promise<string> {
  const [ivPart, ciphertextPart, extra] = encrypted.split('.');
  if (!ivPart || !ciphertextPart || extra) throw new Error('invalid_encrypted_secret');
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(encryptionKeyBytes(keyValue)), 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(base64UrlDecode(ivPart)) },
    key,
    toArrayBuffer(base64UrlDecode(ciphertextPart)),
  );
  return decoder.decode(plaintext);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const [name, ...rest] = part.trim().split('=');
      return [name ?? '', decodeURIComponent(rest.join('='))];
    }),
  );
}

export function oauthStateCookie(state: string): string {
  return `shopify_oauth_state=${encodeURIComponent(state)}; Path=/shopify; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
}

export function clearOauthStateCookie(): string {
  return 'shopify_oauth_state=; Path=/shopify; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}
