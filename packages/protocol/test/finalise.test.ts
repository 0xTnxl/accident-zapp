import type { Code, Feedback, Seat } from '@accident/engine';
import {
  VALID_FEEDBACK,
  answererOf,
  gameStatus,
  mulberry32,
  pick,
  randomCode,
  score,
} from '@accident/engine';
import { describe, expect, it } from 'vitest';
import type { Fault, FinaliseInput, MemoTx, Verdict } from '../src/index.js';
import {
  assembleTranscript,
  encodeCommitMemo,
  encodeRevealMemo,
  finalise,
  selectCommit,
  selectReveal,
  toChainCommit,
  toChainReveal,
  transcriptHash,
} from '../src/index.js';
import type { Game } from './helpers.js';
import { fakeSig, neverHit, playGame, saltOf } from './helpers.js';

type Overrides = Partial<Pick<FinaliseInput, 'commits' | 'reveals' | 'revealWindowClosed'>>;

async function judge(
  game: Game,
  overrides: Overrides = {},
  messages = game.messages,
): Promise<Verdict> {
  const assembled = assembleTranscript(game.room, messages);
  if (!assembled.ok) throw new Error(assembled.reason);
  return finalise({
    transcript: assembled.transcript,
    commits: game.commits,
    reveals: game.reveals,
    revealWindowClosed: false,
    ...overrides,
  });
}

function final(verdict: Verdict) {
  if (verdict.kind !== 'final') throw new Error(`Expected a final verdict, got ${verdict.kind}`);
  return verdict;
}

const kinds = (faults: Fault[], seat?: Seat): string[] =>
  faults.filter((f) => seat === undefined || f.seat === seat).map((f) => f.kind);

/** Two secrets that cannot be hit by the dummy guess 0123, so games run to the 24-guess cap. */
const QUIET: [Code, Code] = ['4567', '8901'];

/** Picks a feedback different from `truth`. */
const differentFrom = (truth: Feedback): Feedback => (truth === 0 ? 1 : 0);

