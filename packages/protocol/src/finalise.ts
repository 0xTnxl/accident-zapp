import type { Code, Feedback, Result, Seat } from '@accident/engine';
import {
  findHits,
  findLies,
  isValidCode,
  roundOf,
  score,
  verdictFromSecrets,
} from '@accident/engine';
import { verifyCommitment } from './commitment.js';
import type { CanonicalCommit, CanonicalReveal } from './memo.js';
import type { Transcript } from './transcript.js';

/** What was proved against a player. Every fault names the seat it is charged to. */
export type Fault =
  | { seat: Seat; kind: 'no-commit' }
  | { seat: Seat; kind: 'commit-equivocation' }
  | { seat: Seat; kind: 'message-equivocation' }
  | { seat: Seat; kind: 'no-reveal' }
  | { seat: Seat; kind: 'reveal-conflict' }
  | { seat: Seat; kind: 'reveal-signer-mismatch' }
  | { seat: Seat; kind: 'invalid-secret' }
  | { seat: Seat; kind: 'commitment-mismatch' }
  | { seat: Seat; kind: 'wrong-answer'; index: number; claimed: Feedback; actual: Feedback };

/** The commit record that counts for a seat, as decided from the chain. */
export interface ChainCommit {
  commitment: string;
  equivocated: boolean;
}

/** The reveal record that counts for a seat, as decided from the chain. */
export interface ChainReveal {
  secret: string;
  salt: string;
  /** Who signed the reveal transaction. Must be the player's own key. */
  signer: string;
  conflicting: boolean;
}

export function toChainCommit(canonical: CanonicalCommit | undefined): ChainCommit | undefined {
  return canonical && { commitment: canonical.commitment, equivocated: canonical.equivocated };
}

export function toChainReveal(canonical: CanonicalReveal | undefined): ChainReveal | undefined {
  return (
    canonical && {
      secret: canonical.reveal.secret,
      salt: canonical.reveal.salt,
      signer: canonical.tx.signer,
      conflicting: canonical.conflicting,
    }
  );
}

export interface FinaliseInput {
  transcript: Transcript;
  commits: readonly [ChainCommit | undefined, ChainCommit | undefined];
  reveals: readonly [ChainReveal | undefined, ChainReveal | undefined];
  /**
   * True once the reveal window (180 s) has passed. Until then a missing reveal means "wait";
   * afterwards it is a fault. The caller owns the clock, so this function stays pure.
   */
  revealWindowClosed: boolean;
}

export type FinalReason = 'fault' | 'both-at-fault' | 'first-hit' | 'equal-round' | 'cap';

export type Verdict =
  /** A reveal is still missing and the window is open. Faults found so far are listed. */
  | { kind: 'pending'; waitingFor: Seat[]; faults: Fault[] }
  /** Neither player revealed and the window closed: nothing can be judged. */
  | { kind: 'abandoned'; faults: Fault[] }
  | {
      kind: 'final';
      result: Result;
      reason: FinalReason;
      faults: Fault[];
      /** Secrets that were revealed and proved genuine, by seat. */
      verifiedSecrets: readonly [Code | undefined, Code | undefined];
    };

const SEATS = [0, 1] as const;

/**
 * Decides the game from the signed transcript, the chain records and the revealed secrets.
 * Deterministic: the same inputs always give the same verdict, so both clients agree.
 *
 * 1. A seat is at fault if it did not commit; signed two conflicting messages; posted two
 *    conflicting commits or reveals; revealed with the wrong signer, an invalid secret, or a
 *    secret and salt that do not match its commitment; or (after the window) never revealed.
 * 2. Every answer a seat gave is re-scored against its genuine secret. Any difference is a fault.
 * 3. One seat at fault: the other wins. Both at fault: draw.
 * 4. Otherwise the first true hit of each seat decides: lower round wins, equal rounds draw,
 *    a single hit wins, no hit is a draw.
 */
export async function finalise(input: FinaliseInput): Promise<Verdict> {
  const { transcript, commits, reveals } = input;
  const faults: Fault[] = [];
  const secrets: [Code | undefined, Code | undefined] = [undefined, undefined];

  for (const seat of SEATS) {
    const commit = commits[seat];
    const reveal = reveals[seat];

    if (!commit) faults.push({ seat, kind: 'no-commit' });
    else if (commit.equivocated) faults.push({ seat, kind: 'commit-equivocation' });
    if (transcript.equivocation[seat]) faults.push({ seat, kind: 'message-equivocation' });
    if (!reveal) continue;

    if (reveal.conflicting) faults.push({ seat, kind: 'reveal-conflict' });
    if (reveal.signer !== transcript.players[seat]) {
      faults.push({ seat, kind: 'reveal-signer-mismatch' });
    }
    if (!isValidCode(reveal.secret)) {
      faults.push({ seat, kind: 'invalid-secret' });
    } else if (commit) {
      const genuine = await verifyCommitment(
        {
          room: transcript.room,
          playerKey: transcript.players[seat],
          secret: reveal.secret,
          saltHex: reveal.salt,
        },
        commit.commitment,
      );
      if (genuine) secrets[seat] = reveal.secret;
      else faults.push({ seat, kind: 'commitment-mismatch' });
    }
  }

  // Lies: compare each answer with the true score of the seat's genuine secret.
  for (const seat of SEATS) {
    const secret = secrets[seat];
    if (secret === undefined) continue;
    for (const index of findLies(transcript.guessCodes, transcript.answerValues, seat, secret)) {
      faults.push({
        seat,
        kind: 'wrong-answer',
        index,
        claimed: transcript.answerValues[index] as Feedback,
        actual: score(secret, transcript.guessCodes[index] as Code),
      });
    }
  }

  const missing = SEATS.filter((seat) => !reveals[seat]);
  if (missing.length > 0 && !input.revealWindowClosed) {
    return { kind: 'pending', waitingFor: [...missing], faults };
  }
  if (missing.length === 2) return { kind: 'abandoned', faults };
  for (const seat of missing) faults.push({ seat, kind: 'no-reveal' });

  const verifiedSecrets = [secrets[0], secrets[1]] as const;
  const faulty = SEATS.filter((seat) => faults.some((f) => f.seat === seat));

  if (faulty.length === 2) {
    return { kind: 'final', result: 'draw', reason: 'both-at-fault', faults, verifiedSecrets };
  }
  if (faulty.length === 1) {
    return {
      kind: 'final',
      result: faulty[0] === 0 ? 'seat1' : 'seat0',
      reason: 'fault',
      faults,
      verifiedSecrets,
    };
  }

  // Nobody is at fault, so both secrets are genuine. Decide by the first true hits.
  const pair = [secrets[0], secrets[1]] as [Code, Code];
  const result = verdictFromSecrets(transcript.guessCodes, pair);
  const [hit0, hit1] = findHits(transcript.guessCodes, pair);
  const reason: FinalReason =
    hit0 === undefined && hit1 === undefined
      ? 'cap'
      : hit0 !== undefined && hit1 !== undefined && roundOf(hit0) === roundOf(hit1)
        ? 'equal-round'
        : 'first-hit';
  return { kind: 'final', result, reason, faults, verifiedSecrets };
}
