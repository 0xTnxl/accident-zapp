import type { Identity } from './messages.js';
import type { MemoTx } from './memo.js';

/**
 * The outside world, as seen by the session. Each port has a real adapter (browser, Solana,
 * Supabase) and an in-memory fake in `testing/`, so whole games run in plain Node.
 */

export type RelayStatus = 'up' | 'down';

/**
 * A realtime channel per room that broadcasts raw strings to the other participant.
 * It may drop, duplicate, delay, reorder or echo messages. It is never trusted.
 */
export interface Transport {
  /** Joins the room's channel. Must call `onStatus('up')` once connected and on every reconnect. */
  join(
    room: string,
    handlers: { onMessage(raw: string): void; onStatus(status: RelayStatus): void },
  ): Promise<void>;
  /** Broadcasts `raw`. May reject when disconnected; the session retries on its own. */
  send(room: string, raw: string): Promise<void>;
  leave(room: string): Promise<void>;
}

/** Solana access, limited to Memo transactions. */
export interface Chain {
  /** Sends a Memo transaction signed by `signer` and returns its signature once submitted. */
  sendMemo(signer: Identity, text: string): Promise<string>;
  /** The transaction with this signature, or `null` if it is not confirmed yet. */
  getMemoTx(sig: string): Promise<MemoTx | null>;
  /** Memo transactions in `room` signed by `address`. The independent audit path. */
  listMemoTxs(address: string, room: string): Promise<MemoTx[]>;
}

/** Persistent key-value storage (localStorage or IndexedDB in the browser). */
export interface Storage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface Clock {
  /** Milliseconds, any epoch. Only differences matter. */
  now(): number;
  /** Runs `fn` after `ms`. Returns a function that cancels it. */
  setTimeout(fn: () => void, ms: number): () => void;
}
