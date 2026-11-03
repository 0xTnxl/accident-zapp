import { describe, expect, it } from 'vitest';
import type { SessionView } from '../src/index.js';
import { encodeMessage, Session } from '../src/index.js';
import {
  isDone,
  makePlayer,
  newWorld,
  until,
  useDeterministicCrypto,
  vsPeer,
  autoplay,
} from './harness.js';
import { ROOM, Sender, fakeSig, identityFromByte, saltOf } from './helpers.js';

useDeterministicCrypto();

describe('pinning the host from the share link', () => {
  it('a guest with the host key ignores an impostor host who speaks first', async () => {
    const world = newWorld();
    const host = identityFromByte(1);
    const guest = makePlayer(world, {
      name: 'guest',
      role: 'guest',
      secret: '4271',
      identityByte: 2,
      hostKey: host.publicKey,
    });
    await guest.session.start();

    const impostor = new Sender(identityFromByte(50), ROOM);
    world.hub.inject(
      ROOM,
      'impostor',
      encodeMessage(impostor.send({ type: 'HELLO', role: 'host' })),
    );
    await world.clock.advance(1_000);
    expect(guest.session.view().peerKey).toBeUndefined();
    expect(guest.session.view().phase).toBe('connecting');

    const real = new Sender(host, ROOM);
    world.hub.inject(ROOM, 'host', encodeMessage(real.send({ type: 'HELLO', role: 'host' })));
    await world.clock.advance(1_000);
    expect(guest.session.view().peerKey).toBe(host.publicKey);
  });

  it('without a host key, the first host HELLO is trusted', async () => {
    const world = newWorld();
    const guest = makePlayer(world, {
      name: 'guest',
      role: 'guest',
      secret: '4271',
      identityByte: 2,
    });
    await guest.session.start();
    const first = new Sender(identityFromByte(50), ROOM);
    world.hub.inject(ROOM, 'first', encodeMessage(first.send({ type: 'HELLO', role: 'host' })));
    await world.clock.advance(1_000);
    expect(guest.session.view().peerKey).toBe(identityFromByte(50).publicKey);
  });

  it('a host ignores a HELLO that claims the wrong role, and one that is not the first message', async () => {
    const world = newWorld();
    const host = makePlayer(world, { name: 'host', role: 'host', secret: '1964', identityByte: 1 });
    await host.session.start();
    const other = new Sender(identityFromByte(50), ROOM);
    world.hub.inject(ROOM, 'other', encodeMessage(other.send({ type: 'HELLO', role: 'host' })));
    await world.clock.advance(500);
    expect(host.session.view().peerKey).toBeUndefined();
    world.hub.inject(ROOM, 'other', encodeMessage(other.send({ type: 'HELLO', role: 'guest' }))); // seq 1
    await world.clock.advance(500);
    expect(host.session.view().peerKey).toBeUndefined();
  });

  it('ignores all traffic before any opponent has said HELLO, including SYNC', async () => {
    const world = newWorld();
    const host = makePlayer(world, { name: 'host', role: 'host', secret: '1964', identityByte: 1 });
    await host.session.start();
    const other = new Sender(identityFromByte(50), ROOM);
    world.hub.inject(ROOM, 'other', encodeMessage(other.send({ type: 'SYNC', received: 0 })));
    world.hub.inject(ROOM, 'other', 'garbage');
    await world.clock.advance(500);
    expect(host.session.view().peerKey).toBeUndefined();
    expect(host.session.view().violations).toBe(0);
  });
});

describe('using the API wrongly', () => {
  it('rejects an invalid guess, a guess out of turn and a guess before the gate', async () => {
    const { world, me } = await vsPeer({ peer: { secret: '4271' }, role: 'guest', auto: false });
    await world.clock.advance(1_000);
    expect(me.view.gateOpen).toBe(true);
    await expect(me.session.submitGuess('1123')).rejects.toThrow(/four different digits/);
    await expect(me.session.submitGuess('abcd')).rejects.toThrow(RangeError);
    // The scripted peer is the host and must guess first, so it is not our turn.
    await expect(me.session.submitGuess('0123')).rejects.toThrow(/not your turn/);

    const early = makePlayer(newWorld(), {
      name: 'e',
      role: 'host',
      secret: '1964',
      identityByte: 1,
    });
    await early.session.start();
    await expect(early.session.submitGuess('0123')).rejects.toThrow(/not started/);
  });

  it('a second guess while the first is unanswered is refused', async () => {
    const { world, me } = await vsPeer({ peer: { secret: '4271', silent: true }, auto: false });
    await world.clock.advance(1_000);
    await me.session.submitGuess('0123');
    await expect(me.session.submitGuess('4567')).rejects.toThrow(/not your turn/);
    expect(me.view.guesses).toEqual(['0123']);
  });
});

