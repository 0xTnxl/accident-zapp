import { describe, expect, it } from 'vitest';
import {
  VALID_FEEDBACK,
  answererOf,
  assertCode,
  assertFeedback,
  decodeFeedback,
  encodeFeedback,
  guesserOf,
  isValidCode,
  isValidFeedback,
  mulberry32,
  pick,
  roundOf,
  score,
  scoreParts,
} from '../src/index.js';
import { NAIVE_CODES, naiveScore } from './helpers.js';

// PRD Appendix A.1
const VECTORS: Array<
  [secret: string, guess: string, dead: number, injured: number, encoded: number]
> = [
  ['1964', '2604', 1, 1, 11],
  ['4271', '1234', 1, 2, 12],
  ['1234', '1234', 4, 0, 40],
  ['1234', '4321', 0, 4, 4],
  ['0123', '4567', 0, 0, 0],
  ['0123', '3210', 0, 4, 4],
  ['0123', '0132', 2, 2, 22],
  ['9876', '6789', 0, 4, 4],
];

describe('score (PRD A.1 vectors)', () => {
  it.each(VECTORS)('secret %s vs guess %s', (secret, guess, dead, injured, encoded) => {
    expect(scoreParts(secret, guess)).toEqual({ dead, injured });
    expect(score(secret, guess)).toBe(encoded);
    expect(encodeFeedback(dead, injured)).toBe(encoded);
    expect(decodeFeedback(encoded)).toEqual({ dead, injured });
  });

  it('is symmetric for 2,000 random pairs', () => {
    const rng = mulberry32(2026);
    for (let i = 0; i < 2000; i++) {
      const a = pick(rng, NAIVE_CODES);
      const b = pick(rng, NAIVE_CODES);
      expect(score(a, b)).toBe(score(b, a));
    }
  });

  it('matches an independent reference implementation for every pair of a sample', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 20000; i++) {
      const a = pick(rng, NAIVE_CODES);
      const b = pick(rng, NAIVE_CODES);
      expect(score(a, b)).toBe(naiveScore(a, b));
    }
  });

  it('never produces an invalid feedback value', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 5000; i++) {
      const f = score(pick(rng, NAIVE_CODES), pick(rng, NAIVE_CODES));
      expect(isValidFeedback(f)).toBe(true);
    }
  });
});

describe('isValidCode', () => {
  it.each(['0123', '9876', '0987', '1234'])('accepts %s', (code) => {
    expect(isValidCode(code)).toBe(true);
  });

  it.each([
    '',
    '123',
    '12345',
    '1123',
    '1213',
    '1231',
    '0000',
    'abcd',
    '12a4',
    ' 123',
    '1 23',
    '１２３４',
  ])('rejects %j', (code) => {
    expect(isValidCode(code)).toBe(false);
  });

  it('rejects non-strings', () => {
    for (const v of [1234, null, undefined, [1, 2, 3, 4], {}]) {
      expect(isValidCode(v)).toBe(false);
    }
  });

  it('assertCode returns valid codes and throws on invalid ones', () => {
    expect(assertCode('1234')).toBe('1234');
    expect(() => assertCode('1123', 'secret')).toThrow(/Invalid secret/);
  });
});

const EXPECTED_VALID = [0, 1, 2, 3, 4, 10, 11, 12, 13, 20, 21, 22, 30, 40];

describe('feedback validity', () => {
  it('has exactly 14 valid values', () => {
    expect([...VALID_FEEDBACK].sort((a, b) => a - b)).toEqual(EXPECTED_VALID);
  });

  it('matches the set of scores achievable by real code pairs', () => {
    expect(achievableFeedback()).toEqual(EXPECTED_VALID);
  });

  it.each(EXPECTED_VALID)('accepts %d', (value) => {
    expect(isValidFeedback(value)).toBe(true);
  });

  it('accepts 22 (2 dead, 2 injured)', () => {
    expect(isValidFeedback(22)).toBe(true);
  });

  it.each([31, 32, 33, 41, 44, 50, 14, 23, 24, 34, 42, 43, 100])('rejects %d', (value) => {
    expect(isValidFeedback(value)).toBe(false);
  });

  it.each([-1, 1.5, NaN, Infinity, '12', null, undefined, 4.0000001])('rejects %j', (value) => {
    expect(isValidFeedback(value)).toBe(false);
  });
});

