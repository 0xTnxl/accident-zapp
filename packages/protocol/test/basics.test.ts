import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ROOM_ALPHABET,
  ROOM_LENGTH,
  assertRoom,
  bytesToHex,
  concatBytes,
  decodeBase58,
  generateRoomCode,
  generateSaltHex,
  hexToBytes,
  isHex,
  isValidPublicKey,
  isValidRoom,
  isValidSignature,
  randomBytes,
  sha256Hex,
  utf8,
} from '../src/index.js';
import { fakeSig, identityFromByte } from './helpers.js';
import bs58 from 'bs58';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hex and bytes', () => {
  it('round-trips', () => {
    const bytes = Uint8Array.from([0, 1, 15, 16, 254, 255]);
    expect(bytesToHex(bytes)).toBe('00010f10feff');
    expect(hexToBytes('00010f10feff')).toEqual(bytes);
    expect(hexToBytes('')).toEqual(new Uint8Array(0));
  });

  it.each(['0G', 'abc', 'ABCD', '0x12', ' 12', '12\n'])('hexToBytes rejects %j', (bad) => {
    expect(() => hexToBytes(bad)).toThrow(RangeError);
  });

  it('isHex checks case, length and type', () => {
    expect(isHex('ab'.repeat(32), 32)).toBe(true);
    expect(isHex('AB'.repeat(32), 32)).toBe(false);
    expect(isHex('ab'.repeat(31), 32)).toBe(false);
    expect(isHex(123, 32)).toBe(false);
    expect(isHex(undefined, 32)).toBe(false);
  });

  it('concatBytes joins parts in order', () => {
    expect(concatBytes(Uint8Array.of(1, 2), new Uint8Array(0), Uint8Array.of(3))).toEqual(
      Uint8Array.of(1, 2, 3),
    );
  });

  it('sha256Hex matches known vectors', async () => {
    expect(await sha256Hex(utf8(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256Hex(utf8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('utf8 encodes multi-byte characters', () => {
    expect(utf8('é')).toEqual(Uint8Array.of(0xc3, 0xa9));
  });

  it('randomBytes gives the requested length and varies', () => {
    expect(randomBytes(16)).toHaveLength(16);
    expect(bytesToHex(randomBytes(32))).not.toBe(bytesToHex(randomBytes(32)));
  });

  it('throws rather than degrade when WebCrypto is missing', async () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => randomBytes(8)).toThrow(/WebCrypto/);
    await expect(sha256Hex(utf8('x'))).rejects.toThrow(/WebCrypto/);
    vi.stubGlobal('crypto', { subtle: {} });
    expect(() => randomBytes(8)).toThrow(/WebCrypto/);
  });
});

describe('room codes', () => {
  it('uses 32 unambiguous characters', () => {
    expect(ROOM_ALPHABET).toHaveLength(32);
    expect(new Set(ROOM_ALPHABET).size).toBe(32);
    for (const banned of '01IO') expect(ROOM_ALPHABET).not.toContain(banned);
  });

  it('generates valid, varied codes using the whole alphabet', () => {
    const seen = new Set<string>();
    const chars = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(ROOM_LENGTH);
      expect(isValidRoom(code)).toBe(true);
      seen.add(code);
      for (const c of code) chars.add(c);
    }
    expect(seen.size).toBeGreaterThan(2990);
    expect(chars.size).toBe(32);
  });

  it.each(['ABC23', 'ABC2345', 'abc234', 'ABC0O1', 'ABC 23', 'ABC23\n', '', 'ÀBC234'])(
    'rejects %j',
    (bad) => {
      expect(isValidRoom(bad)).toBe(false);
      expect(() => assertRoom(bad)).toThrow(RangeError);
    },
  );

  it('rejects non-strings and accepts the PRD example', () => {
    expect(isValidRoom(123456)).toBe(false);
    expect(isValidRoom(null)).toBe(false);
    expect(assertRoom('ABC234')).toBe('ABC234');
  });

  it('salts are 64 hex characters', () => {
    expect(generateSaltHex()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('base58 helpers', () => {
  const key = identityFromByte(1).publicKey;

  it('accepts canonical 32 and 64 byte values', () => {
    expect(isValidPublicKey(key)).toBe(true);
    expect(isValidSignature(fakeSig(3))).toBe(true);
    expect(decodeBase58(key, 32)).toHaveLength(32);
  });

  it('keeps leading zero bytes', () => {
    const zeros = bs58.encode(new Uint8Array(32));
    expect(zeros).toBe('1'.repeat(32));
    expect(isValidPublicKey(zeros)).toBe(true);
  });

  it.each([
    ['a signature is not a key', fakeSig(3), 'key'],
    ['a key is not a signature', key, 'sig'],
    ['invalid characters', '0OIl'.repeat(10), 'key'],
    ['empty', '', 'key'],
    ['far too long', 'A'.repeat(200), 'key'],
    ['a number', 12345, 'key'],
    ['null', null, 'sig'],
  ])('rejects: %s', (_name, value, kind) => {
    expect(kind === 'key' ? isValidPublicKey(value) : isValidSignature(value)).toBe(false);
  });
});
