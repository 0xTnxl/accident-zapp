import type { Connection } from '@solana/web3.js';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import type { Treasury } from './drip.js';
import type { EventRecord } from './event.js';
import type { Counter } from './http.js';

/** The slice of the Supabase client the relayer uses, so tests can supply a fake. */
export interface DatabaseLike {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from(table: string): {
    insert(row: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
  };
}

/** Counters kept in Postgres, incremented by one atomic SQL function (see supabase/migrations). */
export class DatabaseCounter implements Counter {
  constructor(private readonly db: DatabaseLike) {}

  async increment(key: string, day: string): Promise<number> {
    const { data, error } = await this.db.rpc('rate_increment', { p_key: key, p_day: day });
    if (error) throw new Error(`rate_increment failed: ${error.message}`);
    if (typeof data !== 'number') throw new Error('rate_increment returned an unexpected value');
    return data;
  }

  async decrement(key: string, day: string): Promise<void> {
    const { error } = await this.db.rpc('rate_decrement', { p_key: key, p_day: day });
    if (error) throw new Error(`rate_decrement failed: ${error.message}`);
  }
}

export async function storeEvent(db: DatabaseLike, record: EventRecord): Promise<void> {
  const { error } = await db.from('events').insert({
    name: record.name,
    session: record.session,
    at: new Date(record.at).toISOString(),
    props: record.props,
  });
  if (error) throw new Error(`Could not store the event: ${error.message}`);
}

/** The slice of the Solana connection the treasury uses. */
export type ChainLike = Pick<
  Connection,
  'getBalance' | 'getLatestBlockhash' | 'sendRawTransaction' | 'confirmTransaction'
>;

/**
 * Parses the funding wallet's secret key. It is a JSON array of 64 numbers, the format of a Solana
 * CLI keypair file. Returns `undefined` for anything else, so the drip endpoint fails closed, and
 * never includes the value in an error.
 */
export function parseTreasuryKey(raw: string | undefined): Keypair | undefined {
  if (!raw) return undefined;
  try {
    const bytes = JSON.parse(raw) as unknown;
    if (!Array.isArray(bytes) || bytes.length !== 64) return undefined;
    if (!bytes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return undefined;
    return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
  } catch {
    return undefined;
  }
}

/** The funding wallet. It only ever signs a plain transfer of a fixed amount. */
export class SolanaTreasury implements Treasury {
  constructor(
    private readonly wallet: Keypair,
    private readonly chain: ChainLike,
  ) {}

  balanceOf(publicKey: string): Promise<number> {
    return this.chain.getBalance(new PublicKey(publicKey), 'confirmed');
  }

  treasuryBalance(): Promise<number> {
    return this.chain.getBalance(this.wallet.publicKey, 'confirmed');
  }

  async send(publicKey: string, lamports: number): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await this.chain.getLatestBlockhash('confirmed');
    const transaction = new Transaction({
      feePayer: this.wallet.publicKey,
      blockhash,
      lastValidBlockHeight,
    }).add(
      SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: new PublicKey(publicKey),
        lamports,
      }),
    );
    transaction.sign(this.wallet);
    const signature = await this.chain.sendRawTransaction(transaction.serialize());
    await this.chain.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    return signature;
  }
}
