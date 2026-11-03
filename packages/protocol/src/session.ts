import type { Code, Feedback, GameStatus, Seat } from '@accident/engine';
import { answererOf, gameStatus, guesserOf, isValidCode, score } from '@accident/engine';
import { commitment as computeCommitment } from './commitment.js';
import type { ChainCommit, ChainReveal, Verdict } from './finalise.js';
import { finalise, toChainCommit, toChainReveal } from './finalise.js';
import { isValidRoom } from './ids.js';
import type { MemoTx } from './memo.js';
import {
  encodeCommitMemo,
  encodeRevealMemo,
  parseMemo,
  selectCommit,
  selectReveal,
} from './memo.js';
import type { Body, Identity, Role, SignedMessage } from './messages.js';
import { encodeMessage, openMessage, parseMessage, signMessage } from './messages.js';
import type { Chain, Clock, RelayStatus, Storage, Transport } from './ports.js';
import type { Transcript } from './transcript.js';
import { assembleTranscript, transcriptHash } from './transcript.js';

export type Phase =
  'connecting' | 'committing' | 'gate' | 'playing' | 'revealing' | 'final' | 'abandoned' | 'closed';

export interface SessionOptions {
  /** How soon unacknowledged messages are first sent again. It doubles while nothing is heard. */
  resendMs: number;
  /** The longest gap between repeats while the game is live. */
  resendMaxMs: number;
  /** How many repeats to attempt after the game is settled, in case the opponent is still around. */
  settledResendLimit: number;
  /** How long the player on the clock has before the other side may claim a timeout. */
  turnMs: number;
  /** How long to wait for the opponent's reveal before they forfeit. */
  revealWindowMs: number;
  /** How long to wait for both commits to be confirmed on-chain once the opponent has joined. */
  gateTimeoutMs: number;
  /** Attempts for one Memo transaction before asking the player to retry. */
  memoAttempts: number;
  memoBackoffMs: number;
  /** Chain lookup polling: starts at `pollMinMs`, doubles up to `pollMaxMs`. */
  pollMinMs: number;
  pollMaxMs: number;
  /** When a signature is missing or not found, scan the opponent's address after this long. */
  scanAfterMs: number;
  /** How often a pending verdict is recomputed. */
  verdictIntervalMs: number;
  /** Most out-of-order or held messages remembered. */
  maxPending: number;
}

export const DEFAULT_OPTIONS: SessionOptions = {
  resendMs: 3000,
  resendMaxMs: 30_000,
  settledResendLimit: 3,
  turnMs: 180_000,
  revealWindowMs: 180_000,
  gateTimeoutMs: 90_000,
  memoAttempts: 3,
  memoBackoffMs: 500,
  pollMinMs: 250,
  pollMaxMs: 2000,
  scanAfterMs: 5000,
  verdictIntervalMs: 1000,
  maxPending: 8,
};

export interface SessionError {
  code: 'commit-failed' | 'reveal-failed' | 'internal';
  message: string;
  /** True when `retry()` can help. */
  retryable: boolean;
}

/** Everything the UI needs. Recomputed after every change. */
export interface SessionView {
  phase: Phase;
  room: string;
  role: Role;
  seat: Seat;
  peerKey: string | undefined;
  relay: RelayStatus;
  myCommit: 'none' | 'sent' | 'verified';
  peerCommit: 'none' | 'announced' | 'verified';
  /** True once both commit Memos are verified on-chain. No guess or answer moves before this. */
  gateOpen: boolean;
  /**
   * When the play gate opened (REQ-9), in {@link Clock.now} units. Undefined until it does.
   * Together with {@link gameOverAt} this is the trustworthy source for a game's finish time
   * (REQ-25): both are set exactly once, from this player's own clock, at the moment each
   * condition is first met — not reconstructed later and not reset by a refresh, since both are
   * persisted as part of {@link State} and restored by {@link Session.resume}.
   */
  gateOpenedAt: number | undefined;
  /** When the engine's end condition was first met (a hit or the guess cap), independent of the
   * reveal/verdict steps that follow. Undefined until the game is actually over. See
   * {@link gateOpenedAt}. */
  gameOverAt: number | undefined;
  /** Our reveal Memo: not yet, posted, and the opponent's: not yet, announced, confirmed on-chain. */
  myReveal: 'none' | 'sent';
  peerReveal: 'none' | 'announced' | 'verified';
  /** Transaction signatures of the Memo records, for linking to an explorer. */
  records: {
    mine: { commit: string | undefined; reveal: string | undefined };
    peer: { commit: string | undefined; reveal: string | undefined };
  };
  /** Guess codes by index (guess i is made by seat i % 2). */
  guesses: readonly Code[];
  /** Claimed feedback by index. */
  answers: readonly Feedback[];
  status: GameStatus;
  canGuess: boolean;
  /** Whose move it is, and when the countdown ends. Only while playing. */
  onClock: { seat: Seat; deadline: number } | undefined;
  /** True when the opponent is on the clock and the countdown has run out. */
  timeoutClaimable: boolean;
  verdict: Verdict | undefined;
  outcome: 'timeout-win' | undefined;
  abandonReason: string | undefined;
  error: SessionError | undefined;
  /** Validly signed messages that broke the rules and were ignored. */
  violations: number;
}

