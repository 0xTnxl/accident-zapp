import { allCodes } from './codes.js';
import type { Code } from './rules.js';

/** A source of uniform numbers in [0, 1), like Math.random. */
export type Rng = () => number;

/** Small deterministic generator for tests and reproducible simulations. NOT for secrets. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cryptographically secure generator backed by `globalThis.crypto.getRandomValues`
 * (browsers, Web Workers and Node 20+). Use this, not Math.random, for a player's real secret.
 * Throws if WebCrypto is unavailable, rather than silently falling back to a weak source.
 */
export function secureRng(): Rng {
  const webCrypto = (globalThis as { crypto?: { getRandomValues?: unknown } }).crypto;
  if (typeof webCrypto?.getRandomValues !== 'function') {
    throw new Error('Secure random numbers are not available in this environment');
  }
  const buffer = new Uint32Array(1);
  const getRandomValues = (webCrypto.getRandomValues as (a: Uint32Array) => Uint32Array).bind(
    webCrypto,
  );
  return () => {
    getRandomValues(buffer);
    return (buffer[0] as number) / 4294967296;
  };
}

/** Uniform integer in [0, n). `n` must be a positive integer. */
export function randomInt(rng: Rng, n: number): number {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError(`Invalid range: ${n}`);
  return Math.min(n - 1, Math.floor(rng() * n));
}

/** Picks a uniformly random element. Throws on an empty array. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new RangeError('Cannot pick from an empty array');
  return items[randomInt(rng, items.length)] as T;
}

/** A uniformly random valid code, each of the 5,040 equally likely. */
export function randomCode(rng: Rng): Code {
  return pick(rng, allCodes());
}
