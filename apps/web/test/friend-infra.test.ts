import { identityFromSecretKey } from '@accident/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SimChain } from '../src/friend/simChain.js';
import type {
  BroadcastChannelLike,
  RealtimeChannelLike,
  RealtimeClientLike,
} from '../src/friend/transports.js';
import { EVENT, SupabaseTransport, TabTransport } from '../src/friend/transports.js';
import {
  LocalSessionStorage,
  hasIdentity,
  loadOrCreateIdentity,
  realClock,
  requestPersistence,
} from '../src/friend/vault.js';

describe('the burner key vault', () => {
  it('creates a key on first use and gives the same one afterwards', () => {
    expect(hasIdentity()).toBe(false);
    const first = loadOrCreateIdentity();
    expect(hasIdentity()).toBe(true);
    expect(loadOrCreateIdentity().publicKey).toBe(first.publicKey);
  });

  it('stores a key that can sign, and is a real 64 byte secret key', () => {
    const identity = loadOrCreateIdentity();
    const saved = JSON.parse(localStorage.getItem('accident:burner:v1') as string) as number[];
    expect(saved).toHaveLength(64);
    expect(identityFromSecretKey(Uint8Array.from(saved)).publicKey).toBe(identity.publicKey);
  });

  it.each([
    ['not JSON', 'nope'],
    ['not an array', '{"a":1}'],
    ['the wrong length', JSON.stringify([1, 2, 3])],
    ['bytes out of range', JSON.stringify(Array(64).fill(300))],
    ['fractional bytes', JSON.stringify(Array(64).fill(1.5))],
    ['halves that disagree', JSON.stringify(Array(64).fill(7))],
  ])('replaces a damaged key (%s) instead of crashing', (_name, raw) => {
    localStorage.setItem('accident:burner:v1', raw);
    expect(hasIdentity()).toBe(false);
    const identity = loadOrCreateIdentity();
    expect(identity.publicKey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(hasIdentity()).toBe(true);
  });

  it('a different browser profile gets a different key', () => {
    const a = loadOrCreateIdentity();
    localStorage.clear();
    expect(loadOrCreateIdentity().publicKey).not.toBe(a.publicKey);
  });
});

describe('persistence request', () => {
  it('returns what the browser answers', async () => {
    expect(await requestPersistence({ storage: { persist: async () => true } })).toBe(true);
    expect(await requestPersistence({ storage: { persist: async () => false } })).toBe(false);
  });

  it('copes with a browser that has no such API, or one that throws', async () => {
    expect(await requestPersistence({})).toBe(false);
    expect(await requestPersistence({ storage: {} })).toBe(false);
    expect(
      await requestPersistence({
        storage: {
          persist: async () => {
            throw new Error('denied');
          },
        },
      }),
    ).toBe(false);
  });
});

describe('session storage and clock', () => {
  it('reads what it wrote and returns null for a missing key', async () => {
    const storage = new LocalSessionStorage();
    expect(await storage.get('k')).toBeNull();
    await storage.set('k', 'v');
    expect(await storage.get('k')).toBe('v');
  });

  it('lets a storage failure reach the session rather than hiding it', async () => {
    const full = new LocalSessionStorage({
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    });
    await expect(full.set('k', 'v')).rejects.toThrow(/quota/);
  });

  it('the real clock reports time and can cancel a timer', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const cancel = realClock.setTimeout(fn, 100);
    cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
    realClock.setTimeout(fn, 100);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
    expect(typeof realClock.now()).toBe('number');
    vi.useRealTimers();
  });
});

class FakeRealtimeChannel implements RealtimeChannelLike {
  listener: ((message: { payload?: unknown }) => void) | undefined;
  statusCallback: ((status: string) => void) | undefined;
  sent: unknown[] = [];
  sendResult = 'ok';
  on(_type: 'broadcast', _filter: { event: string }, callback: (m: { payload?: unknown }) => void) {
    this.listener = callback;
    return this;
  }
  subscribe(callback: (status: string) => void) {
    this.statusCallback = callback;
    return this;
  }
  async send(message: { type: 'broadcast'; event: string; payload: unknown }): Promise<string> {
    this.sent.push(message);
    return this.sendResult;
  }
}

