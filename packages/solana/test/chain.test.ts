import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import type {
  ConfirmedSignatureInfo,
  ParsedInstruction,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
} from '@solana/web3.js';
import { generateIdentity, identityFromSecretKey } from '@accident/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RpcConnection } from '../src/index.js';
import { MEMO_PROGRAM_ID, SolanaChain, memoInstruction, toMemoTx } from '../src/index.js';

const ROOM = 'ABC234';
const COMMIT = `ACC1|${ROOM}|C|${'ab'.repeat(32)}`;
const REVEAL = `ACC1|${ROOM}|R|1234|${'cd'.repeat(32)}|${'ef'.repeat(32)}`;

function memoIx(text: string, programId: PublicKey = MEMO_PROGRAM_ID): ParsedInstruction {
  return { program: 'spl-memo', programId, parsed: text };
}

function otherIx(programId: PublicKey = SystemProgram.programId): PartiallyDecodedInstruction {
  return { programId, accounts: [], data: '' };
}

function rpcTx(
  payer: string,
  instructions: Array<ParsedInstruction | PartiallyDecodedInstruction>,
  over: { err?: unknown; slot?: number; blockTime?: number | null; signers?: boolean } = {},
): ParsedTransactionWithMeta {
  return {
    slot: over.slot ?? 42,
    blockTime: over.blockTime === undefined ? 1_700_000_000 : over.blockTime,
    version: 'legacy',
    meta: { err: over.err ?? null } as ParsedTransactionWithMeta['meta'],
    transaction: {
      signatures: ['sig'],
      message: {
        recentBlockhash: 'h',
        instructions,
        accountKeys: [
          {
            pubkey: new PublicKey(payer),
            signer: over.signers ?? true,
            writable: true,
            source: 'transaction',
          },
          { pubkey: MEMO_PROGRAM_ID, signer: false, writable: false, source: 'transaction' },
        ],
      },
    },
  } as unknown as ParsedTransactionWithMeta;
}

class FakeRpc implements RpcConnection {
  sent: Buffer[] = [];
  sendOptions: unknown[] = [];
  txs = new Map<string, ParsedTransactionWithMeta | null>();
  infos: ConfirmedSignatureInfo[] = [];
  lastInfosArgs: unknown[] = [];
  lastGetArgs: unknown[] = [];
  blockhash = { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 99 };

  async getLatestBlockhash(): ReturnType<RpcConnection['getLatestBlockhash']> {
    return this.blockhash;
  }

  async sendRawTransaction(
    raw: Buffer | Uint8Array | number[],
    options?: unknown,
  ): Promise<string> {
    this.sent.push(Buffer.from(raw as Uint8Array));
    this.sendOptions.push(options);
    return 'SentSignature111111111111111111111111111111111111111111111111111111111111111111';
  }

  async getParsedTransaction(
    sig: string,
    ...rest: unknown[]
  ): Promise<ParsedTransactionWithMeta | null> {
    this.lastGetArgs = [sig, ...rest];
    return this.txs.get(sig) ?? null;
  }

  async getParsedTransactions(sigs: string[]): Promise<Array<ParsedTransactionWithMeta | null>> {
    return sigs.map((s) => this.txs.get(s) ?? null);
  }

  async getSignaturesForAddress(...args: unknown[]): Promise<ConfirmedSignatureInfo[]> {
    this.lastInfosArgs = args;
    return this.infos;
  }
}

const info = (signature: string, memo: string | null): ConfirmedSignatureInfo =>
  ({ signature, slot: 1, err: null, memo, blockTime: 1 }) as ConfirmedSignatureInfo;