describe('honest games', () => {
  it('reach the result the live rules reached, with no faults (model-based)', async () => {
    const rng = mulberry32(2026);
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const game = await playGame({ secrets: [randomCode(rng), randomCode(rng)], rng });
      const verdict = final(await judge(game));
      const live = gameStatus(game.claimed);
      if (!live.over) throw new Error('the game must end');
      expect(verdict.result).toBe(live.result);
      expect(verdict.faults).toEqual([]);
      expect(verdict.verifiedSecrets).toEqual(game.secrets);
      seen.add(`${verdict.result}/${verdict.reason}`);
    }
    // The sample must exercise more than one kind of ending to mean anything.
    expect(seen.size).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('agrees whichever order the messages arrive in', async () => {
    const rng = mulberry32(5);
    const game = await playGame({ secrets: [randomCode(rng), randomCode(rng)], rng });
    const expected = await judge(game);
    const reversed = await judge(game, {}, [...game.messages].reverse());
    expect(reversed).toEqual(expected);
  });

  it('seat 0 hitting first and seat 1 missing its final guess: seat 0 wins', async () => {
    const game = await playGame({
      secrets: QUIET,
      rng: mulberry32(1),
      guessFor: (index) => (index === 4 ? '8901' : '0123'),
    });
    expect(final(await judge(game))).toMatchObject({ result: 'seat0', reason: 'first-hit' });
  });

  it('seat 1 hitting first: seat 1 wins at once', async () => {
    const game = await playGame({
      secrets: QUIET,
      rng: mulberry32(1),
      guessFor: (index) => (index === 5 ? '4567' : '0123'),
    });
    expect(game.guesses).toHaveLength(6);
    expect(final(await judge(game))).toMatchObject({ result: 'seat1', reason: 'first-hit' });
  });

  it('both hitting in the same round: draw', async () => {
    const game = await playGame({
      secrets: QUIET,
      rng: mulberry32(1),
      guessFor: (index) => (index === 4 ? '8901' : index === 5 ? '4567' : '0123'),
    });
    expect(final(await judge(game))).toMatchObject({ result: 'draw', reason: 'equal-round' });
  });

  it('no hit in 24 guesses: draw at the cap', async () => {
    const game = await playGame({ secrets: QUIET, rng: mulberry32(1), guessFor: neverHit });
    expect(game.guesses).toHaveLength(24);
    expect(final(await judge(game))).toMatchObject({ result: 'draw', reason: 'cap' });
  });
});

describe('attack: a lying answer', () => {
  it.each([
    ['seat 1 lies about an early guess', 2, 1],
    ['seat 0 lies about a guess', 3, 0],
    ['seat 1 lies about the first guess', 0, 1],
    ['seat 0 lies about the last guess', 23, 0],
  ] as const)('%s', async (_name, index, liar) => {
    const game = await playGame({
      secrets: QUIET,
      rng: mulberry32(1),
      guessFor: neverHit,
      claim: (i, truth) => (i === index ? differentFrom(truth) : truth),
    });
    expect(answererOf(index)).toBe(liar);
    const verdict = final(await judge(game));
    expect(verdict.result).toBe(liar === 0 ? 'seat1' : 'seat0');
    expect(verdict.reason).toBe('fault');
    expect(kinds(verdict.faults)).toEqual(['wrong-answer']);
    expect(verdict.faults[0]).toEqual({
      seat: liar,
      kind: 'wrong-answer',
      index,
      claimed: differentFrom(game.truth[index] as Feedback),
      actual: game.truth[index],
    });
  });

  it('a liar loses even when they would have won honestly', async () => {
    // Seat 0 hits at index 4 and would win. Seat 0 also tells one small lie about seat 1's guess.
    const game = await playGame({
      secrets: QUIET,
      rng: mulberry32(1),
      guessFor: (index) => (index === 4 ? '8901' : '0123'),
      claim: (i, truth) => (i === 1 ? differentFrom(truth) : truth),
    });
    const verdict = final(await judge(game));
    expect(verdict.result).toBe('seat1');
    expect(kinds(verdict.faults, 0)).toEqual(['wrong-answer']);
  });

  it('finds every lie, not only the first', async () => {
    const game = await playGame({
      secrets: QUIET,
      rng: mulberry32(1),
      guessFor: neverHit,
      claim: (i, truth) => (i === 2 || i === 6 || i === 8 ? differentFrom(truth) : truth),
    });
    const verdict = final(await judge(game));
    const lies = verdict.faults.filter((f) => f.kind === 'wrong-answer');
    expect(lies.map((f) => (f.kind === 'wrong-answer' ? f.index : -1))).toEqual([2, 6, 8]);
    expect(new Set(lies.map((f) => f.seat))).toEqual(new Set([1]));
  });

  it('both players lying is a draw', async () => {
    const game = await playGame({
      secrets: QUIET,
      rng: mulberry32(1),
      guessFor: neverHit,
      claim: (i, truth) => (i === 2 || i === 3 ? differentFrom(truth) : truth),
    });
    expect(final(await judge(game))).toMatchObject({ result: 'draw', reason: 'both-at-fault' });
  });
});

describe('attack: a false 40', () => {
  it('claiming a hit that did not happen loses', async () => {
    const game = await playGame({
      secrets: QUIET,
      rng: mulberry32(1),
      guessFor: neverHit,
      claim: (i, truth) => (i === 2 ? 40 : truth),
    });
    expect(game.claimed[2]).toBe(40);
    // The live rules stop almost at once because of the claimed hit.
    expect(game.guesses.length).toBeLessThanOrEqual(4);
    const verdict = final(await judge(game));
    expect(verdict.result).toBe('seat0'); // seat 1 made the false claim
    expect(verdict.faults).toEqual([
      { seat: 1, kind: 'wrong-answer', index: 2, claimed: 40, actual: score('8901', '0123') },
    ]);
  });
});

describe('attack: a hidden 40', () => {
  it('hiding a real hit loses, and the game runs on until the reveal exposes it', async () => {
    const game = await playGame({
      secrets: QUIET,
      rng: mulberry32(1),
      guessFor: (index) => (index === 4 ? '8901' : '0123'),
      claim: (i, truth) => (i === 4 ? 11 : truth),
    });
    expect(game.truth[4]).toBe(40);
    expect(game.claimed[4]).toBe(11);
    expect(game.guesses).toHaveLength(24); // nobody noticed, so the game continued
    const verdict = final(await judge(game));
    expect(verdict.result).toBe('seat0');
    expect(verdict.faults).toEqual([
      { seat: 1, kind: 'wrong-answer', index: 4, claimed: 11, actual: 40 },
    ]);
  });

  it('a player who hides a hit on the opponent is beaten even if they hit back later', async () => {
    const game = await playGame({
      secrets: QUIET,
      rng: mulberry32(1),
      guessFor: (index) => (index === 4 ? '8901' : index === 9 ? '4567' : '0123'),
      claim: (i, truth) => (i === 4 ? 11 : truth),
    });
    const verdict = final(await judge(game));
    expect(verdict.result).toBe('seat0');
    expect(verdict.reason).toBe('fault');
  });
});

describe('attack: a bad reveal', () => {
  it('an invalid secret (repeated digits) loses', async () => {
    const game = await playGame({ secrets: QUIET, rng: mulberry32(1), guessFor: neverHit });
    const reveals: Game['reveals'] = [game.reveals[0], { ...game.reveals[1], secret: '1123' }];
    const verdict = final(await judge(game, { reveals }));
    expect(verdict.result).toBe('seat0');
    expect(verdict.faults).toEqual([{ seat: 1, kind: 'invalid-secret' }]);
    expect(verdict.verifiedSecrets).toEqual([QUIET[0], undefined]);
  });

  it.each([
    ['a different secret', { secret: '8902' }],
    ['a different salt', { salt: saltOf(0x77) }],
  ])('%s than was committed loses', async (_name, change) => {
    const game = await playGame({ secrets: QUIET, rng: mulberry32(1), guessFor: neverHit });
    const reveals: Game['reveals'] = [{ ...game.reveals[0], ...change }, game.reveals[1]];
    const verdict = final(await judge(game, { reveals }));
    expect(verdict.result).toBe('seat1');
    expect(verdict.faults).toEqual([{ seat: 0, kind: 'commitment-mismatch' }]);
  });

  it('a mismatched reveal is not also charged with lies against a secret it did not commit to', async () => {
    const game = await playGame({
      secrets: QUIET,
      rng: mulberry32(1),
      guessFor: neverHit,
      claim: (i, truth) => (i === 1 ? differentFrom(truth) : truth),
    });
    // Seat 0 lied about index 1 and then reveals a secret that does not match its commitment.
    const reveals: Game['reveals'] = [{ ...game.reveals[0], secret: '8902' }, game.reveals[1]];
    const verdict = final(await judge(game, { reveals }));
    expect(kinds(verdict.faults, 0)).toEqual(['commitment-mismatch']);
    expect(verdict.result).toBe('seat1');
  });

  it('a reveal signed by the wrong key is a fault, but the genuine secret still counts', async () => {
    const game = await playGame({ secrets: QUIET, rng: mulberry32(1), guessFor: neverHit });
    const reveals: Game['reveals'] = [
      { ...game.reveals[0], signer: game.identities[1].publicKey },
      game.reveals[1],
    ];
    const verdict = final(await judge(game, { reveals }));
    expect(verdict.faults).toEqual([{ seat: 0, kind: 'reveal-signer-mismatch' }]);
    expect(verdict.verifiedSecrets).toEqual(game.secrets);
    expect(verdict.result).toBe('seat1');
  });

  it('a conflicting second reveal is a fault', async () => {
    const game = await playGame({ secrets: QUIET, rng: mulberry32(1), guessFor: neverHit });
    const reveals: Game['reveals'] = [game.reveals[0], { ...game.reveals[1], conflicting: true }];
    const verdict = final(await judge(game, { reveals }));
    expect(verdict.faults).toEqual([{ seat: 1, kind: 'reveal-conflict' }]);
    expect(verdict.result).toBe('seat0');
  });
});

describe('attack: commit games', () => {
  it('posting two different commitments is a fault', async () => {
    const game = await playGame({ secrets: QUIET, rng: mulberry32(1), guessFor: neverHit });
    const commits: Game['commits'] = [game.commits[0], { ...game.commits[1], equivocated: true }];
    const verdict = final(await judge(game, { commits }));
    expect(verdict.faults).toEqual([{ seat: 1, kind: 'commit-equivocation' }]);
    expect(verdict.result).toBe('seat0');
  });

  it('never committing is a fault, and their reveal cannot be trusted', async () => {
    const game = await playGame({ secrets: QUIET, rng: mulberry32(1), guessFor: neverHit });
    const verdict = final(await judge(game, { commits: [game.commits[0], undefined] }));
    expect(verdict.faults).toEqual([{ seat: 1, kind: 'no-commit' }]);
    expect(verdict.verifiedSecrets).toEqual([QUIET[0], undefined]);
    expect(verdict.result).toBe('seat0');
  });

  it('signing two different messages with the same seq is a fault', async () => {
    const game = await playGame({ secrets: QUIET, rng: mulberry32(1), guessFor: neverHit });
    const guess = game.messages.find(
      (m) => m.type === 'GUESS' && m.from === game.identities[0].publicKey,
    );
    const twin = game.senders[0];
    twin.seq = guess?.seq ?? 0;
    const conflicting = twin.send({ type: 'GUESS', guess: '9876' });
    const verdict = final(await judge(game, {}, [...game.messages, conflicting]));
    expect(verdict.faults).toEqual([{ seat: 0, kind: 'message-equivocation' }]);
    expect(verdict.result).toBe('seat1');
  });
});

describe('attack: no reveal', () => {
  it('waits while the window is open', async () => {
    const game = await playGame({ secrets: QUIET, rng: mulberry32(1), guessFor: neverHit });
    const verdict = await judge(game, { reveals: [game.reveals[0], undefined] });
    expect(verdict).toEqual({ kind: 'pending', waitingFor: [1], faults: [] });
    expect(await judge(game, { reveals: [undefined, undefined] })).toEqual({
      kind: 'pending',
      waitingFor: [0, 1],
      faults: [],
    });
  });

  it('forfeits the player who never reveals once the window closes', async () => {
    const game = await playGame({ secrets: QUIET, rng: mulberry32(1), guessFor: neverHit });
    const verdict = final(
      await judge(game, { reveals: [game.reveals[0], undefined], revealWindowClosed: true }),
    );
    expect(verdict.result).toBe('seat0');
    expect(verdict.reason).toBe('fault');
    expect(verdict.faults).toEqual([{ seat: 1, kind: 'no-reveal' }]);
    expect(verdict.verifiedSecrets).toEqual([QUIET[0], undefined]);
  });

  it('the forfeit goes to the other player whichever seat stays silent', async () => {
    const game = await playGame({ secrets: QUIET, rng: mulberry32(1), guessFor: neverHit });
    const verdict = final(
      await judge(game, { reveals: [undefined, game.reveals[1]], revealWindowClosed: true }),
    );
    expect(verdict.result).toBe('seat1');
  });

  it('a revealer who also cheated does not win by forfeit: it is a draw', async () => {
    const game = await playGame({
      secrets: QUIET,
      rng: mulberry32(1),
      guessFor: neverHit,
      claim: (i, truth) => (i === 2 ? differentFrom(truth) : truth),
    });
    // Index 2 is answered by seat 1, the one who does reveal. Seat 0 stays silent.
    expect(answererOf(2)).toBe(1);
    const verdict = final(
      await judge(game, { reveals: [undefined, game.reveals[1]], revealWindowClosed: true }),
    );
    expect(verdict.result).toBe('draw');
    expect(verdict.reason).toBe('both-at-fault');
    expect(kinds(verdict.faults).sort()).toEqual(['no-reveal', 'wrong-answer']);
  });

  it('reports faults found so far even while waiting', async () => {
    const game = await playGame({
      secrets: QUIET,
      rng: mulberry32(1),
      guessFor: neverHit,
      claim: (i, truth) => (i === 2 ? differentFrom(truth) : truth),
    });
    const verdict = await judge(game, { reveals: [game.reveals[0], undefined] });
    expect(verdict.kind).toBe('pending');
    expect(kinds(verdict.faults)).toEqual([]); // seat 1 lied, but has not revealed yet
    const reveal1 = await judge(game, { reveals: [undefined, game.reveals[1]] });
    expect(reveal1.kind).toBe('pending');
  });

  it('nobody revealing after the window is abandoned, not a verdict', async () => {
    const game = await playGame({ secrets: QUIET, rng: mulberry32(1), guessFor: neverHit });
    const verdict = await judge(game, {
      reveals: [undefined, undefined],
      revealWindowClosed: true,
    });
    expect(verdict).toEqual({ kind: 'abandoned', faults: [] });
  });
});

describe('a single planted lie is always found (model-based)', () => {
  it('for random games, seats and replacement answers', async () => {
    const rng = mulberry32(99);
    let planted = 0;
    for (let i = 0; i < 40; i++) {
      const secrets: [Code, Code] = [randomCode(rng), randomCode(rng)];
      const probe = await playGame({ secrets, rng: mulberry32(i) });
      const index = Math.floor(rng() * probe.guesses.length);
      const replacement = pick(rng, VALID_FEEDBACK);

      const game = await playGame({
        secrets,
        rng: mulberry32(i),
        claim: (n, truth) => (n === index ? replacement : truth),
      });
      const liar = answererOf(index);
      const truth = game.truth[index] as Feedback;
      const verdict = final(await judge(game));

      if (replacement === truth) {
        expect(verdict.faults).toEqual([]);
        continue;
      }
      planted++;
      const found = verdict.faults.filter((f) => f.kind === 'wrong-answer' && f.seat === liar);
      expect(found.length).toBeGreaterThanOrEqual(1);
      // The honest seat is never charged.
      expect(verdict.faults.some((f) => f.seat === 1 - liar)).toBe(false);
      expect(verdict.result).toBe(liar === 0 ? 'seat1' : 'seat0');
    }
    expect(planted).toBeGreaterThan(25);
  }, 180_000);
});

describe('working from chain records', () => {
  function txOf(signer: string, text: string, n: number, slot: number): MemoTx {
    return { sig: fakeSig(n), signer, text, slot, blockTime: 1_700_000_000 + slot, ok: true };
  }

  it('maps canonical records and tolerates missing ones', () => {
    expect(toChainCommit(undefined)).toBeUndefined();
    expect(toChainReveal(undefined)).toBeUndefined();
  });

  it('judges a game end to end from Memo records, including the transcript hash', async () => {
    const game = await playGame({ secrets: QUIET, rng: mulberry32(1), guessFor: neverHit });
    const assembled = assembleTranscript(game.room, game.messages);
    if (!assembled.ok) throw new Error(assembled.reason);
    const hash = await transcriptHash(assembled.transcript);

    const chain: MemoTx[] = [];
    let n = 10;
    for (const seat of [0, 1] as const) {
      const key = game.identities[seat].publicKey;
      chain.push(
        txOf(key, encodeCommitMemo(game.room, game.commits[seat].commitment), n++, 100 + seat),
      );
      chain.push(
        txOf(
          key,
          encodeRevealMemo(game.room, game.secrets[seat], game.salts[seat], hash),
          n++,
          200 + seat,
        ),
      );
    }
    const [k0, k1] = [game.identities[0].publicKey, game.identities[1].publicKey];
    const verdict = final(
      await finalise({
        transcript: assembled.transcript,
        commits: [
          toChainCommit(selectCommit(chain, game.room, k0)),
          toChainCommit(selectCommit(chain, game.room, k1)),
        ],
        reveals: [
          toChainReveal(selectReveal(chain, game.room, k0)),
          toChainReveal(selectReveal(chain, game.room, k1)),
        ],
        revealWindowClosed: false,
      }),
    );
    expect(verdict).toMatchObject({ result: 'draw', reason: 'cap', faults: [] });
    expect(selectReveal(chain, game.room, k0)?.reveal.transcriptHash).toBe(hash);
  });

  it('catches a player who changed their secret by posting a second commit', async () => {
    const game = await playGame({ secrets: QUIET, rng: mulberry32(1), guessFor: neverHit });
    const assembled = assembleTranscript(game.room, game.messages);
    if (!assembled.ok) throw new Error(assembled.reason);
    const [k0, k1] = [game.identities[0].publicKey, game.identities[1].publicKey];

    // Seat 1 commits honestly, sees the game going badly, then posts a second commitment.
    const chain: MemoTx[] = [
      txOf(k0, encodeCommitMemo(game.room, game.commits[0].commitment), 1, 100),
      txOf(k1, encodeCommitMemo(game.room, game.commits[1].commitment), 2, 101),
      txOf(k1, encodeCommitMemo(game.room, 'ee'.repeat(32)), 3, 300),
      txOf(k0, encodeRevealMemo(game.room, game.secrets[0], game.salts[0]), 4, 400),
      txOf(k1, encodeRevealMemo(game.room, game.secrets[1], game.salts[1]), 5, 401),
    ];
    const verdict = final(
      await finalise({
        transcript: assembled.transcript,
        commits: [
          toChainCommit(selectCommit(chain, game.room, k0)),
          toChainCommit(selectCommit(chain, game.room, k1)),
        ],
        reveals: [
          toChainReveal(selectReveal(chain, game.room, k0)),
          toChainReveal(selectReveal(chain, game.room, k1)),
        ],
        revealWindowClosed: false,
      }),
    );
    expect(verdict.faults).toEqual([{ seat: 1, kind: 'commit-equivocation' }]);
    expect(verdict.result).toBe('seat0');
  });

  it('is not fooled by a failed transaction posting a different commit', async () => {
    const game = await playGame({ secrets: QUIET, rng: mulberry32(1), guessFor: neverHit });
    const k1 = game.identities[1].publicKey;
    const chain: MemoTx[] = [
      txOf(k1, encodeCommitMemo(game.room, game.commits[1].commitment), 2, 101),
      { ...txOf(k1, encodeCommitMemo(game.room, 'ee'.repeat(32)), 3, 300), ok: false },
    ];
    expect(selectCommit(chain, game.room, k1)?.equivocated).toBe(false);
  });
});
