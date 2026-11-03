import { describe, expect, it } from 'vitest';
import type { EventDeps, EventRecord } from '../src/event.js';
import { DEFAULT_EVENT_LIMIT, EVENTS, MAX_STRING, cleanProps, handleEvent } from '../src/event.js';
import { MemoryCounter } from '../src/http.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const SESSION = 'abc123XYZ_-9';

function setup(perIpPerDay = DEFAULT_EVENT_LIMIT) {
  const stored: EventRecord[] = [];
  const deps: EventDeps = {
    counter: new MemoryCounter(),
    store: async (record) => {
      stored.push(record);
    },
    perIpPerDay,
    now: () => NOW,
  };
  return { stored, deps };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://x.test/api/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.1.1.1', ...headers },
    body: JSON.stringify(body),
  });
}

describe('recording an event', () => {
  it('stores a known event with a random visit id and a time, and nothing else', async () => {
    const { deps, stored } = setup();
    const response = await handleEvent(post({ name: 'app_open', session: SESSION }), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(stored).toEqual([{ name: 'app_open', session: SESSION, at: NOW, props: {} }]);
  });

  it('keeps the allowed properties of an event', async () => {
    const { deps, stored } = setup();
    await handleEvent(
      post({
        name: 'pvp_finished',
        session: SESSION,
        props: { result: 'win', guesses: 7, durationMs: 90_000 },
      }),
      deps,
    );
    expect(stored[0]?.props).toEqual({ result: 'win', guesses: 7, durationMs: 90_000 });
  });

  it('accepts every event the app sends', async () => {
    const { deps, stored } = setup();
    for (const name of Object.keys(EVENTS)) {
      expect((await handleEvent(post({ name, session: SESSION }), deps)).status).toBe(200);
    }
    expect(stored).toHaveLength(Object.keys(EVENTS).length);
  });

  it('never stores the caller’s network address', async () => {
    const { deps, stored } = setup();
    await handleEvent(
      post({ name: 'app_open', session: SESSION }, { 'x-forwarded-for': '203.0.113.9' }),
      deps,
    );
    expect(JSON.stringify(stored)).not.toContain('203.0.113.9');
  });
});

describe('what is dropped', () => {
  it('drops properties an event is not allowed to carry, so nothing personal can be smuggled in', async () => {
    const { deps, stored } = setup();
    await handleEvent(
      post({
        name: 'cpu_game_end',
        session: SESSION,
        props: {
          level: 'hard',
          result: 'win',
          guesses: 6,
          email: 'a@b.c',
          secret: '1964',
          name: 'Ada',
          pubkey: 'K',
        },
      }),
      deps,
    );
    expect(stored[0]?.props).toEqual({ level: 'hard', result: 'win', guesses: 6 });
    expect(JSON.stringify(stored)).not.toMatch(/a@b\.c|1964|Ada/);
  });

  it('drops values of the wrong kind or size', () => {
    expect(
      cleanProps('tx_error', {
        kind: 'x'.repeat(MAX_STRING + 1),
        code: { nested: true },
      }),
    ).toEqual({});
    expect(cleanProps('tx_latency_ms', { ms: NaN })).toEqual({});
    expect(cleanProps('tx_latency_ms', { ms: Infinity })).toEqual({});
    expect(cleanProps('tx_latency_ms', { ms: '12' })).toEqual({ ms: '12' });
    expect(cleanProps('tx_error', { kind: 'x'.repeat(MAX_STRING) })).toEqual({
      kind: 'x'.repeat(MAX_STRING),
    });
    expect(cleanProps('tx_latency_ms', { ms: true })).toEqual({});
  });

  it.each([null, undefined, 5, 'text', [1, 2]])('treats %j as no properties', (props) => {
    expect(cleanProps('cpu_game_end', props)).toEqual({});
  });

  it('ignores properties on events that take none', async () => {
    const { deps, stored } = setup();
    await handleEvent(post({ name: 'app_open', session: SESSION, props: { a: 1 } }), deps);
    expect(stored[0]?.props).toEqual({});
  });
});

describe('what is refused', () => {
  it.each([
    ['an unknown name', { name: 'drop_table', session: SESSION }],
    ['a missing name', { session: SESSION }],
    ['a non-string name', { name: 5, session: SESSION }],
    ['an inherited object key as a name', { name: 'constructor', session: SESSION }],
    ['a prototype name', { name: '__proto__', session: SESSION }],
    ['a toString name', { name: 'toString', session: SESSION }],
    ['a missing session', { name: 'app_open' }],
    ['a session that is too short', { name: 'app_open', session: 'abc' }],
    ['a session with odd characters', { name: 'app_open', session: 'abc def ghi!' }],
    ['a session that is too long', { name: 'app_open', session: 'a'.repeat(41) }],
    ['an email as a session', { name: 'app_open', session: 'person@example.com' }],
    ['a null body', null],
  ])('rejects %s', async (_name, body) => {
    const { deps, stored } = setup();
    expect((await handleEvent(post(body), deps)).status).toBe(400);
    expect(stored).toEqual([]);
  });

  it.each(['GET', 'PUT', 'DELETE'])('refuses %s', async (method) => {
    const { deps } = setup();
    const response = await handleEvent(new Request('https://x.test/api/event', { method }), deps);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('refuses bodies that are not JSON or not JSON content', async () => {
    const { deps } = setup();
    expect(
      (
        await handleEvent(
          new Request('https://x.test/api/event', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{nope',
          }),
          deps,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleEvent(
          new Request('https://x.test/api/event', {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: 'x',
          }),
          deps,
        )
      ).status,
    ).toBe(415);
  });
});

describe('rate limiting', () => {
  it('stops one address from flooding the store, and counts others separately', async () => {
    const { deps, stored } = setup(3);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await handleEvent(post({ name: 'app_open', session: SESSION }), deps)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect(stored).toHaveLength(3);
    expect(
      (
        await handleEvent(
          post({ name: 'app_open', session: SESSION }, { 'x-forwarded-for': '2.2.2.2' }),
          deps,
        )
      ).status,
    ).toBe(200);
  });

  it('starts a fresh allowance the next day', async () => {
    const { deps } = setup(1);
    await handleEvent(post({ name: 'app_open', session: SESSION }), deps);
    expect((await handleEvent(post({ name: 'app_open', session: SESSION }), deps)).status).toBe(
      429,
    );
    const tomorrow: EventDeps = { ...deps, now: () => NOW + 24 * 3600 * 1000 };
    expect((await handleEvent(post({ name: 'app_open', session: SESSION }), tomorrow)).status).toBe(
      200,
    );
  });

  it('does not count refused events against the allowance', async () => {
    const { deps } = setup(2);
    for (let i = 0; i < 5; i++) await handleEvent(post({ name: 'bogus', session: SESSION }), deps);
    expect((await handleEvent(post({ name: 'app_open', session: SESSION }), deps)).status).toBe(
      200,
    );
    expect((await handleEvent(post({ name: 'app_open', session: SESSION }), deps)).status).toBe(
      200,
    );
  });
});
