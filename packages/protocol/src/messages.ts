import type { Code, Feedback } from '@accident/engine';
import { MAX_GUESSES, isValidCode, isValidFeedback } from '@accident/engine';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { isHex, utf8 } from './bytes.js';
import { decodeBase58, isValidPublicKey, isValidRoom, isValidSignature } from './ids.js';
import { PROTOCOL_PREFIX } from './memo.js';

export const MESSAGE_TYPES = ['HELLO', 'COMMIT', 'GUESS', 'ANSWER', 'REVEAL', 'SYNC'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** Largest sequence number accepted. A game needs under 30 per player. */
export const MAX_SEQ = 255;
/** Largest raw wire message accepted, in characters. */
export const MAX_RAW_LENGTH = 1024;

export type Role = 'host' | 'guest';

export type Body =
  | { type: 'HELLO'; role: Role }
  | { type: 'COMMIT'; txSig: string }
  | { type: 'GUESS'; guess: Code }
  | { type: 'ANSWER'; index: number; feedback: Feedback }
  | { type: 'REVEAL'; secret: string; saltHex: string; txSig: string }
  | { type: 'SYNC'; received: number };

/** The message as it travels: everything needed to check who sent it and that it is unaltered. */
export interface SignedMessage {
  room: string;
  /** Sender's public key, base58. */
  from: string;
  seq: number;
  type: MessageType;
  payload: string;
  /** Ed25519 signature over {@link signedText}, base58. */
  sig: string;
}

const DECIMAL = '(?:0|[1-9][0-9]*)';
const ANSWER_PAYLOAD = new RegExp(`^(${DECIMAL}):(${DECIMAL})$`);
const SYNC_PAYLOAD = /^(?:-1|0|[1-9][0-9]{0,2})$/;
const REVEAL_PAYLOAD = /^([0-9]{4}):([0-9a-f]{64}):([1-9A-HJ-NP-Za-km-z]{64,90})$/;

/** Canonical payload text for a body. Throws `RangeError` if the body is not valid. */
export function encodeBody(body: Body): string {
  const payload = ((): string => {
    switch (body.type) {
      case 'HELLO':
        return body.role;
      case 'COMMIT':
        return body.txSig;
      case 'GUESS':
        return body.guess;
      case 'ANSWER':
        return `${body.index}:${body.feedback}`;
      case 'REVEAL':
        return `${body.secret}:${body.saltHex}:${body.txSig}`;
      case 'SYNC':
        return String(body.received);
    }
  })();
  if (decodeBody(body.type, payload) === undefined) {
    throw new RangeError(`Invalid ${body.type} message`);
  }
  return payload;
}

/** Parses a payload against the strict grammar for its type. `undefined` if it does not fit. */
export function decodeBody(type: unknown, payload: unknown): Body | undefined {
  if (typeof payload !== 'string' || payload.length > 300) return undefined;
  switch (type) {
    case 'HELLO':
      return payload === 'host' || payload === 'guest' ? { type, role: payload } : undefined;
    case 'COMMIT':
      return isValidSignature(payload) ? { type, txSig: payload } : undefined;
    case 'GUESS':
      return isValidCode(payload) ? { type, guess: payload } : undefined;
    case 'ANSWER': {
      const match = ANSWER_PAYLOAD.exec(payload);
      if (!match) return undefined;
      const index = Number(match[1]);
      const feedback = Number(match[2]);
      if (!Number.isSafeInteger(index) || index >= MAX_GUESSES || !isValidFeedback(feedback)) {
        return undefined;
      }
      return { type, index, feedback };
    }
    case 'REVEAL': {
      const match = REVEAL_PAYLOAD.exec(payload);
      if (!match || !isValidSignature(match[3]) || !isHex(match[2], 32)) return undefined;
      return { type, secret: match[1] as string, saltHex: match[2] as string, txSig: match[3] };
    }
    case 'SYNC': {
      if (!SYNC_PAYLOAD.test(payload)) return undefined;
      const received = Number(payload);
      return received <= MAX_SEQ ? { type, received } : undefined;
    }
    default:
      return undefined;
  }
}

/** The exact text that is signed: `ACC1|<room>|<seq>|<type>|<payload>`. */
export function signedText(
  message: Pick<SignedMessage, 'room' | 'seq' | 'type' | 'payload'>,
): string {
  return `${PROTOCOL_PREFIX}|${message.room}|${message.seq}|${message.type}|${message.payload}`;
}

export interface Identity {
  /** 64 bytes: 32-byte seed followed by the 32-byte public key (the Solana keypair layout). */
  secretKey: Uint8Array;
  /** Base58 public key. */
  publicKey: string;
}

/** Builds an identity from a 64-byte Solana-style secret key, checking the halves agree. */
export function identityFromSecretKey(secretKey: Uint8Array): Identity {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 64) {
    throw new RangeError('A secret key must be 64 bytes');
  }
  const derived = nacl.sign.keyPair.fromSeed(secretKey.slice(0, 32));
  const given = secretKey.slice(32);
  if (!derived.publicKey.every((byte, i) => byte === given[i])) {
    throw new RangeError('Secret key does not match its public key');
  }
  return { secretKey: secretKey.slice(), publicKey: bs58.encode(derived.publicKey) };
}

