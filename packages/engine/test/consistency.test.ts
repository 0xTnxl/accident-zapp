import { describe, expect, it } from 'vitest';
import type { Code, Feedback, GameStatus, Level, Result, Rng, Seat, Turn } from '../src/index.js';
import {
  LEVELS,
  MAX_GUESSES,
  candidatesFromHistory,
  chooseGuess,
  findLies,
  gameStatus,
  isValidFeedback,
  mulberry32,
  pick,
  randomCode,
  score,
  VALID_FEEDBACK,
  verdictFromSecrets,
} from '../src/index.js';

/**
 * An independent referee that reads feedback by rounds (pairs of answers), unlike
 * `gameStatus`, which scans by index. If the two ever disagree, one has a bug.
 */
function referee(fb: readonly Feedback[]): { over: false } | { over: true; result: Result } {
  for (let round = 0; round < MAX_GUESSES / 2; round++) {
    const first = fb[2 * round]; // seat 0's answer this round
    const second = fb[2 * round + 1]; // seat 1's answer this round
    if (first === undefined) return { over: false };
    if (first === 40) {
      if (second === undefined) return { over: false };
      return { over: true, result: second === 40 ? 'draw' : 'seat0' };
    }
    if (second === undefined) return { over: false };
    if (second === 40) return { over: true, result: 'seat1' };
  }
  return { over: true, result: 'draw' };
}

describe('gameStatus against an independent referee (fuzz)', () => {
  it.each([0.02, 0.08, 0.3])('agrees on random answer streams, hit chance %d', (hitChance) => {
    const rng = mulberry32(Math.round(hitChance * 1000));
    const misses = VALID_FEEDBACK.filter((f) => f !== 40);
    let overGames = 0;

    for (let game = 0; game < 4000; game++) {
      const feedbacks: Feedback[] = [];
      for (;;) {
        const status: GameStatus = gameStatus(feedbacks);
        const expected = referee(feedbacks);
        expect(status.over).toBe(expected.over);
        if (status.over) {
          expect(expected.over && status.result === expected.result).toBe(true);
          overGames++;
          break;
        }
        expect(status.index).toBe(feedbacks.length);
        expect(status.next).toBe((feedbacks.length % 2) as Seat);
        feedbacks.push(rng() < hitChance ? 40 : pick(rng, misses));
      }
    }
    expect(overGames).toBe(4000);
  });
});

/** Plays a full honest game, returning everything needed to check the final verdict. */
function playHonestGame(secrets: [Code, Code], levels: [Level, Level], rng: Rng) {
  const guesses: Code[] = [];
  const feedbacks: Feedback[] = [];
  const history: [Turn[], Turn[]] = [[], []];

  for (;;) {
    const status = gameStatus(feedbacks);
    if (status.over) return { guesses, feedbacks, status };
    const seat = status.next;
    const guess = chooseGuess(levels[seat], candidatesFromHistory(history[seat]), rng);
    if (guess === undefined) throw new Error('Honest answers can never be inconsistent');
    const feedback = score(secrets[1 - seat] as Code, guess);
    history[seat].push({ guess, feedback });
    guesses.push(guess);
    feedbacks.push(feedback);
  }
}

describe('live result and post-reveal verdict agree (model-based)', () => {
  it('for a thousand and more honest games between random players', () => {
    const rng = mulberry32(2026);
    const reasons = new Set<string>();
    const results = new Set<Result>();

    for (let game = 0; game < 1500; game++) {
      const secrets: [Code, Code] = [randomCode(rng), randomCode(rng)];
      // Hard is slow, so it is used sparingly; easy and medium create varied endings.
      const level = (): Level => (rng() < 0.01 ? 'hard' : pick(rng, LEVELS.slice(0, 2)));
      const { guesses, feedbacks, status } = playHonestGame(secrets, [level(), level()], rng);

      if (!status.over) throw new Error('The game must end');
      reasons.add(status.reason);
      results.add(status.result);

      // The verdict computed from the revealed secrets matches what the live rules decided.
      expect(verdictFromSecrets(guesses, secrets)).toBe(status.result);
      // Honest play leaves nothing to find.
      expect(findLies(guesses, feedbacks, 0, secrets[0])).toEqual([]);
      expect(findLies(guesses, feedbacks, 1, secrets[1])).toEqual([]);
    }

    // The sample must actually exercise every ending, or the test proves little.
    expect(results).toEqual(new Set(['seat0', 'seat1', 'draw']));
    expect(reasons.has('first-hit')).toBe(true);
    expect(reasons.has('final-guess-missed')).toBe(true);
    expect(reasons.has('equal-round')).toBe(true);
  }, 120_000);

  it('agrees when nobody hits before the 24-guess cap', () => {
    const secrets: [Code, Code] = ['4567', '8901'];
    const guesses = Array.from({ length: MAX_GUESSES }, () => '0123');
    const feedbacks = [score('8901', '0123'), score('4567', '0123')];
    const all = Array.from({ length: MAX_GUESSES }, (_, i) => feedbacks[i % 2] as Feedback);
    const status = gameStatus(all);
    expect(status).toEqual({ over: true, result: 'draw', reason: 'cap' });
    expect(verdictFromSecrets(guesses, secrets)).toBe('draw');
  });
});

describe('a single lie is always located (model-based)', () => {
  it('flags exactly the altered answer and nothing else', () => {
    const rng = mulberry32(77);
    for (let game = 0; game < 300; game++) {
      const secrets: [Code, Code] = [randomCode(rng), randomCode(rng)];
      const { guesses, feedbacks } = playHonestGame(secrets, ['medium', 'medium'], rng);

      const index = Math.floor(rng() * feedbacks.length);
      const original = feedbacks[index] as Feedback;
      const replacement = pick(
        rng,
        VALID_FEEDBACK.filter((f) => f !== original),
      );
      const tampered = [...feedbacks];
      tampered[index] = replacement;

      const liar = ((index + 1) % 2) as Seat; // the seat that answered guess `index`
      const honest = (1 - liar) as Seat;
      expect(findLies(guesses, tampered, liar, secrets[liar])).toEqual([index]);
      expect(findLies(guesses, tampered, honest, secrets[honest])).toEqual([]);
    }
  });

  it('flags impossible feedback values as lies too', () => {
    const guesses = ['2604'];
    for (const bad of [31, 32, 41, 50, -1, 1.5, NaN]) {
      expect(isValidFeedback(bad)).toBe(false);
      expect(findLies(guesses, [bad], 1, '1964')).toEqual([0]);
    }
  });

  it('a hidden 40 is caught: answering anything but 40 to the true secret', () => {
    // Seat 1 holds 1964 and is guessed exactly, but claims 11.
    expect(findLies(['1964'], [11], 1, '1964')).toEqual([0]);
  });

  it('a false 40 is caught: claiming a hit on a wrong guess', () => {
    expect(findLies(['2604'], [40], 1, '1964')).toEqual([0]);
  });
});
