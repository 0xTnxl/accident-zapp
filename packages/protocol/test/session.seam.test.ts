import type { Code, Feedback } from '@accident/engine';
import { candidatesFromHistory, chooseGuess, mulberry32, VALID_FEEDBACK } from '@accident/engine';
import { describe, expect, it } from 'vitest';
import type { AnswerPolicy, SessionView, Verdict } from '../src/index.js';
import { Session } from '../src/index.js';
import { ManualClock, MemoryChain, MemoryHub, MemoryStorage } from '../src/testing/index.js';
import { identityFromByte, ROOM, saltOf } from './helpers.js';
import { useDeterministicCrypto } from './harness.js';

useDeterministicCrypto();

interface Side {
  session: Session;
  view: SessionView;
}

/** Builds one session wired to the shared world, optionally with an answer policy. */
function makeSide(
  world: { clock: ManualClock; hub: MemoryHub; chain: MemoryChain },
  o: {
    name: string;
    role: 'host' | 'guest';
    identityByte: number;
    secret: Code;
    saltHex: string;
    hostKey?: string;
    answerPolicy?: AnswerPolicy;
  },
): Side {
  const session = Session.create({
    room: ROOM,
    role: o.role,
    identity: identityFromByte(o.identityByte),
    secret: o.secret,
    saltHex: o.saltHex,
    ...(o.hostKey === undefined ? {} : { hostKey: o.hostKey }),
    transport: world.hub.transport(o.name),
    chain: world.chain,
    storage: new MemoryStorage(),
    clock: world.clock,
    options: {},
    ...(o.answerPolicy === undefined ? {} : { answerPolicy: o.answerPolicy }),
  });
  const side: Side = { session, view: session.view() };
  session.subscribe((view) => {
    side.view = view;
  });
  return side;
}

/** Makes a side guess honestly whenever it is its turn, as the harness autoplay does. */
function autoplay(side: Side, seed: number): void {
  const rng = mulberry32(seed);
  let submitted = -1;
  const guess = (view: SessionView): void => {
    if (!view.canGuess || view.guesses.length === submitted) return;
    submitted = view.guesses.length;
    const history = view.guesses
      .map((g, index) => ({ g, index }))
      .filter(({ index }) => index % 2 === view.seat && view.answers[index] !== undefined)
      .map(({ g, index }) => ({ guess: g, feedback: view.answers[index] as number }));
    const code = chooseGuess('medium', candidatesFromHistory(history), rng) ?? '0123';
    void side.session.submitGuess(code).catch(() => undefined);
  };
  side.session.subscribe(guess);
  guess(side.session.view());
}

async function until(clock: ManualClock, done: () => boolean, limitMs = 600_000): Promise<void> {
  for (let t = 0; t < limitMs && !done(); t += 100) await clock.advance(100);
}

function finalOf(v: Verdict | undefined): Extract<Verdict, { kind: 'final' }> {
  if (v?.kind !== 'final') throw new Error(`expected a final verdict, got ${v?.kind}`);
  return v;
}

describe('the Session answerPolicy seam', () => {
  it('is honest by default: no answerPolicy answers with the true score', async () => {
    const world = { clock: new ManualClock(), hub: new MemoryHub(), chain: new MemoryChain() };
    const host = makeSide(world, {
      name: 'host',
      role: 'host',
      identityByte: 1,
      secret: '1964',
      saltHex: saltOf(0xa1),
    });
    const guest = makeSide(world, {
      name: 'guest',
      role: 'guest',
      identityByte: 2,
      secret: '4271',
      saltHex: saltOf(0xb2),
      hostKey: identityFromByte(1).publicKey,
    });

    await host.session.start();
    await guest.session.start();
    autoplay(host, 1);
    autoplay(guest, 2);
    const isDone = (): boolean =>
      ['final', 'abandoned'].includes(host.view.phase) &&
      ['final', 'abandoned'].includes(guest.view.phase);
    await until(world.clock, isDone);

    const verdict = finalOf(host.view.verdict);
    expect(verdict.faults).toEqual([]);
    expect(host.view.verdict).toEqual(guest.view.verdict);
  });

  it('sends a wrong but valid answer when the policy overrides one index, caught at finalisation', async () => {
    const world = { clock: new ManualClock(), hub: new MemoryHub(), chain: new MemoryChain() };
    // The host (seat 0) answers the odd indexes (answererOf(index) === 0 when index is odd), so it
    // can only lie on an odd index. Index 1 is the host's first answer.
    const liedAtIndex = 1;
    // The host lies on that answer: a valid feedback that differs from the honest score.
    const policy: AnswerPolicy = ({ index, honest }): Feedback =>
      index === liedAtIndex ? (VALID_FEEDBACK.find((v) => v !== honest) as Feedback) : honest;

    const host = makeSide(world, {
      name: 'host',
      role: 'host',
      identityByte: 1,
      secret: '1964',
      saltHex: saltOf(0xa1),
      answerPolicy: policy,
    });
    const guest = makeSide(world, {
      name: 'guest',
      role: 'guest',
      identityByte: 2,
      secret: '4271',
      saltHex: saltOf(0xb2),
      hostKey: identityFromByte(1).publicKey,
    });

    await host.session.start();
    await guest.session.start();
    autoplay(host, 1);
    autoplay(guest, 2);
    const isDone = (): boolean =>
      ['final', 'abandoned'].includes(host.view.phase) &&
      ['final', 'abandoned'].includes(guest.view.phase);
    await until(world.clock, isDone);

    const verdict = finalOf(guest.view.verdict);
    // Finalisation re-scores every answer and charges the host a 'wrong-answer' fault, so the
    // honest guest (seat 1) wins by reason 'fault'.
    expect(verdict.reason).toBe('fault');
    expect(verdict.result).toBe('seat1');
    const lie = verdict.faults.find((f) => f.kind === 'wrong-answer');
    if (lie?.kind !== 'wrong-answer') throw new Error('expected a wrong-answer fault');
    expect(lie.seat).toBe(0);
    expect(lie.index).toBe(liedAtIndex);
    expect(lie.claimed).not.toBe(lie.actual);
    // Both sides agree on the same verdict.
    expect(host.view.verdict).toEqual(guest.view.verdict);
  });
});
