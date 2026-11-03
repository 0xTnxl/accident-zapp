import { mulberry32, randomCode } from '@accident/engine';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import {
  COMMITMENT_TAG,
  bytesToHex,
  commitment,
  generateSaltHex,
  verifyCommitment,
} from '../src/index.js';
import { nodeCommitment, saltOf } from './helpers.js';

// PRD Appendix A.2
const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i);
const SALT_BYTES = Uint8Array.from({ length: 32 }, (_, i) => 32 + i);
const PLAYER = bs58.encode(KEY_BYTES);
const SALT = bytesToHex(SALT_BYTES);
const VECTOR = {
  room: 'ABC234',
  playerKey: PLAYER,
  secret: '1234',
  saltHex: SALT,
};
const EXPECTED = '525d7b2d31149cd7453b079bbaa25f6e170652683c478f5e06d19717f9ba7f15';

describe('commitment (PRD A.2 vector)', () => {
  it('reproduces the published hash', async () => {
    expect(SALT).toBe('202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f');
    expect(await commitment(VECTOR)).toBe(EXPECTED);
  });

  it('matches an independent Node crypto calculation', () => {
    expect(nodeCommitment('ABC234', PLAYER, '1234', SALT)).toBe(EXPECTED);
  });

  it('uses the documented tag', () => {
    expect(COMMITMENT_TAG).toBe('ACCIDENT_V1');
  });

  it('matches the independent calculation for random inputs', async () => {
    const rng = mulberry32(31337);
    for (let i = 0; i < 200; i++) {
      const room = Array.from(
        { length: 6 },
        () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(rng() * 32)],
      ).join('');
      const key = bs58.encode(Uint8Array.from({ length: 32 }, () => Math.floor(rng() * 256)));
      const secret = randomCode(rng);
      const salt = bytesToHex(Uint8Array.from({ length: 32 }, () => Math.floor(rng() * 256)));
      expect(await commitment({ room, playerKey: key, secret, saltHex: salt })).toBe(
        nodeCommitment(room, key, secret, salt),
      );
    }
  });
});

describe('commitment binds every input', () => {
  const others = {
    secret: '1243',
    saltHex: saltOf(7),
    room: 'ABC235',
    playerKey: bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => 100 + i)),
  };

  it.each(['secret', 'saltHex', 'room', 'playerKey'] as const)(
    'changing the %s changes the commitment',
    async (field) => {
      const changed = await commitment({ ...VECTOR, [field]: others[field] });
      expect(changed).not.toBe(EXPECTED);
    },
  );

  it('a secret with the same digits in another order differs', async () => {
    const a = await commitment({ ...VECTOR, secret: '1234' });
    const b = await commitment({ ...VECTOR, secret: '4321' });
    expect(a).not.toBe(b);
  });

  it('is 64 lowercase hex characters', async () => {
    expect(await commitment(VECTOR)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('commitment rejects malformed input', () => {
  it.each([
    ['room too short', { room: 'ABC23' }],
    ['room with ambiguous characters', { room: 'ABC0O1' }],
    ['lowercase room', { room: 'abc234' }],
    ['player key not base58', { playerKey: '0OIl' }],
    ['player key too short', { playerKey: bs58.encode(new Uint8Array(31)) }],
    ['player key too long', { playerKey: bs58.encode(new Uint8Array(33)) }],
    ['empty player key', { playerKey: '' }],
    ['secret with repeated digits', { secret: '1123' }],
    ['secret not digits', { secret: 'abcd' }],
    ['secret too short', { secret: '123' }],
    ['salt too short', { saltHex: '00' }],
    ['salt uppercase', { saltHex: SALT.toUpperCase() }],
    ['salt not hex', { saltHex: 'z'.repeat(64) }],
  ])('%s', async (_name, override) => {
    await expect(commitment({ ...VECTOR, ...override })).rejects.toThrow(RangeError);
  });
});

describe('verifyCommitment', () => {
  it('accepts the right reveal', async () => {
    expect(await verifyCommitment(VECTOR, EXPECTED)).toBe(true);
  });

  it.each([
    ['wrong secret', { secret: '1243' }],
    ['wrong salt', { saltHex: saltOf(9) }],
    ['wrong room', { room: 'ZZZ999' }],
    ['wrong player key', { playerKey: bs58.encode(new Uint8Array(32).fill(9)) }],
  ])('rejects a %s', async (_name, override) => {
    expect(await verifyCommitment({ ...VECTOR, ...override }, EXPECTED)).toBe(false);
  });

  it('returns false, never throws, on malformed input or malformed expected hash', async () => {
    expect(await verifyCommitment({ ...VECTOR, secret: '1123' }, EXPECTED)).toBe(false);
    expect(await verifyCommitment(VECTOR, EXPECTED.toUpperCase())).toBe(false);
    expect(await verifyCommitment(VECTOR, 'abc')).toBe(false);
    expect(await verifyCommitment(VECTOR, '')).toBe(false);
  });
});

describe('generateSaltHex', () => {
  it('gives 64 hex characters and never repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const salt = generateSaltHex();
      expect(salt).toMatch(/^[0-9a-f]{64}$/);
      seen.add(salt);
    }
    expect(seen.size).toBe(500);
  });
});
