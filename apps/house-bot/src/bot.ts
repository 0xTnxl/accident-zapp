import type { Code, Feedback, Level, Rng, Turn } from '@accident/engine';
import {
  candidatesFromHistory,
  chooseGuess,
  OPENING_GUESS,
  secureRng,
  VALID_FEEDBACK,
} from '@accident/engine';
import type {
  AnswerPolicy,
  Chain,
  Clock,
  Identity,
  Role,
  SessionOptions,
  SessionView,
  Storage,
  Transport,
} from '@accident/protocol';
import { Session } from '@accident/protocol';
import type { Choice } from './secret.js';
import { makeChoice } from './secret.js';

/**
 * The label a House Bot carries so a room or opponent can tell it apart from a human (REQ-17.3).
 * The relay HELLO payload is fixed to 'host' | 'guest' and must not be weakened to carry this, so
 * the badge lives at the bot layer instead: see {@link HouseBot.label} and {@link HouseBot.marker}.
 */
export const HOUSE_BOT_LABEL = 'House Bot';

/**
 * A room-facing marker a UI renders as the "bot" badge (REQ-17.3). It pairs the bot's public key
 * (how the opponent already identifies the seat, from the signed messages) with the label, so a
 * room can match the badge to the player without any change to protocol message validation.
 */
export interface BotMarker {
  label: string;
  publicKey: string;
}

/**
 * How a bot deviates from honest answering, used to demonstrate and test lie detection (Task 11.2 /
 * REQ-17.2). The bot lies about exactly one of its own answers, at the given 0-based ANSWER index,
 * sending a feedback that differs from the true score but is still a valid {@link Feedback}. Every
 * other answer stays honest. With no cheat option the bot plays the honest path unchanged.
 */
export interface CheatConfig {
  /** The ANSWER index this bot lies about. */
  atGuessIndex: number;
}

/**
 * Builds an {@link AnswerPolicy} that lies on exactly one index. For the targeted index it returns
 * the first valid feedback that is not the honest score, so the ANSWER is syntactically valid yet
 * provably wrong; every other index is answered honestly. Finalisation re-scores each answer and
 * charges the lying seat a 'wrong-answer' fault, so the honest opponent wins.
 */
function cheatingPolicy(cheat: CheatConfig): AnswerPolicy {
  return ({ index, honest }): Feedback => {
    if (index !== cheat.atGuessIndex) return honest;
    const wrong = VALID_FEEDBACK.find((value) => value !== honest);
    // VALID_FEEDBACK has 14 entries, so one that differs from the honest value always exists.
    return wrong as Feedback;
  };
}

/**
 * Picks an honest guess from a view, exactly as the proven harness `autoplay` does: keep only the
 * bot's own answered turns, narrow the still-consistent codes, and ask the engine to choose.
 *
 * Returns {@link OPENING_GUESS} when nothing is consistent, which happens only if the opponent lied
 * (the answers contradict each other). The honest bot keeps playing a valid code so the game can
 * still reach finalisation, where the lie is caught; it never gets stuck.
 */
export function chooseHonestGuess(view: SessionView, level: Level, rng: Rng): Code {
  const history: Turn[] = view.guesses
    .map((guess, index) => ({ guess, index }))
    .filter(({ index }) => index % 2 === view.seat && view.answers[index] !== undefined)
    .map(({ guess, index }) => ({ guess, feedback: view.answers[index] as number }));
  return chooseGuess(level, candidatesFromHistory(history), rng) ?? OPENING_GUESS;
}

/**
 * How to build a {@link HouseBot}. Everything the protocol {@link Session} needs, plus the two
 * knobs that shape the bot's play: its difficulty `level` and its guess `rng`.
 *
 * The bot drives the real protocol. It does not re-implement any of it: funding happens before the
 * bot is built (a no-op in tests), while commit, the play gate, honest auto-answering and reveal
 * all come from the Session. The bot only chooses guesses, with the same engine the web Client uses.
 */
