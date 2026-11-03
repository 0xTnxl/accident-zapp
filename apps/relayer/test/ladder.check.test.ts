import { candidatesFromHistory, chooseGuess, mulberry32 } from '@accident/engine';
import type { Code } from '@accident/engine';
import type { SessionView } from '@accident/protocol';
import { Session, bytesToHex, generateIdentity, generateSaltHex } from '@accident/protocol';
import { ManualClock, MemoryHub, MemoryStorage } from '@accident/protocol/testing';
import { createHash, webcrypto } from 'node:crypto';
import nacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkGame } from '../src/ladder/check.js';
import { type AttestReceipt, type ZendPort, ZendChain, roomForInteraction } from '@accident/zend';

/** In-memory Zend: one interaction's data plus a signed, chained receipt log (zend-attest-v1). */
class FakeZend implements ZendPort {
  readonly key = nacl.sign.keyPair();
  readonly data: Record<string, unknown> = {};
  readonly log: AttestReceipt[] = [];
  state = 'accepted';
  constructor(public user: string) {}

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


async function playGame(cheat: boolean) {
  const zend = new FakeZend('zu_host');
  const chain = new ZendChain({ port: zend, interactionId: INTERACTION, zendPublicKey: zend.publicKeyHex });
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
  zend.user = 'zu_host';
  await chain.bindKey(host.identity);
  zend.user = 'zu_guest';
  await chain.bindKey(guest.identity);
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
  const verdict = host.session.view().verdict;
  const messages = host.session.transcript().map((l) => JSON.parse(l) as unknown);
  if (cheat) {
    // Drop the last answer: a record that differs from what the reveals were anchored to.
    const i = messages.map((m) => (m as { type?: string }).type).lastIndexOf('ANSWER');
    if (i < 0) throw new Error('no answers in game');
    messages.splice(i, 1);
  }
  const interaction = {
    id: INTERACTION, app: 'accident', type: 'challenge', state: 'resolved', data: structuredClone(zend.data),
    participants: [
      { appUserId: 'zu_host', name: 'Host', username: null, avatar: null },
      { appUserId: 'zu_guest', name: 'Guest', username: null, avatar: null },
    ],
    createdAt: '', updatedAt: '',
  };
  return { verdict, zend, interaction, transcript: { room, messages } };
}

describe('server-side game check', () => {
  it('rates a real game with the same result the players saw', async () => {
    const g = await playGame(false);
    if (g.verdict?.kind !== 'final') throw new Error('game did not finish');
    const out = await checkGame({ interaction: g.interaction, receipts: g.zend.log, zendPublicKey: g.zend.publicKeyHex,
      transcript: g.transcript, now: Date.now() });
    expect(out).toMatchObject({ kind: 'final', result: g.verdict.result });
  }, 120_000);

  it('refuses a record that disagrees with the reveals', async () => {
    const g = await playGame(true);
    const out = await checkGame({ interaction: g.interaction, receipts: g.zend.log, zendPublicKey: g.zend.publicKeyHex,
      transcript: g.transcript, now: Date.now() });
    expect(['disputed', 'not_rateable']).toContain(out.kind);
  }, 120_000);

  it('refuses when game keys are bound to the wrong seats', async () => {
    const g = await playGame(false);
    const swapped = { ...g.interaction, participants: [...g.interaction.participants].reverse() };
    const out = await checkGame({ interaction: swapped, receipts: g.zend.log, zendPublicKey: g.zend.publicKeyHex,
      transcript: g.transcript, now: Date.now() });
    expect(out.kind).toBe('not_rateable');
  }, 120_000);
});