describe('the buffer for early and held messages is bounded', () => {
  it('drops messages far ahead of the next expected one instead of growing without limit', async () => {
    const { world, me, peer } = await vsPeer({
      peer: { secret: '4271' },
      auto: false,
      options: { maxPending: 2 },
    });
    await world.clock.advance(1_000);
    // Skip ahead: sequence numbers 10..30 while the next expected is lower. Only two can be kept.
    for (let seq = 10; seq < 30; seq++) {
      world.hub.inject(ROOM, 'peer', peer.forge(seq, 'SYNC', '0'));
      world.hub.inject(ROOM, 'peer', peer.forge(seq, 'GUESS', '0123'));
    }
    await world.clock.advance(1_000);
    expect(me.view.violations).toBe(0);
    expect(me.view.guesses).toEqual([]);
    // The session is still healthy and the game still works.
    await me.session.submitGuess('0123');
    await world.clock.advance(1_000);
    expect(me.view.answers.length).toBeGreaterThanOrEqual(1);
  });
});

describe('reveals', () => {
  it('ignores a second REVEAL message from the opponent', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: '4271' } });
    await until(world, () => me.view.peerReveal !== 'none', 60_000, 50);
    const before = me.view.violations;
    await peer.send({
      type: 'REVEAL',
      secret: '8888'.slice(0, 0) + '8901',
      saltHex: saltOf(3),
      txSig: peer.revealSig as string,
    });
    await until(world, () => isDone(me));
    expect(me.view.violations).toBe(before);
    expect(me.view.verdict?.kind).toBe('final');
  });

  it('retries a failed reveal Memo and still reaches a verdict', async () => {
    const { world, me } = await vsPeer({ peer: { secret: '4271' } });
    // Commits are done once play starts. From here every send fails, including the reveal.
    await until(
      world,
      () => me.view.phase === 'playing' && me.view.guesses.length >= 1,
      60_000,
      10,
    );
    world.chain.failSends = 100;
    await until(world, () => me.view.error !== undefined, 120_000, 50);
    expect(me.view.error?.code).toBe('reveal-failed');
    expect(me.view.error?.retryable).toBe(true);

    // It stops after a few attempts instead of hammering the RPC.
    const attempts = world.chain.calls.send;
    await world.clock.advance(30_000);
    expect(world.chain.calls.send).toBe(attempts);

    world.chain.failSends = 0;
    await me.session.retry();
    await until(world, () => isDone(me));
    expect(me.view.error).toBeUndefined();
    expect(me.view.verdict?.kind).toBe('final');
  });

  it('finds the opponent reveal by scanning when the announced signature is wrong', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: '4271' } });
    peer.o.skipReveal = true; // the scripted peer stays quiet; we post its reveal ourselves
    await until(world, () => me.view.phase === 'revealing', 60_000, 10);
    const { encodeRevealMemo } = await import('../src/index.js');
    world.chain.post(peer.key, encodeRevealMemo(ROOM, '4271', peer.saltHex));
    // Announce a signature that points at nothing. The scan must find the real one.
    await peer.send({
      type: 'REVEAL',
      secret: '4271',
      saltHex: peer.saltHex,
      txSig: fakeSig(201),
    });
    await until(world, () => isDone(me), 120_000);
    const verdict = me.view.verdict;
    expect(verdict?.kind).toBe('final');
    if (verdict?.kind === 'final') {
      expect(verdict.faults).toEqual([]);
      expect(verdict.verifiedSecrets[1]).toBe('4271');
    }
  });

  it('stops asking the chain once the game is settled', async () => {
    const { world, me } = await vsPeer({ peer: { secret: '4271' } });
    await until(world, () => isDone(me));
    await world.clock.advance(10_000);
    const calls = { ...world.chain.calls };
    await world.clock.advance(120_000);
    expect(world.chain.calls).toEqual(calls);
  });
});

