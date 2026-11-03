import { describe, expect, it } from 'vitest';
import type { MemoTx } from '../src/index.js';
import {
  encodeCommitMemo,
  encodeRevealMemo,
  parseMemo,
  selectCommit,
  selectReveal,
} from '../src/index.js';
import { fakeSig, identityFromByte, saltOf } from './helpers.js';

const C1 = '525d7b2d31149cd7453b079bbaa25f6e170652683c478f5e06d19717f9ba7f15';
const C2 = 'ab'.repeat(32);
const SALT = '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f';
const T = 'cd'.repeat(32);

describe('Memo encoding (PRD section 6.2)', () => {
  it('writes the exact published records', () => {
    expect(encodeCommitMemo('ABC234', C1)).toBe(`ACC1|ABC234|C|${C1}`);
    expect(encodeRevealMemo('ABC234', '1234', SALT)).toBe(`ACC1|ABC234|R|1234|${SALT}`);
  });

  it('has the documented sizes: 78, 83 and 148 bytes', () => {
    expect(new TextEncoder().encode(encodeCommitMemo('ABC234', C1))).toHaveLength(78);
    expect(new TextEncoder().encode(encodeRevealMemo('ABC234', '1234', SALT))).toHaveLength(83);
    expect(new TextEncoder().encode(encodeRevealMemo('ABC234', '1234', SALT, T))).toHaveLength(148);
  });

  it('appends the transcript hash when given', () => {
    expect(encodeRevealMemo('ABC234', '1234', SALT, T)).toBe(`ACC1|ABC234|R|1234|${SALT}|${T}`);
  });

  it.each([
    ['bad room', () => encodeCommitMemo('abc234', C1)],
    ['short commitment', () => encodeCommitMemo('ABC234', 'ab')],
    ['uppercase commitment', () => encodeCommitMemo('ABC234', C1.toUpperCase())],
    ['reveal bad room', () => encodeRevealMemo('ABC', '1234', SALT)],
    ['secret too short', () => encodeRevealMemo('ABC234', '123', SALT)],
    ['secret not digits', () => encodeRevealMemo('ABC234', 'abcd', SALT)],
    ['bad salt', () => encodeRevealMemo('ABC234', '1234', 'zz')],
    ['bad transcript hash', () => encodeRevealMemo('ABC234', '1234', SALT, 'nope')],
  ])('refuses to write: %s', (_name, write) => {
    expect(write).toThrow(RangeError);
  });

  it('can record a repeated-digit secret, so a cheating reveal can still be published', () => {
    expect(encodeRevealMemo('ABC234', '1123', SALT)).toBe(`ACC1|ABC234|R|1123|${SALT}`);
  });
});

describe('parseMemo', () => {
  it('round-trips every form', () => {
    expect(parseMemo(encodeCommitMemo('ABC234', C1))).toEqual({
      kind: 'commit',
      room: 'ABC234',
      commitment: C1,
    });
    expect(parseMemo(encodeRevealMemo('ABC234', '1234', SALT))).toEqual({
      kind: 'reveal',
      room: 'ABC234',
      secret: '1234',
      salt: SALT,
    });
    expect(parseMemo(encodeRevealMemo('ABC234', '1234', SALT, T))).toEqual({
      kind: 'reveal',
      room: 'ABC234',
      secret: '1234',
      salt: SALT,
      transcriptHash: T,
    });
  });

  it.each([
    ['empty', ''],
    ['wrong prefix', `ACC2|ABC234|C|${C1}`],
    ['lowercase prefix', `acc1|ABC234|C|${C1}`],
    ['bad room', `ACC1|abc234|C|${C1}`],
    ['unknown kind', `ACC1|ABC234|X|${C1}`],
    ['commit missing hash', 'ACC1|ABC234|C'],
    ['commit short hash', `ACC1|ABC234|C|${C1.slice(2)}`],
    ['commit uppercase hex', `ACC1|ABC234|C|${C1.toUpperCase()}`],
    ['commit extra field', `ACC1|ABC234|C|${C1}|x`],
    ['commit trailing pipe', `ACC1|ABC234|C|${C1}|`],
    ['commit leading space', ` ACC1|ABC234|C|${C1}`],
    ['commit trailing newline', `ACC1|ABC234|C|${C1}\n`],
    ['commit non-hex', `ACC1|ABC234|C|${'g'.repeat(64)}`],
    ['reveal missing salt', 'ACC1|ABC234|R|1234'],
    ['reveal short secret', `ACC1|ABC234|R|123|${SALT}`],
    ['reveal letters in secret', `ACC1|ABC234|R|12a4|${SALT}`],
    ['reveal bad salt', `ACC1|ABC234|R|1234|${SALT.slice(2)}`],
    ['reveal bad transcript hash', `ACC1|ABC234|R|1234|${SALT}|${T.slice(2)}`],
    ['reveal too many fields', `ACC1|ABC234|R|1234|${SALT}|${T}|x`],
    ['reveal empty transcript hash', `ACC1|ABC234|R|1234|${SALT}|`],
    ['far too long', 'A'.repeat(5000)],
  ])('rejects: %s', (_name, text) => {
    expect(parseMemo(text)).toBeUndefined();
  });

  it('rejects non-strings', () => {
    for (const bad of [undefined, null, 12, {}, ['ACC1']]) expect(parseMemo(bad)).toBeUndefined();
  });

  it('parses a reveal with a repeated-digit secret; validity is decided at finalisation', () => {
    expect(parseMemo(`ACC1|ABC234|R|1123|${SALT}`)).toMatchObject({ secret: '1123' });
  });
});

