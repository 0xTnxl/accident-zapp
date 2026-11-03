import type { Code, Feedback, Seat } from '@accident/engine';
import { GUESSES_PER_PLAYER, MAX_GUESSES, answererOf } from '@accident/engine';
import { sha256Hex, utf8 } from './bytes.js';
import type { Body, SignedMessage } from './messages.js';
import { decodeBody, signedText, validateEnvelope, verifyMessage } from './messages.js';

/**
 * A game transcript built from signed relay messages: HELLO, COMMIT, GUESS and ANSWER.
 * REVEAL and SYNC are not part of it. Built by {@link assembleTranscript}.
 */
export interface Transcript {
  room: string;
  /** Public keys by seat: seat 0 is the host, seat 1 the guest. */
  players: readonly [string, string];
  hellos: readonly [SignedMessage, SignedMessage];
  /** The first COMMIT each seat announced, if any. Its payload names the commit transaction. */
  commits: readonly [SignedMessage | undefined, SignedMessage | undefined];
  /** `guesses[i]` is guess number i, made by seat `i % 2`. No gaps. */
  guesses: readonly SignedMessage[];
  /** `answers[i]` answers `guesses[i]`. No gaps, and never longer than `guesses`. */
  answers: readonly SignedMessage[];
  /** The guess codes, aligned with `guesses`. */
  guessCodes: readonly Code[];
  /** The claimed feedback, aligned with `answers`. */
  answerValues: readonly Feedback[];
  /** Seats that signed two different messages for the same position. That is a fault. */
  equivocation: readonly [boolean, boolean];
  /** Reasons messages were dropped, for diagnostics. */
  ignored: readonly string[];
}

export type AssembleResult = { ok: true; transcript: Transcript } | { ok: false; reason: string };

interface Parsed {
  message: SignedMessage;
  body: Body;
}

/**
 * Builds a transcript from untrusted messages, in any order.
 *
 * Every message must be well formed, for this room, and carry a valid signature from one of the
 * two players. The players are the single host and single guest named by HELLO messages; if the
 * HELLOs are missing, repeated by other keys or ambiguous, assembly fails. The result does not
 * depend on the order of the input.
 */
