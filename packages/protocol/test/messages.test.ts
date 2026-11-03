import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import type { Body, SignedMessage } from '../src/index.js';
import {
  MAX_RAW_LENGTH,
  MAX_SEQ,
  MESSAGE_TYPES,
  createVerifier,
  decodeBody,
  encodeBody,
  encodeMessage,
  generateIdentity,
  identityFromSecretKey,
  openMessage,
  parseMessage,
  signMessage,
  signedText,
  validateEnvelope,
  verifyMessage,
} from '../src/index.js';
import { ROOM, fakeSig, identityFromByte, saltOf } from './helpers.js';

const alice = identityFromByte(1);
const mallory = identityFromByte(9);

const BODIES: Body[] = [
  { type: 'HELLO', role: 'host' },
  { type: 'HELLO', role: 'guest' },
  { type: 'COMMIT', txSig: fakeSig(4) },
  { type: 'GUESS', guess: '2604' },
  { type: 'GUESS', guess: '0123' },
  { type: 'ANSWER', index: 0, feedback: 0 },
  { type: 'ANSWER', index: 23, feedback: 40 },
  { type: 'ANSWER', index: 7, feedback: 22 },
  { type: 'REVEAL', secret: '1234', saltHex: saltOf(3), txSig: fakeSig(5) },
  { type: 'SYNC', received: -1 },
  { type: 'SYNC', received: 0 },
  { type: 'SYNC', received: 255 },
];

function signed(body: Body, seq = 0): SignedMessage {
  return signMessage(alice, { room: ROOM, seq, body });
}

describe('signing and verifying', () => {
  it.each(BODIES)('round-trips a %o', (body) => {
    const message = signed(body, 3);
    expect(message).toMatchObject({ room: ROOM, from: alice.publicKey, seq: 3, type: body.type });
    expect(verifyMessage(message)).toBe(true);
    expect(decodeBody(message.type, message.payload)).toEqual(body);
    const opened = openMessage(encodeMessage(message));
    expect(opened?.message).toEqual(message);
    expect(opened?.body).toEqual(body);
  });

  it('signs the documented text', () => {
    const message = signed({ type: 'GUESS', guess: '2604' }, 5);
    expect(signedText(message)).toBe(`ACC1|${ROOM}|5|GUESS|2604`);
  });

  it('is deterministic: the same message always gets the same signature', () => {
    expect(signed({ type: 'GUESS', guess: '2604' }, 2).sig).toBe(
      signed({ type: 'GUESS', guess: '2604' }, 2).sig,
    );
  });

  it('knows all six message types', () => {
    expect([...MESSAGE_TYPES]).toEqual(['HELLO', 'COMMIT', 'GUESS', 'ANSWER', 'REVEAL', 'SYNC']);
  });
});

describe('forgery is detected', () => {
  const genuine = signed({ type: 'ANSWER', index: 2, feedback: 11 }, 4);

  it.each([
    ['a different payload', { payload: '2:12' }],
    ['a different sequence number', { seq: 5 }],
    ['a different type', { type: 'SYNC' as const, payload: '0' }],
    ['a different room', { room: 'ZZZ999' }],
  ])('rejects %s', (_name, change) => {
    expect(verifyMessage({ ...genuine, ...change })).toBe(false);
  });

  it('rejects a message claiming to be from someone else', () => {
    expect(verifyMessage({ ...genuine, from: mallory.publicKey })).toBe(false);
  });

  it('rejects a signature copied from another message', () => {
    const other = signed({ type: 'ANSWER', index: 2, feedback: 40 }, 4);
    expect(verifyMessage({ ...genuine, sig: other.sig })).toBe(false);
  });

  it("rejects a message signed by a key other than the one in 'from'", () => {
    const forged = signMessage(mallory, {
      room: ROOM,
      seq: 4,
      body: { type: 'SYNC', received: 1 },
    });
    expect(verifyMessage({ ...forged, from: alice.publicKey })).toBe(false);
  });

  it('rejects a signature that is 64 bytes of garbage', () => {
    expect(verifyMessage({ ...genuine, sig: fakeSig(7) })).toBe(false);
  });

  it('rejects a flipped bit anywhere in the signature', () => {
    const bytes = bs58.decode(genuine.sig);
    for (const position of [0, 17, 40, 63]) {
      const tampered = Uint8Array.from(bytes);
      tampered[position] = (tampered[position] as number) ^ 1;
      expect(verifyMessage({ ...genuine, sig: bs58.encode(tampered) })).toBe(false);
    }
  });

  it('never throws on arbitrary input', () => {
    for (const bad of [null, undefined, 1, 'x', [], {}, { ...genuine, sig: 'nope' }]) {
      expect(verifyMessage(bad)).toBe(false);
    }
  });
});

