import { describe, expect, it } from 'vitest';
import {
  allCodes,
  candidatesFromHistory,
  filterCandidates,
  isValidCode,
  mulberry32,
  pick,
  score,
} from '../src/index.js';
import { NAIVE_CODES } from './helpers.js';

describe('allCodes', () => {
  it('returns exactly 5,040 valid distinct codes', () => {
    const codes = allCodes();
    expect(codes).toHaveLength(5040);
    expect(new Set(codes).size).toBe(5040);
    expect(codes.every(isValidCode)).toBe(true);
  });

  it('is in ascending order and includes leading zeros', () => {
    const codes = allCodes();
    expect(codes[0]).toBe('0123');
    expect(codes[codes.length - 1]).toBe('9876');
    expect([...codes].sort()).toEqual([...codes]);
    expect(codes).toContain('0987');
  });

  it('agrees with an independent enumeration', () => {
    expect([...allCodes()]).toEqual(NAIVE_CODES);
  });

  it('is frozen so callers cannot corrupt the shared list', () => {
    expect(Object.isFrozen(allCodes())).toBe(true);
  });
});

describe('filterCandidates', () => {
  it('always keeps the true secret', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 300; i++) {
      const secret = pick(rng, allCodes());
      let candidates = [...allCodes()];
      for (let turn = 0; turn < 6; turn++) {
        const guess = pick(rng, allCodes());
        candidates = filterCandidates(candidates, guess, score(secret, guess));
        expect(candidates).toContain(secret);
      }
    }
  });

  it('never grows the candidate set', () => {
    const rng = mulberry32(5);
    const secret = pick(rng, allCodes());
    let candidates = [...allCodes()];
    for (let turn = 0; turn < 8; turn++) {
      const guess = pick(rng, allCodes());
      const next = filterCandidates(candidates, guess, score(secret, guess));
      expect(next.length).toBeLessThanOrEqual(candidates.length);
      candidates = next;
    }
  });

  it('rejects a guess that is not a valid code, even for an empty candidate list', () => {
    for (const bad of ['abcd', '1123', '12', '1234\n']) {
      expect(() => filterCandidates(allCodes(), bad, 0)).toThrow(/Invalid guess/);
      expect(() => filterCandidates([], bad, 0)).toThrow(/Invalid guess/);
      expect(() => candidatesFromHistory([{ guess: bad, feedback: 0 }])).toThrow(RangeError);
    }
  });

  it('an impossible feedback value matches nothing instead of throwing', () => {
    expect(filterCandidates(allCodes(), '0123', 31)).toEqual([]);
    expect(filterCandidates(allCodes(), '0123', 99)).toEqual([]);
  });

  it('leaves only the secret after a 4-dead answer', () => {
    expect(filterCandidates(allCodes(), '1234', 40)).toEqual(['1234']);
  });

  it('returns an empty list for contradictory answers', () => {
    const history = [
      { guess: '1234', feedback: 40 },
      { guess: '5678', feedback: 40 },
    ];
    expect(candidatesFromHistory(history)).toEqual([]);
  });

  it('candidatesFromHistory applies every turn', () => {
    const secret = '1964';
    const history = ['0123', '4567', '2604'].map((guess) => ({
      guess,
      feedback: score(secret, guess),
    }));
    const candidates = candidatesFromHistory(history);
    expect(candidates).toContain(secret);
    for (const c of candidates) {
      for (const turn of history) expect(score(c, turn.guess)).toBe(turn.feedback);
    }
  });
});
