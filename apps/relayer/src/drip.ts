import { isValidPublicKey } from '@accident/protocol';
import type { Counter } from './http.js';
import { clientIp, dayOf, error, json, readJson } from './http.js';

export const LAMPORTS_PER_SOL = 1_000_000_000;

export interface DripConfig {
  /** How much to send each time. Fixed: the caller never chooses an amount. */
  amountLamports: number;
  /** A key that already holds at least this much is not topped up. */
  skipAboveLamports: number;
  /** Refuse to send if it would leave the funding wallet with less than this. */
  reserveLamports: number;
  /** At most this many drips per key per day. */
  perKeyPerDay: number;
  /** At most this many drips per client address per day, so fresh keys cannot bypass the limit. */
  perIpPerDay: number;
}

export const DEFAULT_DRIP: DripConfig = {
  amountLamports: 0.01 * LAMPORTS_PER_SOL,
  skipAboveLamports: 0.005 * LAMPORTS_PER_SOL,
  reserveLamports: 0.5 * LAMPORTS_PER_SOL,
  perKeyPerDay: 1,
  perIpPerDay: 5,
};

/** The funding wallet and the chain, reduced to what the handler needs. */
export interface Treasury {
  balanceOf(publicKey: string): Promise<number>;
  /** The funding wallet's own balance. */
  treasuryBalance(): Promise<number>;
  /** Sends `lamports` to `publicKey` and returns the transaction signature. */
  send(publicKey: string, lamports: number): Promise<string>;
}

export interface DripDeps {
  /** `undefined` when the wallet is not configured. The handler then refuses, it never guesses. */
  treasury: Treasury | undefined;
  counter: Counter;
  config: DripConfig;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
}

/**
 * POST /api/drip  {"pubkey": "<base58>"}
 *
 * Gives a new player a little devnet SOL so they can pay the fees for their four Memo transactions.
 * Devnet tokens are worthless, but the wallet that holds them is finite, so every limit here exists
 * to stop one person emptying it.
 */
export async function handleDrip(request: Request, deps: DripDeps): Promise<Response> {
  if (request.method !== 'POST') return error(405, 'Use POST', { allow: 'POST' });
  if (!deps.treasury) return error(503, 'Funding is not available right now');

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const pubkey = (parsed.value as { pubkey?: unknown } | null)?.pubkey;
  if (!isValidPublicKey(pubkey)) return error(400, 'That is not a valid public key');

  const { treasury, counter, config } = deps;

  // Already has enough: nothing to do, and nothing counted against anyone.
  let balance: number;
  try {
    balance = await treasury.balanceOf(pubkey);
  } catch {
    return error(502, 'Could not check the balance');
  }
  if (balance >= config.skipAboveLamports) return json(200, { ok: true, funded: false });

  const day = dayOf(deps.now());
  const ip = clientIp(request);
  const keyUsed = await counter.increment(`key:${pubkey}`, day);
  const ipUsed = await counter.increment(`ip:${ip}`, day);
  const undo = async (): Promise<void> => {
    await counter.decrement(`key:${pubkey}`, day);
    await counter.decrement(`ip:${ip}`, day);
  };

  if (keyUsed > config.perKeyPerDay) {
    await undo();
    return error(429, 'This key has already been funded today');
  }
  if (ipUsed > config.perIpPerDay) {
    await undo();
    return error(429, 'Too many requests from your network today');
  }

  try {
    const reserve = await treasury.treasuryBalance();
    if (reserve - config.amountLamports < config.reserveLamports) {
      await undo();
      deps.log({ event: 'drip-refused-low-reserve', reserve });
      return error(503, 'Funding is paused while the wallet is refilled');
    }
    const signature = await treasury.send(pubkey, config.amountLamports);
    deps.log({ event: 'drip', pubkey, ip, signature, lamports: config.amountLamports });
    return json(200, { ok: true, funded: true, signature });
  } catch {
    // Not sent, so it should not count against the player.
    await undo();
    deps.log({ event: 'drip-failed', pubkey, ip });
    return error(502, 'Could not send funds right now. Please try again.');
  }
}
