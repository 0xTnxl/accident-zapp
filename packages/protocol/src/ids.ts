import bs58 from 'bs58';
import { bytesToHex, randomBytes } from './bytes.js';

/**
 * Room code alphabet: 32 characters with no 0, 1, I or O, so codes survive being read aloud or
 * typed on a phone. 32 divides 256, so mapping random bytes to characters has no bias.
 */
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_LENGTH = 6;

const ROOM_PATTERN = new RegExp(`^[${ROOM_ALPHABET}]{${ROOM_LENGTH}}$`);

export function isValidRoom(value: unknown): value is string {
  return typeof value === 'string' && ROOM_PATTERN.test(value);
}

export function assertRoom(value: unknown): string {
  if (!isValidRoom(value)) throw new RangeError('Invalid room code');
  return value;
}

/** A fresh random room code: 32^6 (about one billion) possibilities. */
export function generateRoomCode(): string {
  let code = '';
  for (const byte of randomBytes(ROOM_LENGTH)) code += ROOM_ALPHABET[byte % 32];
  return code;
}

/** A fresh random 32-byte salt as 64 lowercase hex characters. */
export function generateSaltHex(): string {
  return bytesToHex(randomBytes(32));
}

/** Decodes a base58 string that must be exactly `length` bytes, or returns `undefined`. */
export function decodeBase58(value: unknown, length: number): Uint8Array | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(value);
  } catch {
    return undefined;
  }
  if (bytes.length !== length) return undefined;
  return bytes;
}

/** True for a base58 Solana public key: exactly 32 bytes in canonical form. */
export function isValidPublicKey(value: unknown): value is string {
  return decodeBase58(value, 32) !== undefined;
}

/** True for a base58 Solana transaction signature or Ed25519 signature: exactly 64 bytes. */
export function isValidSignature(value: unknown): value is string {
  return decodeBase58(value, 64) !== undefined;
}
