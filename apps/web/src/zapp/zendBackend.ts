import type { AttestReceipt, ZendPort } from '@accident/zend';
import { ZendChain } from '@accident/zend';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Backend, BackendEnv } from '../friend/backend.js';
import { SupabaseTransport } from '../friend/transports.js';
import { DualTransport, ZendLiveTransport } from './liveTransport.js';
import type { Zend } from './appkit.js';

/** Zend's public API, for the attestation key and receipts (both public, no auth). */
export const ZEND_API = 'https://api.usezend.app';

/** `@zend/appkit` plus the public receipts endpoint, shaped as the port `ZendChain` needs. */
export function zendPort(zend: Zend, api = ZEND_API): ZendPort {
  return {
    attest: (p) => zend.attest(p),
    async getInteraction(id) {
      const i = await zend.interaction.get(id);
      return { state: i.state, data: i.data };
    },
    async mergeData(id, state, data, idempotencyKey) {
      // Same state, new data: allowed by Zend for any unfinished interaction.
      await zend.interaction.update(id, { state, data, idempotencyKey });
    },
    async receipts(interactionId) {
      const r = await fetch(`${api}/api/zend/v2/apps/attest/interactions/${encodeURIComponent(interactionId)}`);
      if (!r.ok) throw new Error(`receipts ${r.status}`);
      return ((await r.json()) as { receipts: AttestReceipt[] }).receipts;
    },
  };
}

/** Zend's receipt-signing key. Without it receipts are still required, just not signature-checked. */
export async function zendAttestKey(api = ZEND_API): Promise<string | undefined> {
  try {
    const r = await fetch(`${api}/api/zend/v2/apps/attest/key`);
    if (!r.ok) return undefined;
    return ((await r.json()) as { public_key?: string }).public_key;
  } catch {
    return undefined;
  }
}

/**
 * Friend mode inside Zend: live moves over the Supabase relay as before, commit/reveal records on
 * Zend instead of Solana, and no funding step (Zend records cost players nothing).
 */
export function createZendBackend(
  env: BackendEnv,
  zend: Zend,
  interactionId: string,
  zendPublicKey: string | undefined,
): { backend: Backend; chain: ZendChain; realtime: SupabaseClient } {
  if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
    throw new Error('Accident is not configured. Missing: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY');
  }
  const realtime = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
    realtime: { params: { eventsPerSecond: 10 } },
  });
  const chain = new ZendChain({
    port: zendPort(zend),
    interactionId,
    ...(zendPublicKey === undefined ? {} : { zendPublicKey }),
  });
  return {
    chain,
    realtime,
    backend: {
      kind: 'zend',
      // Supabase stays on while players move to Zend live rooms: sending on both means an older
      // tab or Zend app still gets every message. Set VITE_ZEND_LIVE=off to use Supabase only.
      transport: () =>
        env.VITE_ZEND_LIVE === 'off'
          ? new SupabaseTransport(realtime)
          : new DualTransport([new SupabaseTransport(realtime), new ZendLiveTransport(zend, interactionId)]),
      chain,
      explorerUrl: () => undefined,
      fund: async () => ({ ok: true, alreadyFunded: true }),
    },
  };
}
