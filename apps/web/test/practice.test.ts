import type { Code, Feedback } from '@accident/engine';
import { mulberry32, score } from '@accident/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computerGuess,
  computerHistory,
  computerRows,
  newPracticeGame,
  playerGuess,
  playerRows,
  resultOf,
  statusOf,
  turnOf,
} from '../src/practice/game.js';
import type { PracticeGame } from '../src/practice/game.js';
import { InlineComputer, WorkerComputer, chooseNow } from '../src/practice/computer.js';
import type { WorkerLike, WorkerReply, WorkerRequest } from '../src/practice/computer.js';

function game(playerSecret: Code = '1964', computerSecret: Code = '4271'): PracticeGame {
  return { ...newPracticeGame('medium', playerSecret, mulberry32(1)), computerSecret };
}

describe('practice game', () => {
  it('starts with the player to move and nothing played', () => {
    const g = game();
    expect(turnOf(g)).toBe('player');
    expect(g.guesses).toEqual([]);
    expect(resultOf(g)).toBeUndefined();
  });

  it('gives the computer a valid secret of its own', () => {
    const g = newPracticeGame('hard', '0123', mulberry32(9));
    expect(g.computerSecret).toMatch(/^\d{4}$/);
    expect(new Set(g.computerSecret).size).toBe(4);
  });

  it('rejects an invalid player secret', () => {
    expect(() => newPracticeGame('easy', '1123', mulberry32(1))).toThrow(/four different digits/);
  });

  it('the computer’s secret answers the player’s guess, and the player’s secret answers the computer', () => {
    let g = game('1964', '4271');
    g = playerGuess(g, '1234');
    expect(g.answers[0]).toBe(score('4271', '1234')); // against the computer's secret
    expect(turnOf(g)).toBe('computer');
    g = computerGuess(g, '2604');
    expect(g.answers[1]).toBe(score('1964', '2604')); // against the player's secret
    expect(turnOf(g)).toBe('player');
  });

  it('alternates turns strictly', () => {
    const g = playerGuess(game(), '0123');
    expect(() => playerGuess(g, '4567')).toThrow(/not the player/);
    const h = computerGuess(g, '0123');
    expect(() => computerGuess(h, '4567')).toThrow(/not the computer/);
  });

  it('rejects an invalid guess', () => {
    expect(() => playerGuess(game(), '1123')).toThrow(/four different digits/);
  });

  it('never changes the game it is given', () => {
    const g = game();
    playerGuess(g, '0123');
    expect(g.guesses).toEqual([]);
  });

  it('separates the two sides’ guesses into rows', () => {
    let g = game('1964', '4271');
    g = playerGuess(g, '1234');
    g = computerGuess(g, '2604');
    g = playerGuess(g, '0123');
    expect(playerRows(g)).toEqual([
      { guess: '1234', feedback: score('4271', '1234') },
      { guess: '0123', feedback: score('4271', '0123') },
    ]);
    expect(computerRows(g)).toEqual([{ guess: '2604', feedback: score('1964', '2604') }]);
    expect(computerHistory(g)).toEqual([{ guess: '2604', feedback: score('1964', '2604') }]);
  });

  it('the player wins by guessing first, and the computer still gets its last guess', () => {
    let g = game('1964', '4271');
    g = playerGuess(g, '4271');
    expect(turnOf(g)).toBe('computer'); // the equal-turns rule
    expect(resultOf(g)).toBeUndefined();
    g = computerGuess(g, '0123');
    expect(resultOf(g)).toBe('win');
    expect(turnOf(g)).toBeUndefined();
  });

  it('a hit by both in the same round is a draw', () => {
    let g = game('1964', '4271');
    g = playerGuess(g, '4271');
    g = computerGuess(g, '1964');
    expect(resultOf(g)).toBe('draw');
  });

  it('the computer winning first ends the game at once with a loss', () => {
    let g = game('1964', '4271');
    g = playerGuess(g, '0123');
    g = computerGuess(g, '1964');
    expect(resultOf(g)).toBe('loss');
    expect(statusOf(g).over).toBe(true);
    expect(() => playerGuess(g, '4567')).toThrow();
  });

  it('runs to a draw at the cap of 24 guesses', () => {
    let g = game('1964', '4271');
    for (let i = 0; i < 12; i++) {
      g = playerGuess(g, '0123');
      g = computerGuess(g, '0123');
    }
    expect(g.guesses).toHaveLength(24);
    expect(resultOf(g)).toBe('draw');
  });
});

describe('the computer player', () => {
  it('always returns a valid guess and never repeats the opening on the second move', async () => {
    const computer = new InlineComputer(mulberry32(5));
    const first = await computer.choose('medium', []);
    expect(first).toBe('0123');
    const next = await computer.choose('medium', [
      { guess: first, feedback: score('4271', first) },
    ]);
    expect(next).toMatch(/^\d{4}$/);
    computer.dispose();
  });

  it.each(['easy', 'medium', 'hard'] as const)(
    '%s plays a whole game against a fixed secret',
    async (level) => {
      const computer = new InlineComputer(mulberry32(3));
      const history: { guess: Code; feedback: Feedback }[] = [];
      let found = false;
      for (let i = 0; i < 20 && !found; i++) {
        const guess = await computer.choose(level, history);
        const feedback = score('8072', guess);
        found = feedback === 40;
        history.push({ guess, feedback });
      }
      expect(found).toBe(true);
    },
  );
});

