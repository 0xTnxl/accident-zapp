import { generateIdentity } from '@accident/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { DripConfig, DripDeps, Treasury } from '../src/drip.js';
import { DEFAULT_DRIP, LAMPORTS_PER_SOL, handleDrip } from '../src/drip.js';
import { MAX_BODY_BYTES, MemoryCounter, dayOf } from '../src/http.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

class FakeTreasury implements Treasury {
  balances = new Map<string, number>();
  wallet = 10 * LAMPORTS_PER_SOL;
  sent: Array<{ to: string; lamports: number }> = [];
  failSend = false;
  failBalance = false;
  async balanceOf(publicKey: string): Promise<number> {
    if (this.failBalance) throw new Error('rpc down');
    return this.balances.get(publicKey) ?? 0;
  }
  async treasuryBalance(): Promise<number> {
    return this.wallet;
  }
  async send(publicKey: string, lamports: number): Promise<string> {
    if (this.failSend) throw new Error('send failed');
    this.sent.push({ to: publicKey, lamports });
    this.wallet -= lamports;
    return `sig-${this.sent.length}`;
  }
}

function setup(over: Partial<DripConfig> = {}) {
  const treasury = new FakeTreasury();
  const counter = new MemoryCounter();
  const logs: Array<Record<string, unknown>> = [];
  const deps: DripDeps = {
    treasury,
    counter,
    config: { ...DEFAULT_DRIP, ...over },
    now: () => NOW,
    log: (entry) => logs.push(entry),
  };
  return { treasury, counter, logs, deps };
}

function post(body: unknown, headers: Record<string, string> = {}, raw?: string): Request {
  return new Request('https://x.test/api/drip', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.1.1.1', ...headers },
    body: raw ?? JSON.stringify(body),
  });
}

const key = (): string => generateIdentity().publicKey;
const read = async (r: Response): Promise<Record<string, unknown>> =>
  (await r.json()) as Record<string, unknown>;

describe('a normal request', () => {
  it('sends the fixed amount to a new key and says so', async () => {
    const { deps, treasury } = setup();
    const pubkey = key();
    const response = await handleDrip(post({ pubkey }), deps);
    expect(response.status).toBe(200);
    expect(await read(response)).toEqual({ ok: true, funded: true, signature: 'sig-1' });
    expect(treasury.sent).toEqual([{ to: pubkey, lamports: 0.01 * LAMPORTS_PER_SOL }]);
  });

  it('never lets the caller choose an amount', async () => {
    const { deps, treasury } = setup();
    await handleDrip(post({ pubkey: key(), lamports: 999_999_999_999, amount: 1e12 }), deps);
    expect(treasury.sent[0]?.lamports).toBe(DEFAULT_DRIP.amountLamports);
  });

  it('does not top up a key that already has enough, and counts nothing against it', async () => {
    const { deps, treasury, counter } = setup();
    const pubkey = key();
    treasury.balances.set(pubkey, DEFAULT_DRIP.skipAboveLamports);
    const response = await handleDrip(post({ pubkey }), deps);
    expect(await read(response)).toEqual({ ok: true, funded: false });
    expect(treasury.sent).toEqual([]);
    expect(counter.peek(`key:${pubkey}`, dayOf(NOW))).toBe(0);
  });

  it('tops up a key that has a little but not enough', async () => {
    const { deps, treasury } = setup();
    const pubkey = key();
    treasury.balances.set(pubkey, DEFAULT_DRIP.skipAboveLamports - 1);
    expect((await read(await handleDrip(post({ pubkey }), deps))).funded).toBe(true);
  });

  it('logs the drip without the wallet secret', async () => {
    const { deps, logs } = setup();
    await handleDrip(post({ pubkey: key() }), deps);
    expect(logs[0]).toMatchObject({
      event: 'drip',
      ip: '1.1.1.1',
      lamports: 0.01 * LAMPORTS_PER_SOL,
    });
    expect(JSON.stringify(logs)).not.toMatch(/secret/i);
  });
});

