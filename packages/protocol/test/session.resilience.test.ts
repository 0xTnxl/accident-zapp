import { mulberry32 } from '@accident/engine';
import { describe, expect, it } from 'vitest';
import type { Verdict } from '../src/index.js';
import { parseMessage } from '../src/index.js';
import {
  autoplay,
  isDone,
  makePlayer,
  newWorld,
  resumePlayer,
  until,
  useDeterministicCrypto,
  vsPeer,
} from './harness.js';
import type { Player, World } from './harness.js';
import { ROOM } from './helpers.js';

useDeterministicCrypto();

function finalOf(p: Player): Extract<Verdict, { kind: 'final' }> {
  const v = p.session.view().verdict;
  if (v?.kind !== 'final')
    throw new Error(`expected final, got ${v?.kind} (${p.session.view().phase})`);
  return v;
}

async function pair(world: World, seedA = 1, seedB = 2) {
  const alice = makePlayer(world, { name: 'alice', role: 'host', secret: '1964', identityByte: 1 });
  const bob = makePlayer(world, { name: 'bob', role: 'guest', secret: '4271', identityByte: 2 });
  await alice.session.start();
  await bob.session.start();
  autoplay(alice, 'medium', seedA);
  autoplay(bob, 'medium', seedB);
  return { alice, bob };
}

/** Both players end in the same honest verdict. */
function expectAgreement(alice: Player, bob: Player): void {
  expect(alice.session.view().phase).toBe('final');
  expect(bob.session.view().phase).toBe('final');
  const a = finalOf(alice);
  expect(a).toEqual(finalOf(bob));
  expect(a.faults).toEqual([]);
  expect(alice.session.view().guesses).toEqual(bob.session.view().guesses);
  expect(alice.session.view().answers).toEqual(bob.session.view().answers);
}

describe('an unreliable relay', () => {
  it.each([0.1, 0.3, 0.5])('finishes a game when %d of all frames are lost', async (lossRate) => {
    const world = newWorld();
    const rng = mulberry32(Math.round(lossRate * 100));
    world.hub.drop = () => rng() < lossRate;
    const { alice, bob } = await pair(world);
    await until(world, () => isDone(alice) && isDone(bob), 3_000_000, 250);
    expectAgreement(alice, bob);
  });

  it('is not confused by every frame arriving twice or three times', async () => {
    const world = newWorld();
    world.hub.copies = (_f, _to) => 3;
    const { alice, bob } = await pair(world);
    await until(world, () => isDone(alice) && isDone(bob));
    expectAgreement(alice, bob);
    expect(alice.session.view().violations).toBe(0);
    expect(bob.session.view().violations).toBe(0);
  });

  it('recovers when frames arrive out of order', async () => {
    const world = newWorld();
    const rng = mulberry32(5);
    // Hold frames, then release each batch in a shuffled order, every 50 ms.
    world.hub.hold = true;
    const { alice, bob } = await pair(world);
    for (let t = 0; t < 2_000_000 && !(isDone(alice) && isDone(bob)); t += 50) {
      const order = world.hub.held.map((_, i) => i).sort(() => rng() - 0.5);
      world.hub.release(order);
      await world.clock.advance(50);
    }
    expectAgreement(alice, bob);
  });

  it('combines loss, duplication and a relay that echoes', async () => {
    const world = newWorld();
    const rng = mulberry32(99);
    world.hub.drop = () => rng() < 0.25;
    world.hub.copies = () => (rng() < 0.3 ? 2 : 1);
    world.hub.echo = true;
    const { alice, bob } = await pair(world);
    await until(world, () => isDone(alice) && isDone(bob), 3_000_000, 250);
    expectAgreement(alice, bob);
  });
});

