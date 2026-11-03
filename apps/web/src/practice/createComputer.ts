import type { ComputerPlayer, WorkerLike } from './computer.js';
import { InlineComputer, WorkerComputer } from './computer.js';

/**
 * Makes the computer opponent: a Web Worker where the browser has one, so Hard never freezes the
 * page, and the main thread otherwise.
 */
export function createComputer(): ComputerPlayer {
  if (typeof Worker === 'undefined') return new InlineComputer();
  try {
    const worker = new Worker(new URL('./computer.worker.ts', import.meta.url), { type: 'module' });
    return new WorkerComputer(worker as unknown as WorkerLike);
  } catch {
    return new InlineComputer();
  }
}
