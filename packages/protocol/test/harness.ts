import type { Code, Level } from '@accident/engine';
import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, vi } from 'vitest';
import { candidatesFromHistory, chooseGuess, mulberry32 } from '@accident/engine';
import type { Identity, Role, SessionOptions, SessionView } from '../src/index.js';
import { Session, generateSaltHex } from '../src/index.js';
import { ManualClock, MemoryChain, MemoryHub, MemoryStorage } from '../src/testing/index.js';
import type { PeerOptions } from './peer.js';
import { ROOM, identityFromByte } from './helpers.js';

export interface World {
  clock: ManualClock;
  hub: MemoryHub;
  chain: MemoryChain;
}

export function newWorld(): World {
  return { clock: new ManualClock(), hub: new MemoryHub(), chain: new MemoryChain() };
}

export interface Player {
  name: string;
  role: Role;
  identity: Identity;
  secret: Code;
  saltHex: string;
  storage: MemoryStorage;
  session: Session;
  /** The latest view the session reported. */
  view: SessionView;
  errors: unknown[];
  stopAuto: () => void;
}

export interface PlayerOptions {
  name: string;
  role: Role;
  secret: Code;
  identityByte: number;
  hostKey?: string;
  options?: Partial<SessionOptions>;
  storage?: MemoryStorage;
  saltHex?: string;
  room?: string;
}

/** Builds a player wired to the shared world. Does not start it. */
export function makePlayer(world: World, o: PlayerOptions): Player {
  const identity = identityFromByte(o.identityByte);
  const storage = o.storage ?? new MemoryStorage();
  const saltHex = o.saltHex ?? generateSaltHex();
  const session = Session.create({
    room: o.room ?? ROOM,
    role: o.role,
    identity,
    secret: o.secret,
    saltHex,
    ...(o.hostKey === undefined ? {} : { hostKey: o.hostKey }),
    transport: world.hub.transport(o.name),
    chain: world.chain,
    storage,
    clock: world.clock,
    options: o.options ?? {},
  });
  return wrap(session, o, identity, storage, saltHex);
}

function wrap(
  session: Session,
  o: PlayerOptions,
  identity: Identity,
  storage: MemoryStorage,
  saltHex: string,
): Player {
  const player: Player = {
    name: o.name,
    role: o.role,
    identity,
    secret: o.secret,
    saltHex,
    storage,
    session,
    view: session.view(),
    errors: [],
    stopAuto: () => undefined,
  };
  session.subscribe((view) => {
    player.view = view;
  });
  return player;
}

/** Rebuilds a player's session from storage, as after a page refresh. */
export async function resumePlayer(world: World, old: Player, o: PlayerOptions): Promise<Player> {
  const identity = old.identity;
  const session = await Session.resume({
    room: o.room ?? ROOM,
    identity,
    transport: world.hub.transport(o.name),
    chain: world.chain,
    storage: old.storage,
    clock: world.clock,
    options: o.options ?? {},
  });
  if (!session) throw new Error('nothing to resume');
  return wrap(session, o, identity, old.storage, old.saltHex);
}

/**
 * Makes a player guess by itself whenever it is their turn, like the computer opponent will.
 * `pick` may return undefined to pass (for scripted mistakes).
 */
export function autoplay(player: Player, level: Level = 'medium', seed = 1): void {
  const rng = mulberry32(seed);
  let submitted = -1;
  const tryGuess = (view: SessionView): void => {
    if (!view.canGuess || view.guesses.length === submitted) return;
    submitted = view.guesses.length;
    const history = view.guesses
      .map((guess, index) => ({ guess, index }))
      .filter(({ index }) => index % 2 === view.seat && view.answers[index] !== undefined)
      .map(({ guess, index }) => ({ guess, feedback: view.answers[index] as number }));
    const guess = chooseGuess(level, candidatesFromHistory(history), rng) ?? '0123';
    void player.session.submitGuess(guess).catch((e: unknown) => player.errors.push(e));
  };
  const off = player.session.subscribe(tryGuess);
  tryGuess(player.session.view());
  player.stopAuto = off;
}

/** Advances time in small steps until `done` or the limit is reached. */
export async function until(
  world: World,
  done: () => boolean,
  limitMs = 600_000,
  stepMs = 100,
): Promise<void> {
  for (let t = 0; t < limitMs && !done(); t += stepMs) await world.clock.advance(stepMs);
}

export const isDone = (p: Player): boolean =>
  ['final', 'abandoned'].includes(p.session.view().phase);

/**
 * Replaces WebCrypto's SHA-256 with a synchronous one for the duration of each test.
 *
 * The real `crypto.subtle.digest` completes on a later turn of the event loop, but the fake clock
 * only flushes microtasks. With it, simulated time would race ahead while a hash was still being
 * computed. Everything else the session awaits is a microtask, so this makes a whole game run
 * deterministically. The real digest is covered by the commitment and basics tests.
 */
export function useDeterministicCrypto(): void {
  beforeEach(() => {
    vi.stubGlobal('crypto', {
      subtle: {
        digest: async (_algorithm: string, data: Uint8Array): Promise<ArrayBuffer> => {
          const hash = createHash('sha256').update(data).digest();
          return hash.buffer.slice(
            hash.byteOffset,
            hash.byteOffset + hash.byteLength,
          ) as ArrayBuffer;
        },
      },
      getRandomValues: (array: Uint8Array): Uint8Array => webcrypto.getRandomValues(array),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}

export interface VsPeerConfig {
  world?: World;
  /** The session under test plays this role. The scripted peer takes the other. Default host. */
  role?: Role;
  secret?: Code;
  peer: Omit<PeerOptions, 'name' | 'identityByte' | 'seat'>;
  options?: Partial<SessionOptions>;
  /** Let the session guess by itself. Default true. */
  auto?: boolean;
  /** Have the peer post and announce its commit. Default true. */
  commit?: boolean;
}

/** A real session against a scripted peer, both joined and said HELLO, ready for the test to drive. */
export async function vsPeer(cfg: VsPeerConfig) {
  const { ScriptedPeer } = await import('./peer.js');
  const world = cfg.world ?? newWorld();
  const role = cfg.role ?? 'host';
  const me = makePlayer(world, {
    name: 'me',
    role,
    secret: cfg.secret ?? '1964',
    identityByte: 1,
    ...(cfg.options ? { options: cfg.options } : {}),
  });
  const peer = new ScriptedPeer(world, {
    name: 'peer',
    identityByte: 2,
    seat: role === 'host' ? 1 : 0,
    opponentKey: me.identity.publicKey,
    ...cfg.peer,
  });
  await me.session.start();
  await peer.join();
  await peer.hello();
  if (cfg.commit !== false) await peer.commit();
  if (cfg.auto !== false) autoplay(me, 'medium', 11);
  await world.clock.advance(50);
  return { world, me, peer };
}
