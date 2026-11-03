import { gameStatus } from '@accident/engine';
import { describe, expect, it } from 'vitest';
import type { Verdict } from '../src/index.js';
import { parseMessage, selectReveal, transcriptHash, assembleTranscript } from '../src/index.js';
import { ROOM } from './helpers.js';
import {
  autoplay,
  isDone,
  makePlayer,
  newWorld,
  resumePlayer,
  until,
  useDeterministicCrypto,
} from './harness.js';

function finalOf(v: Verdict | undefined) {
  if (v?.kind !== 'final') throw new Error(`expected a final verdict, got ${v?.kind}`);
  return v;
}

useDeterministicCrypto();

describe('a complete game between two sessions', () => {
  it('plays from HELLO to the same final verdict on both sides', async () => {
    const world = newWorld();
    const alice = makePlayer(world, {
      name: 'alice',
      role: 'host',
      secret: '1964',
      identityByte: 1,
    });
    const bob = makePlayer(world, { name: 'bob', role: 'guest', secret: '4271', identityByte: 2 });

    await alice.session.start();
    await bob.session.start();
    autoplay(alice, 'medium', 1);
    autoplay(bob, 'medium', 2);
    await until(world, () => isDone(alice) && isDone(bob));

    expect(alice.view.phase).toBe('final');
    expect(bob.view.phase).toBe('final');
    const a = finalOf(alice.view.verdict);
    const b = finalOf(bob.view.verdict);
    expect(a).toEqual(b);
    expect(a.faults).toEqual([]);
    expect(a.verifiedSecrets).toEqual(['1964', '4271']);

    // The verdict matches what the live rules decided.
    const live = gameStatus([...alice.view.answers]);
    if (!live.over) throw new Error('game should be over');
    expect(a.result).toBe(live.result);

    // Both sides saw the same game.
    expect(alice.view.guesses).toEqual(bob.view.guesses);
    expect(alice.view.answers).toEqual(bob.view.answers);
  });

  it('writes exactly four Memo transactions: two commits and two reveals', async () => {
    const world = newWorld();
    const alice = makePlayer(world, {
      name: 'alice',
      role: 'host',
      secret: '1964',
      identityByte: 1,
    });
    const bob = makePlayer(world, { name: 'bob', role: 'guest', secret: '4271', identityByte: 2 });
    await alice.session.start();
    await bob.session.start();
    autoplay(alice, 'medium', 3);
    autoplay(bob, 'medium', 4);
    await until(world, () => isDone(alice) && isDone(bob));

    expect(world.chain.txs.map((t) => t.text.split('|')[2]).sort()).toEqual(['C', 'C', 'R', 'R']);
    expect(world.chain.calls.send).toBe(4);
  });

  it('anchors the transcript hash in both reveal Memos, and it matches the real transcript', async () => {
    const world = newWorld();
    const alice = makePlayer(world, {
      name: 'alice',
      role: 'host',
      secret: '1964',
      identityByte: 1,
    });
    const bob = makePlayer(world, { name: 'bob', role: 'guest', secret: '4271', identityByte: 2 });
    await alice.session.start();
    await bob.session.start();
    autoplay(alice, 'hard', 5);
    autoplay(bob, 'hard', 6);
    await until(world, () => isDone(alice) && isDone(bob));

    const messages = world.hub.frames
      .map((f) => parseMessage(f.raw))
      .filter((m) => m !== undefined);
    const assembled = assembleTranscript(ROOM, messages);
    if (!assembled.ok) throw new Error(assembled.reason);
    const expected = await transcriptHash(assembled.transcript);

    for (const player of [alice, bob]) {
      const reveal = selectReveal(world.chain.txs, ROOM, player.identity.publicKey);
      expect(reveal?.reveal.transcriptHash).toBe(expected);
    }
  });

  it('keeps secrets and salts off the relay until the game is over', async () => {
    const world = newWorld();
    const alice = makePlayer(world, {
      name: 'alice',
      role: 'host',
      secret: '1964',
      identityByte: 1,
    });
    const bob = makePlayer(world, { name: 'bob', role: 'guest', secret: '4271', identityByte: 2 });
    await alice.session.start();
    await bob.session.start();
    autoplay(alice, 'medium', 7);
    autoplay(bob, 'medium', 8);
    await until(world, () => isDone(alice) && isDone(bob));

    const typeOf = (raw: string): string => (JSON.parse(raw) as { type: string }).type;
    const firstReveal = world.hub.frames.findIndex((f) => typeOf(f.raw) === 'REVEAL');
    expect(firstReveal).toBeGreaterThan(0);

    for (const frame of world.hub.frames.slice(0, firstReveal)) {
      // A secret may appear as a guess (the winning guess is the opponent's secret) but nowhere else.
      if (typeOf(frame.raw) !== 'GUESS') {
        expect(frame.raw).not.toContain('1964');
        expect(frame.raw).not.toContain('4271');
      }
      // Salts never appear before a reveal.
      expect(frame.raw).not.toContain(alice.saltHex);
      expect(frame.raw).not.toContain(bob.saltHex);
    }
    // Nor does anything on the chain reveal a secret until the reveal Memos.
    const commits = world.chain.txs.filter((t) => t.text.split('|')[2] === 'C');
    for (const tx of commits) {
      expect(tx.text).not.toContain('1964');
      expect(tx.text).not.toContain('4271');
    }
  });

  it('stores each secret and salt before any Memo is sent', async () => {
    const world = newWorld();
    const alice = makePlayer(world, {
      name: 'alice',
      role: 'host',
      secret: '1964',
      identityByte: 1,
    });
    const bob = makePlayer(world, { name: 'bob', role: 'guest', secret: '4271', identityByte: 2 });

    const savedBeforeFirstMemo: string[] = [];
    const originalSend = world.chain.sendMemo.bind(world.chain);
    world.chain.sendMemo = async (signer, text) => {
      const owner = signer.publicKey === alice.identity.publicKey ? alice : bob;
      const saved = owner.storage.data.get(`accident:session:${ROOM}`) ?? '';
      savedBeforeFirstMemo.push(
        saved.includes(owner.secret) && saved.includes(owner.saltHex) ? 'yes' : 'no',
      );
      return originalSend(signer, text);
    };

    await alice.session.start();
    await bob.session.start();
    autoplay(alice, 'medium', 9);
    autoplay(bob, 'medium', 10);
    await until(world, () => isDone(alice) && isDone(bob));
    expect(savedBeforeFirstMemo.length).toBe(4);
    expect(new Set(savedBeforeFirstMemo)).toEqual(new Set(['yes']));
  });
});

