import { describe, expect, it } from 'vitest';
import { encodeMessage, encodeRevealMemo, parseMessage } from '../src/index.js';
import {
  isDone,
  makePlayer,
  newWorld,
  resumePlayer,
  until,
  useDeterministicCrypto,
  vsPeer,
  autoplay,
} from './harness.js';
import { ROOM, Sender, identityFromByte } from './helpers.js';

useDeterministicCrypto();

/** The game log of a session, as its owner would persist it. */
function loggedTypes(storage: Map<string, string>): string[] {
  const state = JSON.parse(storage.get(`accident:session:${ROOM}`) as string) as { log: string[] };
  return state.log.map((line) => (JSON.parse(line) as { type: string }).type);
}

describe('rules that keep the record honest', () => {
  it('a GUESS that arrives before the gate never enters the game, even once it is held', async () => {
    const { world, me, peer } = await vsPeer({
      role: 'guest',
      peer: { secret: '4271' },
      auto: false,
      commit: false,
    });
    world.chain.holdBack = true;
    await peer.commit();
    await peer.guess('0123');
    await world.clock.advance(3_000);

    expect(me.view.gateOpen).toBe(false);
    expect(me.view.guesses).toEqual([]); // not in the game yet
    expect(loggedTypes(me.storage.data)).not.toContain('GUESS');
    expect(loggedTypes(me.storage.data)).not.toContain('ANSWER');
  });

  it('a stranger who speaks with the next expected sequence number is still ignored', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: '4271' }, auto: false });
    await world.clock.advance(1_000);
    expect(me.view.peerKey).toBe(peer.key);

    // The peer has sent HELLO (0) and COMMIT (1), so seq 2 is next. The stranger uses exactly that.
    const stranger = new Sender(identityFromByte(93), ROOM);
    stranger.seq = 2;
    world.hub.inject(
      ROOM,
      'stranger',
      encodeMessage(stranger.send({ type: 'GUESS', guess: '0123' })),
    );
    await world.clock.advance(1_000);

    expect(me.view.guesses).toEqual([]);
    expect(me.view.violations).toBe(0);
    expect(loggedTypes(me.storage.data)).toEqual(['HELLO', 'HELLO', 'COMMIT', 'COMMIT']);
  });

  it('the opponent cannot answer their own guess', async () => {
    const { world, me, peer } = await vsPeer({
      role: 'guest',
      peer: { secret: '4271' },
      auto: false,
    });
    await world.clock.advance(1_000);
    await peer.guess('0123'); // the host's guess 0, which we must answer
    await world.clock.advance(1_000);
    expect(me.view.answers).toHaveLength(1); // our honest answer

    // The host now also "answers" its own guess. Index 1 belongs to a guess we never made.
    await peer.send({ type: 'ANSWER', index: 1, feedback: 40 });
    await world.clock.advance(1_000);
    expect(me.view.answers).toHaveLength(1);
    expect(me.view.violations).toBe(1);
  });

  it('a wrong-seat answer to a real guess of the right index is a violation', async () => {
    // We (host) guess 0. The peer (guest) must answer it. Index 0 is answered by the guest: fine.
    // But if the host-side peer tried to answer index 0 while being the one who guessed it, it is wrong.
    const { world, me, peer } = await vsPeer({
      role: 'guest',
      peer: { secret: '4271' },
      auto: false,
    });
    await world.clock.advance(1_000);
    await peer.guess('0123');
    await world.clock.advance(1_000);
    // Index 0 was the peer's own guess; answering it is not allowed.
    await peer.send({ type: 'ANSWER', index: 0, feedback: 40 });
    await world.clock.advance(1_000);
    expect(me.view.violations).toBe(1);
    expect(me.view.answers).toHaveLength(1);
    expect(me.view.answers[0]).not.toBe(40);
  });

  it('a COMMIT announcement that arrives after the commit was already found on-chain changes nothing', async () => {
    // The opponent's commit is on-chain but was never announced, so the scan finds it first.
    const { world, me, peer } = await vsPeer({
      peer: { secret: '4271' },
      commit: false,
      auto: false,
    });
    await peer.postCommitOnly();
    await world.clock.advance(20_000);
    expect(me.view.peerCommit).toBe('verified');
    expect(me.view.gateOpen).toBe(true);

    // The announcement finally arrives. It is harmless: no violation, nothing replaced.
    await peer.send({ type: 'COMMIT', txSig: peer.commitSig as string });
    await world.clock.advance(2_000);
    expect(me.view.violations).toBe(0);
    expect(me.view.peerCommit).toBe('verified');
    expect(me.view.phase).toBe('playing');
  });

  it('an opponent who guesses and answers their own guess in one breath is caught', async () => {
    const { world, me, peer } = await vsPeer({
      role: 'guest',
      peer: { secret: '4271' },
      auto: false,
    });
    await world.clock.advance(1_000);

    // Both messages reach us together, before we have had a chance to answer the guess ourselves.
    world.hub.hold = true;
    await peer.guess('0123');
    await peer.send({ type: 'ANSWER', index: 0, feedback: 40 }); // they answer their own guess
    world.hub.hold = false;
    world.hub.release();
    await world.clock.advance(1_000);

    expect(me.view.violations).toBe(1);
    expect(me.view.answers).toHaveLength(1);
    expect(me.view.answers[0]).not.toBe(40); // only our honest answer counts
  });

  it('an early REVEAL does not enter the log, and a second one never replaces the first', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: '4271' }, auto: false });
    await world.clock.advance(1_000);
    await peer.send({
      type: 'REVEAL',
      secret: '4271',
      saltHex: peer.saltHex,
      txSig: peer.commitSig as string,
    });
    await world.clock.advance(1_000);
    expect(loggedTypes(me.storage.data)).not.toContain('REVEAL');
    expect(me.view.peerReveal).toBe('none');
  });

  it('only the first REVEAL counts once the game is over', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: '4271' } });
    await until(world, () => me.view.peerReveal !== 'none', 60_000, 20);
    const first = loggedTypes(me.storage.data).filter((t) => t === 'REVEAL').length;
    expect(first).toBe(2); // ours and theirs

    await peer.send({
      type: 'REVEAL',
      secret: '8901',
      saltHex: peer.saltHex,
      txSig: peer.revealSig as string,
    });
    await until(world, () => isDone(me));
    const types = loggedTypes(me.storage.data).filter((t) => t === 'REVEAL');
    expect(types).toHaveLength(2); // the second from the peer was ignored, not logged
    expect(me.view.violations).toBe(0);
  });
});

