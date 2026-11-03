import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DRIP } from '../src/drip.js';
import { DEFAULT_EVENT_LIMIT } from '../src/event.js';
import { dripDeps, eventDeps } from '../src/wiring.js';

const WALLET = JSON.stringify([...Keypair.generate().secretKey]);
const DB = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
};

describe('drip wiring', () => {
  it('builds everything from a complete environment', () => {
    const deps = dripDeps({ ...DB, FUNDING_WALLET_SECRET_KEY: WALLET });
    expect(deps?.treasury).toBeDefined();
    expect(deps?.counter).toBeDefined();
    expect(deps?.config).toBe(DEFAULT_DRIP);
    expect(typeof deps?.now()).toBe('number');
  });

  it('does not serve at all without a database, because then there would be no limits', () => {
    expect(dripDeps({ FUNDING_WALLET_SECRET_KEY: WALLET })).toBeUndefined();
    expect(
      dripDeps({ SUPABASE_URL: DB.SUPABASE_URL, FUNDING_WALLET_SECRET_KEY: WALLET }),
    ).toBeUndefined();
    expect(
      dripDeps({ SUPABASE_SERVICE_ROLE_KEY: 'k', FUNDING_WALLET_SECRET_KEY: WALLET }),
    ).toBeUndefined();
  });

  it('leaves the wallet out when its key is missing or unreadable, so the handler refuses', () => {
    expect(dripDeps(DB)?.treasury).toBeUndefined();
    expect(dripDeps({ ...DB, FUNDING_WALLET_SECRET_KEY: 'garbage' })?.treasury).toBeUndefined();
  });

  it('uses the supplied RPC, or devnet by default', () => {
    expect(
      dripDeps({ ...DB, FUNDING_WALLET_SECRET_KEY: WALLET, SOLANA_RPC_URL: 'https://rpc.example' }),
    ).toBeDefined();
    expect(dripDeps({ ...DB, FUNDING_WALLET_SECRET_KEY: WALLET })).toBeDefined();
  });

  it('passes its logger through', () => {
    const log = vi.fn();
    dripDeps({ ...DB, FUNDING_WALLET_SECRET_KEY: WALLET }, log)?.log({ event: 'x' });
    expect(log).toHaveBeenCalledWith({ event: 'x' });
  });
});

describe('event wiring', () => {
  it('stores events through the database client it was given', async () => {
    const inserted: unknown[] = [];
    const fakeClient = (() => ({
      from: () => ({
        insert: async (row: unknown) => {
          inserted.push(row);
          return { error: null };
        },
      }),
      rpc: async () => ({ data: 1, error: null }),
    })) as unknown as Parameters<typeof eventDeps>[1];
    const deps = eventDeps(DB, fakeClient);
    await deps?.store({ name: 'app_open', session: 'abcdefgh1', at: 0, props: {} });
    expect(inserted).toEqual([
      { name: 'app_open', session: 'abcdefgh1', at: '1970-01-01T00:00:00.000Z', props: {} },
    ]);
    expect(await deps?.counter.increment('k', 'd')).toBe(1);
  });

  it('asks the client to keep no login state, since a server has no user', () => {
    let options: unknown;
    const spy = ((_url: string, _key: string, opts: unknown) => {
      options = opts;
      return {};
    }) as unknown as Parameters<typeof eventDeps>[1];
    eventDeps(DB, spy);
    expect(options).toEqual({ auth: { persistSession: false, autoRefreshToken: false } });
  });

  it('builds with a database and uses the default limit', () => {
    const deps = eventDeps(DB);
    expect(deps?.perIpPerDay).toBe(DEFAULT_EVENT_LIMIT);
    expect(typeof deps?.now()).toBe('number');
    expect(typeof deps?.store).toBe('function');
  });

  it('is unavailable without a database', () => {
    expect(eventDeps({})).toBeUndefined();
    expect(eventDeps({ SUPABASE_URL: DB.SUPABASE_URL })).toBeUndefined();
  });
});
