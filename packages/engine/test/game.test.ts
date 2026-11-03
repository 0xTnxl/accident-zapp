import { describe, expect, it } from 'vitest';
import type { Feedback } from '../src/index.js';
import { findHits, findLies, gameStatus, verdictFromSecrets } from '../src/index.js';

/** `n` misses (feedback 0) followed by the given tail. */
function misses(n: number, ...tail: Feedback[]): Feedback[] {
  return [...Array<Feedback>(n).fill(0), ...tail];
}

describe('gameStatus', () => {
  it('starts with seat 0 to guess index 0', () => {
    expect(gameStatus([])).toEqual({ over: false, next: 0, index: 0, finalGuess: false });
  });

  it('alternates seats', () => {
    expect(gameStatus([0])).toMatchObject({ over: false, next: 1, index: 1 });
    expect(gameStatus([0, 11])).toMatchObject({ over: false, next: 0, index: 2 });
  });

  it('seat 1 hitting first ends the game at once with a seat 1 win', () => {
    // seat 0 guesses at even indices, seat 1 at odd indices
    expect(gameStatus(misses(5, 40))).toEqual({ over: true, result: 'seat1', reason: 'first-hit' });
  });

  it('seat 0 hitting first gives seat 1 one final guess', () => {
    expect(gameStatus(misses(4, 40))).toEqual({ over: false, next: 1, index: 5, finalGuess: true });
  });

  it('seat 0 wins if the final guess of seat 1 misses', () => {
    expect(gameStatus(misses(4, 40, 22))).toEqual({
      over: true,
      result: 'seat0',
      reason: 'final-guess-missed',
    });
  });

  it('is a draw if both hit in the same round', () => {
    expect(gameStatus(misses(4, 40, 40))).toEqual({
      over: true,
      result: 'draw',
      reason: 'equal-round',
    });
  });

  it('seat 0 hitting on the very first guess still gives seat 1 a final guess', () => {
    expect(gameStatus([40])).toMatchObject({ over: false, next: 1, finalGuess: true });
    expect(gameStatus([40, 40])).toMatchObject({ over: true, result: 'draw' });
    expect(gameStatus([40, 0])).toMatchObject({ over: true, result: 'seat0' });
  });

  it('is a draw with no hit after 24 answered guesses', () => {
    expect(gameStatus(misses(23))).toMatchObject({ over: false, next: 1, index: 23 });
    expect(gameStatus(misses(24))).toEqual({ over: true, result: 'draw', reason: 'cap' });
  });

  it('seat 1 can still win on the last guess (index 23)', () => {
    expect(gameStatus(misses(23, 40))).toEqual({
      over: true,
      result: 'seat1',
      reason: 'first-hit',
    });
  });

  it('seat 0 hitting on index 22 still lets seat 1 make the final guess at index 23', () => {
    expect(gameStatus(misses(22, 40))).toMatchObject({
      over: false,
      next: 1,
      index: 23,
      finalGuess: true,
    });
    expect(gameStatus(misses(22, 40, 0))).toMatchObject({ over: true, result: 'seat0' });
    expect(gameStatus(misses(22, 40, 40))).toMatchObject({ over: true, result: 'draw' });
  });

  it('rejects invalid feedback', () => {
    expect(() => gameStatus([31])).toThrow(RangeError);
    expect(() => gameStatus([0, 32])).toThrow(RangeError);
    expect(() => gameStatus([0, 1.5])).toThrow(RangeError);
  });

  it('rejects guesses recorded after the game ended', () => {
    expect(() => gameStatus([0, 40, 0])).toThrow(/after the game ended/);
    expect(() => gameStatus([...misses(24), 0])).toThrow(/after the game ended/);
    expect(() => gameStatus([40, 0, 0])).toThrow(/after the game ended/);
  });
});