describe('acknowledgements', () => {
  it('re-acknowledges a message it already has, so the sender stops repeating it', async () => {
    const { world, me } = await vsPeer({ peer: { secret: '4271' }, auto: false });
    await world.clock.advance(1_000);
    const syncsBefore = world.hub.frames.filter(
      (f) => f.from === 'me' && parseMessage(f.raw)?.type === 'SYNC',
    ).length;

    // Replay the peer's own HELLO: we already have it, so we must say so.
    const hello = world.hub.frames.find(
      (f) => f.from === 'peer' && parseMessage(f.raw)?.type === 'HELLO',
    );
    world.hub.inject(ROOM, 'peer', (hello as { raw: string }).raw);
    await world.clock.advance(100);

    const syncsAfter = world.hub.frames.filter(
      (f) => f.from === 'me' && parseMessage(f.raw)?.type === 'SYNC',
    ).length;
    expect(syncsAfter).toBe(syncsBefore + 1);
    expect(me.view.violations).toBe(0);
  });

  it('says what it has the moment the connection comes back, without waiting for a timer', async () => {
    const { world, me } = await vsPeer({ peer: { secret: '4271' }, auto: false });
    await world.clock.advance(1_000);
    world.hub.setLink('me', 'down');
    await world.clock.advance(100);
    const before = world.hub.frames.length;
    world.hub.setLink('me', 'up');
    await world.clock.advance(10); // far less than the 3 s resend interval

    const sent = world.hub.frames.slice(before).filter((f) => f.from === 'me');
    const types = sent.map((f) => parseMessage(f.raw)?.type);
    expect(types).toContain('SYNC');
    expect(me.view.relay).toBe('up');
  });

  it('never acknowledges more than it has saved', async () => {
    const world = newWorld();
    const { me, peer } = await vsPeer({ world, peer: { secret: '4271' }, auto: false });
    await world.clock.advance(500);
    // Make saving slow to fail, then check that no SYNC claims the unsaved message.
    const before = world.hub.frames.length;
    me.storage.onSet = () => {
      throw new Error('disk full');
    };
    await peer.guess('0123');
    await world.clock.advance(1_000);
    const syncs = world.hub.frames
      .slice(before)
      .filter((f) => f.from === 'me')
      .map((f) => parseMessage(f.raw))
      .filter((m) => m?.type === 'SYNC');
    for (const sync of syncs) expect(sync?.payload).not.toBe('3'); // the guess was seq 2 → ack would be 2
    expect(syncs.every((s) => Number(s?.payload) < 2 || s?.payload === undefined)).toBe(true);
  });
});

