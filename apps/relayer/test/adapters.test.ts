import { Keypair, SystemInstruction, SystemProgram, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import type { ChainLike, DatabaseLike } from '../src/adapters.js';
import { DatabaseCounter, SolanaTreasury, parseTreasuryKey, storeEvent } from '../src/adapters.js';

type RpcResult = { data: unknown; error: { message: string } | null };

function fakeDb(
  rpcResult: RpcResult = { data: 1, error: null },
  insertError: string | null = null,
) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const db: DatabaseLike = {
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      return rpcResult;
    },
    from: (table) => ({
      insert: async (row) => {
        inserted.push({ table, row });
        return { error: insertError ? { message: insertError } : null };
      },
    }),
  };
  return { db, calls, inserted };
}

describe('DatabaseCounter', () => {
  it('calls the atomic SQL function and returns the new total', async () => {
    const { db, calls } = fakeDb({ data: 3, error: null });
    expect(await new DatabaseCounter(db).increment('key:A', '2026-10-06')).toBe(3);
    expect(calls).toEqual([
      { fn: 'rate_increment', args: { p_key: 'key:A', p_day: '2026-10-06' } },
    ]);
  });

  it('gives a count back through the matching function', async () => {
    const { db, calls } = fakeDb({ data: null, error: null });
    await new DatabaseCounter(db).decrement('key:A', '2026-10-06');
    expect(calls).toEqual([
      { fn: 'rate_decrement', args: { p_key: 'key:A', p_day: '2026-10-06' } },
    ]);
  });

  it('turns a database error into an error, never into a count that would let a request through', async () => {
    const { db } = fakeDb({ data: null, error: { message: 'connection refused' } });
    await expect(new DatabaseCounter(db).increment('k', 'd')).rejects.toThrow(/connection refused/);
    await expect(new DatabaseCounter(db).decrement('k', 'd')).rejects.toThrow(/connection refused/);
  });

  it.each([[null], ['3'], [undefined], [{}], [[1]]])(
    'refuses an unexpected answer %j',
    async (data) => {
      const { db } = fakeDb({ data, error: null });
      await expect(new DatabaseCounter(db).increment('k', 'd')).rejects.toThrow(/unexpected value/);
    },
  );
});

describe('storeEvent', () => {
  it('inserts a row with an ISO timestamp', async () => {
    const { db, inserted } = fakeDb();
    await storeEvent(db, {
      name: 'app_open',
      session: 'abcdefgh1',
      at: Date.UTC(2026, 9, 6),
      props: { a: 1 },
    });
    expect(inserted).toEqual([
      {
        table: 'events',
        row: {
          name: 'app_open',
          session: 'abcdefgh1',
          at: '2026-10-06T00:00:00.000Z',
          props: { a: 1 },
        },
      },
    ]);
  });

  it('reports a failed insert', async () => {
    const { db } = fakeDb(undefined, 'disk full');
    await expect(
      storeEvent(db, { name: 'app_open', session: 'abcdefgh1', at: 0, props: {} }),
    ).rejects.toThrow(/disk full/);
  });
});

describe('parseTreasuryKey', () => {
  const wallet = Keypair.generate();

  it('reads a Solana CLI style key', () => {
    expect(parseTreasuryKey(JSON.stringify([...wallet.secretKey]))?.publicKey.toBase58()).toBe(
      wallet.publicKey.toBase58(),
    );
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['not JSON', 'nope'],
    ['not an array', '{"a":1}'],
    ['the wrong length', JSON.stringify([1, 2, 3])],
    ['out of range', JSON.stringify(Array(64).fill(999))],
    ['fractional', JSON.stringify(Array(64).fill(1.5))],
    ['halves that disagree', JSON.stringify(Array(64).fill(7))],
  ])('refuses a key that is %s, so the drip fails closed', (_name, raw) => {
    expect(parseTreasuryKey(raw)).toBeUndefined();
  });

  it('does not leak the secret in any failure', () => {
    const bad = JSON.stringify([...wallet.secretKey].map((n, i) => (i === 40 ? (n + 1) % 256 : n)));
    let message = '';
    try {
      parseTreasuryKey(bad);
    } catch (e) {
      message = String(e);
    }
    expect(message).toBe('');
  });
});

describe('SolanaTreasury', () => {
  const wallet = Keypair.generate();
  const recipient = Keypair.generate().publicKey;

  function fakeChain(balances: Record<string, number> = {}) {
    const sent: Buffer[] = [];
    const confirmed: unknown[] = [];
    const chain: ChainLike = {
      getBalance: async (key) => balances[key.toBase58()] ?? 0,
      getLatestBlockhash: async () => ({
        blockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: 50,
      }),
      sendRawTransaction: async (raw) => {
        sent.push(Buffer.from(raw as Uint8Array));
        return 'TheSignature';
      },
      confirmTransaction: (async (strategy: unknown) => {
        confirmed.push(strategy);
        return { context: { slot: 1 }, value: { err: null } };
      }) as ChainLike['confirmTransaction'],
    };
    return { chain, sent, confirmed };
  }

  it('reads balances for a player and for its own wallet', async () => {
    const { chain } = fakeChain({
      [recipient.toBase58()]: 42,
      [wallet.publicKey.toBase58()]: 7_000,
    });
    const treasury = new SolanaTreasury(wallet, chain);
    expect(await treasury.balanceOf(recipient.toBase58())).toBe(42);
    expect(await treasury.treasuryBalance()).toBe(7_000);
  });

  it('signs one plain transfer of exactly the requested amount, paid for by the wallet', async () => {
    const { chain, sent } = fakeChain();
    const signature = await new SolanaTreasury(wallet, chain).send(
      recipient.toBase58(),
      10_000_000,
    );
    expect(signature).toBe('TheSignature');

    const tx = Transaction.from(sent[0] as Buffer);
    expect(tx.feePayer?.toBase58()).toBe(wallet.publicKey.toBase58());
    expect(tx.instructions).toHaveLength(1);
    const ix = tx.instructions[0];
    expect(ix?.programId.equals(SystemProgram.programId)).toBe(true);
    expect(SystemInstruction.decodeInstructionType(ix as never)).toBe('Transfer');
    const decoded = SystemInstruction.decodeTransfer(ix as never);
    expect(decoded.lamports).toBe(10_000_000n);
    expect(decoded.toPubkey.toBase58()).toBe(recipient.toBase58());
    expect(decoded.fromPubkey.toBase58()).toBe(wallet.publicKey.toBase58());
    expect(tx.verifySignatures()).toBe(true);
  });

  it('waits for confirmation before reporting success', async () => {
    const { chain, confirmed } = fakeChain();
    await new SolanaTreasury(wallet, chain).send(recipient.toBase58(), 1);
    expect(confirmed).toEqual([
      {
        signature: 'TheSignature',
        blockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: 50,
      },
    ]);
  });

  it('lets a chain failure surface so the handler can refund the allowance', async () => {
    const { chain } = fakeChain();
    chain.sendRawTransaction = async () => {
      throw new Error('blockhash expired');
    };
    await expect(new SolanaTreasury(wallet, chain).send(recipient.toBase58(), 1)).rejects.toThrow(
      /expired/,
    );
  });
});
