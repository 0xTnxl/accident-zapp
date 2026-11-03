# @accident/solana

The Solana side of Accident: a `Chain` adapter (web3.js v1) for the protocol's `Chain` port.
It only ever sends and reads **Memo v2** transactions on devnet. There is no custom program.

## Strict reading

A Memo only counts if the transaction succeeded, the instruction belongs to the real Memo v2 program,
it is the only Memo in the transaction, and the signer is the fee payer. A look-alike written by
another program, a second smuggled Memo, or an address that merely appears in the transaction is
never accepted. The adapter takes its RPC connection as a parameter, so tests use a fake.

## Scripts

```sh
pnpm --filter @accident/solana devnet-simulate   # spends nothing; needs only the public RPC
pnpm --filter @accident/solana devnet-check      # sends real Memos; needs devnet SOL
```

`devnet-simulate` runs the game's real transactions through the devnet runtime and records sizes,
compute units and the length limit in `devnet-simulate.result.json`. `devnet-check` sends a commit
and reveal, reads them back, scans by address and compares exact text. The public faucet is
rate limited, so it may need a key funded from https://faucet.solana.com.

## Measured limits

A signed Memo works up to 526 bytes (the documented 566 is for unsigned). The fee is 5,000 lamports.
Our records are 78, 83 and 148 bytes.
