import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidCode, mulberry32, pick, randomCode, randomInt, secureRng } from '../src/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mulberry32', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const seqA = Array.from({ length: 20 }, a);
    expect(Array.from({ length: 20 }, b)).toEqual(seqA);
    expect(Array.from({ length: 20 }, c)).not.toEqual(seqA);
  });

  it('stays in [0, 1)', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 100_000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('randomInt', () => {
  it('covers the whole range and never leaves it', () => {
    const rng = mulberry32(5);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = randomInt(rng, 7);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
      seen.add(v);
    }
    expect(seen.size).toBe(7);
  });

  it('is safe even if a broken rng returns exactly 1', () => {
    expect(randomInt(() => 1, 10)).toBe(9);
    expect(randomInt(() => 0, 10)).toBe(0);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects the range %d', (n) => {
    expect(() => randomInt(Math.random, n)).toThrow(RangeError);
  });
});

describe('pick', () => {
  it('returns an element and throws on an empty array', () => {
    expect(pick(mulberry32(1), ['a', 'b', 'c'])).toMatch(/^[abc]$/);
    expect(() => pick(mulberry32(1), [])).toThrow(RangeError);
  });
});

describe('randomCode', () => {
  it('always returns a valid code', () => {
    const rng = mulberry32(9);
    for (let i = 0; i < 5000; i++) expect(isValidCode(randomCode(rng))).toBe(true);
  });

  it('is roughly uniform over first digits and reaches leading zeros', () => {
    const rng = mulberry32(11);
    const counts = new Array<number>(10).fill(0);
    const trials = 50_000;
    for (let i = 0; i < trials; i++) counts[Number(randomCode(rng)[0])]!++;
    for (const count of counts) {
      // Expected 5,000 each; allow a generous 10% band to avoid flakiness.
      expect(count).toBeGreaterThan(4500);
      expect(count).toBeLessThan(5500);
    }
  });
});

describe('secureRng', () => {
  it('returns varying values in [0, 1)', () => {
    const rng = secureRng();
    const values = Array.from({ length: 1000 }, rng);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Set(values).size).toBeGreaterThan(990);
  });

  it('works with randomCode', () => {
    const rng = secureRng();
    for (let i = 0; i < 200; i++) expect(isValidCode(randomCode(rng))).toBe(true);
  });

  it('throws instead of falling back when WebCrypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => secureRng()).toThrow(/not available/);
    vi.stubGlobal('crypto', {});
    expect(() => secureRng()).toThrow(/not available/);
  });
});