class FakeRealtimeClient implements RealtimeClientLike {
  channels: Array<{ name: string; options: unknown; channel: FakeRealtimeChannel }> = [];
  removed: unknown[] = [];
  channel(name: string, options: { config: { broadcast: { self: boolean; ack: boolean } } }) {
    const channel = new FakeRealtimeChannel();
    this.channels.push({ name, options, channel });
    return channel;
  }
  async removeChannel(channel: RealtimeChannelLike) {
    this.removed.push(channel);
  }
}

describe('the Supabase relay transport', () => {
  function setup() {
    const client = new FakeRealtimeClient();
    const transport = new SupabaseTransport(client);
    const messages: string[] = [];
    const statuses: string[] = [];
    const handlers = {
      onMessage: (raw: string) => messages.push(raw),
      onStatus: (status: string) => statuses.push(status),
    };
    return { client, transport, messages, statuses, handlers };
  }

  it('joins a channel named for the room, with no self-echo and acknowledged sends', async () => {
    const { client, transport, handlers } = setup();
    const joined = transport.join('ABC234', handlers as never);
    const { name, options, channel } = client.channels[0] as (typeof client.channels)[number];
    expect(name).toBe('accident:ABC234');
    expect(options).toEqual({ config: { broadcast: { self: false, ack: true } } });
    channel.statusCallback?.('SUBSCRIBED');
    await joined;
  });

  it('reports up when subscribed and down for anything else, including on reconnects', async () => {
    const { client, transport, statuses, handlers } = setup();
    const joined = transport.join('ABC234', handlers as never);
    const channel = (client.channels[0] as (typeof client.channels)[number]).channel;
    channel.statusCallback?.('SUBSCRIBED');
    await joined;
    channel.statusCallback?.('CHANNEL_ERROR');
    channel.statusCallback?.('TIMED_OUT');
    channel.statusCallback?.('CLOSED');
    channel.statusCallback?.('SUBSCRIBED');
    expect(statuses).toEqual(['up', 'down', 'down', 'down', 'up']);
  });

  it('resolves join even if the first status is a failure, so the session can keep retrying', async () => {
    const { client, transport, handlers } = setup();
    const joined = transport.join('ABC234', handlers as never);
    (client.channels[0] as (typeof client.channels)[number]).channel.statusCallback?.(
      'CHANNEL_ERROR',
    );
    await expect(joined).resolves.toBeUndefined();
  });

  it('delivers the string payload of broadcast messages and ignores anything else', async () => {
    const { client, transport, messages, handlers } = setup();
    const joined = transport.join('ABC234', handlers as never);
    const channel = (client.channels[0] as (typeof client.channels)[number]).channel;
    channel.statusCallback?.('SUBSCRIBED');
    await joined;
    channel.listener?.({ payload: { raw: '{"a":1}' } });
    channel.listener?.({ payload: { raw: 42 } });
    channel.listener?.({ payload: {} });
    channel.listener?.({ payload: undefined });
    channel.listener?.({});
    expect(messages).toEqual(['{"a":1}']);
  });

  it('sends the raw string under the shared event name', async () => {
    const { client, transport, handlers } = setup();
    const joined = transport.join('ABC234', handlers as never);
    const channel = (client.channels[0] as (typeof client.channels)[number]).channel;
    channel.statusCallback?.('SUBSCRIBED');
    await joined;
    await transport.send('ABC234', 'hello');
    expect(channel.sent).toEqual([{ type: 'broadcast', event: EVENT, payload: { raw: 'hello' } }]);
  });

  it('turns a refused or failed send into an error the session will retry', async () => {
    const { client, transport, handlers } = setup();
    const joined = transport.join('ABC234', handlers as never);
    const channel = (client.channels[0] as (typeof client.channels)[number]).channel;
    channel.statusCallback?.('SUBSCRIBED');
    await joined;
    channel.sendResult = 'error';
    await expect(transport.send('ABC234', 'x')).rejects.toThrow(/did not accept.*error/);
    channel.sendResult = 'timed out';
    await expect(transport.send('ABC234', 'x')).rejects.toThrow(/timed out/);
  });

  it('refuses to send before joining and after leaving', async () => {
    const { client, transport, handlers } = setup();
    await expect(transport.send('ABC234', 'x')).rejects.toThrow(/Not connected/);
    const joined = transport.join('ABC234', handlers as never);
    (client.channels[0] as (typeof client.channels)[number]).channel.statusCallback?.('SUBSCRIBED');
    await joined;
    await transport.leave();
    expect(client.removed).toHaveLength(1);
    await expect(transport.send('ABC234', 'x')).rejects.toThrow(/Not connected/);
    await expect(transport.leave()).resolves.toBeUndefined();
  });
});