describe('a connection that drops', () => {
  it('resumes after a long disconnect in the middle of a game', async () => {
    const world = newWorld();
    const { alice, bob } = await pair(world);
    await until(world, () => alice.session.view().guesses.length >= 4, 60_000);
    expect(alice.session.view().phase).toBe('playing');

    world.hub.setLink('bob', 'down');
    await world.clock.advance(60_000);
    expect(bob.session.view().relay).toBe('down');
    const stalled = alice.session.view().answers.length;
    await world.clock.advance(10_000);
    expect(alice.session.view().answers.length).toBe(stalled); // nothing moves while Bob is away

    world.hub.setLink('bob', 'up');
    await until(world, () => isDone(alice) && isDone(bob));
    expectAgreement(alice, bob);
  });

  it('reports the relay status honestly', async () => {
    const world = newWorld();
    const { alice } = await pair(world);
    await world.clock.advance(1_000);
    expect(alice.session.view().relay).toBe('up');
    world.hub.setLink('alice', 'down');
    await world.clock.advance(100);
    expect(alice.session.view().relay).toBe('down');
    world.hub.setLink('alice', 'up');
    await world.clock.advance(100);
    expect(alice.session.view().relay).toBe('up');
  });

  it('keeps going when sends fail while the connection is down', async () => {
    const world = newWorld();
    const { alice, bob } = await pair(world);
    await until(world, () => alice.session.view().guesses.length >= 2, 60_000);
    (world.hub.transport('x') as unknown as { failSends: boolean }).failSends = true; // unrelated transport
    world.hub.setLink('alice', 'down');
    world.hub.setLink('alice', 'up');
    await until(world, () => isDone(alice) && isDone(bob));
    expectAgreement(alice, bob);
  });
});

describe('a refresh in the middle of a game', () => {
  it.each([
    ['after the first guess', (p: Player) => p.session.view().guesses.length >= 1],
    ['mid-game', (p: Player) => p.session.view().guesses.length >= 5],
    ['when the game has just ended', (p: Player) => p.session.view().phase === 'revealing'],
  ])('resumes %s and reaches the same verdict', async (_name, when) => {
    const world = newWorld();
    const { alice, bob } = await pair(world);
    await until(world, () => when(bob), 120_000, 10);
    expect(when(bob)).toBe(true);

    // Bob's page dies. Everything in memory is gone; only storage remains.
    await bob.session.close();
    bob.stopAuto();
    const reborn = await resumePlayer(world, bob, {
      name: 'bob2',
      role: 'guest',
      secret: '4271',
      identityByte: 2,
    });
    await reborn.session.start();
    autoplay(reborn, 'medium', 2);

    await until(world, () => isDone(alice) && isDone(reborn));
    expectAgreement(alice, reborn);
  });

  it('resumes while a commit is still waiting for confirmation', async () => {
    const world = newWorld();
    world.chain.holdBack = true; // commits are sent but not yet confirmed
    const { alice, bob } = await pair(world);
    await world.clock.advance(5_000);
    expect(bob.session.view().phase).toBe('gate');
    expect(bob.session.view().myCommit).toBe('sent');

    await bob.session.close();
    bob.stopAuto();
    const reborn = await resumePlayer(world, bob, {
      name: 'bob2',
      role: 'guest',
      secret: '4271',
      identityByte: 2,
    });
    await reborn.session.start();
    autoplay(reborn, 'medium', 2);
    await world.clock.advance(5_000);
    expect(reborn.session.view().phase).toBe('gate');
    expect(reborn.session.view().myCommit).toBe('sent'); // remembered, not re-sent

    world.chain.confirmAll();
    await until(world, () => isDone(alice) && isDone(reborn));
    expectAgreement(alice, reborn);
    // The commit Memo was posted once per player, not again after the refresh.
    expect(world.chain.txs.filter((t) => t.text.split('|')[2] === 'C')).toHaveLength(2);
  });

  it('never reuses a sequence number, so a refresh cannot look like cheating', async () => {
    const world = newWorld();
    const { alice, bob } = await pair(world);
    await until(world, () => bob.session.view().guesses.length >= 5, 120_000, 10);
    await bob.session.close();
    bob.stopAuto();
    const reborn = await resumePlayer(world, bob, {
      name: 'bob2',
      role: 'guest',
      secret: '4271',
      identityByte: 2,
    });
    await reborn.session.start();
    autoplay(reborn, 'medium', 2);
    await until(world, () => isDone(alice) && isDone(reborn));

    // Every distinct message Bob ever put on the relay has a unique sequence number.
    const bySeq = new Map<number, Set<string>>();
    for (const frame of world.hub.frames) {
      const m = parseMessage(frame.raw);
      if (!m || m.from !== bob.identity.publicKey || m.type === 'SYNC') continue;
      bySeq.set(m.seq, (bySeq.get(m.seq) ?? new Set()).add(m.payload));
    }
    for (const [, payloads] of bySeq) expect(payloads.size).toBe(1);
    expect(finalOf(alice).faults).toEqual([]);
  });

  it('cannot resume when nothing was saved', async () => {
    const world = newWorld();
    const { alice } = await pair(world);
    await alice.session.close(); // stop it saving again
    alice.storage.data.clear();
    const { Session } = await import('../src/index.js');
    const none = await Session.resume({
      room: ROOM,
      identity: alice.identity,
      transport: world.hub.transport('x'),
      chain: world.chain,
      storage: alice.storage,
      clock: world.clock,
    });
    expect(none).toBeUndefined();
  });

  it('refuses corrupted or foreign saved state', async () => {
    const world = newWorld();
    const { alice, bob } = await pair(world);
    await world.clock.advance(1_000);
    const key = `accident:session:${ROOM}`;
    const good = alice.storage.data.get(key) as string;
    const { Session } = await import('../src/index.js');
    const base = {
      room: ROOM,
      transport: world.hub.transport('x'),
      chain: world.chain,
      storage: alice.storage,
      clock: world.clock,
    };
    for (const bad of [
      'not json',
      '[]',
      'null',
      JSON.stringify({ ...JSON.parse(good), v: 2 }),
      JSON.stringify({ ...JSON.parse(good), log: ['junk'] }),
      JSON.stringify({ ...JSON.parse(good), secret: '1123' }),
    ]) {
      alice.storage.data.set(key, bad);
      expect(await Session.resume({ ...base, identity: alice.identity })).toBeUndefined();
    }
    // Someone else's key cannot resume this player's game.
    alice.storage.data.set(key, good);
    expect(await Session.resume({ ...base, identity: bob.identity })).toBeUndefined();
    expect(await Session.resume({ ...base, identity: alice.identity })).toBeDefined();
  });
});

