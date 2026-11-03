import { describe, expect, it } from 'vitest';
import type { AnalyticsEvent, Transport } from '../src/friend/analytics.js';
import { Analytics, noopAnalytics, visitId } from '../src/friend/analytics.js';
import { EVENTS, cleanProps, handleEvent } from '../../relayer/src/event.js';
import type { EventDeps, EventName } from '../../relayer/src/event.js';
import { MemoryCounter } from '../../relayer/src/http.js';

function capture() {
  const sent: Array<{ url: string; body: unknown }> = [];
  const transport: Transport = (url, body) => sent.push({ url, body: JSON.parse(body) });
  return { sent, transport };
}

describe('visitId', () => {
  it('makes a 32-character hex id and keeps it across calls', () => {
    const store = new Map<string, string>();
    const s: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
    };
    const first = visitId(s);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(visitId(s)).toBe(first);
  });

  it('passes the relayer’s own session rule', () => {
    const store = new Map<string, string>();
    const s = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(/^[A-Za-z0-9_-]{8,40}$/.test(visitId(s))).toBe(true);
  });

  it('replaces a stored id that does not look right', () => {
    const store = new Map<string, string>([['accident:visit:v1', 'nope!']]);
    const s = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(visitId(s)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('still returns an id when storage is blocked', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(visitId(blocked)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('Analytics', () => {
  it('sends a flat event with name, session and props to the endpoint', () => {
    const { sent, transport } = capture();
    const analytics = new Analytics({ transport, session: 'visit-123', endpoint: '/api/event' });
    analytics.send({ name: 'cpu_game_end', level: 'hard', result: 'win', guesses: 6 });
    expect(sent).toEqual([
      {
        url: '/api/event',
        body: {
          name: 'cpu_game_end',
          session: 'visit-123',
          props: { level: 'hard', result: 'win', guesses: 6 },
        },
      },
    ]);
  });

  it('sends events with no properties as an empty object', () => {
    const { sent, transport } = capture();
    new Analytics({ transport, session: 's' }).send({ name: 'app_open' });
    expect(sent[0]?.body).toEqual({ name: 'app_open', session: 's', props: {} });
  });

  it('does nothing when disabled', () => {
    const { sent, transport } = capture();
    new Analytics({ transport, enabled: false }).send({ name: 'app_open' });
    expect(sent).toEqual([]);
    noopAnalytics.send({ name: 'app_open' });
  });

  it('never throws into the caller, even if the transport does', () => {
    const analytics = new Analytics({
      transport: () => {
        throw new Error('network on fire');
      },
      session: 's',
    });
    expect(() => analytics.send({ name: 'app_open' })).not.toThrow();
  });

  it('defaults to the /api/event endpoint', () => {
    const { sent, transport } = capture();
    new Analytics({ transport, session: 's' }).send({ name: 'rematch_clicked' });
    expect(sent[0]?.url).toBe('/api/event');
  });
});

/**
 * The client and the server must agree on what every event looks like. Build one of each event the
 * client can send, feed it through the real relayer handler, and check nothing is dropped.
 */
describe('every client event is accepted and kept whole by the relayer', () => {
  const samples: AnalyticsEvent[] = [
    { name: 'app_open' },
    { name: 'cpu_game_start', level: 'medium' },
    { name: 'cpu_game_end', level: 'hard', result: 'loss', guesses: 9 },
    { name: 'room_created' },
    { name: 'room_joined' },
    { name: 'commit_confirmed', ms: 1200 },
    { name: 'play_gate_open', ms: 2500 },
    { name: 'pvp_first_guess' },
    { name: 'pvp_finished', result: 'win', guesses: 7, durationMs: 90000 },
    { name: 'rematch_clicked' },
    { name: 'tx_error', kind: 'commit', code: 'blockhash' },
    { name: 'tx_latency_ms', ms: 800 },
    { name: 'relay_latency_ms', ms: 60 },
  ];

  it('covers exactly the relayer’s allow-list', () => {
    expect(samples.map((e) => e.name).sort()).toEqual(Object.keys(EVENTS).sort());
  });

  it.each(samples)('accepts %o with all its properties intact', async (event) => {
    const stored: Array<{ name: string; props: Record<string, unknown> }> = [];
    const deps: EventDeps = {
      counter: new MemoryCounter(),
      store: async (record) => void stored.push(record),
      perIpPerDay: 100,
      now: () => 0,
    };
    const { sent, transport } = capture();
    new Analytics({ transport, session: 'abcdefgh12' }).send(event);
    const body = sent[0]?.body as { name: string; session: string; props: unknown };

    const request = new Request('https://x.test/api/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const response = await handleEvent(request, deps);
    expect(response.status).toBe(200);

    const { name, ...props } = event;
    expect(stored[0]?.name).toBe(name);
    // cleanProps keeps exactly the declared properties; nothing the client sends should be dropped.
    expect(stored[0]?.props).toEqual(cleanProps(name as EventName, props));
    expect(stored[0]?.props).toEqual(props);
  });
});