describe('the turn timer tells the UI when time is up', () => {
  it('emits to subscribers at the moment the countdown ends, without any other event', async () => {
    const { world, me } = await vsPeer({ peer: { secret: '4271', silent: true }, auto: false });
    await world.clock.advance(1_000);
    await me.session.submitGuess('0123');
    await world.clock.advance(500);

    const views: SessionView[] = [];
    me.session.subscribe((v) => views.push(v));
    await world.clock.advance(170_000);
    expect(views.every((v) => !v.timeoutClaimable)).toBe(true);

    views.length = 0;
    await world.clock.advance(20_000); // the 180 s mark passes with no message from anyone
    expect(views.some((v) => v.timeoutClaimable)).toBe(true);
  });

  it('shows the deadline as a time in the future', async () => {
    const { world, me } = await vsPeer({ peer: { secret: '4271' }, auto: false });
    await world.clock.advance(1_000);
    const clock = me.view.onClock;
    expect(clock?.seat).toBe(0);
    expect((clock?.deadline ?? 0) - world.clock.now()).toBeGreaterThan(170_000);
  });
});

describe('closing while work is in flight', () => {
  it('does not post or send anything after close, even if the chain answers late', async () => {
    const world = newWorld();
    const alice = makePlayer(world, {
      name: 'alice',
      role: 'host',
      secret: '1964',
      identityByte: 1,
    });
    const bob = makePlayer(world, { name: 'bob', role: 'guest', secret: '4271', identityByte: 2 });

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = world.chain.sendMemo.bind(world.chain);
    world.chain.sendMemo = async (signer, text) => {
      await gate; // the chain is slow
      return original(signer, text);
    };

    await alice.session.start();
    await bob.session.start();
    await world.clock.advance(5_000);
    await alice.session.close();
    const framesAtClose = world.hub.frames.filter((f) => f.from === 'alice').length;
    release();
    await world.clock.advance(10_000);
    expect(world.hub.frames.filter((f) => f.from === 'alice').length).toBe(framesAtClose);
    expect(alice.session.view().myCommit).toBe('none');
  });

  it('stops retrying a failing Memo when closed', async () => {
    const world = newWorld();
    world.chain.failSends = 100;
    const alice = makePlayer(world, {
      name: 'alice',
      role: 'host',
      secret: '1964',
      identityByte: 1,
    });
    const bob = makePlayer(world, { name: 'bob', role: 'guest', secret: '4271', identityByte: 2 });
    await alice.session.start();
    await bob.session.start();
    await world.clock.advance(600); // mid-backoff
    await alice.session.close();
    const calls = world.chain.calls.send;
    await world.clock.advance(60_000);
    expect(world.chain.calls.send).toBeLessThanOrEqual(calls + 1);
  });

  it('survives a transport that fails to leave', async () => {
    const world = newWorld();
    const alice = makePlayer(world, {
      name: 'alice',
      role: 'host',
      secret: '1964',
      identityByte: 1,
    });
    await alice.session.start();
    const transport = (
      alice.session as unknown as { config: { transport: { leave(): Promise<void> } } }
    ).config.transport;
    transport.leave = async () => {
      throw new Error('socket already closed');
    };
    await expect(alice.session.close()).resolves.toBeUndefined();
  });
});

describe('internal failures are shown, never swallowed', () => {
  it('reports a storage failure as an internal error instead of dying silently', async () => {
    const world = newWorld();
    const { me, peer } = await vsPeer({ peer: { secret: '4271' }, auto: false, world });
    me.storage.onSet = () => {
      throw new Error('disk full');
    };
    await peer.send({ type: 'SYNC', received: 0 });
    await peer.guess('0123');
    await world.clock.advance(2_000);
    expect(me.view.error).toMatchObject({ code: 'internal' });
    expect(me.view.error?.message).toMatch(/disk full/);
    expect(me.view.error?.retryable).toBe(false);
  });

  it('describes a non-Error failure as text', async () => {
    const world = newWorld();
    const { me, peer } = await vsPeer({ peer: { secret: '4271' }, auto: false, world });
    me.storage.onSet = () => {
      throw 'plain string failure';
    };
    await peer.guess('0123');
    await world.clock.advance(2_000);
    expect(me.view.error?.message).toBe('plain string failure');
  });
});