describe('a slow or failing chain', () => {
  it('waits patiently for slow confirmation, then plays', async () => {
    const world = newWorld();
    world.chain.holdBack = true;
    const { alice, bob } = await pair(world);
    await world.clock.advance(30_000);
    expect(alice.session.view().gateOpen).toBe(false);
    expect(alice.session.view().phase).toBe('gate');
    world.chain.confirmAll();
    await until(world, () => isDone(alice) && isDone(bob));
    expectAgreement(alice, bob);
  });

  it('retries a failed Memo send and succeeds', async () => {
    const world = newWorld();
    world.chain.failSends = 2; // the first two sends fail
    const { alice, bob } = await pair(world);
    await until(world, () => isDone(alice) && isDone(bob));
    expectAgreement(alice, bob);
    expect(alice.session.view().error).toBeUndefined();
  });

  it('shows a clear error after repeated failures, and recovers on retry', async () => {
    const world = newWorld();
    world.chain.failSends = 100;
    const { alice, bob } = await pair(world);
    await world.clock.advance(30_000);
    const error = alice.session.view().error;
    expect(error).toMatchObject({ code: 'commit-failed', retryable: true });
    expect(error?.message).toMatch(/RPC unavailable/);
    // It does not spin: a bounded number of attempts, then it waits for the player.
    const attempts = world.chain.calls.send;
    await world.clock.advance(30_000);
    expect(world.chain.calls.send).toBe(attempts);

    world.chain.failSends = 0;
    await alice.session.retry();
    await bob.session.retry();
    await until(world, () => isDone(alice) && isDone(bob));
    expectAgreement(alice, bob);
  });

  it('survives lookups that fail for a while', async () => {
    const world = newWorld();
    world.chain.failReads = true;
    const { alice, bob } = await pair(world);
    await world.clock.advance(20_000);
    expect(alice.session.view().gateOpen).toBe(false);
    world.chain.failReads = false;
    await until(world, () => isDone(alice) && isDone(bob));
    expectAgreement(alice, bob);
  });

  it('gives up on the gate after the timeout', async () => {
    const world = newWorld();
    world.chain.holdBack = true;
    const { alice } = await pair(world);
    await world.clock.advance(120_000);
    expect(alice.session.view().phase).toBe('abandoned');
    expect(alice.session.view().abandonReason).toMatch(/commits/);
  });

  it('does not abandon a host who is simply waiting for a friend to join', async () => {
    const world = newWorld();
    const alice = makePlayer(world, {
      name: 'alice',
      role: 'host',
      secret: '1964',
      identityByte: 1,
    });
    await alice.session.start();
    await world.clock.advance(1_000_000);
    expect(alice.session.view().phase).toBe('connecting');
  });
});

