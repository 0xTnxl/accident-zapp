import { describe, expect, it } from 'vitest';
import {
  EASY_RANDOM_RATE,
  LEVELS,
  OPENING_GUESS,
  allCodes,
  candidatesFromHistory,
  chooseGuess,
  chooseGuessHard,
  mulberry32,
  score,
} from '../src/index.js';
import { simulate, solve } from './helpers.js';

/** An rng that returns the given values in order. */
function sequence(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i++];
    if (v === undefined) throw new Error('sequence exhausted');
    return v;
  };
}

describe('chooseGuess', () => {
  it.each(['easy', 'medium', 'hard'] as const)(
    '%s opens with 0123 when nothing is known',
    (level) => {
      expect(chooseGuess(level, allCodes(), mulberry32(1))).toBe(OPENING_GUESS);
      expect(OPENING_GUESS).toBe('0123');
    },
  );

  it.each(['easy', 'medium', 'hard'] as const)(
    '%s returns undefined when answers were inconsistent',
    (level) => {
      expect(chooseGuess(level, [], mulberry32(1))).toBeUndefined();
    },
  );

  it('medium only ever picks consistent codes', () => {
    const rng = mulberry32(3);
    const history = [{ guess: '0123', feedback: score('1964', '0123') }];
    const candidates = candidatesFromHistory(history);
    for (let i = 0; i < 200; i++) {
      expect(candidates).toContain(chooseGuess('medium', candidates, rng));
    }
  });

  it('easy picks a code outside the candidates about 35% of the time or fewer', () => {
    const rng = mulberry32(4);
    const candidates = candidatesFromHistory([{ guess: '0123', feedback: score('1964', '0123') }]);
    const set = new Set(candidates);
    let outside = 0;
    const trials = 4000;
    for (let i = 0; i < trials; i++) {
      if (!set.has(chooseGuess('easy', candidates, rng)!)) outside++;
    }
    // Random codes land outside the candidate set most of the time, so the rate is at most EASY_RANDOM_RATE.
    expect(outside / trials).toBeLessThanOrEqual(EASY_RANDOM_RATE + 0.03);
    expect(outside / trials).toBeGreaterThan(0.2);
  });

  it('hard is deterministic', () => {
    const candidates = candidatesFromHistory([{ guess: '0123', feedback: score('1964', '0123') }]);
    expect(chooseGuess('hard', candidates, mulberry32(1))).toBe(
      chooseGuess('hard', candidates, mulberry32(999)),
    );
  });

  it('hard returns the only candidate, or the smallest of two whatever the input order', () => {
    expect(chooseGuessHard(['4321'])).toBe('4321');
    expect(chooseGuessHard(['1234', '4321'])).toBe('1234');
    expect(chooseGuessHard(['4321', '1234'])).toBe('1234');
  });

  it('hard throws when there are no candidates', () => {
    expect(() => chooseGuessHard([])).toThrow(/No candidates/);
  });

  it('hard gives the same answer whatever the order of the candidates', () => {
    const candidates = candidatesFromHistory([{ guess: '0123', feedback: score('1964', '0123') }]);
    const shuffled = [...candidates].reverse();
    expect(chooseGuessHard(shuffled)).toBe(chooseGuessHard(candidates));
  });

  it('hard finds a guess that splits the candidates better than a blind guess', () => {
    const candidates = candidatesFromHistory([{ guess: '0123', feedback: 1 }]);
    const guess = chooseGuessHard(candidates);
    const biggest = (g: string): number => {
      const sizes = new Map<number, number>();
      for (const s of candidates) sizes.set(score(s, g), (sizes.get(score(s, g)) ?? 0) + 1);
      return Math.max(...sizes.values());
    };
    expect(biggest(guess)).toBeLessThan(candidates.length / 3);
  });

  it('easy follows the random branch when the dice say so, and the normal branch otherwise', () => {
    const candidates = candidatesFromHistory([{ guess: '0123', feedback: score('1964', '0123') }]);
    // rng values: first call decides the branch, second picks the element
    const randomBranch = chooseGuess('easy', candidates, sequence([0.1, 0.5]));
    const normalBranch = chooseGuess('easy', candidates, sequence([0.9, 0.5]));
    expect(allCodes()).toContain(randomBranch);
    expect(candidates).toContain(normalBranch);
    expect(randomBranch).toBe(allCodes()[Math.floor(0.5 * allCodes().length)]);
    expect(normalBranch).toBe(candidates[Math.floor(0.5 * candidates.length)]);
  });

  it('lists the three levels', () => {
    expect([...LEVELS]).toEqual(['easy', 'medium', 'hard']);
  });

  it('a Hard move stays fast enough for a slow phone (budget: 2 s here)', () => {
    // The largest class after the opener 0123 is feedback 01 with 1,440 candidates.
    const largest = candidatesFromHistory([{ guess: '0123', feedback: 1 }]);
    expect(largest).toHaveLength(1440);
    const start = performance.now();
    chooseGuessHard(largest);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('hard never increases the worst-case bucket versus a random consistent guess', () => {
    const candidates = candidatesFromHistory([{ guess: '0123', feedback: score('1964', '0123') }]);
    const worst = (guess: string): number => {
      const counts = new Map<number, number>();
      for (const s of candidates)
        counts.set(score(s, guess), (counts.get(score(s, guess)) ?? 0) + 1);
      return Math.max(...counts.values());
    };
    const hard = chooseGuessHard(candidates);
    const rng = mulberry32(8);
    for (let i = 0; i < 50; i++) {
      const other = candidates[Math.floor(rng() * candidates.length)]!;
      expect(worst(hard)).toBeLessThanOrEqual(worst(other));
    }
  });
});

describe('hard strategy golden values', () => {
  // These pin the exact behaviour of the documented rule (minimise the largest bucket, then the
  // sum of squared bucket sizes, then the smallest code), so any change to the tie-break or the
  // search is noticed. They are a regression snapshot of this implementation, not independent
  // ground truth. The totals agree with the PRD figures (average 5.32, worst case 8).
  it('replies to the opener 0123 exactly as recorded', () => {
    const expected: Record<number, [size: number, reply: string]> = {
      0: [360, '4567'],
      1: [1440, '1456'],
      2: [1260, '1435'],
      3: [264, '1204'],
      4: [9, '1230'],
      10: [480, '0456'],
      11: [720, '0245'],
      12: [216, '0234'],
      13: [8, '0231'],
      20: [180, '0145'],
      21: [72, '0134'],
      22: [6, '0132'],
      30: [24, '0124'],
    };
    for (const [feedback, [size, reply]] of Object.entries(expected)) {
      const candidates = candidatesFromHistory([{ guess: '0123', feedback: Number(feedback) }]);
      expect(candidates).toHaveLength(size);
      expect(chooseGuessHard(candidates)).toBe(reply);
    }
  });

  it('solves all 5,040 secrets with exactly the recorded distribution of guess counts', () => {
    const distribution: Record<number, number> = {};
    for (const secret of allCodes()) {
      const n = solve('hard', secret, mulberry32(1));
      distribution[n] = (distribution[n] ?? 0) + 1;
    }
    expect(distribution).toEqual({ 1: 1, 2: 13, 3: 109, 4: 629, 5: 2071, 6: 1917, 7: 297, 8: 3 });
  });
});

describe('solving every secret', () => {
  it('hard averages at most 5.4 guesses with a worst case of at most 8 (all 5,040 secrets)', () => {
    const { average, worst } = simulate('hard', mulberry32(1));
    expect(average).toBeLessThanOrEqual(5.4);
    expect(worst).toBeLessThanOrEqual(8);
  }, 120_000);

  it('medium solves every secret, averaging close to the measured 5.47', () => {
    const { average, worst } = simulate('medium', mulberry32(2));
    expect(average).toBeGreaterThan(5.2);
    expect(average).toBeLessThan(5.7);
    expect(worst).toBeLessThanOrEqual(12);
  }, 120_000);

  it('easy solves every secret, averaging close to the measured 6.3', () => {
    const { average } = simulate('easy', mulberry32(3));
    expect(average).toBeGreaterThan(6.0);
    expect(average).toBeLessThan(6.6);
  }, 120_000);

  it('every level finds a specific secret', () => {
    for (const level of ['easy', 'medium', 'hard'] as const) {
      expect(solve(level, '0987', mulberry32(10))).toBeGreaterThan(0);
    }
  });
});
