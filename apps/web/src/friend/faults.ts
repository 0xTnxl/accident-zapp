import { decodeFeedback } from '@accident/engine';
import type { Fault } from '@accident/protocol';

/**
 * Human copy for one proved fault, including the wrong-answer evidence (claimed versus true dead
 * and injured). Shared by the Result screen and the Verifier so both read the record the same way.
 * This lives apart from Room.tsx so the Verifier can reuse it without pulling in the friend-mode
 * chain and relay clients.
 */
export function faultText(fault: Fault): string {
  switch (fault.kind) {
    case 'wrong-answer': {
      const claimed = decodeFeedback(fault.claimed);
      const actual = decodeFeedback(fault.actual);
      return `Guess ${fault.index + 1} was answered ${claimed.dead} dead, ${claimed.injured} injured, but the true answer was ${actual.dead} dead, ${actual.injured} injured.`;
    }
    case 'invalid-secret':
      return 'Revealed a secret that is not four different digits.';
    case 'commitment-mismatch':
      return 'Revealed a secret that does not match what was locked in.';
    case 'commit-equivocation':
      return 'Locked in two different secrets.';
    case 'message-equivocation':
      return 'Sent two conflicting messages for the same move.';
    case 'reveal-signer-mismatch':
      return 'The reveal was signed by a different key.';
    case 'reveal-conflict':
      return 'Published two different reveals.';
    case 'no-commit':
      return 'Never locked in a secret.';
    case 'no-reveal':
      return 'Never revealed their secret.';
  }
}