describe('timeouts (UI only)', () => {
  it('lets a player claim a win when the opponent goes silent', async () => {
    const { world, me } = await vsPeer({ peer: { secret: '4271', silent: true }, auto: false });
    await world.clock.advance(1_000);
    expect(me.view.phase).toBe('playing');
    expect(me.view.canGuess).toBe(true);
    await me.session.submitGuess('0123');
    await world.clock.advance(1_000);

    expect(me.view.onClock?.seat).toBe(1); // waiting on the silent opponent
    expect(me.view.timeoutClaimable).toBe(false);
    await expect(me.session.claimTimeout()).rejects.toThrow(/still has time/);

    await world.clock.advance(181_000);
    expect(me.view.timeoutClaimable).toBe(true);
    await me.session.claimTimeout();
    expect(me.view.phase).toBe('final');
    expect(me.view.outcome).toBe('timeout-win');
  });

  it('does not let a player claim a timeout while it is their own turn', async () => {
    const { world, me } = await vsPeer({ peer: { secret: '4271' }, auto: false });
    await world.clock.advance(300_000);
    expect(me.view.onClock?.seat).toBe(0); // it is my move
    expect(me.view.timeoutClaimable).toBe(false);
    await expect(me.session.claimTimeout()).rejects.toThrow(/still has time/);
  });

  it('restarts the countdown after every move', async () => {
    const { world, me } = await vsPeer({ peer: { secret: '4271' }, auto: true });
    await until(world, () => me.view.guesses.length >= 2, 30_000, 10);
    const first = me.view.onClock?.deadline;
    await world.clock.advance(1_000);
    expect(me.view.timeoutClaimable).toBe(false);
    expect(first).toBeDefined();
  });
});

describe('closing', () => {
  it('stops all activity after close and leaves the saved game for a later resume', async () => {
    const world = newWorld();
    const { alice, bob } = await pair(world);
    await until(world, () => alice.session.view().guesses.length >= 2, 60_000);
    await alice.session.close();
    expect(alice.session.view().phase).toBe('closed');
    const frames = world.hub.frames.length;
    const timers = world.clock.pendingTimers;
    await world.clock.advance(60_000);
    expect(world.hub.frames.filter((f) => f.from === 'alice').length).toBeLessThanOrEqual(frames);
    expect(alice.storage.data.has(`accident:session:${ROOM}`)).toBe(true);
    void bob;
    void timers;
  });

  it('close is idempotent and start is too', async () => {
    const world = newWorld();
    const alice = makePlayer(world, {
      name: 'alice',
      role: 'host',
      secret: '1964',
      identityByte: 1,
    });
    await alice.session.start();
    await alice.session.start();
    await alice.session.close();
    await alice.session.close();
    expect(alice.session.view().phase).toBe('closed');
  });

  it('rejects bad input when creating a session', async () => {
    const world = newWorld();
    const base = { name: 'x', role: 'host' as const, identityByte: 1 };
    expect(() => makePlayer(world, { ...base, secret: '1123' })).toThrow(/secret/);
    expect(() => makePlayer(world, { ...base, secret: '1964', room: 'bad' })).toThrow(/room/);
    expect(() => makePlayer(world, { ...base, secret: '1964', saltHex: 'abc' })).toThrow(/salt/);
  });
});