/** A fresh random identity. */
export function generateIdentity(): Identity {
  return identityFromSecretKey(nacl.sign.keyPair().secretKey);
}

/** Signs a message body. Throws `RangeError` for an invalid room, seq or body. */
export function signMessage(
  identity: Identity,
  fields: { room: string; seq: number; body: Body },
): SignedMessage {
  if (!isValidRoom(fields.room)) throw new RangeError('Invalid room code');
  if (!Number.isSafeInteger(fields.seq) || fields.seq < 0 || fields.seq > MAX_SEQ) {
    throw new RangeError('Invalid sequence number');
  }
  const payload = encodeBody(fields.body);
  const unsigned = { room: fields.room, seq: fields.seq, type: fields.body.type, payload };
  const signature = nacl.sign.detached(utf8(signedText(unsigned)), identity.secretKey);
  return { ...unsigned, from: identity.publicKey, sig: bs58.encode(signature) };
}

/**
 * Checks the shape of an untrusted value and returns it as a clean message, or `undefined`.
 * Does not check the signature. Extra fields are rejected.
 */
export function validateEnvelope(value: unknown): SignedMessage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'from,payload,room,seq,sig,type') return undefined;
  const m = value as Record<string, unknown>;
  if (!isValidRoom(m.room) || !isValidPublicKey(m.from) || !isValidSignature(m.sig)) {
    return undefined;
  }
  if (typeof m.seq !== 'number' || !Number.isSafeInteger(m.seq) || m.seq < 0 || m.seq > MAX_SEQ) {
    return undefined;
  }
  const body = decodeBody(m.type, m.payload);
  if (body === undefined) return undefined;
  return {
    room: m.room,
    from: m.from,
    seq: m.seq,
    type: body.type,
    payload: m.payload as string,
    sig: m.sig,
  };
}

/**
 * Builds a message verifier that remembers recent results.
 *
 * A message is checked when it arrives, again when the transcript is assembled and again at
 * finalisation. Verification is a pure function of (sender, signed text, signature), so caching
 * the answer is safe. When the cache is full it is emptied, which keeps memory bounded.
 */
export function createVerifier(cacheSize: number): (message: unknown) => boolean {
  const cache = new Map<string, boolean>();
  return (message) => {
    const m = validateEnvelope(message);
    if (!m) return false;
    const key = `${m.from}|${m.sig}|${signedText(m)}`;
    const known = cache.get(key);
    if (known !== undefined) return known;
    // validateEnvelope already proved both decode to the right lengths.
    const publicKey = decodeBase58(m.from, 32) as Uint8Array;
    const signature = decodeBase58(m.sig, 64) as Uint8Array;
    const valid = nacl.sign.detached.verify(utf8(signedText(m)), signature, publicKey);
    if (cache.size >= cacheSize) cache.clear();
    cache.set(key, valid);
    return valid;
  };
}

/** True when the message is well formed and `sig` is the sender's valid signature over it. */
export const verifyMessage: (message: unknown) => boolean = createVerifier(2048);

/** Wire form: JSON with a fixed key order. */
export function encodeMessage(message: SignedMessage): string {
  return JSON.stringify({
    room: message.room,
    from: message.from,
    seq: message.seq,
    type: message.type,
    payload: message.payload,
    sig: message.sig,
  });
}

/** Parses a raw wire string. Returns `undefined` for anything oversize, malformed or not strict. */
export function parseMessage(raw: unknown): SignedMessage | undefined {
  if (typeof raw !== 'string' || raw.length > MAX_RAW_LENGTH) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return validateEnvelope(value);
}

/** Parses the wire string and verifies the signature in one step. */
export function openMessage(raw: unknown): { message: SignedMessage; body: Body } | undefined {
  const message = parseMessage(raw);
  if (!message || !verifyMessage(message)) return undefined;
  // parseMessage already validated the payload, so decoding cannot fail here.
  return { message, body: decodeBody(message.type, message.payload) as Body };
}