class FakeBroadcast implements BroadcastChannelLike {
  static all: FakeBroadcast[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(readonly name: string) {
    FakeBroadcast.all.push(this);
  }
  postMessage(message: unknown): void {
    for (const other of FakeBroadcast.all) {
      if (other !== this && other.name === this.name && !other.closed) {
        other.onmessage?.({ data: message });
      }
    }
  }
  close(): void {
    this.closed = true;
  }
}

describe('the same-browser transport', () => {
  it('carries strings between two tabs of the same room and not across rooms', async () => {
    FakeBroadcast.all = [];
    const a = new TabTransport((n) => new FakeBroadcast(n));
    const b = new TabTransport((n) => new FakeBroadcast(n));
    const c = new TabTransport((n) => new FakeBroadcast(n));
    const got: Record<string, string[]> = { a: [], b: [], c: [] };
    const statuses: string[] = [];
    const h = (who: string) => ({
      onMessage: (raw: string) => got[who]?.push(raw),
      onStatus: (s: string) => statuses.push(s),
    });
    await a.join('ABC234', h('a') as never);
    await b.join('ABC234', h('b') as never);
    await c.join('ZZZ999', h('c') as never);
    await a.send('ABC234', 'hi');
    expect(got).toEqual({ a: [], b: ['hi'], c: [] });
    expect(statuses).toEqual(['up', 'up', 'up']);
  });

  it('ignores non-string data and stops after leaving', async () => {
    FakeBroadcast.all = [];
    const a = new TabTransport((n) => new FakeBroadcast(n));
    const got: string[] = [];
    await a.join('ABC234', {
      onMessage: (r: string) => got.push(r),
      onStatus: () => undefined,
    } as never);
    const channel = FakeBroadcast.all[0] as FakeBroadcast;
    channel.onmessage?.({ data: { not: 'a string' } });
    channel.onmessage?.({ data: 'ok' });
    expect(got).toEqual(['ok']);
    await a.leave();
    expect(channel.closed).toBe(true);
    await expect(a.send('ABC234', 'x')).rejects.toThrow(/Not connected/);
    await expect(a.leave()).resolves.toBeUndefined();
  });

  it('builds a real BroadcastChannel by default', async () => {
    const t = new TabTransport();
    await t.join('ABC234', { onMessage: () => undefined, onStatus: () => undefined } as never);
    await expect(t.send('ABC234', 'x')).resolves.toBeUndefined();
    await t.leave();
  });
});

describe('the simulation chain', () => {
  // Created per test, never at import time: a key made before the first test would leak into the
  // vault tests and make the suite depend on the order it runs in.
  let alice: ReturnType<typeof loadOrCreateIdentity>;
  beforeEach(() => {
    alice = loadOrCreateIdentity();
  });
  const text = (room: string) => `ACC1|${room}|C|${'ab'.repeat(32)}`;

  it('records a memo that becomes visible only after the confirmation delay', async () => {
    let now = 1_000_000;
    const chain = new SimChain(localStorage, 700, () => now);
    const sig = await chain.sendMemo(alice, text('ABC234'));
    expect(await chain.getMemoTx(sig)).toBeNull(); // not confirmed yet
    now += 699;
    expect(await chain.getMemoTx(sig)).toBeNull();
    now += 1;
    expect(await chain.getMemoTx(sig)).toMatchObject({ sig, signer: alice.publicKey, ok: true });
  });

  it('shows one shared ledger to every tab', async () => {
    const now = 5_000_000;
    const tabA = new SimChain(localStorage, 0, () => now);
    const tabB = new SimChain(localStorage, 0, () => now);
    const sig = await tabA.sendMemo(alice, text('ABC234'));
    expect((await tabB.getMemoTx(sig))?.text).toBe(text('ABC234'));
  });

  it('gives every transaction a distinct, valid base58 signature of 64 bytes', async () => {
    const chain = new SimChain(localStorage, 0);
    const sigs = new Set<string>();
    for (let i = 0; i < 50; i++) sigs.add(await chain.sendMemo(alice, text('ABC234')));
    expect(sigs.size).toBe(50);
    const bs58 = (await import('bs58')).default;
    for (const sig of sigs) expect(bs58.decode(sig)).toHaveLength(64);
  });

  it('lists only the signer’s records for the room', async () => {
    const chain = new SimChain(localStorage, 0);
    const bob = identityFromSecretKey(
      (await import('@accident/protocol')).generateIdentity().secretKey,
    );
    await chain.sendMemo(alice, text('ABC234'));
    await chain.sendMemo(alice, text('ZZZ999'));
    await chain.sendMemo(bob, text('ABC234'));
    const found = await chain.listMemoTxs(alice.publicKey, 'ABC234');
    expect(found).toHaveLength(1);
    expect(found[0]?.signer).toBe(alice.publicKey);
  });

  it('starts empty and skips damaged entries without losing the rest', async () => {
    const chain = new SimChain(localStorage, 0);
    expect(await chain.listMemoTxs(alice.publicKey, 'ABC234')).toEqual([]);
    const good = await chain.sendMemo(alice, text('ABC234'));
    localStorage.setItem('accident:sim-tx:v2:broken', 'not json');
    localStorage.setItem('accident:sim-tx:v2:empty', 'null');
    localStorage.setItem('accident:unrelated', 'x');
    expect((await chain.getMemoTx(good))?.sig).toBe(good);
    expect(await chain.getMemoTx('missing')).toBeNull();
  });

  it('keeps every transaction when two tabs write at the same moment', async () => {
    // Regression: an earlier design stored one shared list and rewrote it on each send, so two
    // tabs that each read the list before either wrote lost one of the two transactions. Here two
    // chains share a store whose writes are deferred until both have "read", like two threads.
    const backing = new Map<string, string>();
    const pending: Array<() => void> = [];
    const deferred = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => {
        pending.push(() => backing.set(k, v));
      },
      key: (i: number) => [...backing.keys()][i] ?? null,
      get length() {
        return backing.size;
      },
    };
    const tabA = new SimChain(deferred, 0);
    const tabB = new SimChain(deferred, 0);
    const bob = (await import('@accident/protocol')).generateIdentity();
    const [sigA, sigB] = await Promise.all([
      tabA.sendMemo(alice, text('ABC234')),
      tabB.sendMemo(bob, text('ABC234')),
    ]);
    for (const write of pending) write(); // both writes land, in whatever order
    const reader = new SimChain(deferred, 0);
    expect((await reader.getMemoTx(sigA))?.signer).toBe(alice.publicKey);
    expect((await reader.getMemoTx(sigB))?.signer).toBe(bob.publicKey);
  });

  it('lists transactions in the order they were sent', async () => {
    let now = 1_000;
    const chain = new SimChain(localStorage, 0, () => now);
    const first = await chain.sendMemo(alice, text('ABC234'));
    now += 10;
    const second = await chain.sendMemo(alice, text('ABC234'));
    expect((await chain.listMemoTxs(alice.publicKey, 'ABC234')).map((t) => t.sig)).toEqual([
      first,
      second,
    ]);
  });
});