/**
 * Chooses the feedback a seat sends for one guess. Called in {@link Session} with the honest score
 * already computed; its return value is used as the ANSWER feedback. Only {@link Session.create}
 * callers who want to deviate from honest play (such as the cheating House Bot used to demonstrate
 * lie detection) supply one; when omitted the honest score is sent unchanged. The returned value
 * must still be a valid {@link Feedback}: the ANSWER encoder rejects anything else.
 */
export type AnswerPolicy = (ctx: {
  index: number;
  guess: Code;
  secret: Code;
  honest: Feedback;
}) => Feedback;

export interface SessionConfig {
  room: string;
  role: Role;
  identity: Identity;
  /** The player's secret. Saved to storage before anything is sent. */
  secret: Code;
  saltHex: string;
  /** Guests may pin the host's key (from the share link). Otherwise the first host HELLO is used. */
  hostKey?: string;
  transport: Transport;
  chain: Chain;
  storage: Storage;
  clock: Clock;
  options?: Partial<SessionOptions>;
  /**
   * Optional override for the feedback this seat sends. Additive and off by default: with no
   * policy the Session answers honestly, exactly as before. See {@link AnswerPolicy}.
   */
  answerPolicy?: AnswerPolicy;
}

export type ResumeConfig = Pick<
  SessionConfig,
  'room' | 'identity' | 'transport' | 'chain' | 'storage' | 'clock' | 'options'
>;

/** The part of the session that survives a refresh. */
interface State {
  v: 1;
  room: string;
  role: Role;
  publicKey: string;
  hostKey?: string;
  secret: Code;
  saltHex: string;
  peerKey?: string;
  /** Wire-encoded, accepted messages from both players, in order. Excludes SYNC. */
  log: string[];
  nextSeq: number;
  peerNextSeq: number;
  /** Highest of our sequence numbers the opponent has acknowledged. */
  acked: number;
  myCommit?: { sig: string; commitment?: string; verified: boolean };
  peerCommit?: { sig?: string; commitment?: string; verified: boolean };
  myReveal?: { txSig: string };
  peerReveal?: { txSig: string; verified: boolean };
  createdAt: number;
  peerSeenAt?: number;
  gateOpenedAt?: number;
  gameOverAt?: number;
  outcome?: 'timeout-win' | 'abandoned';
  abandonReason?: string;
}

interface Derived {
  transcript: Transcript | undefined;
  guesses: readonly Code[];
  answers: readonly Feedback[];
  status: GameStatus;
}

type Decision = 'apply' | 'hold' | 'ignore' | 'violation';

/** Every message type that can enter the game log. SYNC is bookkeeping only. */
type GameBody = Exclude<Body, { type: 'SYNC' }>;

const storageKey = (room: string): string => `accident:session:${room}`;

/**
 * One player's side of one game: the fairness protocol from first HELLO to final verdict.
 *
 * Design rules, each there for a reason:
 * - The game state is derived from the log of signed messages, so a refresh only has to reload
 *   the log. There is no second copy of the state to get out of step.
 * - A message is written to storage before it is transmitted. If the page dies after sending but
 *   before saving, the restarted session would reuse a sequence number, which looks like cheating.
 * - The secret and salt are saved before the commit Memo is sent.
 * - Every mutation runs through one serial queue, so handlers never interleave.
 * - Nothing the opponent or relay sends is trusted: messages are parsed, checked against the
 *   pinned key, and checked against the rules before they enter the log.
 */
export class Session {
  private readonly options: SessionOptions;
  private readonly me: Seat;
  private s: State;
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(view: SessionView) => void>();
  /** Messages that arrived early (future sequence number) or cannot be applied yet. */
  private readonly pending = new Map<number, { message: SignedMessage; body: GameBody }>();
  private readonly knownTx = new Map<string, MemoTx>();
  private readonly timers = new Map<string, () => void>();
  private readonly sleepers = new Set<{ cancel: () => void; resolve: () => void }>();
  private relay: RelayStatus = 'down';
  private verdict: Verdict | undefined;
  private error: SessionError | undefined;
  private violations = 0;
  private closed = false;
  private started = false;
  /** Operations that failed and wait for the player to press retry, so they never spin. */
  private readonly failedOps = new Set<'commit' | 'reveal'>();
  private reconcileQueued = false;
  /** Consecutive repeats with no reply. Drives the backoff and resets on any sign of life. */
  private resendStep = 0;
  private settledResends = 0;
  private turnDeadline: { seat: Seat; at: number; logLength: number } | undefined;
  private readonly inflight = {
    commit: false,
    reveal: false,
    myPoll: false,
    peerPoll: false,
    revealPoll: false,
    verdict: false,
  };