describe('verification cache', () => {
  it('gives the same answers as the uncached check, for good and bad messages alike', () => {
    const verify = createVerifier(10);
    const good = signed({ type: 'GUESS', guess: '2604' }, 1);
    const bad = { ...good, payload: '4321' };
    for (let round = 0; round < 3; round++) {
      expect(verify(good)).toBe(true);
      expect(verify(bad)).toBe(false);
      expect(verify('junk')).toBe(false);
    }
  });

  it('does not let a cached good message vouch for an altered one', () => {
    const verify = createVerifier(10);
    const good = signed({ type: 'ANSWER', index: 1, feedback: 11 }, 2);
    expect(verify(good)).toBe(true);
    expect(verify({ ...good, payload: '1:12' })).toBe(false);
    expect(verify({ ...good, seq: 3 })).toBe(false);
    expect(verify({ ...good, from: mallory.publicKey })).toBe(false);
    expect(verify(good)).toBe(true);
  });

  it('stays correct when the cache fills and is emptied', () => {
    const verify = createVerifier(2);
    const messages = [0, 1, 2, 3, 4].map((seq) => signed({ type: 'SYNC', received: seq }, seq));
    for (const m of [...messages, ...messages]) expect(verify(m)).toBe(true);
    expect(verify({ ...messages[0]!, payload: '4' })).toBe(false);
  });
});

describe('encoding is strict', () => {
  it('refuses to sign an invalid room, seq or body', () => {
    const body: Body = { type: 'SYNC', received: 0 };
    expect(() => signMessage(alice, { room: 'bad', seq: 0, body })).toThrow(RangeError);
    for (const seq of [-1, 1.5, MAX_SEQ + 1, NaN]) {
      expect(() => signMessage(alice, { room: ROOM, seq, body })).toThrow(RangeError);
    }
    expect(() => signMessage(alice, { room: ROOM, seq: MAX_SEQ, body })).not.toThrow();
  });

  it.each<[string, Body]>([
    ['guess with repeated digits', { type: 'GUESS', guess: '1123' }],
    ['answer 31', { type: 'ANSWER', index: 0, feedback: 31 }],
    ['answer with dead + injured above 4', { type: 'ANSWER', index: 0, feedback: 32 }],
    ['answer 50', { type: 'ANSWER', index: 0, feedback: 50 }],
    ['answer index 24', { type: 'ANSWER', index: 24, feedback: 0 }],
    ['answer index -1', { type: 'ANSWER', index: -1, feedback: 0 }],
    ['answer index 1.5', { type: 'ANSWER', index: 1.5, feedback: 0 }],
    ['commit with a short tx signature', { type: 'COMMIT', txSig: 'abc' }],
    [
      'reveal with a bad salt',
      { type: 'REVEAL', secret: '1234', saltHex: 'ab', txSig: fakeSig(1) },
    ],
    [
      'reveal with a bad secret',
      { type: 'REVEAL', secret: '12', saltHex: saltOf(1), txSig: fakeSig(1) },
    ],
    ['sync below -1', { type: 'SYNC', received: -2 }],
    ['sync above the limit', { type: 'SYNC', received: MAX_SEQ + 1 }],
    ['hello with an unknown role', { type: 'HELLO', role: 'spectator' as 'host' }],
  ])('refuses to encode: %s', (_name, body) => {
    expect(() => encodeBody(body)).toThrow(RangeError);
  });

  it.each([
    ['HELLO', 'player'],
    ['HELLO', ''],
    ['GUESS', '12345'],
    ['GUESS', '1123'],
    ['GUESS', ' 123'],
    ['ANSWER', '01:11'],
    ['ANSWER', '1:011'],
    ['ANSWER', '1:+11'],
    ['ANSWER', '1:1e1'],
    ['ANSWER', '1:31'],
    ['ANSWER', '24:0'],
    ['ANSWER', '1'],
    ['ANSWER', '1:11:1'],
    ['ANSWER', '99999999999999999999:0'],
    ['SYNC', '-2'],
    ['SYNC', '01'],
    ['SYNC', '256'],
    ['SYNC', '1000'],
    ['SYNC', 'x'],
    ['COMMIT', 'short'],
    ['REVEAL', '1234:abc:def'],
    ['REVEAL', `1234:${saltOf(0xab).toUpperCase()}:${fakeSig(1)}`],
    ['NOPE', 'x'],
  ])('rejects the %s payload %j', (type, payload) => {
    expect(decodeBody(type, payload)).toBeUndefined();
  });

  it('rejects non-string payloads and oversize payloads', () => {
    expect(decodeBody('GUESS', 1234)).toBeUndefined();
    expect(decodeBody('GUESS', undefined)).toBeUndefined();
    expect(decodeBody('GUESS', '1'.repeat(400))).toBeUndefined();
    expect(decodeBody(7, '1234')).toBeUndefined();
  });

  it('accepts every valid feedback value in an ANSWER', () => {
    for (const feedback of [0, 1, 2, 3, 4, 10, 11, 12, 13, 20, 21, 22, 30, 40]) {
      expect(decodeBody('ANSWER', `0:${feedback}`)).toEqual({ type: 'ANSWER', index: 0, feedback });
    }
  });
});

