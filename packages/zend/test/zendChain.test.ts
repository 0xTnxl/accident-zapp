import { candidatesFromHistory, chooseGuess, mulberry32 } from '@accident/engine';
import type { Code } from '@accident/engine';
import type { Identity, SessionView } from '@accident/protocol';
import { Session, bytesToHex, generateIdentity, generateSaltHex, hexToBytes, isValidRoom, isValidSignature, selectCommit } from '@accident/protocol';
import { ManualClock, MemoryHub, MemoryStorage } from '@accident/protocol/testing';
import { createHash, webcrypto } from 'node:crypto';
import nacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AttestReceipt, type ZendPort, ZendChain, roomForInteraction, verifyReceipt } from '../src/index.js';

/** In-memory Zend: one interaction's data plus a signed, chained receipt log (zend-attest-v1). */
class FakeZend implements ZendPort {
  readonly key = nacl.sign.keyPair();
  readonly data: Record<string, unknown> = {};
  readonly log: AttestReceipt[] = [];
  state = 'accepted';
  constructor(readonly user: string) {}

  async attest(p: { label: string; dataHash: string; interactionId: string }): Promise<AttestReceipt> {
    const id = this.log.length + 1;
    const prev = this.log.at(-1)?.receipt_hash ?? '0'.repeat(64);
    const unix_ms = 1_700_000_000_000 + id;
    const r = { id, app: 'accident', app_user_id: this.user, interaction_id: p.interactionId, label: p.label,
      data_hash: p.dataHash, prev_hash: prev, unix_ms, receipt_hash: '', signature: '' };
    const be = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
    const z = Buffer.from([0]);
    const bytes = Buffer.concat([Buffer.from('zend-attest-v1'), be(id), Buffer.from(r.app), z, Buffer.from(r.app_user_id), z,
      Buffer.from(r.interaction_id), z, Buffer.from(r.label), z, Buffer.from(r.data_hash, 'hex'), Buffer.from(prev, 'hex'), be(unix_ms)]);
    const hash = createHash('sha256').update(bytes).digest();
    r.receipt_hash = hash.toString('hex');
    r.signature = bytesToHex(nacl.sign.detached(hash, this.key.secretKey));
    this.log.push(r);
    return r;
  }
  async getInteraction() { return { state: this.state, data: structuredClone(this.data) }; }
  async mergeData(_id: string, state: string, patch: Record<string, unknown>) {
    if (state !== this.state) throw new Error('state moved');
    Object.assign(this.data, patch);
  }
  async receipts() { return structuredClone(this.log); }
  get publicKeyHex() { return bytesToHex(this.key.publicKey); }
}

const INTERACTION = 'int_ab12cd34ef56';
// Same trick as the protocol harness: synchronous SHA-256 so the fake clock can't outrun hashing.
beforeEach(() => {
  vi.stubGlobal('crypto', {
    subtle: {
      digest: async (_alg: string, data: Uint8Array): Promise<ArrayBuffer> => {
        const h = createHash('sha256').update(data).digest();
        return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength) as ArrayBuffer;
      },
    },
    getRandomValues: (a: Uint8Array): Uint8Array => webcrypto.getRandomValues(a),
  });
});
afterEach(() => vi.unstubAllGlobals());

function chainFor(zend: FakeZend, verify = true) {
  return new ZendChain({ port: zend, interactionId: INTERACTION, ...(verify ? { zendPublicKey: zend.publicKeyHex } : {}) });
}