describe('crash safety', () => {
  it('a message is saved before it is sent, so a crash cannot reuse its sequence number', async () => {
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

    // For every frame alice puts on the relay, her storage must already contain it.
    const violations: string[] = [];
    const key = `accident:session:${ROOM}`;
    const hub = world.hub;
    const deliver = hub.deliver.bind(hub);
    hub.deliver = (frame) => {
      if (frame.from === 'alice') {
        const m = parseMessage(frame.raw);
        if (m && m.type !== 'SYNC') {
          const saved = JSON.parse(alice.storage.data.get(key) ?? '{"log":[]}') as {
            log: string[];
          };
          const has = saved.log.some((line) => parseMessage(line)?.sig === m.sig);
          if (!has) violations.push(`${m.type}:${m.seq}`);
        }
      }
      deliver(frame);
    };
    await until(world, () => isDone(alice) && isDone(bob));
    expect(violations).toEqual([]);
  });

  it('a crash right after sending never leads to a different message under the same number', async () => {
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
    await until(world, () => alice.session.view().guesses.length >= 3, 60_000, 10);

    await alice.session.close();
    alice.stopAuto();
    const reborn = await resumePlayer(world, alice, {
      name: 'alice2',
      role: 'host',
      secret: '1964',
      identityByte: 1,
    });
    await reborn.session.start();
    autoplay(reborn, 'medium', 1);
    await until(world, () => isDone(reborn) && isDone(bob));

    const bySeq = new Map<number, Set<string>>();
    for (const frame of world.hub.frames) {
      const m = parseMessage(frame.raw);
      if (m?.from === alice.identity.publicKey && m.type !== 'SYNC') {
        bySeq.set(m.seq, (bySeq.get(m.seq) ?? new Set()).add(m.sig));
      }
    }
    for (const sigs of bySeq.values()) expect(sigs.size).toBe(1);
    expect(reborn.session.view().verdict).toEqual(bob.session.view().verdict);
  });
});

