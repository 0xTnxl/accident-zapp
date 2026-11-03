/** Small byte helpers. No dependencies beyond standard web APIs available in browsers and Node 20+. */

const HEX_PATTERN = /^(?:[0-9a-f]{2})*$/;

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Strict lowercase hex. Throws `RangeError` on uppercase, odd length or non-hex characters. */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (typeof hex !== 'string' || !HEX_PATTERN.test(hex)) {
    throw new RangeError('Invalid hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** True for exactly `bytes` bytes of lowercase hex, that is `bytes * 2` characters. */
export function isHex(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length === bytes * 2 && HEX_PATTERN.test(value);
}

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The small slice of WebCrypto this package uses. Browsers, workers and Node 20+ provide it. */
interface WebCryptoLike {
  subtle: { digest(algorithm: 'SHA-256', data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> };
  getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
}

function webCrypto(): WebCryptoLike {
  const c = (globalThis as { crypto?: Partial<WebCryptoLike> }).crypto;
  if (!c?.subtle || typeof c.getRandomValues !== 'function') {
    throw new Error('WebCrypto is not available in this environment');
  }
  return c as WebCryptoLike;
}

export async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await webCrypto().subtle.digest('SHA-256', data));
}

export async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  return bytesToHex(await sha256(data));
}

/** Cryptographically secure random bytes. Throws if WebCrypto is unavailable. */
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  webCrypto().getRandomValues(out);
  return out;
}
