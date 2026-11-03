import { allCodes } from './codes.js';
import { scoreUnchecked } from './internal.js';
import type { Rng } from './rng.js';
import { pick } from './rng.js';
import type { Code } from './rules.js';

export const LEVELS = ['easy', 'medium', 'hard'] as const;
export type Level = (typeof LEVELS)[number];

/** Fixed first guess for the computer, as measured in the PRD (section 7). */
export const OPENING_GUESS: Code = '0123';

/** Probability that Easy ignores what it knows and guesses any random code. */
export const EASY_RANDOM_RATE = 0.35;

/**
 * Hard strategy: among consistent codes, minimise the worst-case remaining candidates,
 * tie-break by the smallest sum of squared bucket sizes, then by the smallest code.
 * Deterministic, so the result is reproducible.
 */
export function chooseGuessHard(candidates: readonly Code[]): Code {
  const first = candidates[0];
  if (first === undefined) throw new RangeError('No candidates left');
  if (candidates.length === 1) return first;

  let best: Code = first;
  let bestMax = Infinity;
  let bestSumSquares = Infinity;

  for (const guess of candidates) {
    const buckets = new Uint16Array(45);
    for (const secret of candidates) buckets[scoreUnchecked(secret, guess)]!++;

    let max = 0;
    let sumSquares = 0;
    for (let i = 0; i < buckets.length; i++) {
      const size = buckets[i]!;
      if (size > max) max = size;
      sumSquares += size * size;
    }

    if (
      max < bestMax ||
      (max === bestMax && sumSquares < bestSumSquares) ||
      (max === bestMax && sumSquares === bestSumSquares && guess < best)
    ) {
      best = guess;
      bestMax = max;
      bestSumSquares = sumSquares;
    }
  }
  return best;
}

/**
 * Chooses the computer's next guess.
 *
 * `candidates` are the secrets still consistent with every answer so far
 * (see `candidatesFromHistory`). When nothing is known yet (all 5,040 codes), every level
 * opens with {@link OPENING_GUESS}.
 *
 * - easy: {@link EASY_RANDOM_RATE} of the time a random code of any kind, else as medium.
 * - medium: a random consistent code.
 * - hard: {@link chooseGuessHard}.
 *
 * Returns `undefined` if `candidates` is empty, which means the answers given were inconsistent.
 */
export function chooseGuess(level: Level, candidates: readonly Code[], rng: Rng): Code | undefined {
  if (candidates.length === 0) return undefined;
  const universe = allCodes();
  if (candidates.length === universe.length) return OPENING_GUESS;

  switch (level) {
    case 'hard':
      return chooseGuessHard(candidates);
    case 'medium':
      return pick(rng, candidates);
    case 'easy':
      return rng() < EASY_RANDOM_RATE ? pick(rng, universe) : pick(rng, candidates);
  }
}