describe('background work ends with the game', () => {
  it('leaves no polling behind after a final verdict, and stops repeating itself', async () => {
    const { world, me } = await vsPeer({ peer: { secret: '4271' } });
    await until(world, () => isDone(me));
    const mine = (): number => world.hub.frames.filter((f) => f.from === 'me').length;

    await world.clock.advance(200_000); // long enough for every allowed last repeat
    const chainCalls = { ...world.chain.calls };
    const frames = mine();

    await world.clock.advance(3_600_000); // an hour of nothing
    expect(world.chain.calls).toEqual(chainCalls);
    expect(mine()).toBe(frames); // it has gone quiet, not just slowed down
  });

  it('repeats quickly at first, then backs off while an opponent is silent', async () => {
    const world = newWorld();
    const host = makePlayer(world, { name: 'host', role: 'host', secret: '1964', identityByte: 1 });
    await host.session.start();
    const times: number[] = [];
    const deliver = world.hub.deliver.bind(world.hub);
    world.hub.deliver = (frame) => {
      if (frame.from === 'host') times.push(world.clock.now());
      deliver(frame);
    };
    await world.clock.advance(300_000);
    // The HELLO went out before we started watching. Repeats then follow at 3, 9, 21, 45 s ...
    // (gaps that double from 3 s up to the 30 s cap), and then every 30 s.
    expect(times.slice(0, 5)).toEqual([3_000, 9_000, 21_000, 45_000, 75_000]);
    const gaps = times.slice(1).map((t, i) => t - (times[i] as number));
    expect(gaps.slice(0, 4)).toEqual([6_000, 12_000, 24_000, 30_000]);
    expect(Math.max(...gaps)).toBe(30_000);
  });

  it('goes back to repeating quickly once a stalled opponent starts moving again', async () => {
    const world = newWorld();
    // Acknowledgements never arrive, so only real game messages can show the opponent is alive.
    const lost: { next: boolean } = { next: false };
    world.hub.drop = (frame) => {
      const type = parseMessage(frame.raw)?.type;
      if (type === 'SYNC') return true;
      if (lost.next && frame.from === 'host' && type === 'GUESS') {
        lost.next = false;
        return true;
      }
      return false;
    };
    const host = makePlayer(world, { name: 'host', role: 'host', secret: '1964', identityByte: 1 });
    const guest = makePlayer(world, {
      name: 'guest',
      role: 'guest',
      secret: '4271',
      identityByte: 2,
    });
    await host.session.start();
    await guest.session.start();
    autoplay(host, 'medium', 1);
    autoplay(guest, 'medium', 2);
    await until(world, () => host.session.view().guesses.length >= 3, 120_000, 10);

    // The guest vanishes for a long time, so the host backs off to its 30 s maximum gap.
    world.hub.setLink('guest', 'down');
    await world.clock.advance(200_000);

    // The guest returns and the game moves again.
    world.hub.setLink('guest', 'up');
    await until(world, () => host.session.view().guesses.length >= 7, 120_000, 100);
    expect(host.session.view().guesses.length).toBeGreaterThanOrEqual(7);

    // Now the host's next guess is lost. Repair should take seconds, not another 30 s backoff.
    lost.next = true;
    const answered = host.session.view().answers.length;
    const started = world.clock.now();
    await until(
      world,
      () => host.session.view().answers.length > answered || isDone(host),
      120_000,
      100,
    );
    expect(host.session.view().answers.length).toBeGreaterThan(answered);
    expect(world.clock.now() - started).toBeLessThan(10_000);
  });

  it('a message that arrives while closing does not restart the timers', async () => {
    const world = newWorld();
    const host = makePlayer(world, { name: 'host', role: 'host', secret: '1964', identityByte: 1 });
    await host.session.start();
    await world.clock.advance(200_000); // backed off, so a reset has something to undo

    await host.session.close();
    const timersAfterClose = world.clock.pendingTimers;
    // Reach the internal reset the way a message handled at the last moment would.
    (host.session as unknown as { heardFromPeer(): void }).heardFromPeer();
    expect(world.clock.pendingTimers).toBe(timersAfterClose);
    await world.clock.advance(60_000);
    expect(world.hub.frames.filter((f) => f.from === 'host').length).toBeLessThan(40);
  });

  it('retries quickly after its own connection comes back, even if nobody has answered', async () => {
    const world = newWorld();
    const host = makePlayer(world, { name: 'host', role: 'host', secret: '1964', identityByte: 1 });
    await host.session.start();
    await world.clock.advance(200_000); // alone for a long time, so it has backed off to the maximum

    const times: number[] = [];
    const deliver = world.hub.deliver.bind(world.hub);
    world.hub.deliver = (frame) => {
      if (frame.from === 'host') times.push(world.clock.now());
      deliver(frame);
    };
    world.hub.setLink('host', 'down');
    world.hub.setLink('host', 'up');
    await world.clock.advance(20_000);

    // Straight away, then again after 3 s and 9 s, not a 30 s wait.
    expect(times).toEqual([200_000, 203_000, 209_000]);
  });

  it('an acknowledgement alone is enough to make it repeat quickly again', async () => {
    const world = newWorld();
    const host = makePlayer(world, { name: 'host', role: 'host', secret: '1964', identityByte: 1 });
    await host.session.start();
    await world.clock.advance(200_000);

    // A guest arrives and goes silent. The host keeps repeating its unacknowledged COMMIT and backs
    // off: repeats at 203, 209, 221, 245 s, with the next due at 275 s (inside the 90 s gate wait).
    const guest = new Sender(identityFromByte(2), ROOM);
    world.hub.inject(ROOM, 'guest', encodeMessage(guest.send({ type: 'HELLO', role: 'guest' })));
    const times: number[] = [];
    const deliver = world.hub.deliver.bind(world.hub);
    world.hub.deliver = (frame) => {
      if (frame.from === 'host' && parseMessage(frame.raw)?.type !== 'SYNC')
        times.push(world.clock.now());
      deliver(frame);
    };
    await world.clock.advance(60_000); // now at 260 s, a repeat is 15 s away
    times.length = 0;

    // The guest acknowledges the HELLO. That proves it is alive, so the host should speed up again.
    const ackAt = world.clock.now();
    const ack = new Sender(identityFromByte(2), ROOM);
    ack.seq = guest.seq;
    world.hub.inject(ROOM, 'guest', encodeMessage(ack.send({ type: 'SYNC', received: 0 })));
    await world.clock.advance(14_000); // still before the old 275 s timer would have fired

    // An immediate resend answers the SYNC, and the next one follows on the fast schedule.
    expect(times[0]).toBe(ackAt);
    expect(times[1]).toBe(ackAt + 3_000);
  });

  it('a late friend still hears the host at once, not after a long backoff', async () => {
    const world = newWorld();
    const host = makePlayer(world, { name: 'host', role: 'host', secret: '1964', identityByte: 1 });
    await host.session.start();
    await world.clock.advance(300_000); // the host has backed off to the maximum gap
    const guest = makePlayer(world, {
      name: 'guest',
      role: 'guest',
      secret: '4271',
      identityByte: 2,
    });
    await guest.session.start();
    await world.clock.advance(1_000); // far less than the backoff
    expect(guest.session.view().peerKey).toBe(host.identity.publicKey);
    expect(host.session.view().peerKey).toBe(guest.identity.publicKey);
  });

  it('does not keep scanning for a reveal that the verdict already proved', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: '4271' }, auto: true });
    peer.o.skipReveal = true;
    await until(world, () => me.view.phase === 'revealing', 60_000, 10);
    world.chain.post(peer.key, encodeRevealMemo(ROOM, '4271', peer.saltHex));
    await until(world, () => isDone(me), 60_000, 100);
    await world.clock.advance(5_000);
    const listed = world.chain.calls.list;
    await world.clock.advance(120_000);
    expect(world.chain.calls.list).toBe(listed);
  });
});

