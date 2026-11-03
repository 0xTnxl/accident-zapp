import { isHex } from './bytes.js';
import { assertRoom, isValidRoom } from './ids.js';

/** Version prefix shared by Memo records and relay messages. */
export const PROTOCOL_PREFIX = 'ACC1';

export interface CommitMemo {
  kind: 'commit';
  room: string;
  /** 64 lowercase hex characters. */
  commitment: string;
}

export interface RevealMemo {
  kind: 'reveal';
  room: string;
  /** Four digits. Format only: whether it is a valid code is decided at finalisation. */
  secret: string;
  /** 64 lowercase hex characters. */
  salt: string;
  /** 64 lowercase hex characters. Absent in the v1.1 form of the record. */
  transcriptHash?: string;
}

export type ParsedMemo = CommitMemo | RevealMemo;

const SECRET_FORMAT = /^[0-9]{4}$/;

/** `ACC1|<room>|C|<commitment hex>` */
export function encodeCommitMemo(room: string, commitmentHex: string): string {
  assertRoom(room);
  if (!isHex(commitmentHex, 32)) throw new RangeError('Invalid commitment');
  return `${PROTOCOL_PREFIX}|${room}|C|${commitmentHex}`;
}

/**
 * `ACC1|<room>|R|<secret>|<salt hex>` plus `|<transcript hash hex>` when given.
 * The secret must be four digits; whether it is a valid code is checked at finalisation,
 * so a cheater's invalid reveal can still be recorded and judged.
 */
export function encodeRevealMemo(
  room: string,
  secret: string,
  saltHex: string,
  transcriptHashHex?: string,
): string {
  assertRoom(room);
  if (!SECRET_FORMAT.test(secret)) throw new RangeError('Invalid secret format');
  if (!isHex(saltHex, 32)) throw new RangeError('Invalid salt');
  const base = `${PROTOCOL_PREFIX}|${room}|R|${secret}|${saltHex}`;
  if (transcriptHashHex === undefined) return base;
  if (!isHex(transcriptHashHex, 32)) throw new RangeError('Invalid transcript hash');
  return `${base}|${transcriptHashHex}`;
}

/**
 * Strict parser. Returns `undefined` for anything that is not exactly a commit or reveal record:
 * wrong prefix, bad room, uppercase hex, extra or missing fields, whitespace, wrong lengths.
 */
export function parseMemo(text: unknown): ParsedMemo | undefined {
  if (typeof text !== 'string' || text.length > 200) return undefined;
  const parts = text.split('|');
  const [prefix, room, kind] = parts;
  if (prefix !== PROTOCOL_PREFIX || !isValidRoom(room)) return undefined;

  if (kind === 'C') {
    if (parts.length !== 4 || !isHex(parts[3], 32)) return undefined;
    return { kind: 'commit', room, commitment: parts[3] };
  }

  if (kind === 'R') {
    if (parts.length !== 5 && parts.length !== 6) return undefined;
    const [, , , secret, salt, transcriptHash] = parts;
    if (secret === undefined || !SECRET_FORMAT.test(secret) || !isHex(salt, 32)) return undefined;
    if (parts.length === 5) return { kind: 'reveal', room, secret, salt };
    if (!isHex(transcriptHash, 32)) return undefined;
    return { kind: 'reveal', room, secret, salt, transcriptHash };
  }

  return undefined;
}

/** A Memo transaction as read back from the chain. The chain adapter fills this in. */
export interface MemoTx {
  /** Transaction signature, base58. */
  sig: string;
  /** Fee payer / signer of the transaction, base58. */
  signer: string;
  /** The Memo instruction text. */
  text: string;
  slot: number;
  /** Unix seconds, or null when the cluster has no block time yet. */
  blockTime: number | null;
  /** False when the transaction failed on-chain. Failed transactions never count. */
  ok: boolean;
}

export interface CanonicalCommit {
  commitment: string;
  tx: MemoTx;
  /** True if the same signer posted a different commitment for this room. That is a fault. */
  equivocated: boolean;
}

export interface CanonicalReveal {
  reveal: RevealMemo;
  tx: MemoTx;
  /** True if the same signer posted a different reveal for this room. That is a fault. */
  conflicting: boolean;
}

function byLanding(a: MemoTx, b: MemoTx): number {
  return a.slot - b.slot || (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0);
}

function relevant(txs: readonly MemoTx[], room: string, signer: string): MemoTx[] {
  return txs.filter((tx) => tx.ok && tx.signer === signer).sort(byLanding);
}

/**
 * The commit record that counts for `signer` in `room`: the earliest successful one.
 * Retries that repeat the same commitment are harmless. A different commitment from the same
 * signer in the same room sets `equivocated`. Returns `undefined` if there is no commit yet.
 */
export function selectCommit(
  txs: readonly MemoTx[],
  room: string,
  signer: string,
): CanonicalCommit | undefined {
  const commits: Array<{ tx: MemoTx; commitment: string }> = [];
  for (const tx of relevant(txs, room, signer)) {
    const memo = parseMemo(tx.text);
    if (memo?.kind === 'commit' && memo.room === room)
      commits.push({ tx, commitment: memo.commitment });
  }
  const first = commits[0];
  if (!first) return undefined;
  return {
    commitment: first.commitment,
    tx: first.tx,
    equivocated: commits.some((c) => c.commitment !== first.commitment),
  };
}

/**
 * The reveal record that counts for `signer` in `room`: the earliest successful one.
 * Identical repeats are harmless; a differing reveal sets `conflicting`.
 */
export function selectReveal(
  txs: readonly MemoTx[],
  room: string,
  signer: string,
): CanonicalReveal | undefined {
  const reveals: Array<{ tx: MemoTx; reveal: RevealMemo }> = [];
  for (const tx of relevant(txs, room, signer)) {
    const memo = parseMemo(tx.text);
    if (memo?.kind === 'reveal' && memo.room === room) reveals.push({ tx, reveal: memo });
  }
  const first = reveals[0];
  if (!first) return undefined;
  const same = (a: RevealMemo, b: RevealMemo): boolean =>
    a.secret === b.secret && a.salt === b.salt && a.transcriptHash === b.transcriptHash;
  return {
    reveal: first.reveal,
    tx: first.tx,
    conflicting: reveals.some((r) => !same(r.reveal, first.reveal)),
  };
}
