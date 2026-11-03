import type { BackendEnv } from './backend.js';

/** The build-time configuration, read once from Vite's environment. */
export function readEnv(): BackendEnv {
  const env = import.meta.env as Record<string, string | undefined>;
  return {
    VITE_BACKEND: env.VITE_BACKEND,
    VITE_SOLANA_RPC_URL: env.VITE_SOLANA_RPC_URL,
    VITE_SUPABASE_URL: env.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: env.VITE_SUPABASE_ANON_KEY,
    VITE_DRIP_URL: env.VITE_DRIP_URL,
  };
}

/**
 * How long the player on the clock has before the other side may claim a timeout, per REQ-13 —
 * a UI convention only, never enforced on-chain. `VITE_TURN_SECONDS` is in whole seconds, since
 * that is what anyone configuring it actually thinks in; `Session` wants milliseconds. Defaults to
 * 60 s if unset, invalid, or not a positive number (the protocol package's own default, used by
 * anyone building a `Session` directly, stays 180 s; this only changes the web app's live default).
 */
export function readTurnMs(): number {
  const raw = (import.meta.env as Record<string, string | undefined>).VITE_TURN_SECONDS;
  const seconds = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000;
}
