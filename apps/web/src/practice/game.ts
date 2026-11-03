import type { Code, Feedback, GameStatus, Level, Rng, Turn } from '@accident/engine';
import { gameStatus, isValidCode, randomCode, score } from '@accident/engine';

/**
 * A game against the computer. Seat 0 is the player, who guesses first; seat 1 is the computer.
 * Guess `i` is made by seat `i % 2` and the other side answers it, exactly as in a friend game, so
 * the same engine rules apply. The app answers for the computer because it knows both secrets.
 */
export interface PracticeGame {
  level: Level;
  playerSecret: Code;
  computerSecret: Code;
  guesses: readonly Code[];
  /** The true answer to each guess. Practice has no one to lie, so these are always honest. */
  answers: readonly Feedback[];
}

export function newPracticeGame(level: Level, playerSecret: Code, rng: Rng): PracticeGame {
  if (!isValidCode(playerSecret)) throw new RangeError('A secret is four different digits');
  return { level, playerSecret, computerSecret: randomCode(rng), guesses: [], answers: [] };
}

export function statusOf(game: PracticeGame): GameStatus {
  return gameStatus(game.answers);
}

/** Whose move it is, or undefined when the game is over. */
export function turnOf(game: PracticeGame): 'player' | 'computer' | undefined {
  const status = statusOf(game);
  if (status.over) return undefined;
  return status.next === 0 ? 'player' : 'computer';
}

function add(game: PracticeGame, guess: Code, secretAnswering: Code): PracticeGame {
  return {
    ...game,
    guesses: [...game.guesses, guess],
    answers: [...game.answers, score(secretAnswering, guess)],
  };
}

/** The player guesses; the computer's secret answers. Throws if it is not the player's turn. */
export function playerGuess(game: PracticeGame, guess: string): PracticeGame {
  if (!isValidCode(guess)) throw new RangeError('A guess is four different digits');
  if (turnOf(game) !== 'player') throw new Error("It is not the player's turn");
  return add(game, guess, game.computerSecret);
}

/** The computer guesses; the player's secret answers. Throws if it is not the computer's turn. */
export function computerGuess(game: PracticeGame, guess: Code): PracticeGame {
  if (turnOf(game) !== 'computer') throw new Error("It is not the computer's turn");
  return add(game, guess, game.playerSecret);
}

/** Every guess the computer has made with the answer it got, for choosing the next guess. */
export function computerHistory(game: PracticeGame): Turn[] {
  const history: Turn[] = [];
  game.guesses.forEach((guess, index) => {
    if (index % 2 === 1) history.push({ guess, feedback: game.answers[index] as Feedback });
  });
  return history;
}

/** The player's own guesses with their answers, for the board. */
export interface Row {
  guess: Code;
  feedback: Feedback;
}

export function playerRows(game: PracticeGame): Row[] {
  const rows: Row[] = [];
  game.guesses.forEach((guess, index) => {
    if (index % 2 === 0) rows.push({ guess, feedback: game.answers[index] as Feedback });
  });
  return rows;
}

export function computerRows(game: PracticeGame): Row[] {
  const rows: Row[] = [];
  game.guesses.forEach((guess, index) => {
    if (index % 2 === 1) rows.push({ guess, feedback: game.answers[index] as Feedback });
  });
  return rows;
}

export type PracticeResult = 'win' | 'loss' | 'draw' | undefined;

/** The result from the player's point of view, or undefined while the game is still going. */
export function resultOf(game: PracticeGame): PracticeResult {
  const status = statusOf(game);
  if (!status.over) return undefined;
  return status.result === 'seat0' ? 'win' : status.result === 'seat1' ? 'loss' : 'draw';
}
