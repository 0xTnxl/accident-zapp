import bs58 from 'bs58';
import type { MemoTx } from '../memo.js';
import { parseMemo } from '../memo.js';
import type { Identity } from '../messages.js';
import type { Chain, Clock, RelayStatus, Storage, Transport } from '../ports.js';

/**
 * In-memory stand-ins for the session's ports. They make whole games run in plain Node and let
 * tests inject the failures that real networks produce. Not part of the production bundle.
 */

// ------------------------------------------------------------------ clock

/** A clock that only moves when told to. */
export class ManualClock implements Clock {
  private time = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, fn });
    return () => {
      this.timers.delete(id);
    };
  }

  /** Moves time forward, firing due timers in order and letting async work settle in between. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      await settle();
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].fn();
    }
    this.time = target;
    await settle();
  }

  get pendingTimers(): number {
    return this.timers.size;
  }
}

/** Lets queued promise callbacks run. Everything in these fakes is microtask based. */
export async function settle(rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// ------------------------------------------------------------------ storage

export class MemoryStorage implements Storage {
  readonly data = new Map<string, string>();
  /** Called before every write. Lets a test observe ordering or simulate a full disk. */
  onSet: ((key: string, value: string) => void) | undefined;

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.onSet?.(key, value);
    this.data.set(key, value);
  }
}

// ------------------------------------------------------------------ relay

export type Frame = { from: string; room: string; raw: string };

/**
 * A relay hub. Each `transport()` is one participant. Messages reach everyone else in the room,
 * never reliably unless the test wants them to.
 */
export class MemoryHub {
  /** Every frame ever sent, in order, including ones the hub then dropped. */
  readonly frames: Frame[] = [];
  /** Return true to lose a frame. */
  drop: ((frame: Frame, to: string) => boolean) | undefined;
  /** Return how many copies to deliver (default 1). */
  copies: ((frame: Frame, to: string) => number) | undefined;
  /** When true, a sender also receives its own frames (some relays echo). */
  echo = false;
  /** When set, frames are held here instead of delivered, so a test can reorder them. */
  hold = false;
  readonly held: Array<() => void> = [];

  private readonly members = new Map<string, Map<string, Member>>();

  transport(name: string): HubTransport {
    return new HubTransport(this, name);
  }

  /** Delivers held frames in the order given by `order` (indexes into `held`). */
  release(order?: number[]): void {
    const batch = this.held.splice(0);
    for (const index of order ?? batch.keys()) batch[index]?.();
  }

  /** Puts a participant offline or back online, as the relay would report it. */
  setLink(name: string, status: RelayStatus): void {
    for (const room of this.members.values()) room.get(name)?.setStatus(status);
  }

  /** Injects a frame as if `from` had sent it, bypassing that participant's session. */
  inject(room: string, from: string, raw: string): void {
    this.deliver({ from, room, raw });
  }

  join(room: string, name: string, member: Member): void {
    const inRoom = this.members.get(room) ?? new Map<string, Member>();
    this.members.set(room, inRoom);
    inRoom.set(name, member);
  }

  leave(room: string, name: string): void {
    this.members.get(room)?.delete(name);
  }

  deliver(frame: Frame): void {
    this.frames.push(frame);
    const inRoom = this.members.get(frame.room);
    if (!inRoom) return;
    for (const [name, member] of inRoom) {
      if (name === frame.from && !this.echo) continue;
      if (!member.online || this.drop?.(frame, name)) continue;
      const n = this.copies?.(frame, name) ?? 1;
      for (let i = 0; i < n; i++) {
        const send = (): void => member.handlers.onMessage(frame.raw);
        if (this.hold) this.held.push(send);
        else queueMicrotask(send);
      }
    }
  }
}

interface Member {
  online: boolean;
  handlers: { onMessage(raw: string): void; onStatus(status: RelayStatus): void };
  setStatus(status: RelayStatus): void;
}

export class HubTransport implements Transport {
  private member: Member | undefined;
  /** Make `send` reject, like a dropped connection. */
  failSends = false;

  constructor(
    private readonly hub: MemoryHub,
    readonly name: string,
  ) {}

  async join(
    room: string,
    handlers: { onMessage(raw: string): void; onStatus(status: RelayStatus): void },
  ): Promise<void> {
    const member: Member = {
      online: true,
      handlers,
      setStatus: (status) => {
        member.online = status === 'up';
        handlers.onStatus(status);
      },
    };
    this.member = member;
    this.hub.join(room, this.name, member);
    handlers.onStatus('up');
  }

  async send(room: string, raw: string): Promise<void> {
    if (this.failSends || !this.member?.online) throw new Error('relay is down');
    this.hub.deliver({ from: this.name, room, raw });
  }

  async leave(room: string): Promise<void> {
    this.hub.leave(room, this.name);
    this.member = undefined;
  }
}

// ------------------------------------------------------------------ chain

/** A tiny Solana: Memo transactions in a list, with controllable confirmation and failures. */
export class MemoryChain implements Chain {
  readonly txs: MemoTx[] = [];
  private counter = 1;
  private slot = 100;
  /** Transactions sent while true stay invisible until {@link confirmAll}. */
  holdBack = false;
  private readonly unconfirmed = new Set<string>();
  /** Make the next N `sendMemo` calls throw. */
  failSends = 0;
  /** Make every lookup throw while true. */
  failReads = false;
  /** Count of calls, for asserting how often the chain was hit. */
  readonly calls = { send: 0, get: 0, list: 0 };

  async sendMemo(signer: Identity, text: string): Promise<string> {
    this.calls.send++;
    if (this.failSends > 0) {
      this.failSends--;
      throw new Error('RPC unavailable');
    }
    return this.post(signer.publicKey, text);
  }

  /** Adds a transaction directly, for scripting another player's records. */
  post(signer: string, text: string, ok = true): string {
    const bytes = new Uint8Array(64);
    new DataView(bytes.buffer).setUint32(0, this.counter++);
    const sig = bs58.encode(bytes);
    this.txs.push({
      sig,
      signer,
      text,
      slot: this.slot++,
      blockTime: 1_700_000_000 + this.slot,
      ok,
    });
    if (this.holdBack) this.unconfirmed.add(sig);
    return sig;
  }

  confirmAll(): void {
    this.unconfirmed.clear();
    this.holdBack = false;
  }

  async getMemoTx(sig: string): Promise<MemoTx | null> {
    this.calls.get++;
    if (this.failReads) throw new Error('RPC unavailable');
    if (this.unconfirmed.has(sig)) return null;
    return this.txs.find((tx) => tx.sig === sig) ?? null;
  }

  async listMemoTxs(address: string, room: string): Promise<MemoTx[]> {
    this.calls.list++;
    if (this.failReads) throw new Error('RPC unavailable');
    return this.txs.filter(
      (tx) =>
        !this.unconfirmed.has(tx.sig) && tx.signer === address && parseMemo(tx.text)?.room === room,
    );
  }
}
