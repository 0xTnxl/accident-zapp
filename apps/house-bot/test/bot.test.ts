import { createHash, webcrypto } from 'node:crypto';
import { mulberry32 } from '@accident/engine';
import type { SessionView } from '@accident/protocol';
import { generateIdentity } from '@accident/protocol';
import {
  ManualClock,
  MemoryChain,
  MemoryHub,
  MemoryStorage,
  settle,
} from '@accident/protocol/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseHonestGuess, HouseBot, makeChoice } from '../src/index.js';

/**
 * The real WebCrypto SHA-256 resolves on a later turn of the event loop, which the ManualClock does
 * not flush, so simulated time would race ahead of a pending commit/reveal hash. Swapping in a
 * synchronous digest (as the protocol harness does) makes a whole game run deterministically.
 */
beforeEach(() => {
  vi.stubGlobal('crypto', {
    subtle: {
      digest: async (_algorithm: string, data: Uint8Array): Promise<ArrayBuffer> => {
        const hash = createHash('sha256').update(data).digest();
        return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength) as ArrayBuffer;
      },
    },
    getRandomValues: (array: Uint8Array): Uint8Array => webcrypto.getRandomValues(array),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ROOM = 'ABC234';

/** Advances the fake clock in small steps, letting async work settle, until `done` or the limit. */
async function until(
  clock: ManualClock,
  done: () => boolean,
  limitMs = 600_000,
  stepMs = 100,
): Promise<void> {
  for (let t = 0; t < limitMs && !done(); t += stepMs) await clock.advance(stepMs);
  await settle();
}

describe('two honest House Bots play a complete game', () => {
  it('reaches a final verdict with no faults through the real protocol', async () => {
    const clock = new ManualClock();
    const hub = new MemoryHub();
    const chain = new MemoryChain();

    const hostIdentity = generateIdentity();
    const host = new HouseBot({
      room: ROOM,
      role: 'host',
      identity: hostIdentity,
      choice: { secret: '1964', saltHex: 'a1'.repeat(32) },
      level: 'medium',
      rng: mulberry32(1),
      transport: hub.transport('host'),
      chain,
      storage: new MemoryStorage(),
      clock,
      options: { turnMs: 300_000 },
    });
    const guest = new HouseBot({
      room: ROOM,
      role: 'guest',
      identity: generateIdentity(),
      choice: { secret: '4271', saltHex: 'b2'.repeat(32) },
      // Pin the host's key, as a guest joining from a share link would.
      hostKey: hostIdentity.publicKey,
      level: 'medium',
      rng: mulberry32(2),
      transport: hub.transport('guest'),
      chain,
      storage: new MemoryStorage(),
      clock,
    });

    await host.start();
    await guest.start();

    const done = (): boolean =>
      ['final', 'abandoned'].includes(host.view().phase) &&
      ['final', 'abandoned'].includes(guest.view().phase);
    await until(clock, done);

    // Both bots finished honestly, agreeing on a final verdict with no faults charged.
    expect(host.view().phase).toBe('final');
    expect(guest.view().phase).toBe('final');

    const verdict = host.view().verdict;
    if (verdict?.kind !== 'final')
      throw new Error(`expected a final verdict, got ${verdict?.kind}`);
    expect(verdict.faults).toEqual([]);
    expect(verdict.faults.some((f) => f.kind === 'wrong-answer')).toBe(false);
    expect(verdict.verifiedSecrets).toEqual(['1964', '4271']);
    expect(host.view().verdict).toEqual(guest.view().verdict);

    // The game actually progressed, and no background guess failed.
    expect(host.view().guesses.length).toBeGreaterThan(0);
    expect(host.view().guesses).toEqual(guest.view().guesses);
    expect(host.errors).toEqual([]);
    expect(guest.errors).toEqual([]);

    await host.close();
    await guest.close();
  });

  it('exposes the transcript and defaults a secret when none is supplied', async () => {
    const clock = new ManualClock();
    const hub = new MemoryHub();
    const chain = new MemoryChain();

    const views: number[] = [];
    const host = new HouseBot({
      room: ROOM,
      role: 'host',
      identity: generateIdentity(),
      // No choice: the bot picks its own secret and salt with the seeded rng.
      rng: mulberry32(7),
      transport: hub.transport('host'),
      chain,
      storage: new MemoryStorage(),
      clock,
    });
    const guest = new HouseBot({
      room: ROOM,
      role: 'guest',
      identity: generateIdentity(),
      rng: mulberry32(8),
      transport: hub.transport('guest'),
      chain,
      storage: new MemoryStorage(),
      clock,
    });

    const off = host.subscribe((view) => views.push(view.guesses.length));
    await host.start();
    await guest.start();
    await until(
      clock,
      () =>
        ['final', 'abandoned'].includes(host.view().phase) &&
        ['final', 'abandoned'].includes(guest.view().phase),
    );
    off();

    expect(host.view().phase).toBe('final');
    expect(host.transcript().length).toBeGreaterThan(0);
    // The subscription saw the game advance.
    expect(views.length).toBeGreaterThan(0);

    await host.close();
    await guest.close();
  });

  it('defaults its rng and choice to the secure generator when none are given', async () => {
    const clock = new ManualClock();
    const hub = new MemoryHub();
    const chain = new MemoryChain();
    // Neither bot is given a choice or an rng: both fall back to makeChoice() and secureRng(),
    // which use the WebCrypto stub installed above. The pair still plays a full game.
    const host = new HouseBot({
      room: ROOM,
      role: 'host',
      identity: generateIdentity(),
      transport: hub.transport('host'),
      chain,
      storage: new MemoryStorage(),
      clock,
    });
    const guest = new HouseBot({
      room: ROOM,
      role: 'guest',
      identity: generateIdentity(),
      transport: hub.transport('guest'),
      chain,
      storage: new MemoryStorage(),
      clock,
    });
    await host.start();
    await guest.start();
    await until(
      clock,
      () =>
        ['final', 'abandoned'].includes(host.view().phase) &&
        ['final', 'abandoned'].includes(guest.view().phase),
    );
    expect(host.view().phase).toBe('final');
    expect(guest.view().phase).toBe('final');
    await host.close();
    await guest.close();
  });
});

describe('chooseHonestGuess', () => {
  const viewWith = (guesses: string[], answers: number[], seat: 0 | 1): SessionView =>
    ({ guesses, answers, seat }) as unknown as SessionView;

  it('opens with 0123 when nothing is known yet', () => {
    expect(chooseHonestGuess(viewWith([], [], 0), 'medium', mulberry32(1))).toBe('0123');
  });

  it('narrows using only the bot\u2019s own answered turns', () => {
    // Seat 0's own guesses are at even indexes. Index 1 is the opponent's guess (seat mismatch) and
    // index 2 has no answer yet (undefined), so both are skipped; only index 0 narrows the search.
    const view = viewWith(['0123', '4567', '8901'], [20], 0);
    const guess = chooseHonestGuess(view, 'hard', mulberry32(1));
    expect(guess).toMatch(/^\d{4}$/);
    expect(guess).not.toBe('0123');
  });

  it('falls back to the opening guess when the answers are inconsistent (a lie)', () => {
    // The bot's own guesses (even indexes) got contradictory feedback for the same code, so no
    // candidate survives. The honest bot opens again rather than get stuck; the lie is caught
    // later at finalisation. Index 1 is the opponent's guess and is ignored.
    const view = viewWith(['0123', '4567', '0123'], [20, 11, 30], 0);
    expect(chooseHonestGuess(view, 'medium', mulberry32(1))).toBe('0123');
  });
});

describe('a guess that cannot be submitted', () => {
  it('is captured in errors rather than thrown', async () => {
    const clock = new ManualClock();
    const hub = new MemoryHub();
    const chain = new MemoryChain();

    const hostIdentity = generateIdentity();
    const host = new HouseBot({
      room: ROOM,
      role: 'host',
      identity: hostIdentity,
      choice: { secret: '1964', saltHex: 'a1'.repeat(32) },
      rng: mulberry32(1),
      transport: hub.transport('host'),
      chain,
      storage: new MemoryStorage(),
      clock,
    });
    const guest = new HouseBot({
      room: ROOM,
      role: 'guest',
      identity: generateIdentity(),
      choice: { secret: '4271', saltHex: 'b2'.repeat(32) },
      rng: mulberry32(2),
      transport: hub.transport('guest'),
      chain,
      storage: new MemoryStorage(),
      clock,
    });

    await host.start();
    await guest.start();

    // Subscribe after start, so this listener runs after the bot's own. The instant the host may
    // guess, close it: the guess the bot just queued then runs against a closed session and is
    // rejected, which the bot must capture in `errors` instead of throwing.
    let closed = false;
    host.subscribe((view) => {
      if (view.canGuess && !closed) {
        closed = true;
        void host.close();
      }
    });

    await until(clock, () => closed && host.errors.length > 0, 60_000);
    expect(host.errors.length).toBeGreaterThan(0);

    await guest.close();
  });
});

describe('makeChoice', () => {
  it('produces a valid secret and salt with the default secure rng', () => {
    const choice = makeChoice();
    expect(choice.secret).toMatch(/^\d{4}$/);
    expect(choice.saltHex).toMatch(/^[0-9a-f]{64}$/);
  });
});
