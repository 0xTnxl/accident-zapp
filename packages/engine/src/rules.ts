/**
 * Canonical rules of Accident (Bulls and Cows). See requirements.md REQ-3.
 *
 * A code is a string of exactly 4 distinct digits "0"-"9". Leading zero allowed.
 * Feedback is an integer: dead * 10 + injured.
 *
 * Every function exported here validates its input and throws `RangeError` on bad input,
 * so it is safe to call with data that came from an opponent.
 */

import { scoreUnchecked } from './internal.js';

export type Code = string;
export type Feedback = number;
export type Seat = 0 | 1;

export const CODE_LENGTH = 4;
export const GUESSES_PER_PLAYER = 12;
export const MAX_GUESSES = GUESSES_PER_PLAYER * 2;
export const WIN_FEEDBACK: Feedback = 40;

// `$` without the `m` flag matches only at the very end of the input in JavaScript,
// so a trailing newline is rejected.
const CODE_PATTERN = /^[0-9]{4}$/;

/** True when `value` is a string of 4 distinct digits "0"-"9". */
export function isValidCode(value: unknown): value is Code {
  if (typeof value !== 'string' || !CODE_PATTERN.test(value)) return false;
  return (
    value[0] !== value[1] &&
    value[0] !== value[2] &&
    value[0] !== value[3] &&
    value[1] !== value[2] &&
    value[1] !== value[3] &&
    value[2] !== value[3]
  );
}

/** Returns `value` typed as a code, or throws `RangeError` naming `label`. */
export function assertCode(value: unknown, label = 'code'): Code {
  if (!isValidCode(value)) throw new RangeError(`Invalid ${label}: ${describe(value)}`);
  return value;
}

/** Short, safe description of an untrusted value for error messages. */
function describe(value: unknown): string {
  if (typeof value === 'string')
    return JSON.stringify(value.length > 16 ? `${value.slice(0, 16)}...` : value);
  return typeof value;
}

/**
 * The 14 feedback values that can occur: dead + injured <= 4, excluding 31
 * (3 dead and 1 injured is impossible with distinct digits).
 */
export const VALID_FEEDBACK: readonly Feedback[] = Object.freeze(
  (() => {
    const values: Feedback[] = [];
    for (let dead = 0; dead <= CODE_LENGTH; dead++) {
      for (let injured = 0; dead + injured <= CODE_LENGTH; injured++) {
        if (dead === 3 && injured === 1) continue;
        values.push(dead * 10 + injured);
      }
    }
    return values;
  })(),
);

const VALID_FEEDBACK_SET: ReadonlySet<number> = new Set(VALID_FEEDBACK);

/** True for exactly the 14 feedback values that can occur. Rejects 31 and dead + injured > 4. */
export function isValidFeedback(value: unknown): value is Feedback {
  return typeof value === 'number' && VALID_FEEDBACK_SET.has(value);
}

/** Returns `value` typed as feedback, or throws `RangeError` naming `label`. */
export function assertFeedback(value: unknown, label = 'feedback'): Feedback {
  if (!isValidFeedback(value)) {
    throw new RangeError(
      `Invalid ${label}: ${typeof value === 'number' ? value : describe(value)}`,
    );
  }
  return value;
}

export interface DeadInjured {
  dead: number;
  injured: number;
}

/** Encodes dead and injured as dead * 10 + injured. Throws if the pair cannot occur. */
export function encodeFeedback(dead: number, injured: number): Feedback {
  const inRange = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= CODE_LENGTH;
  if (!inRange(dead) || !inRange(injured)) {
    throw new RangeError(`Invalid dead/injured pair: ${dead}, ${injured}`);
  }
  return assertFeedback(dead * 10 + injured, 'dead/injured pair');
}

/** Splits a valid feedback value into dead and injured. Throws on an invalid value. */
export function decodeFeedback(feedback: Feedback): DeadInjured {
  assertFeedback(feedback);
  return { dead: Math.floor(feedback / 10), injured: feedback % 10 };
}

/**
 * Feedback of `guess` against `secret`, encoded as dead * 10 + injured.
 * Throws `RangeError` if either argument is not a valid code.
 */
export function score(secret: Code, guess: Code): Feedback {
  assertCode(secret, 'secret');
  assertCode(guess, 'guess');
  return scoreUnchecked(secret, guess);
}

/** Dead and injured counts of `guess` against `secret`. Throws if either is not a valid code. */
export function scoreParts(secret: Code, guess: Code): DeadInjured {
  return decodeFeedback(score(secret, guess));
}

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`Invalid guess index: ${index}`);
  }
}

/** The seat that makes guess number `index` (0-based). Seat 0 guesses first. */
export function guesserOf(index: number): Seat {
  assertIndex(index);
  return (index % 2) as Seat;
}

/** The seat that answers guess number `index`. */
export function answererOf(index: number): Seat {
  assertIndex(index);
  return (1 - (index % 2)) as Seat;
}

/** The round (0-based) that guess number `index` belongs to. */
export function roundOf(index: number): number {
  assertIndex(index);
  return Math.floor(index / 2);
}
