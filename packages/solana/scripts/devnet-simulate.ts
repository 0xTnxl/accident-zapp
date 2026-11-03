/**
 * Settles task 4.2 without spending anything: runs the game's real Memo transactions through the
 * devnet runtime with `simulateTransaction`. Nothing is sent, so no faucet SOL is needed.
 *
 *   pnpm --filter @accident/solana devnet-simulate
 *
 * The fee payer is an existing funded devnet account found by looking at recent Memo traffic. It is
 * only named in the simulation; its key is never used and nothing is signed or submitted.
 * Results are printed and written to `devnet-simulate.result.json`.
 */
import {
  commitment,
  encodeCommitMemo,
  encodeRevealMemo,
  generateRoomCode,
  generateSaltHex,
} from '@accident/protocol';
import type { PublicKey } from '@solana/web3.js';
import { Connection, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { writeFileSync } from 'node:fs';
import { MEMO_PROGRAM_ID, memoInstruction } from '../src/index.js';

const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const connection = new Connection(RPC, 'confirmed');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const result: Record<string, unknown> = { rpc: RPC, memoProgram: MEMO_PROGRAM_ID.toBase58() };

async function findFundedPayer(): Promise<PublicKey> {
  const infos = await connection.getSignaturesForAddress(
    MEMO_PROGRAM_ID,
    { limit: 10 },
    'confirmed',
  );
  for (const info of infos) {
    const tx = await connection.getParsedTransaction(info.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    const payer = tx?.transaction.message.accountKeys[0]?.pubkey;
    if (payer && (await connection.getBalance(payer, 'confirmed')) > 1_000_000) return payer;
    await sleep(300);
  }
  throw new Error('Could not find a funded devnet account to name as the simulated fee payer');
}

interface Outcome {
  bytes: number;
  serialised: number | string;
  error: unknown;
  units: number | undefined;
  memoLogged: string | undefined;
  signedByLogged: boolean;
}

async function simulate(payer: PublicKey, text: string): Promise<Outcome> {
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [memoInstruction(payer, text)],
  }).compileToLegacyMessage();
  const tx = new VersionedTransaction(message);
  const bytes = Buffer.byteLength(text, 'utf8');
  let serialised: number | string;
  try {
    serialised = tx.serialize().length;
  } catch (e) {
    return {
      bytes,
      serialised: `too large: ${(e as Error).message}`,
      error: 'not serialisable',
      units: undefined,
      memoLogged: undefined,
      signedByLogged: false,
    };
  }
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'confirmed',
  });
  const logs = sim.value.logs ?? [];
  return {
    bytes,
    serialised,
    error: sim.value.err,
    units: sim.value.unitsConsumed,
    memoLogged: logs.find((l) => l.includes('Memo (len')),
    signedByLogged: logs.some((l) => l.includes('Signed by')),
  };
}

async function main(): Promise<void> {
  const payer = await findFundedPayer();
  result.simulatedFeePayer = payer.toBase58();
  console.log('simulated fee payer (never signed with):', payer.toBase58());

  // The game's real records, built by the real protocol code.
  const room = generateRoomCode();
  const salt = generateSaltHex();
  const commit = await commitment({
    room,
    playerKey: payer.toBase58(),
    secret: '1964',
    saltHex: salt,
  });
  const records: Record<string, string> = {
    'commit (78 bytes)': encodeCommitMemo(room, commit),
    'reveal v1.1 (83 bytes)': encodeRevealMemo(room, '1964', salt),
    'reveal with transcript hash (148 bytes)': encodeRevealMemo(
      room,
      '1964',
      salt,
      'ab'.repeat(32),
    ),
  };
  const outcomes: Record<string, Outcome> = {};
  for (const [name, text] of Object.entries(records)) {
    outcomes[name] = await simulate(payer, text);
    await sleep(400);
  }

  // Length boundary with a signer attached, as the game sends it.
  for (const bytes of [300, 500, 566, 567, 600, 800, 1000]) {
    outcomes[`${bytes} bytes`] = await simulate(payer, 'ACC1|' + 'x'.repeat(bytes - 5));
    await sleep(400);
  }

  result.outcomes = outcomes;
  for (const [name, o] of Object.entries(outcomes)) {
    const verdict = o.error === null ? 'OK' : `ERR ${JSON.stringify(o.error)}`;
    console.log(
      name.padEnd(40),
      verdict.padEnd(60),
      `tx=${o.serialised}B`.padEnd(14),
      `cu=${o.units ?? '-'}`.padEnd(10),
      o.signedByLogged ? 'signed-by-logged' : 'no-signer-log',
    );
  }
  const sample = outcomes['commit (78 bytes)'];
  console.log('\nlog line for the commit:', sample?.memoLogged);
  writeFileSync(
    new URL('../devnet-simulate.result.json', import.meta.url),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log('Wrote devnet-simulate.result.json');
}

main().catch((e: unknown) => {
  console.error('FAILED:', e);
  process.exit(1);
});