it('records when the play gate opened and when the game ended, in clock order, and keeps both across a resume', async () => {
  const world = newWorld();
  const alice = makePlayer(world, {
    name: 'alice',
    role: 'host',
    secret: '1964',
    identityByte: 1,
  });
  const bob = makePlayer(world, { name: 'bob', role: 'guest', secret: '4271', identityByte: 2 });

  expect(alice.view.gateOpenedAt).toBeUndefined();
  expect(alice.view.gameOverAt).toBeUndefined();

  await alice.session.start();
  await bob.session.start();
  autoplay(alice, 'medium', 12);
  autoplay(bob, 'medium', 13);
  await until(world, () => isDone(alice) && isDone(bob));

  for (const player of [alice, bob]) {
    expect(player.view.gateOpenedAt).toBeTypeOf('number');
    expect(player.view.gameOverAt).toBeTypeOf('number');
    // The gate opens before the game is over: nothing is played until both commits verify, and
    // the game only ends once play has happened.
    expect(player.view.gateOpenedAt as number).toBeLessThanOrEqual(
      player.view.gameOverAt as number,
    );
  }

  // Both timestamps are each player's own clock reading of their own moment, saved as part of
  // State (JSON.stringify(this.s)) and restored by resume, not recomputed or reset afterwards.
  const resumed = await resumePlayer(world, alice, {
    name: 'alice',
    role: 'host',
    secret: '1964',
    identityByte: 1,
  });
  expect(resumed.view.gateOpenedAt).toBe(alice.view.gateOpenedAt);
  expect(resumed.view.gameOverAt).toBe(alice.view.gameOverAt);
});
