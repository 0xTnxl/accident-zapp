import { describe, expect, it } from 'vitest';
import { averageGuesses, emptyStats, loadStats, recordGame, saveStats } from '../src/lib/stats.js';

describe('stats', () => {
  it('starts empty for every level', () => {
    expect(emptyStats()).toEqual({
      easy: { played: 0, won: 0, lost: 0, drawn: 0, guessesInWins: 0 },
      medium: { played: 0, won: 0, lost: 0, drawn: 0, guessesInWins: 0 },
      hard: { played: 0, won: 0, lost: 0, drawn: 0, guessesInWins: 0 },
    });
  });

  it('records a win, a loss and a draw in the right level only', () => {
    let s = emptyStats();
    s = recordGame(s, 'medium', 'win', 5);
    s = recordGame(s, 'medium', 'loss', 9);
    s = recordGame(s, 'hard', 'draw', 12);
    expect(s.medium).toEqual({ played: 2, won: 1, lost: 1, drawn: 0, guessesInWins: 5 });
    expect(s.hard).toEqual({ played: 1, won: 0, lost: 0, drawn: 1, guessesInWins: 0 });
    expect(s.easy.played).toBe(0);
  });

  it('counts guesses only for wins, so the average is about games won', () => {
    let s = emptyStats();
    s = recordGame(s, 'easy', 'win', 4);
    s = recordGame(s, 'easy', 'win', 8);
    s = recordGame(s, 'easy', 'loss', 12);
    expect(averageGuesses(s.easy)).toBe(6);
    expect(averageGuesses(s.hard)).toBeUndefined();
  });

  it('does not change the stats it was given', () => {
    const before = emptyStats();
    recordGame(before, 'easy', 'win', 3);
    expect(before.easy.played).toBe(0);
  });

  it('saves and loads', () => {
    const s = recordGame(emptyStats(), 'hard', 'win', 6);
    saveStats(s);
    expect(loadStats()).toEqual(s);
  });

  it.each([
    ['nothing saved', null],
    ['corrupt JSON', '{nope'],
    ['JSON null', 'null'],
    ['a number', '5'],
    [
      'negative counts',
      JSON.stringify({ easy: { played: -1, won: 0, lost: 0, drawn: 0, guessesInWins: 0 } }),
    ],
    [
      'fractional counts',
      JSON.stringify({ easy: { played: 1.5, won: 0, lost: 0, drawn: 0, guessesInWins: 0 } }),
    ],
    ['missing fields', JSON.stringify({ easy: { played: 1 } })],
    [
      'wrong types',
      JSON.stringify({ easy: { played: '1', won: 0, lost: 0, drawn: 0, guessesInWins: 0 } }),
    ],
  ])('falls back to zero for %s', (_name, raw) => {
    if (raw !== null) localStorage.setItem('accident:stats:v1', raw);
    expect(loadStats()).toEqual(emptyStats());
  });

  it('keeps the good levels when only one is damaged', () => {
    localStorage.setItem(
      'accident:stats:v1',
      JSON.stringify({
        easy: { played: 1, won: 1, lost: 0, drawn: 0, guessesInWins: 4 },
        hard: { played: 'x' },
      }),
    );
    const s = loadStats();
    expect(s.easy.played).toBe(1);
    expect(s.hard).toEqual(emptyStats().hard);
  });

  it('survives storage that throws, both reading and writing', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(loadStats(broken)).toEqual(emptyStats());
    expect(() => saveStats(emptyStats(), broken)).not.toThrow();
  });
});
