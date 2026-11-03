import {
  type Chain,
  type Identity,
  type MemoTx,
  ROOM_ALPHABET,
  ROOM_LENGTH,
  bytesToHex,
  hexToBytes,
  sha256,
  sha256Hex,
  utf8,
} from '@accident/protocol';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

/**
 * A Zend-backed {@link Chain}: the same commit/reveal record Accident kept in Solana Memos, with no
 * chain and no fees.
 *
 * Each record is the Memo text signed by the player's per-game key. The signature doubles as the
 * record's id (a 64-byte value, so it passes the protocol's signature checks unchanged). Records
 * live in the interaction's data; tamper-evidence comes from a Zend attestation receipt over
 * `sha256("accident-memo-v1|" + signer + "|" + text)`, whose id gives the landing order the
 * protocol's "earliest record counts" rules need.
 *
 * A record counts only when (1) the game-key signature verifies and (2) a matching receipt exists
 * for this interaction (and, when `zendPublicKey` is given, Zend's receipt signature verifies).
 */

export interface AttestReceipt {
  id: number;
  app: string;
  app_user_id: string;
  interaction_id: string;
  label: string;
  data_hash: string;
  prev_hash: string;
  unix_ms: number;
  receipt_hash: string;
  signature: string;
}

/** The parts of `@zend/appkit` (and a receipts fetch) this adapter needs. */
export interface ZendPort {
  attest(p: { label: string; dataHash: string; interactionId: string }): Promise<AttestReceipt>;
  getInteraction(id: string): Promise<{ state: string; data: Record<string, unknown> }>;
  /** Shallow-merges `data` without changing state. */
  mergeData(id: string, state: string, data: Record<string, unknown>, idempotencyKey: string): Promise<void>;
  /** Public receipts for the interaction, oldest first (`GET /apps/attest/interactions/:id`). */
  receipts(interactionId: string): Promise<AttestReceipt[]>;
}

export interface ZendChainOptions {
  port: ZendPort;
  interactionId: string;
  /** Hex Ed25519 key from `GET /apps/attest/key`. When set, every receipt is checked against it. */
  zendPublicKey?: string;
}

interface StoredRecord {
  text: string;
  signer: string;
}

const RECORD_PREFIX = 'm:';
const MEMO_TAG = 'accident-memo-v1';

/** The 6-character room code for an interaction (stable, from its id). */
export async function roomForInteraction(interactionId: string): Promise<string> {
  const digest = await sha256(utf8(`accident-room-v1|${interactionId}`));
  let room = '';
  for (let i = 0; i < ROOM_LENGTH; i++) room += ROOM_ALPHABET[(digest[i] ?? 0) % ROOM_ALPHABET.length];
  return room;
}

export async function memoHash(signer: string, text: string): Promise<string> {
  return sha256Hex(utf8(`${MEMO_TAG}|${signer}|${text}`));
}

/** Rebuilds Zend's receipt bytes (format `zend-attest-v1`) and checks hash and signature. */
export async function verifyReceipt(r: AttestReceipt, zendPublicKeyHex: string): Promise<boolean> {
  try {
    const be = (n: number): Uint8Array => {
      const out = new Uint8Array(8);
      new DataView(out.buffer).setBigUint64(0, BigInt(n));
      return out;
    };
    const zero = new Uint8Array([0]);
    const parts = [
      utf8('zend-attest-v1'), be(r.id),
      utf8(r.app), zero, utf8(r.app_user_id), zero, utf8(r.interaction_id), zero, utf8(r.label), zero,
      hexToBytes(r.data_hash), hexToBytes(r.prev_hash), be(r.unix_ms),
    ];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      bytes.set(p, o);
      o += p.length;
    }
    const hash = await sha256(bytes);
    if (bytesToHex(hash) !== r.receipt_hash) return false;
    return nacl.sign.detached.verify(hash, hexToBytes(r.signature), hexToBytes(zendPublicKeyHex));
  } catch {
    return false;
  }
}

