import { Analytics, noopAnalytics } from '../friend/analytics.js';
import { readEnv } from '../friend/env.js';

let instance: Analytics | undefined;

/**
 * The app-wide analytics object. Disabled in the simulation build so a developer playing against
 * themselves does not generate events. Built on first use so importing this never touches storage.
 *
 * This reads the backend choice from the environment directly rather than through `backend.ts`, so
 * that importing analytics (which the always-loaded App does) never pulls in the Solana and
 * Supabase clients. Those stay behind the lazily loaded friend-mode chunk.
 */
export function analytics(): Analytics {
  instance ??= readEnv().VITE_BACKEND === 'sim' ? noopAnalytics : new Analytics();
  return instance;
}

/** Test hook. */
export function resetAnalytics(): void {
  instance = undefined;
}