describe('the Memo instruction', () => {
  it('targets the Memo v2 program and lists the signer as a signing account', () => {
    const signer = Keypair.generate().publicKey;
    const ix = memoInstruction(signer, COMMIT);
    expect(ix.programId.toBase58()).toBe('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
    expect(ix.keys).toEqual([{ pubkey: signer, isSigner: true, isWritable: false }]);
    expect(ix.data.toString('utf8')).toBe(COMMIT);
  });

  it('carries the exact bytes of the record, including non-ASCII', () => {
    const ix = memoInstruction(Keypair.generate().publicKey, 'ACC1|é');
    expect([...ix.data]).toEqual([...Buffer.from('ACC1|é', 'utf8')]);
  });
});

describe('sendMemo', () => {
  it('builds a transaction signed by the player, paid by the player, with one Memo', async () => {
    const rpc = new FakeRpc();
    const chain = new SolanaChain({ connection: rpc });
    const player = generateIdentity();
    const sig = await chain.sendMemo(player, COMMIT);
    expect(sig).toMatch(/^SentSignature/);

    expect(rpc.sent).toHaveLength(1);
    const { Transaction } = await import('@solana/web3.js');
    const tx = Transaction.from(rpc.sent[0] as Buffer);
    expect(tx.feePayer?.toBase58()).toBe(player.publicKey);
    expect(tx.recentBlockhash).toBe(rpc.blockhash.blockhash);
    expect(tx.instructions).toHaveLength(1);
    expect(tx.instructions[0]?.programId.equals(MEMO_PROGRAM_ID)).toBe(true);
    expect(tx.instructions[0]?.data.toString('utf8')).toBe(COMMIT);
    expect(tx.signatures).toHaveLength(1);
    expect(tx.verifySignatures()).toBe(true);
  });

  it('signs with the same key the protocol uses for relay messages', async () => {
    const rpc = new FakeRpc();
    const chain = new SolanaChain({ connection: rpc });
    const seed = Keypair.generate();
    const identity = identityFromSecretKey(seed.secretKey);
    await chain.sendMemo(identity, REVEAL);
    const { Transaction } = await import('@solana/web3.js');
    const tx = Transaction.from(rpc.sent[0] as Buffer);
    expect(tx.feePayer?.toBase58()).toBe(seed.publicKey.toBase58());
    expect(tx.verifySignatures()).toBe(true);
  });

  it('submits with the configured commitment for preflight', async () => {
    const rpc = new FakeRpc();
    await new SolanaChain({ connection: rpc, commitment: 'finalized' }).sendMemo(
      generateIdentity(),
      COMMIT,
    );
    expect(rpc.sendOptions[0]).toEqual({ preflightCommitment: 'finalized' });
    const fallback = new FakeRpc();
    await new SolanaChain({ connection: fallback }).sendMemo(generateIdentity(), COMMIT);
    expect(fallback.sendOptions[0]).toEqual({ preflightCommitment: 'confirmed' });
  });

  it('propagates a submission failure to the caller so the session can retry', async () => {
    const rpc = new FakeRpc();
    rpc.sendRawTransaction = async () => {
      throw new Error('Blockhash not found');
    };
    await expect(
      new SolanaChain({ connection: rpc }).sendMemo(generateIdentity(), COMMIT),
    ).rejects.toThrow(/Blockhash not found/);
  });
});

describe('a hung RPC call', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('times out sendMemo rather than waiting forever, so the session can retry', async () => {
    vi.useFakeTimers();
    const rpc = new FakeRpc();
    rpc.getLatestBlockhash = () => new Promise(() => undefined); // never resolves
    const promise = new SolanaChain({ connection: rpc, rpcTimeoutMs: 5_000 }).sendMemo(
      generateIdentity(),
      COMMIT,
    );
    const assertion = expect(promise).rejects.toThrow(/Timed out waiting for getLatestBlockhash/);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it('times out getMemoTx the same way, using the configured limit', async () => {
    vi.useFakeTimers();
    const rpc = new FakeRpc();
    rpc.getParsedTransaction = () => new Promise(() => undefined);
    const promise = new SolanaChain({ connection: rpc, rpcTimeoutMs: 2_000 }).getMemoTx('s1');
    const assertion = expect(promise).rejects.toThrow(/Timed out waiting for getParsedTransaction/);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
  });

  it('times out listMemoTxs while scanning', async () => {
    vi.useFakeTimers();
    const rpc = new FakeRpc();
    rpc.getSignaturesForAddress = () => new Promise(() => undefined);
    const promise = new SolanaChain({ connection: rpc, rpcTimeoutMs: 3_000 }).listMemoTxs(
      Keypair.generate().publicKey.toBase58(),
      ROOM,
    );
    const assertion = expect(promise).rejects.toThrow(
      /Timed out waiting for getSignaturesForAddress/,
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
  });

  it('defaults the timeout to 10 seconds when not configured', async () => {
    vi.useFakeTimers();
    const rpc = new FakeRpc();
    rpc.getLatestBlockhash = () => new Promise(() => undefined);
    const promise = new SolanaChain({ connection: rpc }).sendMemo(generateIdentity(), COMMIT);
    const assertion = expect(promise).rejects.toThrow(/after 10000ms/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it('still resolves normally when the call finishes before the timeout', async () => {
    const rpc = new FakeRpc();
    const chain = new SolanaChain({ connection: rpc, rpcTimeoutMs: 50 });
    await expect(chain.sendMemo(generateIdentity(), COMMIT)).resolves.toMatch(/^SentSignature/);
  });

  it('does not mistake a slow success for a timeout once it does resolve', async () => {
    vi.useFakeTimers();
    const rpc = new FakeRpc();
    let release = (): void => undefined;
    rpc.getLatestBlockhash = () =>
      new Promise((resolve) => {
        release = () => resolve(rpc.blockhash);
      });
    const chain = new SolanaChain({ connection: rpc, rpcTimeoutMs: 100_000 });
    const promise = chain.sendMemo(generateIdentity(), COMMIT);
    await vi.advanceTimersByTimeAsync(1_000);
    release();
    await expect(promise).resolves.toMatch(/^SentSignature/);
  });
});

describe('reading a transaction', () => {
  const player = Keypair.generate().publicKey.toBase58();

  it('returns the memo, signer, slot and block time of a genuine Memo transaction', async () => {
    const rpc = new FakeRpc();
    rpc.txs.set('s1', rpcTx(player, [memoIx(COMMIT)], { slot: 777, blockTime: 1_234 }));
    const tx = await new SolanaChain({ connection: rpc }).getMemoTx('s1');
    expect(tx).toEqual({
      sig: 's1',
      signer: player,
      text: COMMIT,
      slot: 777,
      blockTime: 1_234,
      ok: true,
    });
  });

  it('returns null when the transaction is not confirmed yet', async () => {
    const rpc = new FakeRpc();
    expect(await new SolanaChain({ connection: rpc }).getMemoTx('missing')).toBeNull();
  });

  it('asks for the configured commitment and supports versioned transactions', async () => {
    const rpc = new FakeRpc();
    await new SolanaChain({ connection: rpc }).getMemoTx('x');
    expect(rpc.lastGetArgs).toEqual([
      'x',
      { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ]);
  });

  it('treats a real transaction that is not a Memo as not found, never as a Memo', async () => {
    const rpc = new FakeRpc();
    // Someone announces the signature of an ordinary transfer as their commit.
    rpc.txs.set('transfer', rpcTx(player, [otherIx()]));
    rpc.txs.set('impostor', rpcTx(player, [memoIx(COMMIT, Keypair.generate().publicKey)]));
    const chain = new SolanaChain({ connection: rpc });
    expect(await chain.getMemoTx('transfer')).toBeNull();
    expect(await chain.getMemoTx('impostor')).toBeNull();
  });

  it('reports a failed transaction as not ok, so it never counts', async () => {
    const rpc = new FakeRpc();
    rpc.txs.set(
      'bad',
      rpcTx(player, [memoIx(COMMIT)], { err: { InstructionError: [0, 'Custom'] } }),
    );
    expect((await new SolanaChain({ connection: rpc }).getMemoTx('bad'))?.ok).toBe(false);
  });

  it('keeps a null block time rather than inventing one', () => {
    expect(
      toMemoTx('s', rpcTx(player, [memoIx(COMMIT)], { blockTime: null }))?.blockTime,
    ).toBeNull();
  });

  it('finds the memo among other instructions, as real transactions have', () => {
    const tx = rpcTx(player, [otherIx(), memoIx(COMMIT), otherIx()]);
    expect(toMemoTx('s', tx)?.text).toBe(COMMIT);
  });
});

describe('what is NOT accepted as a Memo', () => {
  const player = Keypair.generate().publicKey.toBase58();
  const impostorProgram = Keypair.generate().publicKey;

  it('a transaction with no Memo instruction', () => {
    expect(toMemoTx('s', rpcTx(player, [otherIx()]))).toBeUndefined();
  });

  it('a look-alike memo written by a different program', () => {
    expect(toMemoTx('s', rpcTx(player, [memoIx(COMMIT, impostorProgram)]))).toBeUndefined();
  });

  it('the older Memo v1 program, which is not the one the game uses', () => {
    const v1 = new PublicKey('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo');
    expect(toMemoTx('s', rpcTx(player, [memoIx(COMMIT, v1)]))).toBeUndefined();
  });

  it('two Memo instructions in one transaction, so a second record cannot be smuggled in', () => {
    expect(toMemoTx('s', rpcTx(player, [memoIx(COMMIT), memoIx(REVEAL)]))).toBeUndefined();
  });

  it('a Memo the node could not decode to text', () => {
    const raw: PartiallyDecodedInstruction = {
      programId: MEMO_PROGRAM_ID,
      accounts: [],
      data: '3Bxs',
    };
    expect(toMemoTx('s', rpcTx(player, [raw]))).toBeUndefined();
    const notText = {
      program: 'spl-memo',
      programId: MEMO_PROGRAM_ID,
      parsed: { odd: true },
    } as unknown as ParsedInstruction;
    expect(toMemoTx('s', rpcTx(player, [notText]))).toBeUndefined();
  });

  it('a transaction with no signer at all', () => {
    expect(toMemoTx('s', rpcTx(player, [memoIx(COMMIT)], { signers: false }))).toBeUndefined();
  });
});

describe('scanning an address', () => {
  const player = Keypair.generate().publicKey.toBase58();
  const other = Keypair.generate().publicKey.toBase58();

  it('returns this room’s records signed by that address, and nothing else', async () => {
    const rpc = new FakeRpc();
    rpc.infos = [
      info('commit', `[78] ${COMMIT}`),
      info('reveal', `[148] ${REVEAL}`),
      info('elsewhere', '[78] ACC1|ZZZ999|C|' + 'ab'.repeat(32)),
      info('unrelated', '[5] hello'),
      info('nomemo', null),
    ];
    rpc.txs.set('commit', rpcTx(player, [memoIx(COMMIT)]));
    rpc.txs.set('reveal', rpcTx(player, [memoIx(REVEAL)]));
    rpc.txs.set('elsewhere', rpcTx(player, [memoIx(`ACC1|ZZZ999|C|${'ab'.repeat(32)}`)]));
    const found = await new SolanaChain({ connection: rpc }).listMemoTxs(player, ROOM);
    expect(found.map((t) => t.sig).sort()).toEqual(['commit', 'reveal']);
  });

  it('does not trust the address list alone: the fee payer must be that address', async () => {
    const rpc = new FakeRpc();
    // The address appears in the transaction (say as a mentioned account) but did not sign it.
    rpc.infos = [info('theirs', `[78] ${COMMIT}`)];
    rpc.txs.set('theirs', rpcTx(other, [memoIx(COMMIT)]));
    expect(await new SolanaChain({ connection: rpc }).listMemoTxs(player, ROOM)).toEqual([]);
  });

  it('checks the memo text itself, not just the hint the node returned', async () => {
    const rpc = new FakeRpc();
    rpc.infos = [info('liar', `[78] ${COMMIT}`)]; // the hint claims this room...
    rpc.txs.set('liar', rpcTx(player, [memoIx(`ACC1|ZZZ999|C|${'ab'.repeat(32)}`)])); // ...the text does not
    expect(await new SolanaChain({ connection: rpc }).listMemoTxs(player, ROOM)).toEqual([]);
  });

  it('skips transactions the node no longer has', async () => {
    const rpc = new FakeRpc();
    rpc.infos = [info('gone', `[78] ${COMMIT}`), info('here', `[78] ${COMMIT}`)];
    rpc.txs.set('here', rpcTx(player, [memoIx(COMMIT)]));
    expect(
      (await new SolanaChain({ connection: rpc }).listMemoTxs(player, ROOM)).map((t) => t.sig),
    ).toEqual(['here']);
  });

  it('makes no second request when nothing in the list mentions the room', async () => {
    const rpc = new FakeRpc();
    let fetched = false;
    rpc.getParsedTransactions = async () => {
      fetched = true;
      return [];
    };
    rpc.infos = [info('a', '[5] hello'), info('b', null)];
    expect(await new SolanaChain({ connection: rpc }).listMemoTxs(player, ROOM)).toEqual([]);
    expect(fetched).toBe(false);
  });

  it('respects the scan limit and commitment', async () => {
    const rpc = new FakeRpc();
    await new SolanaChain({ connection: rpc, scanLimit: 7, commitment: 'finalized' }).listMemoTxs(
      player,
      ROOM,
    );
    const [address, options, commitment] = rpc.lastInfosArgs as [
      PublicKey,
      { limit: number },
      string,
    ];
    expect(address.toBase58()).toBe(player);
    expect(options).toEqual({ limit: 7 });
    expect(commitment).toBe('finalized');
    const defaults = new FakeRpc();
    await new SolanaChain({ connection: defaults }).listMemoTxs(player, ROOM);
    expect((defaults.lastInfosArgs[1] as { limit: number }).limit).toBe(100);
  });
});

describe('Memo program id', () => {
  it('is the published Memo v2 address', () => {
    expect(MEMO_PROGRAM_ID.toBase58()).toBe('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
  });
});
