import type { Code, Feedback } from '@accident/engine';
import { score } from '@accident/engine';
import { describe, expect, it } from 'vitest';
import type { Fault, SessionView, Verdict } from '../src/index.js';
import { encodeMessage, parseMessage } from '../src/index.js';
import { isDone, until, useDeterministicCrypto, vsPeer } from './harness.js';
import { ROOM, identityFromByte, Sender } from './helpers.js';
import type { Player } from './harness.js';

useDeterministicCrypto();

const SECRET: Code = '1964';
const PEER_SECRET: Code = '4271';

const kinds = (faults: Fault[]): string[] => faults.map((f) => `${f.seat}:${f.kind}`);

function finalOf(view: SessionView): Extract<Verdict, { kind: 'final' }> {
  if (view.verdict?.kind !== 'final')
    throw new Error(`expected final, got ${view.verdict?.kind} (${view.phase})`);
  return view.verdict;
}

const typeOf = (raw: string): string => (JSON.parse(raw) as { type: string }).type;
const sentBy = (player: Player, frames: { from: string; raw: string }[], type: string) =>
  frames.filter((f) => f.from === player.name && typeOf(f.raw) === type);

describe('an honest session against a lying opponent', () => {
  it('a lying answer costs the liar the game', async () => {
    const { world, me, peer } = await vsPeer({
      peer: {
        secret: PEER_SECRET,
        lie: (i, truth): Feedback => (i === 2 ? (truth === 0 ? 1 : 0) : truth),
      },
    });
    await until(world, () => isDone(me));
    const v = finalOf(me.view);
    expect(v.result).toBe('seat0');
    expect(v.reason).toBe('fault');
    expect(kinds(v.faults)).toEqual(['1:wrong-answer']);
    expect(v.faults[0]).toMatchObject({ index: 2 });
    expect(peer.errors).toEqual([]);
  });

  it('a hidden 40 is caught at the reveal', async () => {
    const { world, me } = await vsPeer({
      peer: { secret: PEER_SECRET, lie: (_i, truth): Feedback => (truth === 40 ? 11 : truth) },
    });
    await until(world, () => isDone(me));
    const v = finalOf(me.view);
    expect(v.result).toBe('seat0');
    expect(v.faults).toEqual([
      expect.objectContaining({ seat: 1, kind: 'wrong-answer', claimed: 11, actual: 40 }),
    ]);
    // Nobody noticed during play: the hidden hit did not end the game.
    expect(me.view.answers.filter((f) => f === 40).length).toBeLessThanOrEqual(1);
  });

  it('a false 40 is caught at the reveal', async () => {
    const { world, me } = await vsPeer({
      peer: { secret: PEER_SECRET, lie: (i, truth): Feedback => (i === 2 ? 40 : truth) },
    });
    await until(world, () => isDone(me));
    const v = finalOf(me.view);
    expect(v.result).toBe('seat0');
    expect(v.faults).toEqual([
      expect.objectContaining({ seat: 1, kind: 'wrong-answer', index: 2, claimed: 40 }),
    ]);
  });

  it('an invalid secret in the reveal loses', async () => {
    const { world, me } = await vsPeer({ peer: { secret: PEER_SECRET, revealSecret: '1123' } });
    await until(world, () => isDone(me));
    const v = finalOf(me.view);
    expect(kinds(v.faults)).toEqual(['1:invalid-secret']);
    expect(v.result).toBe('seat0');
  });

  it('revealing a different valid secret than was committed loses', async () => {
    const { world, me } = await vsPeer({ peer: { secret: PEER_SECRET, revealSecret: '8902' } });
    await until(world, () => isDone(me));
    const v = finalOf(me.view);
    expect(kinds(v.faults)).toEqual(['1:commitment-mismatch']);
    expect(v.result).toBe('seat0');
  });

  it('posting a second, different commitment loses', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: PEER_SECRET } });
    peer.postSecondCommit();
    await until(world, () => isDone(me));
    const v = finalOf(me.view);
    expect(kinds(v.faults)).toEqual(['1:commit-equivocation']);
    expect(v.result).toBe('seat0');
  });

  it('a player who never reveals forfeits after the window, and the verdict waits until then', async () => {
    const { world, me } = await vsPeer({ peer: { secret: PEER_SECRET, skipReveal: true } });
    await until(world, () => me.view.phase === 'revealing' && me.view.myReveal === 'sent');
    await world.clock.advance(5_000);
    expect(me.view.verdict).toMatchObject({ kind: 'pending', waitingFor: [1] });

    // Well inside the 180 s window, nothing is decided.
    await world.clock.advance(100_000);
    expect(me.view.verdict?.kind).toBe('pending');

    await until(world, () => isDone(me));
    const v = finalOf(me.view);
    expect(kinds(v.faults)).toEqual(['1:no-reveal']);
    expect(v.result).toBe('seat0');
    expect(v.verifiedSecrets).toEqual([SECRET, undefined]);
  });

  it('still wins honestly when the opponent plays fairly', async () => {
    const { world, me } = await vsPeer({ peer: { secret: PEER_SECRET } });
    await until(world, () => isDone(me));
    expect(finalOf(me.view).faults).toEqual([]);
  });
});