export interface HouseBotConfig {
  room: string;
  role: Role;
  identity: Identity;
  /** The secret and salt to commit to. Defaults to a fresh {@link makeChoice}. */
  choice?: Choice;
  /** Guests may pin the host's key from the share link. */
  hostKey?: string;
  /** Guessing difficulty. Default 'medium'. */
  level?: Level;
  /** Source of randomness for guess selection. Default {@link secureRng}; tests inject a seed. */
  rng?: Rng;
  /**
   * Makes the bot lie about one answer, to demonstrate lie detection (Task 11.2). Omit for honest
   * play, which is byte-for-byte identical to a bot with no cheat option.
   */
  cheat?: CheatConfig;
  /** A custom label for the room badge. Defaults to {@link HOUSE_BOT_LABEL}. */
  label?: string;
  transport: Transport;
  chain: Chain;
  storage: Storage;
  clock: Clock;
  options?: Partial<SessionOptions>;
}

/**
 * An honest Node House Bot. It owns one protocol {@link Session} and, whenever the view says it
 * may guess, picks a code that is still consistent with every answer it has received and submits
 * it. All other protocol behaviour (commit, gate, auto-answer, reveal, finalisation) is the
 * Session's, so the bot plays by exactly the same rules as a human Client.
 */
export class HouseBot {
  private readonly session: Session;
  private readonly level: Level;
  private readonly rng: Rng;
  /** The bot's own public key, how the opponent identifies this seat in the signed messages. */
  private readonly publicKey: string;
  /** How a room should badge this player as a bot (REQ-17.3). */
  readonly label: string;
  /** The length of `guesses` at the last submission, so each turn is answered once. */
  private submitted = -1;
  private unsubscribe: (() => void) | undefined;
  /** Errors from a background guess that could not be submitted, surfaced for inspection. */
  readonly errors: unknown[] = [];

  constructor(config: HouseBotConfig) {
    const choice = config.choice ?? makeChoice(config.rng);
    this.level = config.level ?? 'medium';
    this.rng = config.rng ?? secureRng();
    this.label = config.label ?? HOUSE_BOT_LABEL;
    this.publicKey = config.identity.publicKey;
    this.session = Session.create({
      room: config.room,
      role: config.role,
      identity: config.identity,
      secret: choice.secret,
      saltHex: choice.saltHex,
      ...(config.hostKey === undefined ? {} : { hostKey: config.hostKey }),
      transport: config.transport,
      chain: config.chain,
      storage: config.storage,
      clock: config.clock,
      options: config.options ?? {},
      // Honest by default: with no cheat option no answerPolicy is passed, so the Session answers
      // every guess with the true score, exactly as an honest Client does.
      ...(config.cheat === undefined ? {} : { answerPolicy: cheatingPolicy(config.cheat) }),
    });
  }

  /**
   * The room-facing marker a UI uses to render the "bot" badge (REQ-17.3). It carries the label and
   * the bot's public key, which the opponent already learns from the signed messages, so the badge
   * can be matched to the seat without touching protocol message validation.
   */
  marker(): BotMarker {
    return { label: this.label, publicKey: this.publicKey };
  }

  /** Joins the room and begins playing. Guesses are made automatically as turns come up. */
  async start(): Promise<void> {
    this.unsubscribe = this.session.subscribe((view) => this.onView(view));
    await this.session.start();
    this.onView(this.session.view());
  }

  /** The latest view of the game. */
  view(): SessionView {
    return this.session.view();
  }

  /** The signed messages of the game so far, as wire strings. */
  transcript(): string[] {
    return this.session.transcript();
  }

  /** Watches the game. Returns a function that stops watching. */
  subscribe(listener: (view: SessionView) => void): () => void {
    return this.session.subscribe(listener);
  }

  /** Leaves the room and stops the bot. The saved game stays so it could be resumed. */
  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.session.close();
  }

  /**
   * Guesses when it is the bot's turn. Mirrors the proven harness `autoplay`: build the bot's own
   * answered turns from the view, narrow the candidates, and ask the engine for a move.
   */
  private onView(view: SessionView): void {
    if (!view.canGuess || view.guesses.length === this.submitted) return;
    this.submitted = view.guesses.length;
    const guess = chooseHonestGuess(view, this.level, this.rng);
    void this.session.submitGuess(guess).catch((error: unknown) => this.errors.push(error));
  }
}
