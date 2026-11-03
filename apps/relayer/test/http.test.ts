import { describe, expect, it } from 'vitest';
import { MemoryCounter, clientIp, dayOf, error, json, readJson } from '../src/http.js';

describe('readJson', () => {
  it('reads a small JSON body', async () => {
    const request = new Request('https://x.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{"a":1}',
    });
    expect(await readJson(request)).toEqual({ ok: true, value: { a: 1 } });
  });

  it('is not fooled by the case of the content type', async () => {
    const request = new Request('https://x.test', {
      method: 'POST',
      headers: { 'content-type': 'Application/JSON' },
      body: '[]',
    });
    expect(await readJson(request)).toEqual({ ok: true, value: [] });
  });

  it('refuses a request with no content type at all', async () => {
    const result = await readJson(new Request('https://x.test', { method: 'POST' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(415);
  });

  it('counts the real size in bytes, not characters, of a body that lies about its length', async () => {
    // 1,100 two-byte characters is 2,200 bytes but only 1,100 characters.
    const body = JSON.stringify({ pad: 'é'.repeat(1100) });
    const request = new Request('https://x.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '5' },
      body,
    });
    const result = await readJson(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });
});

describe('response helpers', () => {
  it('builds JSON responses that are never cached', async () => {
    const response = json(201, { ok: true }, { 'x-extra': '1' });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-extra')).toBe('1');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('builds error responses with a message', async () => {
    const response = error(418, 'teapot');
    expect(response.status).toBe(418);
    expect(await response.json()).toEqual({ ok: false, error: 'teapot' });
  });
});

describe('clientIp', () => {
  it('uses the first forwarded address, trimmed', () => {
    const r = new Request('https://x.test', {
      headers: { 'x-forwarded-for': ' 5.5.5.5 , 6.6.6.6' },
    });
    expect(clientIp(r)).toBe('5.5.5.5');
  });

  it('falls back to one shared bucket when there is no usable header', () => {
    expect(clientIp(new Request('https://x.test'))).toBe('unknown');
    expect(clientIp(new Request('https://x.test', { headers: { 'x-forwarded-for': '' } }))).toBe(
      'unknown',
    );
    expect(
      clientIp(new Request('https://x.test', { headers: { 'x-forwarded-for': 'a'.repeat(65) } })),
    ).toBe('unknown');
  });
});

describe('dayOf', () => {
  it('changes at UTC midnight', () => {
    expect(dayOf(Date.UTC(2026, 9, 6, 23, 59, 59))).toBe('2026-10-06');
    expect(dayOf(Date.UTC(2026, 9, 7, 0, 0, 0))).toBe('2026-10-07');
  });
});

describe('MemoryCounter', () => {
  it('counts per key and per day', async () => {
    const c = new MemoryCounter();
    expect(await c.increment('a', 'd1')).toBe(1);
    expect(await c.increment('a', 'd1')).toBe(2);
    expect(await c.increment('b', 'd1')).toBe(1);
    expect(await c.increment('a', 'd2')).toBe(1);
    expect(c.peek('a', 'd1')).toBe(2);
    expect(c.peek('never', 'd1')).toBe(0);
  });

  it('gives a count back but never goes below zero, even for a key it has not seen', async () => {
    const c = new MemoryCounter();
    await c.decrement('ghost', 'd1');
    expect(c.peek('ghost', 'd1')).toBe(0);
    await c.increment('a', 'd1');
    await c.decrement('a', 'd1');
    await c.decrement('a', 'd1');
    expect(c.peek('a', 'd1')).toBe(0);
  });
});