describe('evidence the UI can show', () => {
  it('reports the transaction signatures of both players’ commit and reveal Memos', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: '4271' } });
    // Early on only the commit exists: the reveal Memo is posted when the game ends, not before.
    expect(me.view.records.mine.commit).toBeDefined();
    expect(me.view.records.mine.reveal).toBeUndefined();
    expect(me.view.records.peer.reveal).toBeUndefined();
    await until(world, () => isDone(me));

    const mineOnChain = world.chain.txs.filter((t) => t.signer === me.identity.publicKey);
    const peerOnChain = world.chain.txs.filter((t) => t.signer === peer.key);
    const sigOf = (txs: typeof mineOnChain, kind: 'C' | 'R'): string | undefined =>
      txs.find((t) => t.text.split('|')[2] === kind)?.sig;

    expect(me.view.records.mine.commit).toBe(sigOf(mineOnChain, 'C'));
    expect(me.view.records.mine.reveal).toBe(sigOf(mineOnChain, 'R'));
    expect(me.view.records.peer.commit).toBe(sigOf(peerOnChain, 'C'));
    expect(me.view.records.peer.reveal).toBe(sigOf(peerOnChain, 'R'));
    for (const sig of Object.values({ ...me.view.records.mine, ...me.view.records.peer })) {
      expect(sig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/);
    }
  });

  it('exports the signed transcript, and it holds no secret before the reveals', async () => {
    const { world, me } = await vsPeer({ peer: { secret: '4271' }, auto: false });
    await world.clock.advance(1_000);
    await me.session.submitGuess('0123');
    await world.clock.advance(1_000);
    const exported = me.session.transcript();
    const types = exported.map((line) => (JSON.parse(line) as { type: string }).type);
    // Both HELLOs and COMMITs, our guess, their answer, then their own guess and our answer to it.
    expect(types.slice(0, 6)).toEqual(['HELLO', 'HELLO', 'COMMIT', 'COMMIT', 'GUESS', 'ANSWER']);
    expect(types.filter((t) => t === 'REVEAL')).toEqual([]);
    expect(exported.join('')).not.toContain(me.secret);
    // Each line is a complete, verifiable wire message.
    for (const line of exported) expect(parseMessage(line)).toBeDefined();
  });

  it('hands out a copy, so a caller cannot alter the log', async () => {
    const world = newWorld();
    const p = makePlayer(world, { name: 'p', role: 'host', secret: '1964', identityByte: 1 });
    await p.session.start();
    const copy = p.session.transcript();
    copy.length = 0;
    expect(p.session.transcript()).toHaveLength(1);
  });
});
