import type { Code, Feedback, Seat } from '@accident/engine';
import {
  candidatesFromHistory,
  chooseGuess,
  gameStatus,
  mulberry32,
  score,
} from '@accident/engine';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { Body, Identity, SignedMessage } from '../src/index.js';
import {
  commitment,
  encodeCommitMemo,
  encodeMessage,
  encodeRevealMemo,
  generateSaltHex,
  openMessage,
  signedText,
} from '../src/index.js';
import type { HubTransport } from '../src/testing/index.js';
import type { World } from './harness.js';
import { ROOM, Sender, identityFromByte } from './helpers.js';

export interface PeerOptions {
  name: string;
  secret: Code;
  identityByte: number;
  seat?: Seat;
  room?: string;
  /** Replace the honest answer. Return the feedback to claim. */
  lie?: (index: number, truth: Feedback) => Feedback;
  /** The only player this peer talks to, like a guest that got the host key from the share link. */
  opponentKey?: string;
  /** Never reveal. */
  skipReveal?: boolean;
  /** Reveal this secret instead of the committed one. */
  revealSecret?: string;
  /** Do not answer or guess at all (a peer that goes silent after committing). */
  silent?: boolean;
  seed?: number;
}

/**
 * A minimal client written directly against the protocol functions, for playing the other side
 * in tests. Unlike a Session it can lie, misbehave, or hold back on purpose.
 */
export class ScriptedPeer {
  readonly identity: Identity;
  readonly seat: Seat;
  readonly room: string;
  readonly saltHex = generateSaltHex();
  readonly sender: Sender;
  readonly transport: HubTransport;
  /** Valid messages received from the other player. */
  readonly received: SignedMessage[] = [];
  readonly guesses: Code[] = [];
  readonly answers: Feedback[] = [];
  readonly errors: unknown[] = [];
  commitSig: string | undefined;
  revealSig: string | undefined;
  over = false;
  /** The opponent, pinned from the first HELLO like a real client. */
  opponent: string | undefined;
  private readonly seen = new Set<string>();
  private readonly rng: () => number;

  constructor(
    private readonly world: World,
    readonly o: PeerOptions,
  ) {
    this.identity = identityFromByte(o.identityByte);
    this.seat = o.seat ?? 1;
    this.room = o.room ?? ROOM;
    this.sender = new Sender(this.identity, this.room);
    this.transport = world.hub.transport(o.name);
    this.rng = mulberry32(o.seed ?? 1);
    this.opponent = o.opponentKey;
  }

  get key(): string {
    return this.identity.publicKey;
  }

  async join(): Promise<void> {
    await this.transport.join(this.room, {
      onMessage: (raw) => {
        void this.handle(raw).catch((e: unknown) => this.errors.push(e));
      },
      onStatus: () => undefined,
    });
  }

  /** Sends a message with the next sequence number. */
  async send(body: Body): Promise<SignedMessage> {
    const message = this.sender.send(body);
    await this.transport.send(this.room, encodeMessage(message));
    return message;
  }

  async hello(): Promise<void> {
    await this.send({ type: 'HELLO', role: this.seat === 0 ? 'host' : 'guest' });
  }

  async commitmentHex(): Promise<string> {
    return commitment({
      room: this.room,
      playerKey: this.key,
      secret: this.o.secret,
      saltHex: this.saltHex,
    });
  }

  /** Posts the commit Memo and announces it, like a real client. */
  async commit(): Promise<string> {
    this.commitSig = this.world.chain.post(
      this.key,
      encodeCommitMemo(this.room, await this.commitmentHex()),
    );
    await this.send({ type: 'COMMIT', txSig: this.commitSig });
    return this.commitSig;
  }

  /** Puts a commit Memo on the chain without telling anyone over the relay. */
  async postCommitOnly(): Promise<string> {
    this.commitSig = this.world.chain.post(
      this.key,
      encodeCommitMemo(this.room, await this.commitmentHex()),
    );
    return this.commitSig;
  }

  /** Posts a second, different commitment: the "I changed my mind" attack. */
  postSecondCommit(): string {
    return this.world.chain.post(this.key, encodeCommitMemo(this.room, 'ab'.repeat(32)));
  }

  /** Signs arbitrary text as this player, skipping all validation. For malformed-message tests. */
  forge(seq: number, type: string, payload: string): string {
    const unsigned = { room: this.room, seq, type, payload };
    const sig = nacl.sign.detached(
      new TextEncoder().encode(signedText(unsigned as never)),
      this.identity.secretKey,
    );
    return JSON.stringify({
      room: this.room,
      from: this.key,
      seq,
      type,
      payload,
      sig: bs58.encode(sig),
    });
  }

  private async handle(raw: string): Promise<void> {
    const opened = openMessage(raw);
    if (!opened || opened.message.room !== this.room || opened.message.from === this.key) return;
    if (this.opponent === undefined && opened.body.type === 'HELLO')
      this.opponent = opened.message.from;
    if (opened.message.from !== this.opponent) return;
    const id = `${opened.message.from}:${opened.message.seq}:${opened.message.type}`;
    if (this.seen.has(id) || opened.body.type === 'SYNC') return;
    this.seen.add(id);
    this.received.push(opened.message);
    if (this.o.silent) return;

    const { body } = opened;
    if (body.type === 'GUESS') {
      // The opponent guessed: answer the next unanswered index, honestly unless told to lie.
      const index = this.answers.length;
      const truth = score(this.o.secret, body.guess);
      const claimed = this.o.lie ? this.o.lie(index, truth) : truth;
      this.answers.push(claimed);
      await this.send({ type: 'ANSWER', index, feedback: claimed });
      await this.afterAnswer();
    } else if (body.type === 'ANSWER') {
      // The opponent answered one of our guesses.
      this.answers.push(body.feedback);
      await this.afterAnswer();
    }
  }

  private async afterAnswer(): Promise<void> {
    const status = gameStatus(this.answers);
    if (status.over) {
      this.over = true;
      await this.reveal();
    } else if (
      status.next === this.seat &&
      this.answers.length === this.guesses.length * 2 + this.seat
    ) {
      await this.guess();
    }
  }

  /** Makes this player's next guess: `code` if given, otherwise a sensible one. */
  async guess(code?: Code): Promise<void> {
    // Our k-th guess is global guess 2k + seat, so its answer sits at that index.
    const history = this.guesses.map((guess, k) => ({
      guess,
      feedback: this.answers[2 * k + this.seat] as Feedback,
    }));
    const next = code ?? chooseGuess('medium', candidatesFromHistory(history), this.rng) ?? '0123';
    this.guesses.push(next);
    await this.send({ type: 'GUESS', guess: next });
  }

  async reveal(): Promise<void> {
    if (this.o.skipReveal) return;
    const secret = this.o.revealSecret ?? this.o.secret;
    this.revealSig = this.world.chain.post(
      this.key,
      encodeRevealMemo(this.room, secret, this.saltHex),
    );
    await this.send({ type: 'REVEAL', secret, saltHex: this.saltHex, txSig: this.revealSig });
  }
}
