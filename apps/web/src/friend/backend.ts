import type { Chain, Transport } from '@accident/protocol';
import { SolanaChain } from '@accident/solana';
import { Connection, PublicKey } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';
import { Buffer } from 'buffer';
import { SimChain } from './simChain.js';
import { SupabaseTransport, TabTransport } from './transports.js';

// @solana/web3.js builds its Memo instruction data with Node's Buffer (packages/solana/src/chain.ts),
// which only exists as a browser global if something defines it. Vite does not polyfill it, so the
// first real on-chain commit crashed every browser with "Buffer is not defined" the moment a secret
// was locked in; nothing in the test suite caught this because tests run in real Node, where Buffer
// is already a true global. Importing the `buffer` package here (not Node's own, which does not
// exist for the bundler) and assigning it keeps the shim out of the always-loaded entry, since this
// module is only reached once friend mode's live backend is lazily loaded.
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer;
}

/** Which services friend mode talks to. */
/** `zend`: running as a ZApp inside Zend (records on Zend, no funding). */
export type BackendKind = 'live' | 'sim' | 'zend';

export interface Backend {
  kind: BackendKind;
  /** A new transport for one game. */
  transport(): Transport;
  chain: Chain;
  /** Where to send a player to see a transaction. Undefined in simulation. */
  explorerUrl(signature: string): string | undefined;
  /** Asks for a little devnet SOL for a new key. Simulation needs none. */
  fund(publicKey: string): Promise<FundResult>;
}

export type FundResult = { ok: true; alreadyFunded: boolean } | { ok: false; reason: string };

export interface BackendEnv {
  VITE_BACKEND?: string | undefined;
  VITE_SOLANA_RPC_URL?: string | undefined;
  VITE_SUPABASE_URL?: string | undefined;
  VITE_SUPABASE_ANON_KEY?: string | undefined;
  VITE_DRIP_URL?: string | undefined;
  /** `off` sends game messages over Supabase only; anything else also uses Zend live rooms. */
  VITE_ZEND_LIVE?: string | undefined;
}

export const DEFAULT_RPC = 'https://api.devnet.solana.com';

/**
 * Tries `attempt` up to `attempts` times, waiting `backoffMs * 2^n` between tries. One flaky
 * reply (a dropped connection, a 502 from an edge node) should not be the whole story; this is
 * the same bounded-retry shape `Session.sendMemo` already uses for Memo transactions.
 */
async function withRetry<T>(
  attempt: () => Promise<T>,
  attempts: number,
  backoffMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(backoffMs * 2 ** (i - 1));
    try {
      return await attempt();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('The request failed');
}

/** What is missing for the live backend, so the UI can say exactly what to configure. */
export function missingConfig(env: BackendEnv): string[] {
  const missing: string[] = [];
  if (!env.VITE_SUPABASE_URL) missing.push('VITE_SUPABASE_URL');
  if (!env.VITE_SUPABASE_ANON_KEY) missing.push('VITE_SUPABASE_ANON_KEY');
  return missing;
}

/** Which backend to use: simulation only when asked for; otherwise live. */
export function backendKind(env: BackendEnv): BackendKind {
  return env.VITE_BACKEND === 'sim' ? 'sim' : 'live';
}

/**
 * Asks the drip service for devnet SOL. It is the only server this app talks to besides the relay
 * and the RPC, and it only ever sends worthless test tokens.
 */
export async function requestDrip(
  dripUrl: string,
  publicKey: string,
  fetcher: typeof fetch = fetch,
): Promise<FundResult> {
  try {
    // A fetch can reject outright (offline, DNS hiccup, dropped connection) well before the
    // service ever gets to answer with its own error body; that case is worth one quiet retry
    // rather than sending a new player straight to a dead end. A reply the service did send
    // (even an error one) is final and is not retried.
    const response = await withRetry(
      () =>
        fetcher(dripUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pubkey: publicKey }),
        }),
      2,
      500,
    );
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      funded?: boolean;
      error?: string;
    };
    if (response.ok && body.ok) return { ok: true, alreadyFunded: body.funded === false };
    return { ok: false, reason: body.error ?? `The funding service answered ${response.status}` };
  } catch {
    return { ok: false, reason: 'Could not reach the funding service' };
  }
}

export function createBackend(env: BackendEnv): Backend {
  if (backendKind(env) === 'sim') {
    return {
      kind: 'sim',
      transport: () => new TabTransport(),
      chain: new SimChain(),
      explorerUrl: () => undefined,
      fund: async () => ({ ok: true, alreadyFunded: true }),
    };
  }

  const missing = missingConfig(env);
  if (missing.length > 0) {
    throw new Error(`Friend mode is not configured. Missing: ${missing.join(', ')}`);
  }
  const connection = new Connection(env.VITE_SOLANA_RPC_URL || DEFAULT_RPC, 'confirmed');
  const realtime = createClient(
    env.VITE_SUPABASE_URL as string,
    env.VITE_SUPABASE_ANON_KEY as string,
    {
      realtime: { params: { eventsPerSecond: 10 } },
    },
  );
  const dripUrl = env.VITE_DRIP_URL ?? '/api/drip';

  return {
    kind: 'live',
    transport: () => new SupabaseTransport(realtime),
    chain: new SolanaChain({ connection }),
    explorerUrl: (signature) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    async fund(publicKey) {
      let balance: number;
      try {
        // One flaky devnet RPC reply should not read as "needs funding" (or crash the setup
        // screen); try a couple of times before giving up on the check itself.
        balance = await withRetry(
          () => connection.getBalance(new PublicKey(publicKey), 'confirmed'),
          3,
          500,
        );
      } catch {
        return { ok: false, reason: 'Could not check your balance. Please try again.' };
      }
      // Four Memo transactions cost 0.00002 SOL. Anything above a small floor is plenty.
      if (balance >= MIN_BALANCE_LAMPORTS) return { ok: true, alreadyFunded: true };
      return requestDrip(dripUrl, publicKey);
    },
  };
}

/** Enough for about 100 transactions at 5,000 lamports each. */
export const MIN_BALANCE_LAMPORTS = 500_000;
