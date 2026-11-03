/**
 * Sends real Memo transactions on devnet to settle the open questions in the spec (task 4.2).
 *
 *   pnpm --filter @accident/solana devnet-check
 *
 * It needs the public devnet RPC and a few devnet SOL. It spends only devnet SOL.
 *
 * By default it makes a throwaway key and asks the faucet for SOL, which the public faucet often
 * refuses (429). To use a key you funded yourself at https://faucet.solana.com, set
 * `DEVNET_FUNDED_SECRET_KEY` to its secret key as a JSON array of 64 numbers (the format of a
 * Solana CLI keypair file). The key is never printed or written anywhere.
 *
 * Results are printed and written to `devnet-check.result.json` for the record.
 */
import {
  identityFromSecretKey,
  commitment,
  encodeCommitMemo,
  encodeRevealMemo,
  generateIdentity,
  generateRoomCode,
  generateSaltHex,
  parseMemo,
} from '@accident/protocol';
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { writeFileSync } from 'node:fs';
import { MEMO_PROGRAM_ID, SolanaChain } from '../src/index.js';

const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const connection = new Connection(RPC, 'confirmed');
const chain = new SolanaChain({ connection });

const result: Record<string, unknown> = { rpc: RPC, memoProgram: MEMO_PROGRAM_ID.toBase58() };
const log = (label: string, value: unknown): void => {
  result[label] = value;
  console.log(label.padEnd(28), typeof value === 'string' ? value : JSON.stringify(value));
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fund(address: PublicKey): Promise<number> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const sig = await connection.requestAirdrop(address, 0.05 * LAMPORTS_PER_SOL);
      const latest = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
      return await connection.getBalance(address, 'confirmed');
    } catch (e) {
      console.log(`airdrop attempt ${attempt} failed: ${(e as Error).message.slice(0, 100)}`);
      await sleep(2000 * attempt);
    }
  }
  return 0;
}

async function waitFor<T>(what: string, read: () => Promise<T | null>, ms = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read().catch(() => null);
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const supplied = process.env.DEVNET_FUNDED_SECRET_KEY;
  const player = supplied
    ? identityFromSecretKey(Uint8Array.from(JSON.parse(supplied) as number[]))
    : generateIdentity();
  log('player', player.publicKey);
  log('key source', supplied ? 'DEVNET_FUNDED_SECRET_KEY' : 'throwaway, funded by airdrop');

  const existing = await connection.getBalance(new PublicKey(player.publicKey), 'confirmed');
  const balance = existing > 0 ? existing : await fund(new PublicKey(player.publicKey));
  log('balance (lamports)', String(balance));
  if (balance === 0) throw new Error('Could not get devnet SOL from the faucet');

  // 1. The real game records, exactly as the session writes them.
  const room = generateRoomCode();
  const salt = generateSaltHex();
  const commit = await commitment({
    room,
    playerKey: player.publicKey,
    secret: '1964',
    saltHex: salt,
  });
  const commitText = encodeCommitMemo(room, commit);
  const revealText = encodeRevealMemo(room, '1964', salt, 'ab'.repeat(32));
  log('room', room);
  log('commit text bytes', String(Buffer.byteLength(commitText)));
  log('reveal text bytes', String(Buffer.byteLength(revealText)));

  const sentAt = Date.now();
  const commitSig = await chain.sendMemo(player, commitText);
  log('commit signature', commitSig);
  const commitTx = await waitFor('commit confirmation', () => chain.getMemoTx(commitSig));
  log('commit confirm ms', String(Date.now() - sentAt));

  const revealSentAt = Date.now();
  const revealSig = await chain.sendMemo(player, revealText);
  const revealTx = await waitFor('reveal confirmation', () => chain.getMemoTx(revealSig));
  log('reveal confirm ms', String(Date.now() - revealSentAt));

  // 2. What came back must equal what was sent, byte for byte.
  log('commit text round-trips', String(commitTx.text === commitText));
  log('reveal text round-trips', String(revealTx.text === revealText));
  log('commit signer is the player', String(commitTx.signer === player.publicKey));
  log('commit ok', String(commitTx.ok));
  log('commit parses', String(parseMemo(commitTx.text)?.kind === 'commit'));
  log('reveal parses with hash', String(parseMemo(revealTx.text)?.kind === 'reveal'));
  log('commit slot / blockTime', `${commitTx.slot} / ${commitTx.blockTime}`);

  // 3. The audit path: find both records by scanning the player's address.
  const scanned = await waitFor(
    'address scan',
    async () => {
      const found = await chain.listMemoTxs(player.publicKey, room);
      return found.length >= 2 ? found : null;
    },
    90_000,
  );
  log('scan finds records', String(scanned.length));
  log(
    'scan texts match',
    String(
      scanned
        .map((t) => t.text)
        .sort()
        .join('\n') === [commitText, revealText].sort().join('\n'),
    ),
  );

  // 4. The length limit: 566 bytes is documented. Find out what really works here.
  const limits: Record<string, string> = {};
  for (const bytes of [148, 300, 566, 567, 900]) {
    const text = 'ACC1|' + 'x'.repeat(bytes - 5);
    try {
      const sig = await chain.sendMemo(player, text);
      const tx = await waitFor(`${bytes}-byte memo`, () => chain.getMemoTx(sig), 30_000);
      limits[String(bytes)] = tx.ok ? 'ok' : 'failed on-chain';
    } catch (e) {
      limits[String(bytes)] = `rejected: ${(e as Error).message.slice(0, 80)}`;
    }
  }
  log('length limits', limits);

  const fee = balance - (await connection.getBalance(new PublicKey(player.publicKey), 'confirmed'));
  log('lamports spent', String(fee));
  writeFileSync(
    new URL('../devnet-check.result.json', import.meta.url),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log('\nWrote devnet-check.result.json');
}

main().catch((e: unknown) => {
  console.error('FAILED:', e);
  process.exit(1);
});
