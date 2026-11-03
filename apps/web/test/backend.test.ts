import { describe, expect, it, vi } from 'vitest';
import { requestDrip, MIN_BALANCE_LAMPORTS } from '../src/friend/backend.js';
import type { BackendEnv } from '../src/friend/backend.js';

const PUBKEY = '11111111111111111111111111111111';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('requestDrip', () => {
  it('succeeds on the first try when the service answers normally', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, funded: true }));
    const result = await requestDrip('/api/drip', PUBKEY, fetcher);
    expect(result).toEqual({ ok: true, alreadyFunded: false });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('retries once after a dropped connection, then succeeds', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, funded: true }));
    const result = await requestDrip('/api/drip', PUBKEY, fetcher);
    expect(result).toEqual({ ok: true, alreadyFunded: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('gives a friendly reason when every attempt fails to connect', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network error'));
    const result = await requestDrip('/api/drip', PUBKEY, fetcher);
    expect(result).toEqual({ ok: false, reason: 'Could not reach the funding service' });
    // Bounded: it does not retry forever.
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not retry an answer the service actually sent, even an error one', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(429, { error: 'Too many requests' }));
    const result = await requestDrip('/api/drip', PUBKEY, fetcher);
    expect(result).toEqual({ ok: false, reason: 'Too many requests' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('createBackend live fund()', () => {
  const env: BackendEnv = {
    VITE_BACKEND: 'live',
    VITE_SUPABASE_URL: 'https://example.supabase.co',
    VITE_SUPABASE_ANON_KEY: 'anon-key',
    VITE_DRIP_URL: '/api/drip',
  };

  /** Stubs `Connection` so `fund()` calls `getBalance` against a fake instead of real RPC. */
  async function mockConnection(getBalance: ReturnType<typeof vi.fn>): Promise<void> {
    vi.resetModules();
    vi.doMock('@solana/web3.js', async () => {
      const actual = await vi.importActual<typeof import('@solana/web3.js')>('@solana/web3.js');
      class FakeConnection {
        getBalance = getBalance;
      }
      return { ...actual, Connection: FakeConnection };
    });
  }

  it('retries a flaky balance check before giving up and shows a friendly reason', async () => {
    const getBalance = vi.fn().mockRejectedValue(new Error('fetch failed'));
    await mockConnection(getBalance);
    const { createBackend: createBackendFresh } = await import('../src/friend/backend.js');
    const backend = createBackendFresh(env);
    const result = await backend.fund(PUBKEY);
    expect(result).toEqual({
      ok: false,
      reason: 'Could not check your balance. Please try again.',
    });
    expect(getBalance).toHaveBeenCalledTimes(3);
    vi.doUnmock('@solana/web3.js');
  });

  it('recovers from one flaky balance check and still asks for a drip when underfunded', async () => {
    const getBalance = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(0);
    await mockConnection(getBalance);
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, funded: true }));
    globalThis.fetch = fetcher as unknown as typeof fetch;
    const { createBackend: createBackendFresh } = await import('../src/friend/backend.js');
    const backend = createBackendFresh(env);
    const result = await backend.fund(PUBKEY);
    expect(result).toEqual({ ok: true, alreadyFunded: false });
    expect(getBalance).toHaveBeenCalledTimes(2);
    vi.doUnmock('@solana/web3.js');
  });

  it('skips the drip entirely once the balance is already above the floor', async () => {
    const getBalance = vi.fn().mockResolvedValue(MIN_BALANCE_LAMPORTS);
    await mockConnection(getBalance);
    const fetcher = vi.fn();
    globalThis.fetch = fetcher as unknown as typeof fetch;
    const { createBackend: createBackendFresh } = await import('../src/friend/backend.js');
    const backend = createBackendFresh(env);
    const result = await backend.fund(PUBKEY);
    expect(result).toEqual({ ok: true, alreadyFunded: true });
    expect(fetcher).not.toHaveBeenCalled();
    vi.doUnmock('@solana/web3.js');
  });
});