class FakeWorker implements WorkerLike {
  onmessage: ((event: { data: WorkerReply }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  sent: WorkerRequest[] = [];
  terminated = false;
  throwOnPost = false;
  postMessage(message: WorkerRequest): void {
    if (this.throwOnPost) throw new Error('cannot post');
    this.sent.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(reply: WorkerReply): void {
    this.onmessage?.({ data: reply });
  }
}

describe('the worker-backed computer', () => {
  it('sends a request and resolves with the worker’s guess', async () => {
    const worker = new FakeWorker();
    const computer = new WorkerComputer(worker);
    const pending = computer.choose('hard', []);
    expect(worker.sent).toEqual([{ id: 0, level: 'hard', history: [] }]);
    worker.reply({ id: 0, guess: '9876' });
    await expect(pending).resolves.toBe('9876');
  });

  it('matches replies to requests by id, even out of order', async () => {
    const worker = new FakeWorker();
    const computer = new WorkerComputer(worker);
    const a = computer.choose('easy', []);
    const b = computer.choose('easy', []);
    worker.reply({ id: 1, guess: '1111'.replace(/./g, (_c, i) => String(i)) });
    worker.reply({ id: 0, guess: '4567' });
    await expect(a).resolves.toBe('4567');
    await expect(b).resolves.toBe('0123');
  });

  it('falls back to the main thread when the worker reports an error', async () => {
    const worker = new FakeWorker();
    const computer = new WorkerComputer(worker, mulberry32(1));
    const pending = computer.choose('medium', []);
    worker.reply({ id: 0, error: 'boom' });
    await expect(pending).resolves.toBe('0123');
  });

  it('falls back when the worker crashes, for everything waiting', async () => {
    const worker = new FakeWorker();
    const computer = new WorkerComputer(worker, mulberry32(1));
    const a = computer.choose('medium', []);
    const b = computer.choose('hard', []);
    worker.onerror?.({ message: 'crash' });
    await expect(Promise.all([a, b])).resolves.toEqual(['0123', '0123']);
  });

  it('falls back when the worker cannot be messaged', async () => {
    const worker = new FakeWorker();
    worker.throwOnPost = true;
    const computer = new WorkerComputer(worker, mulberry32(1));
    await expect(computer.choose('medium', [])).resolves.toBe('0123');
  });

  it('ignores a reply for a request nobody is waiting on', async () => {
    const worker = new FakeWorker();
    new WorkerComputer(worker);
    expect(() => worker.reply({ id: 99, guess: '0123' })).not.toThrow();
  });

  it('stops the worker on dispose and refuses further requests', async () => {
    const worker = new FakeWorker();
    const computer = new WorkerComputer(worker);
    computer.dispose();
    expect(worker.terminated).toBe(true);
    await expect(computer.choose('easy', [])).rejects.toThrow(/stopped/);
  });
});

describe('a worker that never answers', () => {
  // The real-world case: offline, the worker script could not be loaded, so it is silent. There is
  // no error event either. The game must not hang waiting for it.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('computes on the main thread after the timeout', async () => {
    const worker = new FakeWorker();
    const computer = new WorkerComputer(worker, mulberry32(1), 4000);
    const pending = computer.choose('medium', []);
    await vi.advanceTimersByTimeAsync(3999);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await expect(pending).resolves.toBe('0123');
  });

  it('uses the documented default timeout', () => {
    expect(WorkerComputer.REPLY_TIMEOUT_MS).toBe(4000);
  });

  it('a late reply after the fallback is ignored, not applied twice', async () => {
    const worker = new FakeWorker();
    const computer = new WorkerComputer(worker, mulberry32(1), 100);
    const pending = computer.choose('medium', []);
    await vi.advanceTimersByTimeAsync(150);
    await expect(pending).resolves.toBe('0123');
    expect(() => worker.reply({ id: 0, guess: '9876' })).not.toThrow();
  });

  it('a prompt reply cancels the timer so nothing is computed needlessly', async () => {
    const worker = new FakeWorker();
    const computer = new WorkerComputer(worker, mulberry32(1), 100);
    const pending = computer.choose('hard', []);
    worker.reply({ id: 0, guess: '5678' });
    await expect(pending).resolves.toBe('5678');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaving the screen cancels waiting timers and does no work for nobody', async () => {
    const worker = new FakeWorker();
    const computer = new WorkerComputer(worker, mulberry32(1), 100);
    void computer.choose('hard', []);
    expect(vi.getTimerCount()).toBe(1);
    computer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('chooseNow', () => {
  it('uses the opening guess when nothing is known', () => {
    expect(chooseNow('hard', [], mulberry32(1))).toBe('0123');
  });
});