  /** How this seat chooses its answers. Honest when undefined. */
  private readonly answerPolicy: AnswerPolicy | undefined;

  private constructor(
    private readonly config: Pick<
      SessionConfig,
      'identity' | 'transport' | 'chain' | 'storage' | 'clock'
    >,
    state: State,
    options?: Partial<SessionOptions>,
    answerPolicy?: AnswerPolicy,
  ) {
    this.s = state;
    this.me = state.role === 'host' ? 0 : 1;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.answerPolicy = answerPolicy;
  }

  /** Starts a new game. Call {@link start} to begin. */
  static create(config: SessionConfig): Session {
    if (!isValidRoom(config.room)) throw new RangeError('Invalid room code');
    if (!isValidCode(config.secret)) throw new RangeError('Invalid secret');
    if (!/^[0-9a-f]{64}$/.test(config.saltHex)) throw new RangeError('Invalid salt');
    const state: State = {
      v: 1,
      room: config.room,
      role: config.role,
      publicKey: config.identity.publicKey,
      secret: config.secret,
      saltHex: config.saltHex,
      log: [],
      nextSeq: 0,
      peerNextSeq: 0,
      acked: -1,
      createdAt: config.clock.now(),
    };
    if (config.hostKey !== undefined) state.hostKey = config.hostKey;
    return new Session(config, state, config.options, config.answerPolicy);
  }

  /**
   * Restores a game after a refresh from what was saved. Returns `undefined` when nothing usable
   * is stored, in which case the player cannot reveal and the UI must say so.
   */
  static async resume(config: ResumeConfig): Promise<Session | undefined> {
    const raw = await config.storage.get(storageKey(config.room));
    if (raw === null) return undefined;
    const state = parseState(raw, config.room, config.identity.publicKey);
    return state ? new Session(config, state, config.options) : undefined;
  }

  // ---------------------------------------------------------------- public API