export function assembleTranscript(room: string, messages: readonly unknown[]): AssembleResult {
  const ignored: string[] = [];
  const valid: Parsed[] = [];

  for (const raw of messages) {
    const message = validateEnvelope(raw);
    if (!message) {
      ignored.push('malformed message');
    } else if (message.room !== room) {
      ignored.push('message for another room');
    } else if (!verifyMessage(message)) {
      ignored.push(`bad signature on ${message.type} seq ${message.seq}`);
    } else {
      // validateEnvelope already checked the payload, so decoding cannot fail.
      valid.push({ message, body: decodeBody(message.type, message.payload) as Body });
    }
  }

  // Players: exactly one key says host and exactly one, different, says guest.
  const hosts = new Set<string>();
  const guests = new Set<string>();
  for (const { message, body } of valid) {
    if (body.type !== 'HELLO') continue;
    (body.role === 'host' ? hosts : guests).add(message.from);
  }
  if (hosts.size !== 1 || guests.size !== 1) {
    return { ok: false, reason: 'Could not identify exactly one host and one guest' };
  }
  const players = [[...hosts][0] as string, [...guests][0] as string] as const;
  if (players[0] === players[1]) return { ok: false, reason: 'Host and guest are the same key' };
  const seatOf = (key: string): Seat | undefined =>
    key === players[0] ? 0 : key === players[1] ? 1 : undefined;

  // Group by sender and position, keeping one message per (sender, seq).
  const equivocation: [boolean, boolean] = [false, false];
  const bySeat: [Map<number, Parsed>, Map<number, Parsed>] = [new Map(), new Map()];
  const sorted = [...valid].sort((a, b) => compare(a.message.sig, b.message.sig));
  for (const parsed of sorted) {
    const seat = seatOf(parsed.message.from);
    if (seat === undefined) {
      ignored.push('message from a stranger');
      continue;
    }
    if (parsed.body.type === 'SYNC' || parsed.body.type === 'REVEAL') continue;
    const existing = bySeat[seat].get(parsed.message.seq);
    if (!existing) {
      bySeat[seat].set(parsed.message.seq, parsed);
    } else if (existing.message.sig !== parsed.message.sig) {
      equivocation[seat] = true;
      ignored.push(`seat ${seat} signed two messages with seq ${parsed.message.seq}`);
    }
  }

  const inSeqOrder = (seat: Seat): Parsed[] =>
    [...bySeat[seat].values()].sort((a, b) => a.message.seq - b.message.seq);

  const hellos: SignedMessage[] = [];
  const commits: Array<SignedMessage | undefined> = [undefined, undefined];
  const guessesBySeat: [SignedMessage[], SignedMessage[]] = [[], []];
  const answersByIndex = new Map<number, SignedMessage>();

  for (const seat of [0, 1] as const) {
    const expectedRole = seat === 0 ? 'host' : 'guest';
    for (const { message, body } of inSeqOrder(seat)) {
      switch (body.type) {
        case 'HELLO':
          if (body.role !== expectedRole || hellos[seat] !== undefined) {
            ignored.push(`unexpected HELLO from seat ${seat}`);
          } else {
            hellos[seat] = message;
          }
          break;
        case 'COMMIT':
          if (commits[seat] === undefined) commits[seat] = message;
          else ignored.push(`extra COMMIT from seat ${seat}`);
          break;
        case 'GUESS':
          if (guessesBySeat[seat].length >= GUESSES_PER_PLAYER) {
            ignored.push(`seat ${seat} sent more than ${GUESSES_PER_PLAYER} guesses`);
          } else {
            guessesBySeat[seat].push(message);
          }
          break;
        case 'ANSWER': {
          if (answererOf(body.index) !== seat) {
            ignored.push(`seat ${seat} answered guess ${body.index} out of turn`);
            break;
          }
          const existing = answersByIndex.get(body.index);
          if (!existing) {
            answersByIndex.set(body.index, message);
          } else if (existing.payload !== message.payload) {
            equivocation[seat] = true;
            ignored.push(`seat ${seat} gave two answers to guess ${body.index}`);
          }
          break;
        }
      }
    }
  }

  // Guess i belongs to seat i % 2 and is that seat's floor(i / 2)-th guess, so interleave.
  const guesses: SignedMessage[] = [];
  for (let i = 0; i < MAX_GUESSES; i++) {
    const guess = guessesBySeat[(i % 2) as Seat][Math.floor(i / 2)];
    if (!guess) break;
    guesses.push(guess);
  }
  const used = guesses.length;
  const extra = guessesBySeat[0].length + guessesBySeat[1].length - used;
  if (extra > 0) ignored.push(`${extra} guess(es) after a gap in the turn order`);

  const answers: SignedMessage[] = [];
  for (let i = 0; i < used; i++) {
    const answer = answersByIndex.get(i);
    if (!answer) break;
    answers.push(answer);
  }
  if (answersByIndex.size > answers.length) ignored.push('answers after a gap or without a guess');

  // Each player was identified by a HELLO above, and the first one per seat is kept.
  const hello0 = hellos[0] as SignedMessage;
  const hello1 = hellos[1] as SignedMessage;

  return {
    ok: true,
    transcript: {
      room,
      players,
      hellos: [hello0, hello1],
      commits: [commits[0], commits[1]],
      guesses,
      answers,
      guessCodes: guesses.map((m) => (decodeBody('GUESS', m.payload) as { guess: Code }).guess),
      answerValues: answers.map(
        (m) => (decodeBody('ANSWER', m.payload) as { feedback: Feedback }).feedback,
      ),
      equivocation,
      ignored,
    },
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The messages in canonical order: HELLO seat 0, HELLO seat 1, COMMIT seat 0, COMMIT seat 1
 * (if present), then for each guess number i: GUESS i, ANSWER i (if present).
 */
export function transcriptMessages(transcript: Transcript): SignedMessage[] {
  const out: SignedMessage[] = [...transcript.hellos];
  for (const commit of transcript.commits) if (commit) out.push(commit);
  transcript.guesses.forEach((guess, i) => {
    out.push(guess);
    const answer = transcript.answers[i];
    if (answer) out.push(answer);
  });
  return out;
}

/** One line per message: `<signed text>|<signature>`. */
export function transcriptLines(transcript: Transcript): string[] {
  return transcriptMessages(transcript).map((m) => `${signedText(m)}|${m.sig}`);
}

/** SHA-256 (64 lowercase hex characters) of the canonical lines joined by newlines. */
export function transcriptHash(transcript: Transcript): Promise<string> {
  return sha256Hex(utf8(transcriptLines(transcript).join('\n')));
}
