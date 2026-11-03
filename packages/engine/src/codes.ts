import { scoreUnchecked } from './internal.js';
import type { Code, Feedback } from './rules.js';
import { CODE_LENGTH, assertCode, isValidCode } from './rules.js';

let cache: readonly Code[] | undefined;

/**
 * All 5,040 valid codes (10 x 9 x 8 x 7), in ascending order "0123" ... "9876".
 * The returned array is shared and frozen. Copy before mutating.
 */
export function allCodes(): readonly Code[] {
  if (cache) return cache;
  const codes: Code[] = [];
  for (let n = 0; n < 10 ** CODE_LENGTH; n++) {
    const code = String(n).padStart(CODE_LENGTH, '0');
    if (isValidCode(code)) codes.push(code);
  }
  cache = Object.freeze(codes);
  return cache;
}

/**
 * Candidates that would have produced `feedback` for `guess`.
 *
 * `guess` must be a valid code (throws `RangeError` otherwise). `candidates` are trusted to be
 * valid codes, as they normally come from {@link allCodes}. A `feedback` value that cannot occur
 * simply matches no candidate, so the result is empty.
 */
export function filterCandidates(
  candidates: readonly Code[],
  guess: Code,
  feedback: Feedback,
): Code[] {
  assertCode(guess, 'guess');
  return candidates.filter((secret) => scoreUnchecked(secret, guess) === feedback);
}

/** One answered guess. */
export interface Turn {
  guess: Code;
  feedback: Feedback;
}

/**
 * Codes consistent with every (guess, feedback) pair in `history`.
 * An empty result means the answers contradict each other, so someone gave a wrong answer.
 */
export function candidatesFromHistory(history: readonly Turn[]): Code[] {
  let candidates: Code[] = [...allCodes()];
  for (const turn of history) {
    candidates = filterCandidates(candidates, turn.guess, turn.feedback);
  }
  return candidates;
}
