# Accident

Dead-and-Injured (Bulls and Cows) with a public Solana record. Two players each lock in a secret
4-digit number with a hash on Solana devnet, play through a signed realtime relay, then reveal.
Anyone can check afterwards that nobody lied. No custom Solana program, no money, devnet only.

> Status: hackathon build. Spec: [`.kiro/specs/accident/`](.kiro/specs/accident/).

## Play

- **Play the computer**: works offline, three difficulties, runs in a Web Worker. Not provably fair.
- **Play a friend**: a room code and link; both secrets are committed on-chain before the first guess.

Example: secret `1964`, guess `2604` is 1 dead (the 4) and 1 injured (the 6).

## Honest limits

- The chain records and proves; the clients enforce. Timeouts are a UI convention, not on-chain.
- Nothing can stop someone using a solver to answer for them.
- Practice mode is local and not provably fair.
- Friend mode has been tested against a **simulated** chain and relay and against in-memory fakes.
  It has not yet been run against live devnet and a live relay (see "Not yet verified").

## Layout

| Path                | What                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------- |
| `packages/engine`   | Pure rules, scoring, candidate filtering, computer strategies.                          |
| `packages/protocol` | Commitment, Memo records, signed messages, transcript, verdict, and the game session.   |
| `packages/solana`   | web3.js `Chain` adapter, plus devnet scripts that measured the Memo limits.             |
| `apps/web`          | React PWA: practice, friend mode, offline support. Friend mode is code-split.           |
| `apps/relayer`      | `POST /api/drip` (devnet SOL for new keys) and `POST /api/event` (anonymous analytics). |
| `api/`              | Re-exports the relayer functions at the site origin for Vercel.                         |
| `supabase/`         | SQL migration for the atomic rate counters and the events table.                        |

## Develop

Requires Node 22 and pnpm 11.

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test:coverage
pnpm --filter @accident/web dev:sim      # friend mode against a simulated chain, two tabs: ?as=host / ?as=guest
pnpm --filter @accident/web build && pnpm --filter @accident/web build:sim
pnpm --filter @accident/web e2e          # real Chrome, phone viewport
```

## Configuration (live friend mode)

Web build (public values): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, optionally
`VITE_SOLANA_RPC_URL`. Server (host secrets, never committed): `FUNDING_WALLET_SECRET_KEY` (JSON array
of 64 numbers), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Run `supabase/migrations/0001_relayer.sql`
once. Without the web values, friend mode shows a plain explanation and the computer game still works.
CI fails if a server secret name appears in the built app or 64-byte key material is committed.

## Not yet verified

- A real Memo submitted on devnet (the public faucet refused this sandbox; the transactions were
  checked by simulation instead, see `packages/solana/devnet-simulate.result.json`).
- Supabase Realtime and the drip function against live projects (checked against the real client's
  types and against fakes only).
- Real phones, mobile data, screen wake lock, and the 15-second first-guess target on hardware.

## Licence

MIT. See [LICENSE](LICENSE).
