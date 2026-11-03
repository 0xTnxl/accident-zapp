import type { Level } from '@accident/engine';
import { LEVELS } from '@accident/engine';

export interface LevelStats {
  played: number;
  won: number;
  lost: number;
  drawn: number;
  /** Total guesses the player used across games they won, for the average. */
  guessesInWins: number;
}

export type Stats = Record<Level, LevelStats>;

const KEY = 'accident:stats:v1';

const empty = (): LevelStats => ({ played: 0, won: 0, lost: 0, drawn: 0, guessesInWins: 0 });

export function emptyStats(): Stats {
  return { easy: empty(), medium: empty(), hard: empty() };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Reads saved stats. Anything damaged or unexpected starts from zero rather than crashing. */
export function loadStats(storage: Pick<Storage, 'getItem'> = localStorage): Stats {
  const stats = emptyStats();
  try {
    const raw = JSON.parse(storage.getItem(KEY) ?? 'null') as Record<
      string,
      Partial<LevelStats>
    > | null;
    if (!raw || typeof raw !== 'object') return stats;
    for (const level of LEVELS) {
      const saved = raw[level];
      if (!saved) continue;
      const fields = ['played', 'won', 'lost', 'drawn', 'guessesInWins'] as const;
      if (fields.every((f) => isCount(saved[f]))) stats[level] = saved as LevelStats;
    }
  } catch {
    // Corrupt JSON or storage blocked: show empty stats.
  }
  return stats;
}

export type Outcome = 'win' | 'loss' | 'draw';

/** Returns new stats with one finished game added. `guesses` is how many the player made. */
export function recordGame(stats: Stats, level: Level, outcome: Outcome, guesses: number): Stats {
  const before = stats[level];
  return {
    ...stats,
    [level]: {
      played: before.played + 1,
      won: before.won + (outcome === 'win' ? 1 : 0),
      lost: before.lost + (outcome === 'loss' ? 1 : 0),
      drawn: before.drawn + (outcome === 'draw' ? 1 : 0),
      guessesInWins: before.guessesInWins + (outcome === 'win' ? guesses : 0),
    },
  };
}

export function saveStats(stats: Stats, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(KEY, JSON.stringify(stats));
  } catch {
    // Private mode or a full disk: stats are a nicety, never worth failing a game over.
  }
}

/** Average guesses in games won, or undefined when there are none. */
export function averageGuesses(stats: LevelStats): number | undefined {
  return stats.won === 0 ? undefined : stats.guessesInWins / stats.won;
}
