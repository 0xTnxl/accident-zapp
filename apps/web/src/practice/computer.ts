import type { Code, Level, Turn } from '@accident/engine';
import { candidatesFromHistory, chooseGuess } from '@accident/engine';

/** Chooses the computer's next guess. Hard can take a noticeable moment on a slow phone. */
export interface ComputerPlayer {
  choose(level: Level, history: readonly Turn[]): Promise<Code>;
  /** Stops any background work. */
  dispose(): void;
}

/** Picks a guess right now, on the calling thread. Used in tests and as the worker's fallback. */
export function chooseNow(level: Level, history: readonly Turn[], rng: () => number): Code {
  const candidates = candidatesFromHistory([...history]);
  // Honest answers can never contradict each other, so there is always a candidate.
  return chooseGuess(level, candidates, rng) as Code;
}

/** Runs on the main thread. Fine for tests and for Easy and Medium; Hard may stall the page. */
export class InlineComputer implements ComputerPlayer {
  constructor(private readonly rng: () => number = Math.random) {}

  async choose(level: Level, history: readonly Turn[]): Promise<Code> {
    return chooseNow(level, history, this.rng);
  }

  dispose(): void {}
}

export interface WorkerRequest {
  id: number;
  level: Level;
  history: Turn[];
}

export type WorkerReply = { id: number; guess: Code } | { id: number; error: string };

/** The small part of `Worker` this class needs, so a test can supply a fake. */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  terminate(): void;
  onmessage: ((event: { data: WorkerReply }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
}

/**
 * Runs the computer in a Web Worker so the page stays responsive while Hard thinks. If the worker
 * fails, the request falls back to the main thread so the game can always continue.
 */
export class WorkerComputer implements ComputerPlayer {
  /**
   * How long to wait for the worker before computing on the main thread instead. A worker whose
   * script cannot be loaded (for example offline, before it was cached) never replies and never
   * raises an error, so without this the game would wait forever.
   */
  static readonly REPLY_TIMEOUT_MS = 4000;

  private nextId = 0;
  private readonly watchdogs = new Set<ReturnType<typeof setTimeout>>();
  private readonly waiting = new Map<number, (reply: WorkerReply) => void>();
  private disposed = false;

  constructor(
    private readonly worker: WorkerLike,
    private readonly fallbackRng: () => number = Math.random,
    private readonly timeoutMs: number = WorkerComputer.REPLY_TIMEOUT_MS,
  ) {
    worker.onmessage = (event) => {
      this.waiting.get(event.data.id)?.(event.data);
      this.waiting.delete(event.data.id);
    };
    worker.onerror = () => {
      // Answer everything waiting from the main thread instead of hanging the game.
      for (const [id, resolve] of [...this.waiting]) {
        resolve({ id, error: 'worker failed' });
        this.waiting.delete(id);
      }
    };
  }

  choose(level: Level, history: readonly Turn[]): Promise<Code> {
    if (this.disposed) return Promise.reject(new Error('The computer was stopped'));
    const id = this.nextId++;
    return new Promise<Code>((resolve) => {
      let settled = false;
      const finish = (guess: Code): void => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        this.watchdogs.delete(watchdog);
        this.waiting.delete(id);
        resolve(guess);
      };
      const fallback = (): void => finish(chooseNow(level, history, this.fallbackRng));
      const watchdog = setTimeout(fallback, this.timeoutMs);
      this.watchdogs.add(watchdog);

      this.waiting.set(id, (reply) => {
        if ('guess' in reply) finish(reply.guess);
        else fallback();
      });
      try {
        this.worker.postMessage({ id, level, history: [...history] });
      } catch {
        fallback();
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    // Leaving the screen must not trigger a slow main-thread computation for nobody.
    for (const watchdog of this.watchdogs) clearTimeout(watchdog);
    this.watchdogs.clear();
    this.worker.terminate();
    this.waiting.clear();
  }
}
