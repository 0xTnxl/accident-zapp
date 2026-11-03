import { assertCode } from '@accident/engine';
import { concatBytes, hexToBytes, isHex, sha256Hex, utf8 } from './bytes.js';
import { assertRoom, decodeBase58 } from './ids.js';

/** Domain-separation tag that opens every commitment. */
export const COMMITMENT_TAG = 'ACCIDENT_V1';

export interface CommitmentInput {
  /** Room code, 6 characters from the room alphabet. */
  room: string;
  /** The committing player's public key, base58 (32 bytes). */
  playerKey: string;
  /** The secret: 4 distinct digits. */
  secret: string;
  /** 32 random bytes as 64 lowercase hex characters. Fresh for every game. */
  saltHex: string;
}

/**
 * `SHA-256( "ACCIDENT_V1" || room (6 ASCII bytes) || playerKey (32 bytes)
 *           || secret (4 bytes, one digit value 0-9 per byte) || salt (32 bytes) )`
 *
 * Returns 64 lowercase hex characters. Throws `RangeError` on any malformed input, including a
 * secret that is not a valid code. The room and player key bind the commitment to one game and
 * one player so it cannot be replayed elsewhere.
 */
export async function commitment(input: CommitmentInput): Promise<string> {
  const room = assertRoom(input.room);
  const key = decodeBase58(input.playerKey, 32);
  if (key === undefined) throw new RangeError('Invalid player key');
  const secret = assertCode(input.secret, 'secret');
  if (!isHex(input.saltHex, 32)) throw new RangeError('Invalid salt');

  const secretBytes = Uint8Array.from(secret, (digit) => digit.charCodeAt(0) - 48);
  return sha256Hex(
    concatBytes(utf8(COMMITMENT_TAG), utf8(room), key, secretBytes, hexToBytes(input.saltHex)),
  );
}

/** True when the revealed secret and salt reproduce `expectedHex`. Never throws on bad input. */
export async function verifyCommitment(
  input: CommitmentInput,
  expectedHex: string,
): Promise<boolean> {
  if (!isHex(expectedHex, 32)) return false;
  try {
    return (await commitment(input)) === expectedHex;
  } catch {
    return false;
  }
}
