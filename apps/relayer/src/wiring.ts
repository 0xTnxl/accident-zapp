import { Connection } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';
import type { DatabaseLike } from './adapters.js';
import { DatabaseCounter, SolanaTreasury, parseTreasuryKey, storeEvent } from './adapters.js';
import type { DripDeps } from './drip.js';
import { DEFAULT_DRIP } from './drip.js';
import type { EventDeps } from './event.js';
import { DEFAULT_EVENT_LIMIT } from './event.js';

/** Everything the functions read from the host's environment. Secrets live here and nowhere else. */
export interface RelayerEnv {
  SOLANA_RPC_URL?: string | undefined;
  /** JSON array of 64 numbers. Only ever set as a host secret, never in the repository. */
  FUNDING_WALLET_SECRET_KEY?: string | undefined;
  SUPABASE_URL?: string | undefined;
  SUPABASE_SERVICE_ROLE_KEY?: string | undefined;
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
