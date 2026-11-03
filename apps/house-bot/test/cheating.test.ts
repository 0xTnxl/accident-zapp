import { createHash, webcrypto } from 'node:crypto';
import { mulberry32, score, VALID_FEEDBACK } from '@accident/engine';
import { generateIdentity } from '@accident/protocol';
import {
  ManualClock,
  MemoryChain,
  MemoryHub,
  MemoryStorage,
  settle,
} from '@accident/protocol/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOUSE_BOT_LABEL, HouseBot } from '../src/index.js';

/**
 * As in bot.test.ts: the real WebCrypto SHA-256 resolves on a later event-loop turn the ManualClock
 * never flushes, so a synchronous digest keeps a whole game deterministic under the fake clock.
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

describe('a cheating House Bot is caught at finalisation', () => {
  it('lies on one answer; the honest bot wins by fault with a wrong-answer charged to the cheater', async () => {
    const clock = new ManualClock();
    const hub = new MemoryHub();
    const chain = new MemoryChain();

    // The host is seat 0, which answers the odd guess indexes (answererOf(index) === 0 when index
    // is odd), so index 1 is an answer it actually gives. It lies there; the guest plays honestly.
    const liedAtIndex = 1;

    const hostIdentity = generateIdentity();
    const host = new HouseBot({
      room: ROOM,
      role: 'host',
      identity: hostIdentity,
      choice: { secret: '1964', saltHex: 'a1'.repeat(32) },
      level: 'medium',
      rng: mulberry32(1),
      cheat: { atGuessIndex: liedAtIndex },
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

    expect(guest.view().phase).toBe('final');

    // The honest guest's verdict catches the lie: a final 'fault' win for the honest seat (1).
    const verdict = guest.view().verdict;
    if (verdict?.kind !== 'final')
      throw new Error(`expected a final verdict, got ${verdict?.kind}`);
    expect(verdict.reason).toBe('fault');
    expect(verdict.result).toBe('seat1');

    const lie = verdict.faults.find((f) => f.kind === 'wrong-answer');
    if (lie?.kind !== 'wrong-answer') throw new Error('expected a wrong-answer fault');
    expect(lie.seat).toBe(0);
    expect(lie.index).toBe(liedAtIndex);
    expect(lie.claimed).not.toBe(lie.actual);

    // The claimed feedback is a valid value, just not the true score of the host's secret.
    expect(VALID_FEEDBACK).toContain(lie.claimed);
    expect(lie.actual).toBe(score('1964', host.view().guesses[liedAtIndex] as string));

    // Both sides agree on the same final verdict.
    expect(host.view().verdict).toEqual(guest.view().verdict);

    await host.close();
    await guest.close();
  });
});

describe('the House Bot is labelled as a bot in the room (REQ-17.3)', () => {
  it('exposes the default label and a room-facing marker tying the label to its public key', () => {
    const clock = new ManualClock();
    const hub = new MemoryHub();
    const chain = new MemoryChain();
    const identity = generateIdentity();
    const bot = new HouseBot({
      room: ROOM,
      role: 'host',
      identity,
      rng: mulberry32(1),
      transport: hub.transport('host'),
      chain,
      storage: new MemoryStorage(),
      clock,
    });

    expect(HOUSE_BOT_LABEL).toBe('House Bot');
    expect(bot.label).toBe(HOUSE_BOT_LABEL);
    // The marker a room UI renders: the label plus the public key the opponent already sees.
    expect(bot.marker()).toEqual({ label: HOUSE_BOT_LABEL, publicKey: identity.publicKey });
  });

  it('honours a custom label', () => {
    const clock = new ManualClock();
    const hub = new MemoryHub();
    const chain = new MemoryChain();
    const identity = generateIdentity();
    const bot = new HouseBot({
      room: ROOM,
      role: 'guest',
      identity,
      label: 'Dealer',
      rng: mulberry32(1),
      transport: hub.transport('guest'),
      chain,
      storage: new MemoryStorage(),
      clock,
    });
    expect(bot.label).toBe('Dealer');
    expect(bot.marker().label).toBe('Dealer');
  });
});