describe('a session created from scratch', () => {
  it('is in the connecting phase with an empty game', () => {
    const world = newWorld();
    const p = makePlayer(world, { name: 'p', role: 'guest', secret: '4271', identityByte: 2 });
    const v = p.session.view();
    expect(v).toMatchObject({
      phase: 'connecting',
      seat: 1,
      role: 'guest',
      relay: 'down',
      myCommit: 'none',
      peerCommit: 'none',
      gateOpen: false,
      canGuess: false,
      guesses: [],
      answers: [],
      violations: 0,
    });
    expect(Session.create).toBeTypeOf('function');
  });

  it('autoplay can drive a whole game through the public API', async () => {
    const world = newWorld();
    const a = makePlayer(world, { name: 'a', role: 'host', secret: '1964', identityByte: 1 });
    const b = makePlayer(world, { name: 'b', role: 'guest', secret: '4271', identityByte: 2 });
    await a.session.start();
    await b.session.start();
    autoplay(a, 'easy', 21);
    autoplay(b, 'hard', 22);
    await until(world, () => isDone(a) && isDone(b));
    expect(a.session.view().verdict).toEqual(b.session.view().verdict);
  });
});

describe('remaining corners', () => {
  it('works with no subscribers at all', async () => {
    const world = newWorld();
    const p = makePlayer(world, { name: 'p', role: 'host', secret: '1964', identityByte: 1 });
    // makePlayer subscribes for its own bookkeeping; a bare session has none.
    const bare = Session.create({
      room: ROOM,
      role: 'host',
      identity: identityFromByte(5),
      secret: '1964',
      saltHex: saltOf(1),
      transport: world.hub.transport('bare'),
      chain: world.chain,
      storage: p.storage,
      clock: world.clock,
    });
    await bare.start();
    await world.clock.advance(5_000);
    expect(bare.view().phase).toBe('connecting');
    await bare.close();
  });

  it('holds an early ANSWER until the gate opens, then applies it in order', async () => {
    // The scripted peer is the host. It commits, guesses, and later answers our guess, all before
    // our gate opens, because confirmation of its commit is held back.
    const { world, me, peer } = await vsPeer({
      role: 'guest',
      peer: { secret: '4271' },
      auto: false,
      commit: false,
    });
    world.chain.holdBack = true;
    await peer.commit();
    await peer.guess('0123');
    await world.clock.advance(2_000);
    expect(me.view.gateOpen).toBe(false);

    // An ANSWER to a guess of ours that cannot exist yet (gate closed, so we have made none).
    await peer.send({ type: 'ANSWER', index: 1, feedback: 0 });
    await world.clock.advance(2_000);
    expect(me.view.answers).toEqual([]); // held, not applied

    world.chain.confirmAll();
    await world.clock.advance(5_000);
    // Once open, the stale ANSWER is judged on the rules: there was no guess 1, so it is a violation.
    expect(me.view.gateOpen).toBe(true);
    expect(me.view.violations).toBe(1);
    expect(me.view.answers).toHaveLength(1); // only our own answer to their first guess
  });

  it('holds an ANSWER that is next in order while the gate is still closed', async () => {
    // The peer sends only HELLO and COMMIT, then an ANSWER as its very next message (seq 2).
    // Our gate is closed because its commit is unconfirmed, so that ANSWER must wait, not count.
    const { world, me, peer } = await vsPeer({
      role: 'guest',
      peer: { secret: '4271' },
      auto: false,
      commit: false,
    });
    world.chain.holdBack = true;
    await peer.commit();
    await peer.send({ type: 'ANSWER', index: 0, feedback: 0 });
    await world.clock.advance(3_000);
    expect(me.view.gateOpen).toBe(false);
    expect(me.view.violations).toBe(0); // held, not judged yet
    expect(me.view.answers).toEqual([]);

    world.chain.confirmAll();
    await world.clock.advance(5_000);
    // Now it is judged against the rules: no guess of ours exists, so it is a violation.
    expect(me.view.gateOpen).toBe(true);
    expect(me.view.violations).toBe(1);
    expect(me.view.answers).toEqual([]);
  });

  it('a sleep begun after close returns at once instead of waiting', async () => {
    const world = newWorld();
    const p = makePlayer(world, { name: 'p', role: 'host', secret: '1964', identityByte: 1 });
    await p.session.start();
    await p.session.close();
    const sleep = (p.session as unknown as { sleep(ms: number): Promise<void> }).sleep.bind(
      p.session,
    );
    const timersBefore = world.clock.pendingTimers;
    await expect(sleep(60_000)).resolves.toBeUndefined();
    expect(world.clock.pendingTimers).toBe(timersBefore); // no timer was left behind
  });

  it('reports an abandoned verdict when neither player ever reveals', async () => {
    const { world, me } = await vsPeer({ peer: { secret: '4271', skipReveal: true } });
    // Make our own reveal fail permanently so that nobody reveals.
    await until(
      world,
      () => me.view.phase === 'playing' && me.view.guesses.length >= 1,
      60_000,
      10,
    );
    world.chain.failSends = 1000;
    await until(world, () => me.view.phase === 'abandoned', 400_000, 500);
    expect(me.view.phase).toBe('abandoned');
    expect(me.view.verdict).toEqual({ kind: 'abandoned', faults: [] });
  });

  it('describes a Memo failure that is not an Error', async () => {
    const world = newWorld();
    world.chain.sendMemo = async () => {
      throw 'rate limited';
    };
    const a = makePlayer(world, { name: 'a', role: 'host', secret: '1964', identityByte: 1 });
    const b = makePlayer(world, { name: 'b', role: 'guest', secret: '4271', identityByte: 2 });
    await a.session.start();
    await b.session.start();
    await world.clock.advance(20_000);
    expect(a.session.view().error).toMatchObject({
      code: 'commit-failed',
      message: 'The Memo transaction failed',
    });
  });

  it('a poll loop that wakes after close exits cleanly', async () => {
    const world = newWorld();
    world.chain.holdBack = true;
    const a = makePlayer(world, { name: 'a', role: 'host', secret: '1964', identityByte: 1 });
    const b = makePlayer(world, { name: 'b', role: 'guest', secret: '4271', identityByte: 2 });
    await a.session.start();
    await b.session.start();
    await world.clock.advance(3_000); // polling is under way
    await a.session.close();
    await b.session.close();
    const calls = { ...world.chain.calls };
    await world.clock.advance(60_000);
    expect(world.chain.calls).toEqual(calls);
  });

  it('closing in the middle of the reveal Memo send posts nothing further', async () => {
    const { world, me } = await vsPeer({ peer: { secret: '4271' } });
    await until(
      world,
      () => me.view.phase === 'playing' && me.view.guesses.length >= 1,
      60_000,
      10,
    );
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = world.chain.sendMemo.bind(world.chain);
    world.chain.sendMemo = async (signer, text) => {
      if (text.split('|')[2] === 'R') await gate; // only the reveal is slow
      return original(signer, text);
    };
    await until(world, () => me.view.phase === 'revealing', 60_000, 10);
    await me.session.close();
    const revealsBefore = world.hub.frames.filter(
      (f) => f.from === 'me' && f.raw.includes('"REVEAL"'),
    ).length;
    release();
    await world.clock.advance(10_000);
    const revealsAfter = world.hub.frames.filter(
      (f) => f.from === 'me' && f.raw.includes('"REVEAL"'),
    ).length;
    expect(revealsAfter).toBe(revealsBefore);
  });

  it('finds a reveal by scanning after the signature lookup keeps failing', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: '4271', skipReveal: true } });
    await until(world, () => me.view.phase === 'revealing', 60_000, 10);
    const { encodeRevealMemo } = await import('../src/index.js');
    const real = world.chain.post(peer.key, encodeRevealMemo(ROOM, '4271', peer.saltHex));
    void real;
    await peer.send({
      type: 'REVEAL',
      secret: '4271',
      saltHex: peer.saltHex,
      txSig: fakeSig(200),
    });
    // Make the verdict scan fail so only the reveal poll's own scan can confirm the reveal.
    const list = world.chain.listMemoTxs.bind(world.chain);
    let n = 0;
    world.chain.listMemoTxs = async (address, room) => {
      if (address === peer.key && n++ < 2) throw new Error('scan failed');
      return list(address, room);
    };
    await until(world, () => me.view.peerReveal === 'verified', 60_000, 100);
    expect(me.view.peerReveal).toBe('verified');
  });
});