const alice = identityFromByte(1).publicKey;
const bob = identityFromByte(2).publicKey;

function tx(over: Partial<MemoTx> & { text: string }): MemoTx {
  return { sig: fakeSig(1), signer: alice, slot: 100, blockTime: 1_700_000_000, ok: true, ...over };
}

describe('selectCommit: the earliest commit counts', () => {
  const commit1 = `ACC1|ABC234|C|${C1}`;
  const commit2 = `ACC1|ABC234|C|${C2}`;

  it('returns undefined when there is no commit', () => {
    expect(selectCommit([], 'ABC234', alice)).toBeUndefined();
  });

  it('finds a single commit', () => {
    const t = tx({ text: commit1 });
    expect(selectCommit([t], 'ABC234', alice)).toEqual({
      commitment: C1,
      tx: t,
      equivocated: false,
    });
  });

  it('treats a retry of the same commit as harmless', () => {
    const result = selectCommit(
      [
        tx({ text: commit1, sig: fakeSig(1), slot: 100 }),
        tx({ text: commit1, sig: fakeSig(2), slot: 103 }),
      ],
      'ABC234',
      alice,
    );
    expect(result?.equivocated).toBe(false);
    expect(result?.tx.slot).toBe(100);
  });

  it('a different later commit is equivocation, and the earlier one still counts', () => {
    const result = selectCommit(
      [
        tx({ text: commit2, sig: fakeSig(2), slot: 105 }),
        tx({ text: commit1, sig: fakeSig(1), slot: 100 }),
      ],
      'ABC234',
      alice,
    );
    expect(result).toMatchObject({ commitment: C1, equivocated: true });
  });

  it('is not affected by the order the transactions are listed in', () => {
    const a = tx({ text: commit1, sig: fakeSig(1), slot: 100 });
    const b = tx({ text: commit2, sig: fakeSig(2), slot: 100 });
    const forward = selectCommit([a, b], 'ABC234', alice);
    const backward = selectCommit([b, a], 'ABC234', alice);
    expect(forward).toEqual(backward);
    expect(forward?.equivocated).toBe(true);
  });

  it('ignores failed transactions', () => {
    const failed = tx({ text: commit1, ok: false });
    expect(selectCommit([failed], 'ABC234', alice)).toBeUndefined();
    const result = selectCommit(
      [failed, tx({ text: commit2, sig: fakeSig(2), slot: 200 })],
      'ABC234',
      alice,
    );
    expect(result).toMatchObject({ commitment: C2, equivocated: false });
  });

  it('ignores another signer, another room, reveals and junk', () => {
    const others = [
      tx({ text: commit1, signer: bob }),
      tx({ text: `ACC1|ZZZ999|C|${C1}` }),
      tx({ text: `ACC1|ABC234|R|1234|${SALT}` }),
      tx({ text: 'hello world' }),
    ];
    expect(selectCommit(others, 'ABC234', alice)).toBeUndefined();
  });

  it('a commit by someone else cannot make the player look like an equivocator', () => {
    const result = selectCommit(
      [tx({ text: commit1 }), tx({ text: commit2, signer: bob, sig: fakeSig(5) })],
      'ABC234',
      alice,
    );
    expect(result).toMatchObject({ commitment: C1, equivocated: false });
  });
});

describe('selectReveal: the earliest reveal counts', () => {
  const reveal = `ACC1|ABC234|R|1234|${SALT}`;
  const other = `ACC1|ABC234|R|4321|${saltOf(7)}`;
  const withHash = `ACC1|ABC234|R|1234|${SALT}|${T}`;

  it('returns undefined when there is none', () => {
    expect(selectReveal([tx({ text: `ACC1|ABC234|C|${C1}` })], 'ABC234', alice)).toBeUndefined();
  });

  it('finds one reveal, with or without the transcript hash', () => {
    expect(selectReveal([tx({ text: reveal })], 'ABC234', alice)).toMatchObject({
      reveal: { secret: '1234', salt: SALT },
      conflicting: false,
    });
    expect(selectReveal([tx({ text: withHash })], 'ABC234', alice)?.reveal.transcriptHash).toBe(T);
  });

  it('identical repeats are harmless', () => {
    const result = selectReveal(
      [tx({ text: reveal, sig: fakeSig(1) }), tx({ text: reveal, sig: fakeSig(2), slot: 101 })],
      'ABC234',
      alice,
    );
    expect(result?.conflicting).toBe(false);
  });

  it.each([
    ['a different secret and salt', other],
    ['the same secret with a transcript hash added', withHash],
  ])('%s later is a conflict', (_name, later) => {
    const result = selectReveal(
      [
        tx({ text: reveal, sig: fakeSig(1), slot: 100 }),
        tx({ text: later, sig: fakeSig(2), slot: 110 }),
      ],
      'ABC234',
      alice,
    );
    expect(result).toMatchObject({ conflicting: true, reveal: { secret: '1234' } });
  });

  it('a different salt alone is a conflict', () => {
    const result = selectReveal(
      [
        tx({ text: reveal, sig: fakeSig(1), slot: 100 }),
        tx({ text: `ACC1|ABC234|R|1234|${saltOf(1)}`, sig: fakeSig(2), slot: 101 }),
      ],
      'ABC234',
      alice,
    );
    expect(result?.conflicting).toBe(true);
  });

  it('ignores failed, foreign and wrong-room records', () => {
    const txs = [
      tx({ text: reveal, ok: false }),
      tx({ text: reveal, signer: bob }),
      tx({ text: `ACC1|ZZZ999|R|1234|${SALT}` }),
    ];
    expect(selectReveal(txs, 'ABC234', alice)).toBeUndefined();
  });
});