describe('verdictFromSecrets', () => {
  const secrets: [string, string] = ['1234', '5678'];

  it('finds the first true hit of each seat', () => {
    // seat 0 guesses indices 0, 2, 4 against secret of seat 1 (5678)
    // seat 1 guesses indices 1, 3, 5 against secret of seat 0 (1234)
    const guesses = ['0123', '0123', '4567', '1234', '5678', '1234'];
    expect(findHits(guesses, secrets)).toEqual([4, 3]);
  });

  it('lower round wins when both hit', () => {
    // seat 1 hits at index 3 (round 1); seat 0 hits at index 4 (round 2)
    expect(verdictFromSecrets(['0123', '0123', '4567', '1234', '5678'], secrets)).toBe('seat1');
    // seat 0 hits at index 2 (round 1); seat 1 hits at index 5 (round 2)
    expect(verdictFromSecrets(['0123', '0123', '5678', '0123', '0123', '1234'], secrets)).toBe(
      'seat0',
    );
  });

  it('equal rounds draw', () => {
    // seat 0 hits at index 2 and seat 1 at index 3, both round 1
    expect(verdictFromSecrets(['0123', '0123', '5678', '1234'], secrets)).toBe('draw');
  });

  it('one hit wins', () => {
    expect(verdictFromSecrets(['5678'], secrets)).toBe('seat0');
    expect(verdictFromSecrets(['0123', '1234'], secrets)).toBe('seat1');
  });

  it('no hit is a draw', () => {
    expect(verdictFromSecrets(['0123', '0123'], secrets)).toBe('draw');
    expect(verdictFromSecrets([], secrets)).toBe('draw');
  });

  it('only counts the first hit of a seat', () => {
    expect(findHits(['5678', '0123', '5678'], secrets)).toEqual([0, undefined]);
  });
});

describe('findLies', () => {
  const guesses = ['2604', '2604', '1234'];

  it('reports answers that contradict the revealed secret', () => {
    // Secret 1964. Seat 1 answers the guesses at indices 0 and 2; seat 0 answers index 1.
    // True scores: '2604' -> 11, '1234' -> 20 (dead at positions 0 and 3).
    expect(findLies(guesses, [11, 11, 20], 1, '1964')).toEqual([]);
    expect(findLies(guesses, [11, 11, 40], 1, '1964')).toEqual([2]);
    expect(findLies(guesses, [0, 11, 40], 1, '1964')).toEqual([0, 2]);
  });

  it('only checks answers given by the requested seat', () => {
    // The wrong answer at index 1 belongs to seat 0, so it is not reported for seat 1.
    expect(findLies(guesses, [11, 99, 20], 1, '1964')).toEqual([]);
    expect(findLies(guesses, [11, 99, 20], 0, '1964')).toEqual([1]);
  });

  it('rejects a revealed secret that is not a valid code', () => {
    expect(() => findLies(guesses, [11], 1, '1123')).toThrow(/Invalid secret/);
    // Even when there is nothing to check, a bad secret is still an error.
    expect(() => findLies([], [], 1, '1123')).toThrow(/Invalid secret/);
    expect(() => findLies([], [], 0, 'abcd')).toThrow(/Invalid secret/);
    expect(() => findHits(guesses, ['1123', '5678'])).toThrow(/Invalid secret of seat 0/);
    expect(() => findHits(guesses, ['1234', 'abcd'])).toThrow(/Invalid secret of seat 1/);
    expect(() => verdictFromSecrets(guesses, ['1234', '55'])).toThrow(RangeError);
  });

  it('throws if a guess it has to check is not a valid code', () => {
    // Index 0 is answered by seat 1, so seat 1's check reaches the invalid guess.
    expect(() => findLies(['2222'], [0], 1, '1964')).toThrow(/Invalid guess/);
    // Seat 0 answers nothing at index 0, so that guess is never scored for seat 0.
    expect(findLies(['2222'], [0], 0, '1964')).toEqual([]);
  });

  it('ignores answers that go beyond the guesses made', () => {
    expect(findLies(['2604'], [11, 0], 0, '1964')).toEqual([]);
    expect(findLies([], [0], 1, '1964')).toEqual([]);
  });
});