describe('seat helpers', () => {
  it('seat 0 guesses first and seats alternate', () => {
    expect([0, 1, 2, 3].map(guesserOf)).toEqual([0, 1, 0, 1]);
    expect([0, 1, 2, 3].map(answererOf)).toEqual([1, 0, 1, 0]);
    expect([0, 1, 2, 3, 22, 23].map(roundOf)).toEqual([0, 0, 1, 1, 11, 11]);
  });

  it.each([-1, 1.5, NaN, Infinity, -0.5])('reject the invalid index %d', (index) => {
    expect(() => guesserOf(index)).toThrow(RangeError);
    expect(() => answererOf(index)).toThrow(RangeError);
    expect(() => roundOf(index)).toThrow(RangeError);
  });
});

describe('input validation at the trust boundary', () => {
  it.each(['1234\n', '\n1234', '1234 ', '12\n34', '１２３４', '1234\u0000', 'x'.repeat(10_000)])(
    'score rejects the invalid code %j',
    (bad) => {
      expect(() => score(bad, '1234')).toThrow(RangeError);
      expect(() => score('1234', bad)).toThrow(RangeError);
      expect(() => scoreParts(bad, '1234')).toThrow(RangeError);
    },
  );

  it('score rejects non-string input', () => {
    for (const bad of [1234, null, undefined, {}, ['1', '2', '3', '4']]) {
      expect(() => score(bad as unknown as string, '1234')).toThrow(RangeError);
    }
  });

  it('names the offending argument without echoing a huge value', () => {
    expect(() => score('1123', '1234')).toThrow(/Invalid secret/);
    expect(() => score('1234', '1123')).toThrow(/Invalid guess/);
    try {
      score('x'.repeat(100_000), '1234');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(100);
    }
  });

  it('a repeated guess is allowed and scores normally', () => {
    expect(score('1964', '2604')).toBe(score('1964', '2604'));
  });
});

describe('feedback encoding', () => {
  it('round-trips every valid value', () => {
    for (const value of VALID_FEEDBACK) {
      const { dead, injured } = decodeFeedback(value);
      expect(encodeFeedback(dead, injured)).toBe(value);
    }
  });

  it.each([
    [3, 1],
    [2, 3],
    [4, 1],
    [0, 10],
    [-1, 20],
    [2, -10],
    [2, -9],
    [0, -1],
    [-2, 4],
    [1.5, 0],
    [0, 0.5],
    [5, 0],
    [0, 5],
    [NaN, 0],
    [0, Infinity],
  ])('encodeFeedback rejects dead=%d injured=%d', (dead, injured) => {
    expect(() => encodeFeedback(dead, injured)).toThrow(RangeError);
  });

  it.each([31, 13.5, -1, 44, NaN])('decodeFeedback rejects %d', (value) => {
    expect(() => decodeFeedback(value)).toThrow(RangeError);
  });

  it('assertFeedback returns valid values and throws on others', () => {
    expect(assertFeedback(22)).toBe(22);
    expect(() => assertFeedback(31, 'answer')).toThrow(/Invalid answer: 31/);
    expect(() => assertFeedback('22')).toThrow(/Invalid feedback: "22"/);
  });

  it('VALID_FEEDBACK cannot be modified at runtime', () => {
    expect(Object.isFrozen(VALID_FEEDBACK)).toBe(true);
    expect(() => (VALID_FEEDBACK as number[]).push(31)).toThrow(TypeError);
  });
});

/** The feedback values a real score can produce, derived from all pairs of codes. */
function achievableFeedback(): number[] {
  const seen = new Set<number>();
  for (const a of NAIVE_CODES) for (const b of NAIVE_CODES) seen.add(naiveScore(a, b));
  return [...seen].sort((x, y) => x - y);
}