export class ZendChain implements Chain {
  private readonly port: ZendPort;
  private readonly interactionId: string;
  private readonly zendPublicKey: string | undefined;

  constructor(options: ZendChainOptions) {
    this.port = options.port;
    this.interactionId = options.interactionId;
    this.zendPublicKey = options.zendPublicKey;
  }

  /**
   * Records which Zend player owns this game key (receipt `app_user_id`), so the verifier can show
   * names next to seats. Call once per game before committing.
   */
  async bindKey(identity: Identity): Promise<AttestReceipt> {
    return this.port.attest({
      label: 'key',
      dataHash: await sha256Hex(utf8(`accident-key-v1|${identity.publicKey}`)),
      interactionId: this.interactionId,
    });
  }

  async sendMemo(signer: Identity, text: string): Promise<string> {
    // Ed25519 is deterministic, so a retry of the same text yields the same id and overwrites
    // the same key instead of creating a second record.
    const sig = bs58.encode(nacl.sign.detached(utf8(text), signer.secretKey));
    const record: StoredRecord = { text, signer: signer.publicKey };
    const current = await this.port.getInteraction(this.interactionId);
    await this.port.mergeData(this.interactionId, current.state, { [RECORD_PREFIX + sig]: record }, `memo:${sig}`);
    await this.port.attest({
      label: 'memo',
      dataHash: await memoHash(signer.publicKey, text),
      interactionId: this.interactionId,
    });
    return sig;
  }

  async getMemoTx(sig: string): Promise<MemoTx | null> {
    const all = await this.load();
    return all.find((tx) => tx.sig === sig) ?? null;
  }

  async listMemoTxs(address: string, room: string): Promise<MemoTx[]> {
    const all = await this.load();
    return all.filter((tx) => tx.signer === address && tx.text.includes(`|${room}|`));
  }

  /** Every record that has a valid game-key signature and a matching (verified) receipt. */
  private async load(): Promise<MemoTx[]> {
    const [interaction, receipts] = await Promise.all([
      this.port.getInteraction(this.interactionId),
      this.port.receipts(this.interactionId),
    ]);
    const firstReceipt = new Map<string, AttestReceipt>();
    for (const r of [...receipts].sort((a, b) => a.id - b.id)) {
      if (r.label !== 'memo' || r.interaction_id !== this.interactionId) continue;
      if (this.zendPublicKey !== undefined && !(await verifyReceipt(r, this.zendPublicKey))) continue;
      if (!firstReceipt.has(r.data_hash)) firstReceipt.set(r.data_hash, r);
    }
    const out: MemoTx[] = [];
    for (const [key, value] of Object.entries(interaction.data ?? {})) {
      if (!key.startsWith(RECORD_PREFIX)) continue;
      const rec = value as Partial<StoredRecord> | null;
      if (typeof rec?.text !== 'string' || typeof rec.signer !== 'string') continue;
      const sig = key.slice(RECORD_PREFIX.length);
      if (!validSignature(sig, rec.text, rec.signer)) continue;
      const receipt = firstReceipt.get(await memoHash(rec.signer, rec.text));
      if (!receipt) continue; // not "confirmed" until Zend has a receipt
      out.push({
        sig,
        signer: rec.signer,
        text: rec.text,
        slot: receipt.id,
        blockTime: Math.floor(receipt.unix_ms / 1000),
        ok: true,
      });
    }
    return out.sort((a, b) => a.slot - b.slot || (a.sig < b.sig ? -1 : 1));
  }
}

function validSignature(sigB58: string, text: string, signerB58: string): boolean {
  try {
    const sig = bs58.decode(sigB58);
    const key = bs58.decode(signerB58);
    return sig.length === 64 && key.length === 32 && nacl.sign.detached.verify(utf8(text), sig, key);
  } catch {
    return false;
  }
}