describe('limits that protect the wallet', () => {
  it('gives one key only one drip per day', async () => {
    const { deps, treasury } = setup();
    const pubkey = key();
    expect((await handleDrip(post({ pubkey }), deps)).status).toBe(200);
    // The key still has no balance here (the fake does not credit it), so the limit is what stops it.
    const again = await handleDrip(post({ pubkey }), deps);
    expect(again.status).toBe(429);
    expect(await read(again)).toMatchObject({
      ok: false,
      error: expect.stringContaining('already been funded'),
    });
    expect(treasury.sent).toHaveLength(1);
  });

  it('a new day starts a fresh allowance', async () => {
    const { deps, treasury } = setup();
    const pubkey = key();
    await handleDrip(post({ pubkey }), deps);
    const tomorrow: DripDeps = { ...deps, now: () => NOW + 24 * 3600 * 1000 };
    expect((await handleDrip(post({ pubkey }), tomorrow)).status).toBe(200);
    expect(treasury.sent).toHaveLength(2);
  });

  it('stops one address from draining the wallet with a stream of fresh keys', async () => {
    const { deps, treasury } = setup({ perIpPerDay: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push((await handleDrip(post({ pubkey: key() }), deps)).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
    expect(treasury.sent).toHaveLength(3);
  });

  it('counts different addresses separately', async () => {
    const { deps, treasury } = setup({ perIpPerDay: 1 });
    await handleDrip(post({ pubkey: key() }, { 'x-forwarded-for': '1.1.1.1' }), deps);
    await handleDrip(post({ pubkey: key() }, { 'x-forwarded-for': '2.2.2.2' }), deps);
    expect(treasury.sent).toHaveLength(2);
  });

  it('uses the first address in x-forwarded-for, the real client, not a proxy added later', async () => {
    const { deps, counter } = setup();
    await handleDrip(
      post({ pubkey: key() }, { 'x-forwarded-for': '9.9.9.9, 10.0.0.1, 10.0.0.2' }),
      deps,
    );
    expect(counter.peek('ip:9.9.9.9', dayOf(NOW))).toBe(1);
  });

  it('puts requests with no usable address in one shared bucket, which is stricter', async () => {
    const { deps, treasury } = setup({ perIpPerDay: 2 });
    for (let i = 0; i < 4; i++) {
      await handleDrip(post({ pubkey: key() }, { 'x-forwarded-for': '' }), deps);
    }
    expect(treasury.sent).toHaveLength(2);
    const long = 'x'.repeat(100);
    const r = await handleDrip(post({ pubkey: key() }, { 'x-forwarded-for': long }), deps);
    expect(r.status).toBe(429);
  });

  it('cannot be beaten by firing many requests for one key at the same instant', async () => {
    const { deps, treasury } = setup();
    const pubkey = key();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => handleDrip(post({ pubkey }), deps)),
    );
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(treasury.sent).toHaveLength(1);
  });

  it('refuses rather than emptying the wallet below its reserve', async () => {
    const { deps, treasury, logs } = setup();
    treasury.wallet = DEFAULT_DRIP.reserveLamports + DEFAULT_DRIP.amountLamports - 1;
    const response = await handleDrip(post({ pubkey: key() }), deps);
    expect(response.status).toBe(503);
    expect(await read(response)).toMatchObject({ error: expect.stringContaining('paused') });
    expect(treasury.sent).toEqual([]);
    expect(logs[0]).toMatchObject({ event: 'drip-refused-low-reserve' });
  });

  it('sends exactly down to the reserve and no further', async () => {
    const { deps, treasury } = setup();
    treasury.wallet = DEFAULT_DRIP.reserveLamports + DEFAULT_DRIP.amountLamports;
    expect((await handleDrip(post({ pubkey: key() }), deps)).status).toBe(200);
    expect(
      (await handleDrip(post({ pubkey: key() }, { 'x-forwarded-for': '7.7.7.7' }), deps)).status,
    ).toBe(503);
  });

  it('gives the player their allowance back when the wallet is low, so they can retry later', async () => {
    const { deps, treasury, counter } = setup();
    const pubkey = key();
    treasury.wallet = 0;
    await handleDrip(post({ pubkey }), deps);
    expect(counter.peek(`key:${pubkey}`, dayOf(NOW))).toBe(0);
    expect(counter.peek('ip:1.1.1.1', dayOf(NOW))).toBe(0);
    treasury.wallet = 10 * LAMPORTS_PER_SOL;
    expect((await handleDrip(post({ pubkey }), deps)).status).toBe(200);
  });

  it('gives the allowance back when the send itself fails', async () => {
    const { deps, treasury, counter, logs } = setup();
    const pubkey = key();
    treasury.failSend = true;
    const response = await handleDrip(post({ pubkey }), deps);
    expect(response.status).toBe(502);
    expect(counter.peek(`key:${pubkey}`, dayOf(NOW))).toBe(0);
    expect(logs[0]).toMatchObject({ event: 'drip-failed' });
    treasury.failSend = false;
    expect((await handleDrip(post({ pubkey }), deps)).status).toBe(200);
  });

  it('gives the allowance back when a limit refuses, so refusals never pile up', async () => {
    const { deps, counter } = setup({ perIpPerDay: 1 });
    await handleDrip(post({ pubkey: key() }), deps);
    const other = key();
    await handleDrip(post({ pubkey: other }), deps); // refused: address limit
    expect(counter.peek(`key:${other}`, dayOf(NOW))).toBe(0);
    expect(counter.peek('ip:1.1.1.1', dayOf(NOW))).toBe(1);
  });

  it('a refused repeat for one key does not use up the network’s allowance for other players', async () => {
    // A household on one network: one person keeps pressing retry after already being funded.
    const { deps, counter, treasury } = setup({ perIpPerDay: 3 });
    const pubkey = key();
    await handleDrip(post({ pubkey }), deps);
    for (let i = 0; i < 5; i++) expect((await handleDrip(post({ pubkey }), deps)).status).toBe(429);
    expect(counter.peek('ip:1.1.1.1', dayOf(NOW))).toBe(1);
    expect(counter.peek(`key:${pubkey}`, dayOf(NOW))).toBe(1);
    // Others on the same network are still served.
    expect((await handleDrip(post({ pubkey: key() }), deps)).status).toBe(200);
    expect((await handleDrip(post({ pubkey: key() }), deps)).status).toBe(200);
    expect(treasury.sent).toHaveLength(3);
  });

  it('reports a chain outage when it cannot read the balance', async () => {
    const { deps, treasury } = setup();
    treasury.failBalance = true;
    expect((await handleDrip(post({ pubkey: key() }), deps)).status).toBe(502);
  });
});

describe('bad input and a missing wallet', () => {
  it('fails closed when no wallet is configured', async () => {
    const { deps } = setup();
    const response = await handleDrip(post({ pubkey: key() }), { ...deps, treasury: undefined });
    expect(response.status).toBe(503);
  });

  it.each(['GET', 'PUT', 'DELETE', 'PATCH'])('refuses %s', async (method) => {
    const { deps } = setup();
    const response = await handleDrip(new Request('https://x.test/api/drip', { method }), deps);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a number', 5],
    ['an empty string', ''],
    ['text that is not base58', '0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl'],
    ['a signature, not a key', 'A'.repeat(88)],
    ['a key that is too short', 'abc'],
    ['an array', [key()]],
    ['an object', { a: 1 }],
  ])('rejects %s as the key', async (_name, pubkey) => {
    const { deps, treasury } = setup();
    const response = await handleDrip(post({ pubkey }), deps);
    expect(response.status).toBe(400);
    expect(treasury.sent).toEqual([]);
  });

  it('rejects a body that is not an object', async () => {
    const { deps } = setup();
    for (const body of [null, 'x', 5, [], true]) {
      expect((await handleDrip(post(body), deps)).status).toBe(400);
    }
  });

  it('rejects a body that is not JSON', async () => {
    const { deps } = setup();
    expect((await handleDrip(post(undefined, {}, '{nope'), deps)).status).toBe(400);
  });

  it('rejects other content types', async () => {
    const { deps } = setup();
    const response = await handleDrip(
      post(undefined, { 'content-type': 'text/plain' }, 'hi'),
      deps,
    );
    expect(response.status).toBe(415);
  });

  it('rejects an oversized body by its declared length and by its real length', async () => {
    const { deps, treasury } = setup();
    const big = JSON.stringify({ pubkey: key(), pad: 'x'.repeat(MAX_BODY_BYTES) });
    expect(
      (await handleDrip(post(undefined, { 'content-length': String(big.length) }, big), deps))
        .status,
    ).toBe(413);
    // A client can understate the length. The real size is checked too.
    expect((await handleDrip(post(undefined, { 'content-length': '10' }, big), deps)).status).toBe(
      413,
    );
    expect(treasury.sent).toEqual([]);
  });

  it('never includes stack traces or internals in an error body', async () => {
    const { deps, treasury } = setup();
    treasury.failSend = true;
    const text = JSON.stringify(await read(await handleDrip(post({ pubkey: key() }), deps)));
    expect(text).not.toMatch(/send failed|stack|at \w+/i);
  });

  it('sends no caching headers that could replay a funding answer', async () => {
    const { deps } = setup();
    const response = await handleDrip(post({ pubkey: key() }), deps);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json');
  });
});

describe('configuration', () => {
  it('keeps the default drip far below the wallet reserve and well above a game’s cost', () => {
    expect(DEFAULT_DRIP.amountLamports).toBe(10_000_000);
    expect(DEFAULT_DRIP.amountLamports).toBeGreaterThan(20_000 * 100); // 100 games of fees
    expect(DEFAULT_DRIP.reserveLamports).toBeGreaterThan(DEFAULT_DRIP.amountLamports * 10);
    expect(DEFAULT_DRIP.skipAboveLamports).toBeLessThan(DEFAULT_DRIP.amountLamports);
  });

  it('a logger that throws would not be reached before the wallet is checked', async () => {
    const { deps } = setup();
    const log = vi.fn();
    await handleDrip(post({ pubkey: 'bad' }), { ...deps, log });
    expect(log).not.toHaveBeenCalled();
  });
});
