import { createHash, webcrypto } from 'node:crypto';
import type { Code, Feedback } from '@accident/engine';
import { score } from '@accident/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Body, Chain, Identity, SignedMessage } from '../src/index.js';
import {
  commitment,
  decodeBody,
  encodeCommitMemo,
  encodeRevealMemo,
  generateIdentity,
  signMessage,
  verifyGame,
} from '../src/index.js';
import { MemoryChain } from '../src/testing/index.js';

/**
 * verifyGame hashes with WebCrypto (transcriptHash and verifyCommitment). Swap in a synchronous
 * SHA-256 so those resolve deterministically, exactly as controller.test.tsx does.
 */
beforeEach(() => {
  vi.stubGlobal('crypto', {
    subtle: {
      digest: async (_a: string, data: Uint8Array): Promise<ArrayBuffer> => {
        const h = createHash('sha256').update(data).digest();
        return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength) as ArrayBuffer;
      },
    },
    getRandomValues: (a: Uint8Array): Uint8Array => webcrypto.getRandomValues(a),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ROOM = 'ABC234';
const SALT0 = 'a'.repeat(64);
const SALT1 = 'b'.repeat(64);

interface Player {
  identity: Identity;
  secret: Code;
  salt: string;
}

/** A tiny honest two-player game: HELLO, COMMIT, one guess each with its answer. */
interface Game {
  host: Player;
  guest: Player;
  messages: SignedMessage[];
  seq: [number, number];
}

function sign(player: Player, seq: number, body: Body): SignedMessage {
  return signMessage(player.identity, { room: ROOM, seq, body });
}

async function makeGame(options?: {
  /** Replace seat 1's answer to seat 0's guess with this (claimed) feedback, to script a lie. */
  lyingAnswer?: Feedback;
}): Promise<Game> {
  const host: Player = { identity: generateIdentity(), secret: '1234', salt: SALT0 };
  const guest: Player = { identity: generateIdentity(), secret: '5678', salt: SALT1 };

  const commit0 = await commitment({
    room: ROOM,
    playerKey: host.identity.publicKey,
    secret: host.secret,
    saltHex: host.salt,
  });
  const commit1 = await commitment({
    room: ROOM,
    playerKey: guest.identity.publicKey,
    secret: guest.secret,
    saltHex: guest.salt,
  });

  // Seat 0 guesses first (index 0, answered by seat 1); seat 1 guesses next (index 1, by seat 0).
  const guess0: Code = '5678';
  const guess1: Code = '1234';
  const answer0 = options?.lyingAnswer ?? score(guest.secret, guess0);
  const answer1 = score(host.secret, guess1);

  // Commit tx signatures the COMMIT messages name. 64-byte base58, like a real tx signature.
  const chain = new MemoryChain();
  const commitSig0 = chain.post(host.identity.publicKey, encodeCommitMemo(ROOM, commit0));
  const commitSig1 = chain.post(guest.identity.publicKey, encodeCommitMemo(ROOM, commit1));

  const seqHost = { n: 0 };
  const seqGuest = { n: 0 };
  const messages: SignedMessage[] = [
    sign(host, seqHost.n++, { type: 'HELLO', role: 'host' }),
    sign(guest, seqGuest.n++, { type: 'HELLO', role: 'guest' }),
    sign(host, seqHost.n++, { type: 'COMMIT', txSig: commitSig0 }),
    sign(guest, seqGuest.n++, { type: 'COMMIT', txSig: commitSig1 }),
    sign(host, seqHost.n++, { type: 'GUESS', guess: guess0 }),
    sign(guest, seqGuest.n++, { type: 'ANSWER', index: 0, feedback: answer0 }),
    sign(guest, seqGuest.n++, { type: 'GUESS', guess: guess1 }),
    sign(host, seqHost.n++, { type: 'ANSWER', index: 1, feedback: answer1 }),
  ];

  // Carry the signatures the test may need; the chain built here is thrown away by callers that
  // seed their own, so expose only the players and messages.
  return { host, guest, messages, seq: [seqHost.n, seqGuest.n] };
}

/** The transcript file as the Result-screen export writes it. */
function file(game: Game): { room: string; messages: SignedMessage[] } {
  return { room: ROOM, messages: game.messages };
}

/** The canonical transcript hash of a game, computed the same way verifyGame does. */
async function hashOf(game: Game): Promise<string> {
  const { assembleTranscript, transcriptHash } = await import('../src/index.js');
  const assembled = assembleTranscript(ROOM, game.messages);
  if (!assembled.ok) throw new Error(assembled.reason);
  return transcriptHash(assembled.transcript);
}

/** Seeds commit and reveal Memos for both seats on a fresh chain and returns the reveal sigs. */
async function seedChain(
  game: Game,
  options?: {
    hash?: readonly [string | undefined, string | undefined];
    withHash?: boolean;
    reveal0?: { secret: string; salt: string; signer?: Identity };
    reveal1?: { secret: string; salt: string; signer?: Identity };
    omitReveal0?: boolean;
    revealRoom0?: string;
  },
): Promise<{ chain: MemoryChain; revealSigs: [string, string] }> {
  const chain = new MemoryChain();
  const h = options?.hash;

  const c0 = await commitment({
    room: ROOM,
    playerKey: game.host.identity.publicKey,
    secret: game.host.secret,
    saltHex: game.host.salt,
  });
  const c1 = await commitment({
    room: ROOM,
    playerKey: game.guest.identity.publicKey,
    secret: game.guest.secret,
    saltHex: game.guest.salt,
  });
  chain.post(game.host.identity.publicKey, encodeCommitMemo(ROOM, c0));
  chain.post(game.guest.identity.publicKey, encodeCommitMemo(ROOM, c1));

  const r0 = options?.reveal0 ?? { secret: game.host.secret, salt: game.host.salt };
  const r1 = options?.reveal1 ?? { secret: game.guest.secret, salt: game.guest.salt };
  const signer0 = options?.reveal0?.signer ?? game.host.identity;
  const signer1 = options?.reveal1?.signer ?? game.guest.identity;
  const room0 = options?.revealRoom0 ?? ROOM;

  const hash0 = h ? h[0] : options?.withHash ? await hashOf(game) : undefined;
  const hash1 = h ? h[1] : options?.withHash ? await hashOf(game) : undefined;

  let revealSig0 = '';
  if (!options?.omitReveal0) {
    revealSig0 = chain.post(signer0.publicKey, encodeRevealMemo(room0, r0.secret, r0.salt, hash0));
  }
  const revealSig1 = chain.post(
    signer1.publicKey,
    encodeRevealMemo(ROOM, r1.secret, r1.salt, hash1),
  );

  return { chain, revealSigs: [revealSig0, revealSig1] };
}

describe('verifyGame', () => {
  it('(a) verifies an honest completed game: final, no faults, both secrets, hashes match', async () => {
    const game = await makeGame();
    const { chain, revealSigs } = await seedChain(game, { withHash: true });

    const result = await verifyGame({ transcript: file(game), revealSigs }, { chain });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verdict.kind).toBe('final');
    if (result.verdict.kind !== 'final') return;
    expect(result.verdict.faults).toEqual([]);
    expect(result.verdict.verifiedSecrets).toEqual([game.host.secret, game.guest.secret]);
    expect(result.hashCheck[0]).toEqual({ present: true, matches: true });
    expect(result.hashCheck[1]).toEqual({ present: true, matches: true });
    expect(result.commitSigs[0]).toBeDefined();
    expect(result.commitSigs[1]).toBeDefined();
    expect(result.revealSigs).toEqual(revealSigs);
  });

  it('(b) catches a lying ANSWER with wrong-answer evidence; the honest player wins', async () => {
    // Seat 1 claims the wrong feedback for seat 0's guess of seat 1's secret.
    const truth = score('5678', '5678'); // 40
    const lie = (truth === 0 ? 1 : 0) as Feedback;
    const game = await makeGame({ lyingAnswer: lie });
    const { chain, revealSigs } = await seedChain(game);

    const result = await verifyGame({ transcript: file(game), revealSigs }, { chain });

    expect(result.ok).toBe(true);
    if (!result.ok || result.verdict.kind !== 'final') throw new Error('expected final verdict');
    const wrong = result.verdict.faults.find((f) => f.kind === 'wrong-answer');
    expect(wrong).toBeDefined();
    if (!wrong || wrong.kind !== 'wrong-answer') throw new Error('expected wrong-answer');
    expect(wrong.seat).toBe(1);
    expect(wrong.index).toBe(0);
    expect(wrong.claimed).toBe(lie);
    expect(wrong.actual).toBe(truth);
    expect(result.verdict.reason).toBe('fault');
    // Seat 1 is at fault, so seat 0 wins.
    expect(result.verdict.result).toBe('seat0');
  });

  it('(c) a reveal whose secret does not match the commitment is a commitment-mismatch', async () => {
    const game = await makeGame();
    // Reveal a different (still valid) code for seat 0 than it committed.
    const { chain, revealSigs } = await seedChain(game, {
      reveal0: { secret: '9876', salt: game.host.salt },
    });

    const result = await verifyGame({ transcript: file(game), revealSigs }, { chain });

    expect(result.ok).toBe(true);
    if (!result.ok || result.verdict.kind !== 'final') throw new Error('expected final verdict');
    expect(result.verdict.faults).toContainEqual({ seat: 0, kind: 'commitment-mismatch' });
    expect(result.verdict.result).toBe('seat1');
  });

  it('(d) a reveal with an invalid code is an invalid-secret fault', async () => {
    const game = await makeGame();
    // Re-commit seat 0 to the invalid secret so the mismatch does not fire first.
    const chain = new MemoryChain();
    const badSecret = '1123'; // repeated digit, not a valid code
    const badCommit = createHash('sha256').update('ignored').digest('hex'); // commitment is checked only for valid codes
    // Seed commits: seat 0 commits to the invalid secret's commitment, seat 1 honest.
    const c1 = await commitment({
      room: ROOM,
      playerKey: game.guest.identity.publicKey,
      secret: game.guest.secret,
      saltHex: game.guest.salt,
    });
    chain.post(game.host.identity.publicKey, encodeCommitMemo(ROOM, badCommit));
    chain.post(game.guest.identity.publicKey, encodeCommitMemo(ROOM, c1));
    const revealSig0 = chain.post(
      game.host.identity.publicKey,
      encodeRevealMemo(ROOM, badSecret, game.host.salt),
    );
    const revealSig1 = chain.post(
      game.guest.identity.publicKey,
      encodeRevealMemo(ROOM, game.guest.secret, game.guest.salt),
    );

    const result = await verifyGame(
      { transcript: file(game), revealSigs: [revealSig0, revealSig1] },
      { chain },
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.verdict.kind !== 'final') throw new Error('expected final verdict');
    expect(result.verdict.faults).toContainEqual({ seat: 0, kind: 'invalid-secret' });
  });

  it('(e) a reveal signed by the wrong key is a reveal-signer-mismatch', async () => {
    const game = await makeGame();
    const stranger = generateIdentity();
    // Seat 0's reveal is posted by a stranger key, with seat 0's genuine secret and salt.
    const { chain, revealSigs } = await seedChain(game, {
      reveal0: { secret: game.host.secret, salt: game.host.salt, signer: stranger },
    });

    const result = await verifyGame({ transcript: file(game), revealSigs }, { chain });

    expect(result.ok).toBe(true);
    if (!result.ok || result.verdict.kind !== 'final') throw new Error('expected final verdict');
    expect(result.verdict.faults).toContainEqual({ seat: 0, kind: 'reveal-signer-mismatch' });
  });

  it('(f) a missing reveal (getMemoTx returns null) is a no-reveal fault and that seat loses', async () => {
    const game = await makeGame();
    // Seed only seat 1's reveal; seat 0's sig points at a transaction that was never posted.
    const { chain, revealSigs } = await seedChain(game, { omitReveal0: true });
    const neverPosted = '1'.repeat(44); // a valid-shape signature the chain does not know

    const result = await verifyGame(
      { transcript: file(game), revealSigs: [neverPosted, revealSigs[1]] },
      { chain },
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.verdict.kind !== 'final') throw new Error('expected final verdict');
    expect(result.verdict.faults).toContainEqual({ seat: 0, kind: 'no-reveal' });
    expect(result.verdict.result).toBe('seat1');
    expect(result.revealSigs[0]).toBeUndefined();
  });

  it('(g) a transcript-hash mismatch is flagged but does not change the verdict', async () => {
    const game = await makeGame();
    const wrongHash = 'f'.repeat(64);
    const { chain, revealSigs } = await seedChain(game, { hash: [wrongHash, wrongHash] });

    const result = await verifyGame({ transcript: file(game), revealSigs }, { chain });

    expect(result.ok).toBe(true);
    if (!result.ok || result.verdict.kind !== 'final') throw new Error('expected final verdict');
    expect(result.hashCheck[0]).toEqual({ present: true, matches: false });
    expect(result.hashCheck[1]).toEqual({ present: true, matches: false });
    // The verdict is unaffected: still an honest final with no faults.
    expect(result.verdict.faults).toEqual([]);
    expect(result.verdict.verifiedSecrets).toEqual([game.host.secret, game.guest.secret]);
  });

  it('(g2) a v1.1 reveal with no hash reports present:false', async () => {
    const game = await makeGame();
    const { chain, revealSigs } = await seedChain(game); // no hashes seeded

    const result = await verifyGame({ transcript: file(game), revealSigs }, { chain });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hashCheck[0]).toEqual({ present: false, matches: false });
    expect(result.hashCheck[1]).toEqual({ present: false, matches: false });
  });

  it('(h) a malformed transcript file returns a structured error, not a throw', async () => {
    const game = await makeGame();
    const { chain, revealSigs } = await seedChain(game);

    const notObject = await verifyGame({ transcript: 42, revealSigs }, { chain });
    expect(notObject).toEqual({ ok: false, error: expect.any(String) });

    const anArray = await verifyGame({ transcript: [1, 2], revealSigs }, { chain });
    expect(anArray.ok).toBe(false);

    const badRoom = await verifyGame(
      { transcript: { room: 'nope', messages: [] }, revealSigs },
      { chain },
    );
    expect(badRoom.ok).toBe(false);

    const noMessages = await verifyGame(
      { transcript: { room: ROOM, messages: 'oops' }, revealSigs },
      { chain },
    );
    expect(noMessages.ok).toBe(false);
  });

  it('(i) a reveal Memo for the wrong room is treated as missing', async () => {
    const game = await makeGame();
    const { chain, revealSigs } = await seedChain(game, { revealRoom0: 'ZZZ234' });

    const result = await verifyGame({ transcript: file(game), revealSigs }, { chain });

    expect(result.ok).toBe(true);
    if (!result.ok || result.verdict.kind !== 'final') throw new Error('expected final verdict');
    expect(result.revealSigs[0]).toBeUndefined();
    expect(result.verdict.faults).toContainEqual({ seat: 0, kind: 'no-reveal' });
  });

  it('(j) a seat that posted two differing reveals is a reveal-conflict, even if given the good one', async () => {
    // Seat 0 posts an honest reveal first, then a differing (losing) reveal second. The user hands
    // the verifier the second (good-looking) signature, but the earliest-reveal rule makes the
    // first canonical and flags the conflict, mirroring the live Result screen (D1 / design 5.4).
    const game = await makeGame();
    const { chain, revealSigs } = await seedChain(game);

    // A second reveal from seat 0 with a different secret: this is the equivocation.
    const secondSig = chain.post(
      game.host.identity.publicKey,
      encodeRevealMemo(ROOM, '9876', game.host.salt),
    );

    const result = await verifyGame(
      { transcript: file(game), revealSigs: [secondSig, revealSigs[1]] },
      { chain },
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.verdict.kind !== 'final') throw new Error('expected final verdict');
    expect(result.verdict.faults).toContainEqual({ seat: 0, kind: 'reveal-conflict' });
    // The earliest (honest) reveal is canonical, so the verdict uses seat 0's real secret and the
    // conflict is seat 0's own fault: seat 1 wins.
    expect(result.verdict.result).toBe('seat1');
    expect(result.revealSigs[0]).toBe(revealSigs[0]);
  });

  it('(k) resolves the commit from the transcript COMMIT sig when the address scan is empty', async () => {
    // Exercises resolveCommit's fallback: a chain whose listMemoTxs never returns seat 0's commit
    // (as if the audit scan found nothing) while getMemoTx still resolves the COMMIT tx the
    // transcript names. The named COMMIT must then feed the honest verdict.
    const game = await makeGame();
    const { chain, revealSigs } = await seedChain(game);
    const hiddenCommit = commitSigForSeat(game, 0);

    const scanBlind = emptyScanFor(chain, game.host.identity.publicKey);

    const result = await verifyGame({ transcript: file(game), revealSigs }, { chain: scanBlind });

    expect(result.ok).toBe(true);
    if (!result.ok || result.verdict.kind !== 'final') throw new Error('expected final verdict');
    // Seat 0's commit was found only via the named COMMIT tx, so the game still verifies clean.
    expect(result.verdict.faults).toEqual([]);
    expect(result.commitSigs[0]).toBe(hiddenCommit);
  });
});

/** The COMMIT tx signature seat `seat` named in its COMMIT message in the game's transcript. */
function commitSigForSeat(game: Game, seat: 0 | 1): string {
  const player = seat === 0 ? game.host : game.guest;
  for (const message of game.messages) {
    if (message.from !== player.identity.publicKey) continue;
    const body = decodeBody(message.type, message.payload);
    if (body?.type === 'COMMIT') return body.txSig;
  }
  throw new Error('no COMMIT message for seat');
}

/**
 * Wraps a chain so that listMemoTxs returns nothing for `blindAddress` (simulating an audit scan
 * that found no commit for that seat) while getMemoTx still resolves every seeded transaction.
 * This forces resolveCommit down its transcript-named-COMMIT fallback for that seat.
 */
function emptyScanFor(chain: MemoryChain, blindAddress: string): Chain {
  return {
    sendMemo: (signer, text) => chain.sendMemo(signer, text),
    getMemoTx: (sig) => chain.getMemoTx(sig),
    listMemoTxs: (address, room) =>
      address === blindAddress ? Promise.resolve([]) : chain.listMemoTxs(address, room),
  };
}