describe('the play gate', () => {
  it('sends no GUESS and no ANSWER until both commits are confirmed on-chain', async () => {
    const { world, me, peer } = await vsPeer({
      role: 'guest', // the scripted peer is the host, so it legitimately guesses first
      peer: { secret: PEER_SECRET },
      commit: false,
    });
    world.chain.holdBack = true; // commits land but are not confirmed yet
    await peer.commit();
    await peer.guess('0123'); // an eager opponent guesses straight away
    await world.clock.advance(20_000);

    expect(me.view.gateOpen).toBe(false);
    expect(me.view.phase).toBe('gate');
    expect(sentBy(me, world.hub.frames, 'GUESS')).toEqual([]);
    expect(sentBy(me, world.hub.frames, 'ANSWER')).toEqual([]);
    await expect(me.session.submitGuess('1234')).rejects.toThrow(/not started/);

    world.chain.confirmAll();
    await world.clock.advance(5_000);

    // Now the held guess is answered, and answered correctly.
    expect(me.view.gateOpen).toBe(true);
    const firstAnswer = sentBy(me, world.hub.frames, 'ANSWER')[0];
    expect(parseMessage(firstAnswer?.raw)?.payload).toBe(`0:${score(SECRET, '0123')}`);
  });

  it('does not open on an announced commit that is not on-chain, and gives up', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: PEER_SECRET }, commit: false });
    await peer.send({
      type: 'COMMIT',
      txSig: 'A'.repeat(88).replace(/A/g, '1').slice(0, 64) + 'x'.repeat(0),
    });
    await world.clock.advance(120_000);
    expect(me.view.gateOpen).toBe(false);
    expect(me.view.phase).toBe('abandoned');
    expect(me.view.abandonReason).toMatch(/commits/);
  });

  it("rejects a commit announcement whose transaction belongs to someone else's key", async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: PEER_SECRET }, commit: false });
    const stranger = identityFromByte(77).publicKey;
    const sig = world.chain.post(stranger, `ACC1|${ROOM}|C|${'ab'.repeat(32)}`);
    await peer.send({ type: 'COMMIT', txSig: sig });
    await world.clock.advance(120_000);
    expect(me.view.gateOpen).toBe(false);
    expect(me.view.phase).toBe('abandoned');
  });

  it('finds the opponent commit on-chain even if the announcement is lost', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: PEER_SECRET }, commit: false });
    await peer.postCommitOnly(); // on the chain, but never announced
    await world.clock.advance(20_000);
    expect(me.view.peerCommit).toBe('verified');
    expect(me.view.gateOpen).toBe(true);
  });
});

describe('messages that break the rules', () => {
  it('an out-of-turn guess is ignored and not answered', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: PEER_SECRET }, auto: false });
    await world.clock.advance(1_000);
    expect(me.view.gateOpen).toBe(true);
    await peer.guess('0123'); // the host must guess first, so this is out of turn
    await world.clock.advance(1_000);

    expect(me.view.violations).toBe(1);
    expect(me.view.guesses).toEqual([]);
    expect(sentBy(me, world.hub.frames, 'ANSWER')).toEqual([]);
    // The game still works afterwards.
    await me.session.submitGuess('0123');
    await world.clock.advance(1_000);
    expect(me.view.guesses).toEqual(['0123']);
    expect(me.view.answers).toHaveLength(1);
  });

  it('a second guess before the first is answered is a violation', async () => {
    const { world, me, peer } = await vsPeer({
      role: 'guest',
      peer: { secret: PEER_SECRET },
      auto: false,
    });
    await peer.guess('0123');
    await peer.guess('4567'); // seat 0 again, with no answer in between
    await world.clock.advance(2_000);
    expect(me.view.guesses).toEqual(['0123']);
    expect(me.view.violations).toBe(1);
  });

  it('an answer to a guess that was never made is a violation', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: PEER_SECRET }, auto: false });
    await world.clock.advance(1_000);
    await peer.send({ type: 'ANSWER', index: 0, feedback: 0 });
    await world.clock.advance(1_000);
    expect(me.view.violations).toBe(1);
    expect(me.view.answers).toEqual([]);
  });

  it('an answer for the wrong index is a violation', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: PEER_SECRET }, auto: false });
    await world.clock.advance(1_000);
    await me.session.submitGuess('0123');
    await world.clock.advance(500);
    const before = me.view.answers.length;
    await peer.send({ type: 'ANSWER', index: 5, feedback: 0 });
    await world.clock.advance(500);
    expect(me.view.violations).toBeGreaterThanOrEqual(1);
    expect(me.view.answers.length).toBe(before + 0 === 1 ? 1 : before);
  });

  it('a REVEAL before the game is over is held, not trusted', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: PEER_SECRET }, auto: false });
    await world.clock.advance(1_000);
    await peer.send({
      type: 'REVEAL',
      secret: PEER_SECRET,
      saltHex: peer.saltHex,
      txSig: peer.commitSig as string,
    });
    await world.clock.advance(2_000);
    expect(me.view.phase).toBe('playing');
    expect(me.view.verdict).toBeUndefined();
    expect(me.view.violations).toBe(0);
  });

  it('a repeated HELLO after pinning is a violation', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: PEER_SECRET }, auto: false });
    await peer.hello();
    await world.clock.advance(1_000);
    expect(me.view.violations).toBe(1);
  });
});

