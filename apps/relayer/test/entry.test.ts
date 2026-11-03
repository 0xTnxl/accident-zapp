import { generateIdentity } from '@accident/protocol';
import { describe, expect, it } from 'vitest';
import type { DripDeps } from '../src/drip.js';
import { DEFAULT_DRIP } from '../src/drip.js';
import { dripEntry, eventEntry, methodNotAllowed } from '../src/entry.js';
import type { EventDeps } from '../src/event.js';
import { MemoryCounter } from '../src/http.js';

const post = (body: unknown): Request =>
  new Request('https://x.test/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const goodDrip = (): DripDeps => ({
  treasury: {
    balanceOf: async () => 0,
    treasuryBalance: async () => 10e9,
    send: async () => 'sig',
  },
  counter: new MemoryCounter(),
  config: DEFAULT_DRIP,
  now: () => 0,
  log: () => undefined,
});

describe('the drip function', () => {
  it('serves a request when it is set up', async () => {
    const response = await dripEntry(post({ pubkey: generateIdentity().publicKey }), goodDrip);
    expect(response.status).toBe(200);
  });

  it('says it is unavailable when it cannot be set up, and does not try anything else', async () => {
    const response = await dripEntry(
      post({ pubkey: generateIdentity().publicKey }),
      () => undefined,
    );
    expect(response.status).toBe(503);
  });

  it('turns an unexpected failure into a plain error that reveals nothing', async () => {
    const broken: DripDeps = {
      ...goodDrip(),
      counter: {
        increment: async () => {
          throw new Error('postgres://user:password@internal-host:5432/db refused the connection');
        },
        decrement: async () => undefined,
      },
    };
    const response = await dripEntry(post({ pubkey: generateIdentity().publicKey }), () => broken);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toBe('{"ok":false,"error":"Something went wrong"}');
    expect(text).not.toMatch(/postgres|password|internal/);
  });
});

describe('the event function', () => {
  const goodEvent = (stored: unknown[] = []): EventDeps => ({
    counter: new MemoryCounter(),
    store: async (record) => {
      stored.push(record);
    },
    perIpPerDay: 100,
    now: () => 0,
  });

  it('records an event when it is set up', async () => {
    const stored: unknown[] = [];
    const response = await eventEntry(post({ name: 'app_open', session: 'abcdefgh1' }), () =>
      goodEvent(stored),
    );
    expect(response.status).toBe(200);
    expect(stored).toHaveLength(1);
  });

  it('gives a quick soft refusal, not an error, when analytics are not set up', async () => {
    const response = await eventEntry(
      post({ name: 'app_open', session: 'abcdefgh1' }),
      () => undefined,
    );
    expect(response.status).toBe(202);
  });

  it('never lets a storage failure reach the player', async () => {
    const broken: EventDeps = {
      ...goodEvent(),
      store: async () => {
        throw new Error('disk full');
      },
    };
    const response = await eventEntry(
      post({ name: 'app_open', session: 'abcdefgh1' }),
      () => broken,
    );
    expect(response.status).toBe(202);
    expect(await response.text()).not.toMatch(/disk/);
  });
});

describe('methods', () => {
  it('only POST is allowed', () => {
    const response = methodNotAllowed();
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});
