import type { Code, Feedback, Level, Rng, Seat, Turn } from '@accident/engine';
import {
  candidatesFromHistory,
  chooseGuess,
  gameStatus,
  randomCode,
  score,
} from '@accident/engine';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import type { Body, ChainCommit, ChainReveal, Identity, SignedMessage } from '../src/index.js';
import { commitment, identityFromSecretKey, signMessage } from '../src/index.js';

export const ROOM = 'ABC234';

/** A deterministic identity: the same byte always gives the same key. */
export function identityFromByte(byte: number): Identity {
  const seed = new Uint8Array(32).fill(byte);
  return identityFromSecretKey(nacl.sign.keyPair.fromSeed(seed).secretKey);
}

/** A well-formed fake 64-byte signature or transaction signature. */
export function fakeSig(n: number): string {
  return bs58.encode(new Uint8Array(64).fill(n));
}

/** 64 hex characters: 32 bytes all equal to `n`. */
export function saltOf(n: number): string {
  return n.toString(16).padStart(2, '0').repeat(32);
}

/** Independent commitment calculation with Node's own crypto, to cross-check the real one. */
export function nodeCommitment(
  room: string,
  playerKey: string,
  secret: string,
  saltHex: string,
): string {
  return createHash('sha256')
    .update('ACCIDENT_V1')
    .update(Buffer.from(room, 'ascii'))
    .update(Buffer.from(bs58.decode(playerKey)))
    .update(Buffer.from(Array.from(secret, (d) => Number(d))))
    .update(Buffer.from(saltHex, 'hex'))
    .digest('hex');
}

// Ed25519 signatures are deterministic, so identical messages can share one signing operation.
// This only speeds up the tests; signing itself is exercised directly in messages.test.ts.
const signatureCache = new Map<string, SignedMessage>();

function signCached(identity: Identity, room: string, seq: number, body: Body): SignedMessage {
  const key = `${identity.publicKey}|${room}|${seq}|${JSON.stringify(body)}`;
  let message = signatureCache.get(key);
  if (!message) {
    message = signMessage(identity, { room, seq, body });
    signatureCache.set(key, message);
  }
  return message;
}

/** Hands out messages with a per-sender sequence counter, like a real client. */
export class Sender {
  seq = 0;
  constructor(
    readonly identity: Identity,
    readonly room: string = ROOM,
  ) {}
  send(body: Body): SignedMessage {
    return signCached(this.identity, this.room, this.seq++, body);
  }
}

export interface Game {
  room: string;
  identities: [Identity, Identity];
  secrets: [Code, Code];
  salts: [string, string];
  senders: [Sender, Sender];
  /** Every HELLO, COMMIT, GUESS and ANSWER message, in the order they were sent. */
  messages: SignedMessage[];
  guesses: Code[];
  /** What was claimed for each guess (may contain lies). */
  claimed: Feedback[];
  /** What the honest answer would have been. */
  truth: Feedback[];
  commits: [ChainCommit, ChainCommit];
  reveals: [ChainReveal, ChainReveal];
}

export interface PlayOptions {
  secrets: [Code, Code];
  rng: Rng;
  levels?: [Level, Level];
  /** Picks the guess for a turn. Return undefined to let the computer choose. */
  guessFor?: (index: number, seat: Seat, secrets: [Code, Code]) => Code | undefined;
  /** Replaces the honest answer. The answering seat is the opposite of `index % 2`. */
  claim?: (index: number, truth: Feedback) => Feedback;
}

/** Plays a whole game with real signatures, following the live rules on the claimed answers. */
export async function playGame(options: PlayOptions): Promise<Game> {
  const { secrets, rng } = options;
  const levels = options.levels ?? ['medium', 'medium'];
  const identities: [Identity, Identity] = [identityFromByte(1), identityFromByte(2)];
  const salts: [string, string] = [saltOf(0xa1), saltOf(0xb2)];
  const senders: [Sender, Sender] = [new Sender(identities[0]), new Sender(identities[1])];

  const commitments: [string, string] = [
    await commitment({
      room: ROOM,
      playerKey: identities[0].publicKey,
      secret: secrets[0],
      saltHex: salts[0],
    }),
    await commitment({
      room: ROOM,
      playerKey: identities[1].publicKey,
      secret: secrets[1],
      saltHex: salts[1],
    }),
  ];

  const messages: SignedMessage[] = [
    senders[0].send({ type: 'HELLO', role: 'host' }),
    senders[1].send({ type: 'HELLO', role: 'guest' }),
    senders[0].send({ type: 'COMMIT', txSig: fakeSig(1) }),
    senders[1].send({ type: 'COMMIT', txSig: fakeSig(2) }),
  ];

  const guesses: Code[] = [];
  const claimed: Feedback[] = [];
  const truth: Feedback[] = [];
  const history: [Turn[], Turn[]] = [[], []];

  for (;;) {
    const status = gameStatus(claimed);
    if (status.over) break;
    const seat = status.next;
    const index = status.index;
    const guess =
      options.guessFor?.(index, seat, secrets) ??
      chooseGuess(levels[seat], candidatesFromHistory(history[seat]), rng) ??
      randomCode(rng); // answers became inconsistent, so a real client would just carry on
    const honest = score(secrets[1 - seat] as Code, guess);
    const said = options.claim ? options.claim(index, honest) : honest;

    history[seat].push({ guess, feedback: said });
    guesses.push(guess);
    truth.push(honest);
    claimed.push(said);
    messages.push(senders[seat].send({ type: 'GUESS', guess }));
    messages.push(senders[(1 - seat) as Seat].send({ type: 'ANSWER', index, feedback: said }));
  }

  return {
    room: ROOM,
    identities,
    secrets,
    salts,
    senders,
    messages,
    guesses,
    claimed,
    truth,
    commits: [
      { commitment: commitments[0], equivocated: false },
      { commitment: commitments[1], equivocated: false },
    ],
    reveals: [
      { secret: secrets[0], salt: salts[0], signer: identities[0].publicKey, conflicting: false },
      { secret: secrets[1], salt: salts[1], signer: identities[1].publicKey, conflicting: false },
    ],
  };
}

/** A guesser that never hits, for games meant to run to the cap. */
export const neverHit = (): Code => '0123';