describe('ZendChain records', () => {
  it('derives a valid, stable room code from the interaction', async () => {
    const a = await roomForInteraction(INTERACTION);
    expect(isValidRoom(a)).toBe(true);
    expect(await roomForInteraction(INTERACTION)).toBe(a);
    expect(await roomForInteraction('int_other')).not.toBe(a);
  });

  it('returns a protocol-valid id, confirms once attested, and is idempotent', async () => {
    const zend = new FakeZend('zu_a');
    const chain = chainFor(zend);
    const me = generateIdentity();
    const text = `ACC1|ABCDEF|C|${'ab'.repeat(32)}`;
    const sig = await chain.sendMemo(me, text);
    expect(isValidSignature(sig)).toBe(true);
    expect(await chain.sendMemo(me, text)).toBe(sig);
    const tx = await chain.getMemoTx(sig);
    expect(tx).toMatchObject({ sig, signer: me.publicKey, text, ok: true, slot: 1 });
    expect((await chain.listMemoTxs(me.publicKey, 'ABCDEF')).length).toBe(1);
    expect(await chain.listMemoTxs(me.publicKey, 'ZZZZZZ')).toEqual([]);
  });

  it('ignores records without a receipt, with a forged signature, or with a bad Zend signature', async () => {
    const zend = new FakeZend('zu_a');
    const chain = chainFor(zend);
    const me: Identity = generateIdentity();
    const forged = Buffer.alloc(64, 7);
    zend.data[`m:${(await import('bs58')).default.encode(forged)}`] = { text: 'ACC1|ABCDEF|C|x', signer: me.publicKey };
    const sig = await chain.sendMemo(me, 'ACC1|ABCDEF|C|' + 'cd'.repeat(32));
    expect((await chain.listMemoTxs(me.publicKey, 'ABCDEF')).map((t) => t.sig)).toEqual([sig]);

    const tampered = new FakeZend('zu_a');
    const c2 = new ZendChain({ port: tampered, interactionId: INTERACTION, zendPublicKey: zend.publicKeyHex });
    const s2 = await c2.sendMemo(me, 'ACC1|ABCDEF|C|' + 'ef'.repeat(32));
    expect(await c2.getMemoTx(s2)).toBeNull();
  });

  it('verifies receipts and rejects edits', async () => {
    const zend = new FakeZend('zu_a');
    const r = await zend.attest({ label: 'key', dataHash: 'aa'.repeat(32), interactionId: INTERACTION });
    expect(await verifyReceipt(r, zend.publicKeyHex)).toBe(true);
    expect(await verifyReceipt({ ...r, label: 'memo' }, zend.publicKeyHex)).toBe(false);
    expect(await verifyReceipt({ ...r, signature: 'zz' }, zend.publicKeyHex)).toBe(false);
  });

  it('keeps the earliest commit when a player equivocates', async () => {
    const zend = new FakeZend('zu_a');
    const chain = chainFor(zend);
    const me = generateIdentity();
    await chain.sendMemo(me, `ACC1|ABCDEF|C|${'11'.repeat(32)}`);
    await chain.sendMemo(me, `ACC1|ABCDEF|C|${'22'.repeat(32)}`);
    const canon = selectCommit(await chain.listMemoTxs(me.publicKey, 'ABCDEF'), 'ABCDEF', me.publicKey);
    expect(canon?.commitment).toBe('11'.repeat(32));
    expect(canon?.equivocated).toBe(true);
  });

  it('binds a game key to the Zend player', async () => {
    const zend = new FakeZend('zu_alice');
    const r = await chainFor(zend).bindKey(generateIdentity());
    expect(r).toMatchObject({ label: 'key', app_user_id: 'zu_alice' });
    expect(hexToBytes(r.data_hash).length).toBe(32);
  });
});

describe('a full game on Zend records', () => {
  it('reaches the same clean final verdict on both sides', async () => {
    const zend = new FakeZend('zu_shared');
    const chain = chainFor(zend);
    const room = await roomForInteraction(INTERACTION);
    const clock = new ManualClock();
    const hub = new MemoryHub();
    const mk = (name: string, role: 'host' | 'guest', secret: Code, hostKey?: string) => {
      const identity = generateIdentity();
      const session = Session.create({ room, role, identity, secret, saltHex: generateSaltHex(),
        ...(hostKey ? { hostKey } : {}), transport: hub.transport(name), chain, storage: new MemoryStorage(), clock });
      return { identity, session };
    };
    const host = mk('host', 'host', '1964');
    const guest = mk('guest', 'guest', '4271', host.identity.publicKey);
    const play = (s: Session, seed: number) => {
      const rng = mulberry32(seed);
      let done = -1;
      const go = (v: SessionView) => {
        if (!v.canGuess || v.guesses.length === done) return;
        done = v.guesses.length;
        const history = v.guesses.map((guess, index) => ({ guess, index }))
          .filter(({ index }) => index % 2 === v.seat && v.answers[index] !== undefined)
          .map(({ guess, index }) => ({ guess, feedback: v.answers[index] as number }));
        void s.submitGuess(chooseGuess('medium', candidatesFromHistory(history), rng) ?? '0123').catch(() => undefined);
      };
      s.subscribe(go);
      go(s.view());
    };
    await host.session.start();
    await guest.session.start();
    play(host.session, 1);
    play(guest.session, 2);
    const over = () => ['final', 'abandoned'].includes(host.session.view().phase) && ['final', 'abandoned'].includes(guest.session.view().phase);
    for (let t = 0; t < 600_000 && !over(); t += 100) await clock.advance(100);
    if (!over()) throw new Error(`stuck: host ${host.session.view().phase}/${host.session.view().error?.code ?? '-'}, guest ${guest.session.view().phase}/${guest.session.view().error?.code ?? '-'}`);

    const a = host.session.view().verdict;
    const b = guest.session.view().verdict;
    expect(host.session.view().phase).toBe('final');
    expect(a).toEqual(b);
    if (a?.kind !== 'final') throw new Error('expected final');
    expect(a.faults).toEqual([]);
    expect(a.verifiedSecrets).toEqual(['1964', '4271']);
    // Two commits and two reveals, each with exactly one Zend receipt.
    expect(Object.keys(zend.data).filter((k) => k.startsWith('m:')).length).toBe(4);
    expect(zend.log.filter((r) => r.label === 'memo').length).toBeGreaterThanOrEqual(4);
  }, 120_000);
});
