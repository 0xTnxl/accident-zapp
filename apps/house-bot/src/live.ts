import { Connection } from '@solana/web3.js';
import type { Identity, Storage, Transport } from '@accident/protocol';
import { generateIdentity } from '@accident/protocol';
import { SolanaChain } from '@accident/solana';
import { HouseBot } from './bot.js';

/**
 * Live wiring for the House Bot. This file is for manual/operational use only: it is never imported
 * by a test and does no network I/O at import time (everything happens inside {@link runLiveBot}).
 *
 * It reads its configuration from the environment and plays one game as a labelled bot:
 * - `ACCIDENT_RPC_URL`  Solana RPC endpoint (defaults to devnet).
 * - `ACCIDENT_ROOM`     the room code to join (required).
 * - `ACCIDENT_ROLE`     'host' or 'guest' (defaults to 'guest').
 * - `ACCIDENT_HOST_KEY` the host's public key to pin, when joining as a guest.
 */
export interface LiveConfig {
  rpcUrl: string;
  room: string;
  role: 'host' | 'guest';
  hostKey: string | undefined;
}

/** Reads the bot's configuration from `process.env`, failing loudly if the room is missing. */
export function liveConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const room = env.ACCIDENT_ROOM;
  if (!room) throw new Error('ACCIDENT_ROOM is required');
  const role = env.ACCIDENT_ROLE === 'host' ? 'host' : 'guest';
  return {
    rpcUrl: env.ACCIDENT_RPC_URL ?? 'https://api.devnet.solana.com',
    room,
    role,
    hostKey: env.ACCIDENT_HOST_KEY,
  };
}

/** The minimum a live bot needs beyond its chain: a relay transport and a place to save state. */
export interface LiveDeps {
  transport: Transport;
  storage: Storage;
  identity?: Identity;
}

/** A plain in-process key-value store, enough for a single live game. */
class MemoryStore implements Storage {
  private readonly data = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
}

/**
 * Builds a {@link HouseBot} wired to a real {@link SolanaChain} and the given relay transport, then
 * starts it. The caller supplies the transport (e.g. a Supabase Realtime adapter) so this module
 * stays free of any relay-specific dependency, and so the bot can be driven by whatever relay the
 * room uses. Nothing here runs until it is called.
 */
export async function runLiveBot(config: LiveConfig, deps: LiveDeps): Promise<HouseBot> {
  const chain = new SolanaChain({ connection: new Connection(config.rpcUrl, 'confirmed') });
  const bot = new HouseBot({
    room: config.room,
    role: config.role,
    identity: deps.identity ?? generateIdentity(),
    ...(config.hostKey === undefined ? {} : { hostKey: config.hostKey }),
    transport: deps.transport,
    chain,
    storage: deps.storage ?? new MemoryStore(),
    clock: { now: () => Date.now(), setTimeout: wallClockTimer },
  });
  await bot.start();
  return bot;
}

function wallClockTimer(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
}