  /** Saves the secret, joins the room and says HELLO (or picks up where a saved game left off). */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const fresh = this.s.log.length === 0;
    await this.run(async () => {
      // The vault comes first: a refresh after this point can never lose the secret.
      await this.persist();
    });
    await this.config.transport.join(this.s.room, {
      onMessage: (raw) => this.detached(() => this.receive(raw)),
      onStatus: (status) => this.detached(() => this.onRelayStatus(status)),
    });
    this.armResend();
    if (fresh) await this.run(() => this.sendBody({ type: 'HELLO', role: this.s.role }));
    else await this.run(() => this.resendUnacked());
    this.schedule();
  }

  /**
   * The signed messages of this game, as wire strings in the order they were accepted. Together with
   * the two reveal Memos this is everything needed to check the game independently. It contains no
   * secret before the reveals.
   */
  transcript(): string[] {
    return [...this.s.log];
  }

  subscribe(listener: (view: SessionView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  view(): SessionView {
    const d = this.derive();
    const s = this.s;
    const gateOpen = this.gateOpen();
    const playing = this.phase(d) === 'playing';
    const onClock = playing ? this.clockSeat(d) : undefined;
    const now = this.config.clock.now();
    const deadline = this.turnDeadline?.at;
    return {
      phase: this.phase(d),
      room: s.room,
      role: s.role,
      seat: this.me,
      peerKey: s.peerKey,
      relay: this.relay,
      myCommit: !s.myCommit ? 'none' : s.myCommit.verified ? 'verified' : 'sent',
      peerCommit: !s.peerCommit ? 'none' : s.peerCommit.verified ? 'verified' : 'announced',
      gateOpen,
      gateOpenedAt: s.gateOpenedAt,
      gameOverAt: s.gameOverAt,
      myReveal: s.myReveal ? 'sent' : 'none',
      peerReveal: this.peerRevealStatus(),
      records: {
        mine: { commit: s.myCommit?.sig, reveal: s.myReveal?.txSig },
        peer: { commit: s.peerCommit?.sig, reveal: s.peerReveal?.txSig },
      },
      guesses: d.guesses,
      answers: d.answers,
      status: d.status,
      canGuess:
        playing &&
        !d.status.over &&
        d.status.next === this.me &&
        d.guesses.length === d.answers.length,
      onClock:
        onClock !== undefined && deadline !== undefined ? { seat: onClock, deadline } : undefined,
      timeoutClaimable:
        playing &&
        onClock !== undefined &&
        onClock !== this.me &&
        deadline !== undefined &&
        now >= deadline,
      verdict: this.verdict,
      outcome: s.outcome === 'timeout-win' ? 'timeout-win' : undefined,
      abandonReason: s.abandonReason,
      error: this.error,
      violations: this.violations,
    };
  }

  /** Sends the player's next guess. Rejects if it is not their turn or the gate is closed. */
  submitGuess(guess: string): Promise<void> {
    return this.run(async () => {
      if (!isValidCode(guess)) throw new RangeError('A guess is four different digits');
      const v = this.view();
      if (!v.gateOpen)
        throw new Error('The game has not started: waiting for both commits on-chain');
      if (!v.canGuess) throw new Error('It is not your turn');
      await this.sendBody({ type: 'GUESS', guess });
      this.schedule();
    });
  }

  /** Ends the game as a win when the opponent has run out of time. UI-only, never on-chain. */
  claimTimeout(): Promise<void> {
    return this.run(async () => {
      if (!this.view().timeoutClaimable) throw new Error('The opponent still has time');
      this.s.outcome = 'timeout-win';
      await this.persist();
    });
  }

  /** Tries a failed Memo transaction again. */
  retry(): Promise<void> {
    return this.run(async () => {
      this.error = undefined;
      this.failedOps.clear();
      this.schedule();
    });
  }

  /** Leaves the room and stops all timers. The saved game stays so it can be resumed. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
    for (const sleeper of [...this.sleepers]) {
      sleeper.cancel();
      sleeper.resolve();
    }
    this.sleepers.clear();
    await this.queue;
    await this.config.transport.leave(this.s.room).catch(() => undefined);
    this.emit();
  }

  // ---------------------------------------------------------------- serial execution

  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.then(
      () => this.emit(),
      () => this.emit(),
    );
    return result;
  }

  /** Runs `task` on the queue without waiting. Any failure is shown to the player, never lost. */
  private detached(task: () => Promise<void>): void {
    void this.run(task).catch((e: unknown) => this.fail('internal', e));
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const view = this.view();
    for (const listener of [...this.listeners]) listener(view);
  }

  private fail(code: SessionError['code'], cause: unknown, retryable = false): void {
    const message = cause instanceof Error ? cause.message : String(cause);
    this.error = { code, message, retryable };
    this.emit();
  }

  private schedule(): void {
    if (this.reconcileQueued || this.closed) return;
    this.reconcileQueued = true;
    this.detached(async () => {
      this.reconcileQueued = false;
      await this.reconcile();
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.closed) {
        resolve();
        return;
      }
      const sleeper = {
        cancel: this.config.clock.setTimeout(() => {
          this.sleepers.delete(sleeper);
          resolve();
        }, ms),
        resolve,
      };
      this.sleepers.add(sleeper);
    });
  }

  private arm(name: string, ms: number, fn: () => void): void {
    this.timers.get(name)?.();
    if (this.closed) return;
    this.timers.set(
      name,
      this.config.clock.setTimeout(() => {
        this.timers.delete(name);
        fn();
      }, ms),
    );
  }

  // ---------------------------------------------------------------- persistence and sending

  private async persist(): Promise<void> {
    await this.config.storage.set(storageKey(this.s.room), JSON.stringify(this.s));
  }

  /** Signs, logs, saves and only then transmits. See the class comment for why. */
  private async sendBody(body: Body): Promise<void> {
    const seq = this.s.nextSeq;
    const message = signMessage(this.config.identity, { room: this.s.room, seq, body });
    this.s.log.push(encodeMessage(message));
    this.s.nextSeq = seq + 1;
    await this.persist();
    await this.transmit(message);
  }

  private async transmit(message: SignedMessage): Promise<void> {
    try {
      await this.config.transport.send(this.s.room, encodeMessage(message));
    } catch {
      // Not fatal. The resend timer and the next reconnect send it again.
    }
  }

  private async sendSync(): Promise<void> {
    const message = signMessage(this.config.identity, {
      room: this.s.room,
      seq: this.s.nextSeq,
      body: { type: 'SYNC', received: this.s.peerNextSeq - 1 },
    });
    await this.transmit(message);
  }

  private unacked(): SignedMessage[] {
    const out: SignedMessage[] = [];
    for (const line of this.s.log) {
      const message = parseMessage(line);
      if (message && message.from === this.s.publicKey && message.seq > this.s.acked) {
        out.push(message);
      }
    }
    return out;
  }

  private async resendUnacked(): Promise<void> {
    for (const message of this.unacked()) await this.transmit(message);
  }

  private armResend(): void {
    const wait = Math.min(this.options.resendMs * 2 ** this.resendStep, this.options.resendMaxMs);
    this.arm('resend', wait, () => {
      this.detached(async () => {
        if (this.unacked().length > 0) {
          // Once the game is over, keep trying a few times in case the opponent returns, then stop.
          if (this.settled && this.settledResends++ >= this.options.settledResendLimit) return;
          await this.resendUnacked();
          this.resendStep++;
        }
        this.armResend();
      });
    });
  }

  /** The opponent is alive: go back to repeating quickly if we ever need to. */
  private heardFromPeer(): void {
    this.settledResends = 0;
    if (this.resendStep === 0) return;
    // A timer armed during a long silence may be seconds away. Shorten it now.
    this.resendStep = 0;
    // Messages only arrive after start(), so only a closed session can skip this.
    if (!this.closed) this.armResend();
  }

  private async onRelayStatus(status: RelayStatus): Promise<void> {
    this.relay = status;
    if (status === 'up') {
      this.heardFromPeer();
      if (this.s.peerKey) await this.sendSync();
      await this.resendUnacked();
    }
  }

  // ---------------------------------------------------------------- receiving

  private async receive(raw: string): Promise<void> {
    const opened = openMessage(raw);
    if (!opened) return;
    const { message, body } = opened;
    if (message.room !== this.s.room || message.from === this.s.publicKey) return;

    let newlyPinned = false;
    if (!this.s.peerKey) {
      if (!this.mayPin(message, body)) return;
      newlyPinned = true;
      this.s.peerKey = message.from;
      this.s.peerSeenAt = this.config.clock.now();
    } else if (message.from !== this.s.peerKey) {
      return;
    }

    if (body.type === 'SYNC') {
      if (body.received > this.s.acked) {
        this.heardFromPeer();
        this.s.acked = body.received;
        await this.persist();
      }
      await this.resendUnacked();
      return;
    }

    const expected = this.s.peerNextSeq;
    if (message.seq < expected) {
      await this.sendSync(); // a repeat: tell them we have it so they stop
      return;
    }
    if (message.seq > expected && this.pending.size >= this.options.maxPending) return;
    this.pending.set(message.seq, { message, body });
    const progressed = await this.pump();
    if (progressed) this.heardFromPeer();
    // They only now know we exist, so tell them what we have said rather than wait for the timer.
    if (newlyPinned) await this.resendUnacked();
    if (message.seq > expected) await this.sendSync(); // ask for whatever is missing
    this.schedule();
  }

  private mayPin(message: SignedMessage, body: Body): boolean {
    if (body.type !== 'HELLO' || message.seq !== 0) return false;
    if (body.role !== (this.s.role === 'host' ? 'guest' : 'host')) return false;
    return (
      this.s.role === 'host' || this.s.hostKey === undefined || message.from === this.s.hostKey
    );
  }

  /** Applies buffered messages in sequence order for as long as the next one is ready. */
  private async pump(): Promise<boolean> {
    let progressed = false;
    for (;;) {
      const entry = this.pending.get(this.s.peerNextSeq);
      if (!entry) return progressed;
      const decision = this.decide(entry.body);
      if (decision === 'hold') return progressed;
      this.pending.delete(this.s.peerNextSeq);
      if (decision === 'violation') this.violations++;
      if (decision === 'apply') {
        this.s.log.push(encodeMessage(entry.message));
        this.record(entry.body);
      }
      this.s.peerNextSeq++;
      await this.persist();
      await this.sendSync(); // saved first, so an ack never promises more than we kept
      progressed = true;
    }
  }

  private decide(body: GameBody): Decision {
    const d = this.derive();
    const peerSeat = (1 - this.me) as Seat;
    switch (body.type) {
      case 'HELLO':
        return this.s.log.some((l) => parseMessage(l)?.from === this.s.peerKey)
          ? 'violation'
          : 'apply';
      case 'COMMIT':
        return this.s.peerCommit ? 'ignore' : 'apply';
      case 'GUESS':
        if (!this.gateOpen()) return 'hold';
        return !d.status.over && d.status.next === peerSeat && d.guesses.length === d.answers.length
          ? 'apply'
          : 'violation';
      case 'ANSWER':
        if (!this.gateOpen()) return 'hold';
        return !d.status.over &&
          body.index === d.answers.length &&
          body.index < d.guesses.length &&
          answererOf(body.index) === peerSeat
          ? 'apply'
          : 'violation';
      case 'REVEAL':
        if (!d.status.over) return 'hold';
        return this.s.peerReveal ? 'ignore' : 'apply';
    }
  }

  private record(body: GameBody): void {
    if (body.type === 'COMMIT') this.s.peerCommit = { sig: body.txSig, verified: false };
    if (body.type === 'REVEAL') this.s.peerReveal = { txSig: body.txSig, verified: false };
  }

  // ---------------------------------------------------------------- derived state

  private derive(): Derived {
    const messages = this.s.log.map((line) => parseMessage(line) as SignedMessage);
    const result = assembleTranscript(this.s.room, messages);
    if (!result.ok)
      return { transcript: undefined, guesses: [], answers: [], status: gameStatus([]) };
    const t = result.transcript;
    return {
      transcript: t,
      guesses: t.guessCodes,
      answers: t.answerValues,
      status: gameStatus(t.answerValues),
    };
  }

  /**
   * The opponent's reveal as the player should see it. A final verdict that proved the opponent's
   * secret counts as confirmation, even if the audit scan got there before the signature lookup.
   */
  private peerRevealStatus(): 'none' | 'announced' | 'verified' {
    const peerSeat = (1 - this.me) as Seat;
    const provedByVerdict =
      this.verdict?.kind === 'final' && this.verdict.verifiedSecrets[peerSeat] !== undefined;
    if (provedByVerdict || this.s.peerReveal?.verified) return 'verified';
    return this.s.peerReveal ? 'announced' : 'none';
  }

  /** True once nothing more will happen, so background polling can stop. */
  private get settled(): boolean {
    return (
      this.closed ||
      this.s.outcome !== undefined ||
      this.verdict?.kind === 'final' ||
      this.verdict?.kind === 'abandoned'
    );
  }

  private gateOpen(): boolean {
    return this.s.myCommit?.verified === true && this.s.peerCommit?.verified === true;
  }

  private phase(d: Derived): Phase {
    if (this.closed) return 'closed';
    if (this.s.outcome === 'abandoned') return 'abandoned';
    if (this.s.outcome === 'timeout-win') return 'final';
    if (this.verdict?.kind === 'final') return 'final';
    if (this.verdict?.kind === 'abandoned') return 'abandoned';
    if (!this.s.peerKey) return 'connecting';
    if (!this.s.myCommit) return 'committing';
    if (!this.gateOpen()) return 'gate';
    return d.status.over ? 'revealing' : 'playing';
  }

  /** The seat the game is waiting on: whoever must guess, or whoever must answer. */
  private clockSeat(d: Derived): Seat {
    if (d.guesses.length > d.answers.length) return answererOf(d.answers.length);
    return guesserOf(d.guesses.length);
  }

  // ---------------------------------------------------------------- reconcile

  /** Brings the session in line with the log. Safe to run any number of times. */
  private async reconcile(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (this.closed || !(await this.step())) return;
    }
  }

  /** One pass. Returns true if it changed something, so the caller runs another pass. */
  private async step(): Promise<boolean> {
    const s = this.s;
    if (s.outcome || !s.peerKey) return false;
    const now = this.config.clock.now();
    this.armGateTimer();

    if (!s.myCommit && !this.inflight.commit && !this.failedOps.has('commit')) this.startCommit();
    if (s.myCommit && !s.myCommit.verified) this.startPoll('my');
    if (s.myCommit && !s.peerCommit?.verified) this.startPoll('peer');

    if (!this.gateOpen()) return false;
    if (s.gateOpenedAt === undefined) {
      s.gateOpenedAt = now;
      await this.persist();
      return true;
    }

    let changed = await this.pump();
    const d = this.derive();

    if (
      d.guesses.length > d.answers.length &&
      answererOf(d.answers.length) === this.me &&
      !d.status.over
    ) {
      const index = d.answers.length;
      const guess = d.guesses[index] as Code;
      const honest = score(s.secret, guess);
      // Honest by default. An answerPolicy (used only to demonstrate lie detection) may return a
      // different feedback; the ANSWER encoder still enforces that it is a valid Feedback.
      const feedback = this.answerPolicy
        ? this.answerPolicy({ index, guess, secret: s.secret, honest })
        : honest;
      await this.sendBody({ type: 'ANSWER', index, feedback });
      changed = true;
    }

    if (d.status.over) {
      if (s.gameOverAt === undefined) {
        s.gameOverAt = now;
        await this.persist();
        changed = true;
      }
      if (!s.myReveal && !this.inflight.reveal && !this.failedOps.has('reveal'))
        this.startReveal(d.transcript as Transcript);
      if (s.peerReveal && !s.peerReveal.verified) this.startRevealPoll();
      this.startVerdict();
    } else {
      this.armTurnTimer(d);
    }
    return changed;
  }

  private armGateTimer(): void {
    if (this.timers.has('gate') || this.gateOpen()) return;
    this.arm('gate', this.options.gateTimeoutMs, () => {
      this.detached(async () => {
        if (this.gateOpen() || this.s.outcome) return;
        this.s.outcome = 'abandoned';
        this.s.abandonReason = 'Both commits could not be confirmed on-chain in time';
        await this.persist();
      });
    });
  }

  private armTurnTimer(d: Derived): void {
    const seat = this.clockSeat(d);
    const logLength = this.s.log.length;
    if (this.turnDeadline?.logLength === logLength && this.turnDeadline.seat === seat) return;
    const at = this.config.clock.now() + this.options.turnMs;
    this.turnDeadline = { seat, at, logLength };
    this.arm('turn', this.options.turnMs, () => {
      this.detached(async () => undefined); // running a task emits, so the UI sees the countdown end
    });
  }

  // ---------------------------------------------------------------- chain: commit

  private startCommit(): void {
    this.inflight.commit = true;
    void (async () => {
      try {
        const commitment = await computeCommitment({
          room: this.s.room,
          playerKey: this.s.publicKey,
          secret: this.s.secret,
          saltHex: this.s.saltHex,
        });
        const sig = await this.sendMemo(encodeCommitMemo(this.s.room, commitment));
        await this.run(async () => {
          if (this.closed) return;
          this.s.myCommit = { sig, commitment, verified: false };
          await this.sendBody({ type: 'COMMIT', txSig: sig });
        });
      } catch (e) {
        this.failedOps.add('commit');
        this.fail('commit-failed', e, true);
      } finally {
        this.inflight.commit = false;
        this.schedule();
      }
    })();
  }

  /** Sends a Memo, trying a few times before giving up to the player. */
  private async sendMemo(text: string): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.options.memoAttempts; attempt++) {
      if (attempt > 0) await this.sleep(this.options.memoBackoffMs * 2 ** (attempt - 1));
      if (this.closed) break;
      try {
        return await this.config.chain.sendMemo(this.config.identity, text);
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('The Memo transaction failed');
  }

  private startPoll(which: 'my' | 'peer'): void {
    const flag = which === 'my' ? 'myPoll' : 'peerPoll';
    if (this.inflight[flag]) return;
    this.inflight[flag] = true;
    void this.pollCommit(which).finally(() => {
      this.inflight[flag] = false;
    });
  }

  private async pollCommit(which: 'my' | 'peer'): Promise<void> {
    const began = this.config.clock.now();
    let delay = this.options.pollMinMs;
    for (let attempt = 0; !this.settled; attempt++) {
      const found = await this.lookupCommit(which, attempt, this.config.clock.now() - began);
      if (found) {
        await this.run(async () => {
          this.knownTx.set(found.tx.sig, found.tx);
          if (which === 'my') {
            // Only polled once our commit was sent, so the record exists.
            this.s.myCommit = {
              ...(this.s.myCommit as NonNullable<State['myCommit']>),
              commitment: found.commitment,
              verified: true,
            };
          } else {
            this.s.peerCommit = {
              sig: this.s.peerCommit?.sig ?? found.tx.sig,
              commitment: found.commitment,
              verified: true,
            };
          }
          await this.persist();
        });
        this.schedule();
        return;
      }
      await this.sleep(delay);
      delay = Math.min(delay * 2, this.options.pollMaxMs);
    }
  }

  private async lookupCommit(
    which: 'my' | 'peer',
    attempt: number,
    elapsed: number,
  ): Promise<{ commitment: string; tx: MemoTx } | undefined> {
    const signer = which === 'my' ? this.s.publicKey : (this.s.peerKey as string);
    const sig = which === 'my' ? this.s.myCommit?.sig : this.s.peerCommit?.sig;
    try {
      if (sig) {
        const tx = await this.config.chain.getMemoTx(sig);
        const memo = tx && tx.ok && tx.signer === signer ? parseMemo(tx.text) : undefined;
        if (tx && memo?.kind === 'commit' && memo.room === this.s.room) {
          return { commitment: memo.commitment, tx };
        }
      }
      if (sig ? attempt >= 3 : elapsed >= this.options.scanAfterMs) {
        const canonical = selectCommit(
          await this.config.chain.listMemoTxs(signer, this.s.room),
          this.s.room,
          signer,
        );
        if (canonical) return { commitment: canonical.commitment, tx: canonical.tx };
      }
    } catch {
      // A failed lookup is the same as "not there yet". The loop tries again.
    }
    return undefined;
  }

  // ---------------------------------------------------------------- chain: reveal and verdict

  private startReveal(transcript: Transcript): void {
    this.inflight.reveal = true;
    void (async () => {
      try {
        const hash = await transcriptHash(transcript);
        const sig = await this.sendMemo(
          encodeRevealMemo(this.s.room, this.s.secret, this.s.saltHex, hash),
        );
        await this.run(async () => {
          if (this.closed) return;
          this.s.myReveal = { txSig: sig };
          await this.sendBody({
            type: 'REVEAL',
            secret: this.s.secret,
            saltHex: this.s.saltHex,
            txSig: sig,
          });
        });
      } catch (e) {
        this.failedOps.add('reveal');
        this.fail('reveal-failed', e, true);
      } finally {
        this.inflight.reveal = false;
        this.schedule();
      }
    })();
  }

  private startRevealPoll(): void {
    if (this.inflight.revealPoll) return;
    this.inflight.revealPoll = true;
    void (async () => {
      try {
        const peer = this.s.peerKey as string;
        let delay = this.options.pollMinMs;
        for (let attempt = 0; !this.settled; attempt++) {
          // Only started once the opponent has announced a reveal, so the signature exists.
          const sig = (this.s.peerReveal as { txSig: string }).txSig;
          try {
            const tx = await this.config.chain.getMemoTx(sig);
            const memo = tx && tx.ok && tx.signer === peer ? parseMemo(tx.text) : undefined;
            let found = tx && memo?.kind === 'reveal' && memo.room === this.s.room ? tx : undefined;
            if (!found && attempt >= 3) {
              found = selectReveal(
                await this.config.chain.listMemoTxs(peer, this.s.room),
                this.s.room,
                peer,
              )?.tx;
            }
            if (found) {
              await this.run(async () => {
                this.knownTx.set(found.sig, found);
                // Only polled once the opponent announced a reveal, so the record exists.
                this.s.peerReveal = {
                  ...(this.s.peerReveal as NonNullable<State['peerReveal']>),
                  verified: true,
                };
                await this.persist();
              });
              return;
            }
          } catch {
            // Same as not found yet.
          }
          await this.sleep(delay);
          delay = Math.min(delay * 2, this.options.pollMaxMs);
        }
      } finally {
        this.inflight.revealPoll = false;
        this.schedule();
      }
    })();
  }

  private startVerdict(): void {
    if (
      this.inflight.verdict ||
      this.verdict?.kind === 'final' ||
      this.verdict?.kind === 'abandoned'
    )
      return;
    this.inflight.verdict = true;
    void (async () => {
      try {
        while (!this.settled) {
          const closedWindow =
            this.config.clock.now() >= (this.s.gameOverAt as number) + this.options.revealWindowMs;
          const verdict = await this.computeVerdict(closedWindow);
          await this.run(async () => {
            this.verdict = verdict;
          });
          if (verdict.kind !== 'pending') return;
          await this.sleep(this.options.verdictIntervalMs);
        }
      } finally {
        this.inflight.verdict = false;
      }
    })();
  }

  private async computeVerdict(revealWindowClosed: boolean): Promise<Verdict> {
    // Only called once the game is over, which needs a transcript.
    const transcript = this.derive().transcript as Transcript;
    const { chain } = this.config;

    const sigs = [
      this.s.myCommit?.sig,
      this.s.peerCommit?.sig,
      this.s.myReveal?.txSig,
      this.s.peerReveal?.txSig,
    ];
    for (const sig of sigs) {
      if (!sig || this.knownTx.has(sig)) continue;
      try {
        const tx = await chain.getMemoTx(sig);
        if (tx) this.knownTx.set(sig, tx);
      } catch {
        // Not there yet.
      }
    }

    const txs = new Map<string, MemoTx>(this.knownTx);
    for (const player of transcript.players) {
      try {
        for (const tx of await chain.listMemoTxs(player, this.s.room)) txs.set(tx.sig, tx);
      } catch {
        // The audit scan is best effort. Records found by signature still count.
      }
    }
    const all = [...txs.values()];
    const [p0, p1] = transcript.players;
    const commits: [ChainCommit | undefined, ChainCommit | undefined] = [
      toChainCommit(selectCommit(all, this.s.room, p0)),
      toChainCommit(selectCommit(all, this.s.room, p1)),
    ];
    const reveals: [ChainReveal | undefined, ChainReveal | undefined] = [
      toChainReveal(selectReveal(all, this.s.room, p0)),
      toChainReveal(selectReveal(all, this.s.room, p1)),
    ];
    return finalise({ transcript, commits, reveals, revealWindowClosed });
  }
}

function parseState(raw: string, room: string, publicKey: string): State | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const s = value as Partial<State>;
  const ok =
    s.v === 1 &&
    s.room === room &&
    s.publicKey === publicKey &&
    (s.role === 'host' || s.role === 'guest') &&
    isValidCode(s.secret) &&
    typeof s.saltHex === 'string' &&
    Array.isArray(s.log) &&
    s.log.every((line) => typeof line === 'string' && parseMessage(line) !== undefined) &&
    Number.isInteger(s.nextSeq) &&
    Number.isInteger(s.peerNextSeq) &&
    Number.isInteger(s.acked) &&
    typeof s.createdAt === 'number';
  return ok ? (s as State) : undefined;
}