describe('forgery, replay and strangers', () => {
  it('ignores a message with a forged signature', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: PEER_SECRET }, auto: false });
    await world.clock.advance(1_000);
    const real = new Sender(identityFromByte(2), ROOM);
    real.seq = peer.sender.seq;
    const message = real.send({ type: 'GUESS', guess: '0123' });
    const forged = encodeMessage({ ...message, payload: '9876' });
    world.hub.inject(ROOM, 'peer', forged);
    await world.clock.advance(1_000);
    expect(me.view.violations).toBe(0);
    expect(me.view.guesses).toEqual([]);
  });

  it('ignores a message that claims to be from the opponent but is signed by another key', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: PEER_SECRET }, auto: false });
    await world.clock.advance(1_000);
    const mallory = new Sender(identityFromByte(90), ROOM);
    mallory.seq = peer.sender.seq;
    const message = mallory.send({ type: 'GUESS', guess: '0123' });
    world.hub.inject(ROOM, 'peer', encodeMessage({ ...message, from: peer.key }));
    await world.clock.advance(1_000);
    expect(me.view.guesses).toEqual([]);
    expect(me.view.violations).toBe(0);
  });

  it('ignores a validly signed stranger, before and after pinning', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: PEER_SECRET }, auto: false });
    const stranger = new Sender(identityFromByte(91), ROOM);
    world.hub.inject(
      ROOM,
      'stranger',
      encodeMessage(stranger.send({ type: 'HELLO', role: 'guest' })),
    );
    world.hub.inject(
      ROOM,
      'stranger',
      encodeMessage(stranger.send({ type: 'GUESS', guess: '0123' })),
    );
    await world.clock.advance(1_000);
    expect(me.view.peerKey).toBe(peer.key);
    expect(me.view.guesses).toEqual([]);
    expect(me.view.violations).toBe(0);
  });

  it('ignores a message for another room', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: PEER_SECRET }, auto: false });
    await world.clock.advance(1_000);
    const other = new Sender(peer.identity, 'ZZZ999');
    other.seq = 2;
    world.hub.inject(ROOM, 'peer', encodeMessage(other.send({ type: 'GUESS', guess: '0123' })));
    await world.clock.advance(1_000);
    expect(me.view.guesses).toEqual([]);
  });

  it('a replayed message changes nothing', async () => {
    const { world, me } = await vsPeer({ peer: { secret: PEER_SECRET } });
    await until(world, () => me.view.answers.length >= 4, 60_000);
    const logBefore = JSON.stringify(me.view.answers) + JSON.stringify(me.view.guesses);
    const violationsBefore = me.view.violations;
    for (const frame of world.hub.frames.filter((f) => f.from === 'peer').slice(0, 6)) {
      world.hub.inject(ROOM, 'peer', frame.raw);
    }
    await world.clock.advance(1_000);
    const upto = me.view.answers.length;
    expect(JSON.stringify(me.view.answers.slice(0, 4))).toBe(
      JSON.stringify(JSON.parse(logBefore.split(']')[0] + ']').slice(0, 4)),
    );
    expect(me.view.violations).toBe(violationsBefore);
    expect(upto).toBeGreaterThanOrEqual(4);
  });

  it('is unaffected by a relay that echoes its own messages back', async () => {
    const { world, me } = await vsPeer({ peer: { secret: PEER_SECRET } });
    world.hub.echo = true;
    await until(world, () => isDone(me));
    expect(finalOf(me.view).faults).toEqual([]);
    expect(me.view.violations).toBe(0);
  });

  it('a feedback of 31 is dropped before it reaches the game', async () => {
    const { world, me, peer } = await vsPeer({ peer: { secret: PEER_SECRET }, auto: false });
    await world.clock.advance(1_000);
    await me.session.submitGuess('0123');
    await world.clock.advance(500);
    const before = [...me.view.answers];
    const violations = me.view.violations;
    // A correctly signed ANSWER with the impossible value 31, using the peer's next sequence number.
    world.hub.inject(ROOM, 'peer', peer.forge(peer.sender.seq + 5, 'ANSWER', '2:31'));
    await world.clock.advance(1_000);
    expect(me.view.answers).toEqual(before);
    expect(me.view.violations).toBe(violations);
  });
});
