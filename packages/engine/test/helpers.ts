import type { Code, Level, Rng, Turn } from '../src/index.js';
import { allCodes, candidatesFromHistory, chooseGuess, score } from '../src/index.js';

export const NAIVE_CODES: Code[] = (() => {
  const out: Code[] = [];
  for (let a = 0; a < 10; a++)
    for (let b = 0; b < 10; b++)
      for (let c = 0; c < 10; c++)
        for (let d = 0; d < 10; d++) {
          if (new Set([a, b, c, d]).size === 4) out.push(`${a}${b}${c}${d}`);
        }
  return out;
})();

/** Independent, slow reference implementation of the feedback rule. */
export function naiveScore(secret: string, guess: string): number {
  let dead = 0;
  let injured = 0;
  for (let i = 0; i < 4; i++) {
    if (guess[i] === secret[i]) dead++;
    else if (secret.includes(guess[i]!)) injured++;
  }
  return dead * 10 + injured;
}

// Hard is deterministic, so identical game states can share one computation.
const hardMemo = new Map<string, Code | undefined>();

function nextGuess(level: Level, history: readonly Turn[], rng: Rng): Code | undefined {
  if (level !== 'hard') return chooseGuess(level, candidatesFromHistory(history), rng);
  const key = history.map((t) => `${t.guess}${t.feedback}`).join(',');
  if (!hardMemo.has(key))
    hardMemo.set(key, chooseGuess(level, candidatesFromHistory(history), rng));
  return hardMemo.get(key);
}

/** Plays the computer against a fixed secret. Returns the number of guesses used. */
export function solve(level: Level, secret: Code, rng: Rng, maxGuesses = 100): number {
  const history: Turn[] = [];
  for (let n = 1; n <= maxGuesses; n++) {
    const guess = nextGuess(level, history, rng);
    if (guess === undefined) throw new Error(`Ran out of candidates for ${secret}`);
    const feedback = score(secret, guess);
    if (feedback === 40) return n;
    history.push({ guess, feedback });
  }
  throw new Error(`Did not solve ${secret} in ${maxGuesses} guesses`);
}

export function simulate(level: Level, rng: Rng): { average: number; worst: number } {
  let total = 0;
  let worst = 0;
  const codes = allCodes();
  for (const secret of codes) {
    const n = solve(level, secret, rng);
    total += n;
    if (n > worst) worst = n;
  }
  return { average: total / codes.length, worst };
}
