import { Connection } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';
import type { DatabaseLike } from './adapters.js';
import { DatabaseCounter, SolanaTreasury, parseTreasuryKey, storeEvent } from './adapters.js';
import type { DripDeps } from './drip.js';
import { DEFAULT_DRIP } from './drip.js';
import type { EventDeps } from './event.js';
import { DEFAULT_EVENT_LIMIT } from './event.js';
import type { LadderDeps } from './ladder/handler.js';
import { LadderStore } from './ladder/store.js';
import { DEFAULT_ZEND_API, HttpZendApi } from './ladder/zend.js';

/** Everything the functions read from the host's environment. Secrets live here and nowhere else. */
export interface RelayerEnv {
  SOLANA_RPC_URL?: string | undefined;
  /** JSON array of 64 numbers. Only ever set as a host secret, never in the repository. */
  FUNDING_WALLET_SECRET_KEY?: string | undefined;
  SUPABASE_URL?: string | undefined;
  SUPABASE_SERVICE_ROLE_KEY?: string | undefined;
  /** Accident's Zend app key (`zapp_sk_...`), from `zend apps create`. Host secret. */
  ZEND_APP_KEY?: string | undefined;
  /** Override for testing against another Zend; defaults to production. */
  ZEND_API_URL?: string | undefined;
}

export const DEFAULT_RPC = 'https://api.devnet.solana.com';

function database(
  env: RelayerEnv,
  make: typeof createClient = createClient,
): DatabaseLike | undefined {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return undefined;
  return make(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as DatabaseLike;
}

/**
 * Builds the drip handler's dependencies from the environment. Anything missing leaves the
 * dependency out, and the handler refuses to act. It never falls back to something permissive.
 */
export function dripDeps(
  env: RelayerEnv,
  log: DripDeps['log'] = console.log,
): DripDeps | undefined {
  const db = database(env);
  if (!db) return undefined; // without a counter there are no limits, so do not serve at all
  const wallet = parseTreasuryKey(env.FUNDING_WALLET_SECRET_KEY);
  const connection = new Connection(env.SOLANA_RPC_URL || DEFAULT_RPC, 'confirmed');
  return {
    treasury: wallet ? new SolanaTreasury(wallet, connection) : undefined,
    counter: new DatabaseCounter(db),
    config: DEFAULT_DRIP,
    now: Date.now,
    log,
  };
}

export function eventDeps(
  env: RelayerEnv,
  make: typeof createClient = createClient,
): EventDeps | undefined {
  const db = database(env, make);
  if (!db) return undefined;
  return {
    counter: new DatabaseCounter(db),
    store: (record) => storeEvent(db, record),
    perIpPerDay: DEFAULT_EVENT_LIMIT,
    now: Date.now,
  };
}

/**
 * Dashboard values are easy to paste with extras: surrounding spaces or quotes, or the whole
 * `NAME=value` line the Zend CLI prints. Accept those and use just the value.
 */
export function cleanSecret(raw: string | undefined, name: string): string | undefined {
  if (raw === undefined) return undefined;
  let v = raw.trim();
  if (v.startsWith(`${name}=`)) v = v.slice(name.length + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1).trim();
  return v === '' ? undefined : v;
}

/** The leaderboard and tournaments need both Supabase and Zend; without either they don't serve. */
export function ladderDeps(env: RelayerEnv, make: typeof createClient = createClient): LadderDeps | undefined {
  const url = cleanSecret(env.SUPABASE_URL, 'SUPABASE_URL');
  const serviceKey = cleanSecret(env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY');
  const appKey = cleanSecret(env.ZEND_APP_KEY, 'ZEND_APP_KEY');
  // Names and shape only, never values, so the logs say what to fix without leaking anything.
  const problems = [
    !url && 'SUPABASE_URL is not set',
    !serviceKey && 'SUPABASE_SERVICE_ROLE_KEY is not set',
    !appKey && 'ZEND_APP_KEY is not set',
    appKey && !appKey.startsWith('zapp_sk_') && `ZEND_APP_KEY should start with zapp_sk_ (it starts with "${appKey.slice(0, 4)}")`,
  ].filter((p): p is string => typeof p === 'string');
  if (problems.length > 0 || !url || !serviceKey || !appKey) {
    console.error(`ladder unavailable: ${problems.join('; ')}`);
    return undefined;
  }
  const db = make(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    store: new LadderStore(db),
    zend: new HttpZendApi(appKey, cleanSecret(env.ZEND_API_URL, 'ZEND_API_URL') || DEFAULT_ZEND_API),
    now: Date.now,
  };
}