describe('wire parsing', () => {
  const good = signed({ type: 'GUESS', guess: '2604' }, 1);
  const wire = encodeMessage(good);

  it('parses what it encodes', () => {
    expect(parseMessage(wire)).toEqual(good);
    expect(validateEnvelope(good)).toEqual(good);
  });

  it('writes a fixed key order', () => {
    expect(Object.keys(JSON.parse(wire))).toEqual([
      'room',
      'from',
      'seq',
      'type',
      'payload',
      'sig',
    ]);
  });

  it.each([
    ['not JSON', '{nope'],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a JSON string', '"x"'],
    ['an empty object', '{}'],
    ['an extra field', JSON.stringify({ ...good, admin: true })],
    ['a missing field', JSON.stringify({ ...good, sig: undefined })],
    ['a numeric string seq', JSON.stringify({ ...good, seq: '1' })],
    ['a fractional seq', JSON.stringify({ ...good, seq: 1.5 })],
    ['a negative seq', JSON.stringify({ ...good, seq: -1 })],
    ['a seq over the limit', JSON.stringify({ ...good, seq: MAX_SEQ + 1 })],
    ['a bad room', JSON.stringify({ ...good, room: 'abc' })],
    ['a bad sender key', JSON.stringify({ ...good, from: 'abc' })],
    ['a bad signature', JSON.stringify({ ...good, sig: 'abc' })],
    ['an unknown type', JSON.stringify({ ...good, type: 'KICK' })],
    ['a payload that does not fit the type', JSON.stringify({ ...good, payload: 'xyz' })],
    ['an oversize message', ' '.repeat(MAX_RAW_LENGTH + 1) + wire],
  ])('rejects %s', (_name, raw) => {
    expect(parseMessage(raw)).toBeUndefined();
    expect(openMessage(raw)).toBeUndefined();
  });

  it('rejects a __proto__ smuggling attempt and leaves prototypes untouched', () => {
    const raw = `{"__proto__":{"polluted":true},"room":"${ROOM}"}`;
    expect(parseMessage(raw)).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects non-string input', () => {
    for (const bad of [undefined, null, 5, {}, []]) expect(parseMessage(bad)).toBeUndefined();
  });

  it('parses but refuses to open a forged message', () => {
    const forged = encodeMessage({ ...good, payload: '4321' });
    expect(parseMessage(forged)).toBeDefined();
    expect(openMessage(forged)).toBeUndefined();
  });

  it('validateEnvelope strips nothing and returns a clean copy', () => {
    const copy = validateEnvelope({ ...good });
    expect(copy).toEqual(good);
    expect(copy).not.toBe(good);
  });
});

describe('identities', () => {
  it('generates distinct valid identities that can sign', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    expect(a.publicKey).not.toBe(b.publicKey);
    const message = signMessage(a, { room: ROOM, seq: 0, body: { type: 'HELLO', role: 'host' } });
    expect(verifyMessage(message)).toBe(true);
  });

  it('rebuilds the same identity from its secret key', () => {
    const again = identityFromSecretKey(alice.secretKey);
    expect(again.publicKey).toBe(alice.publicKey);
    expect(again.secretKey).not.toBe(alice.secretKey);
  });

  it('rejects a secret key of the wrong size or with mismatched halves', () => {
    expect(() => identityFromSecretKey(new Uint8Array(32))).toThrow(/64 bytes/);
    expect(() => identityFromSecretKey([1, 2] as unknown as Uint8Array)).toThrow(RangeError);
    const mismatched = Uint8Array.from(alice.secretKey);
    mismatched[40] = (mismatched[40] as number) ^ 1;
    expect(() => identityFromSecretKey(mismatched)).toThrow(/does not match/);
  });

  it('does not expose the input key array it was given', () => {
    const key = Uint8Array.from(alice.secretKey);
    const identity = identityFromSecretKey(key);
    key.fill(0);
    expect(identity.secretKey[0]).toBe(alice.secretKey[0]);
  });
});
