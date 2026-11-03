import { createHash, webcrypto } from 'node:crypto';
import { identityFromSecretKey, generateIdentity } from '@accident/protocol';
import type { Chain, Transport } from '@accident/protocol';
import { MemoryChain, MemoryHub } from '@accident/protocol/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Backend, FundResult } from '../src/friend/backend.js';
import {
  MIN_BALANCE_LAMPORTS,
  backendKind,
  createBackend,
  missingConfig,
  requestDrip,
} from '../src/friend/backend.js';
import { FriendController, newChoice } from '../src/friend/controller.js';
import { controllerFor, leaveRoom, resetRegistry } from '../src/friend/registry.js';

/**
 * The session hashes with WebCrypto, which finishes on a later turn of the event loop. These tests
 * drive time by hand, so swap in a synchronous SHA-256 to keep every step deterministic.
 */
beforeEach(() => {
  vi.stubGlobal('crypto', {
    subtle: {
      digest: async (_a: string, data: Uint8Array): Promise<ArrayBuffer> => {
        const h = createHash('sha256').update(data).digest();
        return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength) as ArrayBuffer;
      },
    },
    getRandomValues: (a: Uint8Array): Uint8Array => webcrypto.getRandomValues(a),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetRegistry();
});

// One counter for the whole file. The hub tells participants apart by name, so two backends that
// each counted from zero would both be "t0" and the hub would treat them as the same player.
let transportCount = 0;

function fakeBackend(over: Partial<Backend> & { hub?: MemoryHub; chain?: Chain } = {}): Backend {
  const hub = over.hub ?? new MemoryHub();
  return {
    kind: 'sim',
    transport: (): Transport => hub.transport(`t${transportCount++}`),
    chain: over.chain ?? new MemoryChain(),
    explorerUrl: () => undefined,
    fund: async (): Promise<FundResult> => ({ ok: true, alreadyFunded: true }),
    ...over,
  };
}

const ROOM = 'ABC234';

describe('the friend controller', () => {
  it('stays idle until told to begin, and rejects nothing before then', () => {
    const c = new FriendController({
      room: ROOM,
      role: 'host',
      hostKey: undefined,
      identity: generateIdentity(),
      backend: fakeBackend(),
    });
    expect(c.state()).toEqual({ step: 'idle' });
    expect(c.view()).toBeUndefined();
    expect(c.transcript()).toEqual([]);
    expect(c.room).toBe(ROOM);
    expect(c.role).toBe('host');
  });

  it('funds the key, then starts a session with the chosen secret', async () => {
    const identity = generateIdentity();
    const fund = vi.fn(async (): Promise<FundResult> => ({ ok: true, alreadyFunded: false }));
    const c = new FriendController({
      room: ROOM,
      role: 'host',
      hostKey: undefined,
      identity,
      backend: fakeBackend({ fund }),
    });
    const steps: string[] = [];
    c.onSetup((s) => steps.push(s.step));
    await c.begin(newChoice('1964'));
    expect(fund).toHaveBeenCalledWith(identity.publicKey);
    expect(steps).toEqual(['funding', 'ready']);
    expect(c.view()?.phase).toBe('connecting');
    expect(c.view()?.role).toBe('host');
    await c.dispose();
  });

  it('saves the secret to this device before anything is sent', async () => {
    const c = new FriendController({
      room: ROOM,
      role: 'host',
      hostKey: undefined,
      identity: generateIdentity(),
      backend: fakeBackend(),
    });
    await c.begin(newChoice('1964'));
    const saved = localStorage.getItem(`accident:session:${ROOM}`) as string;
    expect(saved).toContain('1964');
    await c.dispose();
  });

  it('reports a funding failure and does not start a game', async () => {
    const c = new FriendController({
      room: ROOM,
      role: 'guest',
      hostKey: undefined,
      identity: generateIdentity(),
      backend: fakeBackend({ fund: async () => ({ ok: false, reason: 'faucet dry' }) }),
    });
    await c.begin(newChoice('1964'));
    expect(c.state()).toEqual({ step: 'funding-failed', reason: 'faucet dry' });
    expect(c.view()).toBeUndefined();
    expect(localStorage.getItem(`accident:session:${ROOM}`)).toBeNull();
  });

  it('can try again after a funding failure', async () => {
    let ok = false;
    const c = new FriendController({
      room: ROOM,
      role: 'guest',
      hostKey: undefined,
      identity: generateIdentity(),
      backend: fakeBackend({
        fund: async () => (ok ? { ok: true, alreadyFunded: false } : { ok: false, reason: 'no' }),
      }),
    });
    await c.begin(newChoice('1964'));
    expect(c.state().step).toBe('funding-failed');
    ok = true;
    await c.begin(newChoice('1964'));
    expect(c.state().step).toBe('ready');
    expect(c.view()).toBeDefined();
    await c.dispose();
  });

  it('ignores a second begin while a game is running, so two games never start', async () => {
    const fund = vi.fn(async (): Promise<FundResult> => ({ ok: true, alreadyFunded: true }));
    const c = new FriendController({
      room: ROOM,
      role: 'host',
      hostKey: undefined,
      identity: generateIdentity(),
      backend: fakeBackend({ fund }),
    });
    await c.begin(newChoice('1964'));
    await c.begin(newChoice('0123'));
    expect(fund).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(`accident:session:${ROOM}`)).toContain('1964');
    await c.dispose();
  });

  it('does not start a game if it was disposed while funding', async () => {
    let release: (r: FundResult) => void = () => undefined;
    const slow = new Promise<FundResult>((resolve) => (release = resolve));
    const c = new FriendController({
      room: ROOM,
      role: 'host',
      hostKey: undefined,
      identity: generateIdentity(),
      backend: fakeBackend({ fund: () => slow }),
    });
    const starting = c.begin(newChoice('1964'));
    await c.dispose();
    release({ ok: true, alreadyFunded: true });
    await starting;
    expect(c.view()).toBeUndefined();
    expect(localStorage.getItem(`accident:session:${ROOM}`)).toBeNull();
    await c.begin(newChoice('1964'));
    expect(c.view()).toBeUndefined();
  });

  it('two controllers can play a whole game through the real session', async () => {
    vi.useFakeTimers();
    const hub = new MemoryHub();
    const chain = new MemoryChain();
    const alice = new FriendController({
      room: ROOM,
      role: 'host',
      hostKey: undefined,
      identity: generateIdentity(),
      backend: fakeBackend({ hub, chain }),
    });
    const bob = new FriendController({
      room: ROOM,
      role: 'guest',
      hostKey: undefined,
      identity: generateIdentity(),
      backend: fakeBackend({ hub, chain }),
    });
    await alice.begin(newChoice('1964'));
    await bob.begin(newChoice('4271'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(alice.view()?.gateOpen).toBe(true);
    expect(bob.view()?.gateOpen).toBe(true);
    expect(alice.view()?.peerKey).toBe(bob.identity.publicKey);

    await alice.guess('0123');
    await vi.advanceTimersByTimeAsync(1000);
    expect(alice.view()?.guesses).toEqual(['0123']);
    expect(alice.view()?.answers).toHaveLength(1);
    expect(alice.transcript().length).toBeGreaterThan(4);
    await alice.dispose();
    await bob.dispose();
  });

  it('resumes a saved game after a refresh, with no secret asked for again', async () => {
    vi.useFakeTimers();
    const hub = new MemoryHub();
    const identity = generateIdentity();
    const first = new FriendController({
      room: ROOM,
      role: 'host',
      hostKey: undefined,
      identity,
      backend: fakeBackend({ hub }),
    });
    await first.begin(newChoice('1964'));
    await vi.advanceTimersByTimeAsync(500);
    await first.dispose();

    const second = new FriendController({
      room: ROOM,
      role: 'host',
      hostKey: undefined,
      identity,
      backend: fakeBackend({ hub }),
    });
    expect(await second.resume()).toBe(true);
    expect(second.view()?.role).toBe('host');
    expect(localStorage.getItem(`accident:session:${ROOM}`)).toContain('1964');
    await second.dispose();
  });

  it('says there is nothing to resume when nothing was saved, or it belongs to another key', async () => {
    const c = new FriendController({
      room: ROOM,
      role: 'host',
      hostKey: undefined,
      identity: generateIdentity(),
      backend: fakeBackend(),
    });
    expect(await c.resume()).toBe(false);
    const owner = generateIdentity();
    const game = new FriendController({
      room: ROOM,
      role: 'host',
      hostKey: undefined,
      identity: owner,
      backend: fakeBackend(),
    });
    await game.begin(newChoice('1964'));
    await game.dispose();
    const stranger = new FriendController({
      room: ROOM,
      role: 'host',
      hostKey: undefined,
      identity: identityFromSecretKey(generateIdentity().secretKey),
      backend: fakeBackend(),
    });
    expect(await stranger.resume()).toBe(false);
  });

  it('passes the host key from the share link to the session', async () => {
    vi.useFakeTimers();
    const hub = new MemoryHub();
    const host = generateIdentity();
    const guest = new FriendController({
      room: ROOM,
      role: 'guest',
      hostKey: host.publicKey,
      identity: generateIdentity(),
      backend: fakeBackend({ hub }),
    });
    await guest.begin(newChoice('4271'));
    await vi.advanceTimersByTimeAsync(1000);
    // An impostor host speaks first; the pinned key means the guest ignores it.
    const impostor = new FriendController({
      room: ROOM,
      role: 'host',
      hostKey: undefined,
      identity: generateIdentity(),
      backend: fakeBackend({ hub }),
    });
    await impostor.begin(newChoice('1234'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(guest.view()?.peerKey).toBeUndefined();
    await guest.dispose();
    await impostor.dispose();
  });

  it('exposes its backend and identity to the screens', () => {
    const backend = fakeBackend();
    const identity = generateIdentity();
    const c = new FriendController({
      room: ROOM,
      role: 'host',
      hostKey: undefined,
      identity,
      backend,
    });
    expect(c.backend).toBe(backend);
    expect(c.identity).toBe(identity);
  });

  it('forwards guesses, retries and timeouts to the session and tolerates having none yet', async () => {
    const c = new FriendController({
      room: ROOM,
      role: 'host',
      hostKey: undefined,
      identity: generateIdentity(),
      backend: fakeBackend(),
    });
    await expect(c.guess('0123')).resolves.toBeUndefined();
    await expect(c.retry()).resolves.toBeUndefined();
    await expect(c.claimTimeout()).resolves.toBeUndefined();
    await c.dispose();
  });

  it('stops notifying views and setup changes after listeners are removed', async () => {
    const c = new FriendController({
      room: ROOM,
      role: 'host',
      hostKey: undefined,
      identity: generateIdentity(),
      backend: fakeBackend(),
    });
    const views: unknown[] = [];
    const setups: unknown[] = [];
    const offView = c.onView((v) => views.push(v));
    const offSetup = c.onSetup((s) => setups.push(s));
    offView();
    offSetup();
    await c.begin(newChoice('1964'));
    expect(views).toEqual([]);
    expect(setups).toEqual([]);
    await c.dispose();
  });
});

describe('the controller registry', () => {
  it('returns the same live controller for the same room, so a remount does not start a second game', () => {
    const init = {
      room: ROOM,
      role: 'host' as const,
      hostKey: undefined,
      identity: generateIdentity(),
      backend: fakeBackend(),
    };
    const a = controllerFor(init);
    const b = controllerFor({ ...init });
    expect(b).toBe(a);
  });

  it('keeps different rooms and different roles apart', () => {
    const base = { hostKey: undefined, identity: generateIdentity(), backend: fakeBackend() };
    const a = controllerFor({ ...base, room: 'ABC234', role: 'host' });
    const b = controllerFor({ ...base, room: 'ABC235', role: 'host' });
    const c = controllerFor({ ...base, room: 'ABC234', role: 'guest' });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('forgets a room once the player leaves it, and stops its game', async () => {
    const init = {
      room: ROOM,
      role: 'host' as const,
      hostKey: undefined,
      identity: generateIdentity(),
      backend: fakeBackend(),
    };
    const a = controllerFor(init);
    await a.begin(newChoice('1964'));
    await leaveRoom(ROOM);
    expect(controllerFor(init)).not.toBe(a);
    expect(a.view()).toBeUndefined();
  });

  it('leaving one room does not disturb another', async () => {
    const base = { hostKey: undefined, identity: generateIdentity(), backend: fakeBackend() };
    const keep = controllerFor({ ...base, room: 'ABC235', role: 'host' });
    controllerFor({ ...base, room: ROOM, role: 'host' });
    await leaveRoom(ROOM);
    expect(controllerFor({ ...base, room: 'ABC235', role: 'host' })).toBe(keep);
  });
});

describe('choosing a backend', () => {
  it('uses simulation only when asked to', () => {
    expect(backendKind({ VITE_BACKEND: 'sim' })).toBe('sim');
    expect(backendKind({ VITE_BACKEND: 'live' })).toBe('live');
    expect(backendKind({})).toBe('live');
    expect(backendKind({ VITE_BACKEND: 'SIM' })).toBe('live');
  });

  it('says exactly what is missing for the live backend', () => {
    expect(missingConfig({})).toEqual(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']);
    expect(missingConfig({ VITE_SUPABASE_URL: 'https://x.supabase.co' })).toEqual([
      'VITE_SUPABASE_ANON_KEY',
    ]);
    expect(missingConfig({ VITE_SUPABASE_URL: 'u', VITE_SUPABASE_ANON_KEY: 'k' })).toEqual([]);
  });

  it('refuses to build a live backend that is not configured, naming what to set', () => {
    expect(() => createBackend({})).toThrow(/VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY/);
  });

  it('builds the simulation backend with no configuration and needs no funding', async () => {
    const backend = createBackend({ VITE_BACKEND: 'sim' });
    expect(backend.kind).toBe('sim');
    expect(backend.explorerUrl('sig')).toBeUndefined();
    expect(await backend.fund('anything')).toEqual({ ok: true, alreadyFunded: true });
    expect(backend.transport()).toBeDefined();
  });

  it('builds the live backend when configured, with devnet explorer links', () => {
    const backend = createBackend({
      VITE_SUPABASE_URL: 'https://x.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'anon',
    });
    expect(backend.kind).toBe('live');
    expect(backend.explorerUrl('SIG')).toBe('https://explorer.solana.com/tx/SIG?cluster=devnet');
    expect(backend.transport()).toBeDefined();
  });

  it('keeps the funding floor well above the cost of a game', () => {
    expect(MIN_BALANCE_LAMPORTS).toBeGreaterThanOrEqual(20_000 * 10);
  });
});

describe('asking for devnet SOL', () => {
  const ok =
    (body: unknown, status = 200) =>
    async () =>
      new Response(JSON.stringify(body), { status });

  it('reports success and whether the key was topped up', async () => {
    expect(await requestDrip('/api/drip', 'KEY', ok({ ok: true, funded: true }))).toEqual({
      ok: true,
      alreadyFunded: false,
    });
    expect(await requestDrip('/api/drip', 'KEY', ok({ ok: true, funded: false }))).toEqual({
      ok: true,
      alreadyFunded: true,
    });
  });

  it('sends the public key as JSON', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    await requestDrip('/api/drip', 'KEY123', async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }));
    });
    expect(seen[0]?.url).toBe('/api/drip');
    expect(seen[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ pubkey: 'KEY123' });
  });

  it('passes on the service’s own reason when it refuses', async () => {
    expect(
      await requestDrip('/api/drip', 'K', ok({ ok: false, error: 'Daily limit reached' }, 429)),
    ).toEqual({
      ok: false,
      reason: 'Daily limit reached',
    });
  });

  it('gives a plain reason for an unexpected or unreadable answer', async () => {
    expect(
      await requestDrip('/api/drip', 'K', async () => new Response('<html>', { status: 502 })),
    ).toEqual({
      ok: false,
      reason: 'The funding service answered 502',
    });
    expect(await requestDrip('/api/drip', 'K', ok({ ok: false }, 500))).toMatchObject({
      ok: false,
    });
  });

  it('copes with the service being unreachable', async () => {
    const down = async (): Promise<Response> => {
      throw new TypeError('Failed to fetch');
    };
    expect(await requestDrip('/api/drip', 'K', down)).toEqual({
      ok: false,
      reason: 'Could not reach the funding service',
    });
  });
});
