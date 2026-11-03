# Going live

This runbook takes Accident from "code-complete, tested against fakes" to a live devnet deployment
that two phones can play on. It is devnet only: no real money, no tokens, no escrow.

The code is done. What remains is **operations**: standing up a Supabase project, a Vercel
deployment, and a funded devnet key. The steps below are ordered so that each one is independently
verifiable — you get a working milestone at every stage, not just at the end.

## What "live" means here

A fully live friend game needs three external services:

| Service           | Used for                                                            | Needed by                        |
| ----------------- | ------------------------------------------------------------------- | -------------------------------- |
| **Vercel**        | Hosting the web app and the `/api/drip` + `/api/event` functions    | Everything except local practice |
| **Supabase**      | Realtime relay (friend-mode messages) and the drip/analytics tables | Friend mode, drip, analytics     |
| **Solana devnet** | The commit/reveal Memo records and the funding wallet               | The on-chain play gate           |

Practice mode needs **none** of these — it runs entirely in the browser. So the first milestone
(a deployed practice game) is reachable the moment the app is on Vercel.

---

## Stage 0 — Prerequisites

- A [Vercel](https://vercel.com) account and a project linked to this repo.
- A [Supabase](https://supabase.com) project (free tier is fine).
- A Solana devnet RPC endpoint. The public `https://api.devnet.solana.com` works for testing; a
  dedicated RPC (Helius, QuickNode, etc.) is steadier under load.
- The Solana CLI or any wallet that can produce a devnet keypair, for the funding wallet.

---

## Stage 1 — Deploy to Vercel (unlocks practice mode)

The deploy workflow (`.github/workflows/deploy.yml`) and `vercel.json` are already in the repo.

1. **Link the Vercel project** to this repo (via the Vercel dashboard or `vercel link`).
2. **Add the GitHub repository secrets** (repo → Settings → Secrets and variables → Actions):
   - `VERCEL_TOKEN`
   - `VERCEL_ORG_ID`
   - `VERCEL_PROJECT_ID`
3. Push to `main` (or merge a PR). The workflow runs
   `vercel pull → vercel build --prod → vercel deploy --prebuilt --prod`.

**Verify (spec task 3.4):** open the deployed URL on a phone and finish a game of practice mode.
No backend is required for this — if practice works, the shell, service worker, engine, and Web
Worker are all good on real hardware.

> Without the Supabase values below, "Play a friend" shows a plain explanation of what is missing
> and practice mode still works. So you can ship this stage before the backend is ready.

---

## Stage 2 — Stand up Supabase (unlocks relay, drip, analytics)

1. **Run the migration.** Open `supabase/migrations/0001_relayer.sql` and run it once, either in the
   Supabase SQL editor or with `supabase db push`. It creates the atomic rate-limit counters and the
   anonymous events table, both with Row Level Security on and no public policies (only the
   service-role key can touch them).
2. **Collect the keys** from the Supabase project settings:
   - Project URL
   - `anon` public key
   - `service_role` secret key (server-only — never ships to the browser)

### Environment variables

Set these in the **Vercel project** (Settings → Environment Variables), not in the GitHub workflow.
Names come from `.env.example`.

**Server (secret — relayer functions only):**

| Name                        | Value                                                        |
| --------------------------- | ------------------------------------------------------------ |
| `FUNDING_WALLET_SECRET_KEY` | The funding wallet secret key, as a JSON array of 64 numbers |
| `SOLANA_RPC_URL`            | Your devnet RPC URL                                          |
| `SUPABASE_URL`              | Supabase project URL                                         |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase `service_role` key                                  |

**Web (public — safe to expose in the bundle):**

| Name                     | Value                                                                                                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`      | Supabase project URL                                                                                                                                                                                                                                                          |
| `VITE_SUPABASE_ANON_KEY` | Supabase `anon` key                                                                                                                                                                                                                                                           |
| `VITE_SOLANA_RPC_URL`    | Your devnet RPC URL (optional; defaults to the public devnet RPC)                                                                                                                                                                                                             |
| `VITE_BACKEND`           | Optional; `'live'` or `'sim'`, defaults to `'live'`. Leave unset in Vercel — only the `dev:sim`/`build:sim` scripts set this to `'sim'` locally. If it's accidentally set to `sim` in Vercel, friend mode silently runs the in-memory simulation instead of the real backend. |
| `VITE_DRIP_URL`          | Optional; overrides where the web app posts drip requests. Defaults to `/api/drip` (the co-located Vercel function) — leave unset unless the drip function is hosted elsewhere.                                                                                               |
| `VITE_TURN_SECONDS`      | Optional; how long a player has on the clock before the other side may claim a timeout, in whole seconds. Defaults to 60. UI-only per REQ-13 — never enforced on-chain, and raising or lowering it does not change anything about the commit/reveal or play-gate rules.       |

> CI fails the build if a **server** secret name (`FUNDING_WALLET_SECRET_KEY`,
> `SUPABASE_SERVICE_ROLE_KEY`) appears in the built web app, or if anything that looks like a
> 64-byte key is committed. Keep server secrets out of any `VITE_` variable.

**Verify:** redeploy, open "Play a friend", and create a room. The relay status chip should go green
and the funding ("drip") state should resolve once Stage 3 is funded.

---

## Stage 3 — Fund devnet (unlocks the on-chain play gate)

This is the one step that previously blocked live testing: the public faucet rate-limited the
sandbox (HTTP 429), so **a real Memo has never actually landed on devnet** — the Memo sizes and
limits were confirmed by simulation only (`packages/solana/devnet-simulate.result.json`).

1. **Create a funding wallet** (a devnet keypair) and fund it at <https://faucet.solana.com>. This
   wallet pays `/api/drip` top-ups to new players. Put its secret key in `FUNDING_WALLET_SECRET_KEY`
   (Stage 2). Fees are 5,000 lamports per transaction, so 0.01 SOL covers ~500 Memo transactions.
2. **Confirm a real Memo round-trip.** Fund any devnet key, then run the full
   send → read-back → address-scan check:

   ```sh
   DEVNET_FUNDED_SECRET_KEY='[/* 64 numbers */]' \
     pnpm --filter @accident/solana devnet-check
   ```

   Set `DEVNET_FUNDED_SECRET_KEY` to a funded key's secret (JSON array of 64 numbers, the Solana CLI
   keypair format). Optionally set `SOLANA_RPC_URL`. The key is never printed or written anywhere.
   Results are written to `packages/solana/devnet-check.result.json`.

   This closes spec item 4.2 ("submit one real Memo"): a commit and a reveal Memo land on devnet and
   verify by signature.

---

## Stage 4 — Live friend game and field test (spec Day 2–4)

With Stages 1–3 green:

1. **Two browsers, one game.** On the live URL, host in one browser and join from another; play a
   full game. Both commit Memos should land, the play gate should open, and the result screen should
   show explorer links to both players' commit and reveal Memos.
2. **Caught lie.** Demonstrate lie detection either with the **House Bot** cheating mode
   (`apps/house-bot`) or by pasting two reveals and a transcript into the **Verifier** page
   (`/verify`).

   `apps/house-bot/src/live.ts` exports `liveConfigFromEnv()` and `runLiveBot()` for exactly this —
   read its header comment for the up-to-date contract. There is no CLI entry point yet (no `start`
   script in `apps/house-bot/package.json`); wiring it up to a real transport (e.g. the Supabase
   adapter from `apps/web/src/friend/transports.ts`) and calling `runLiveBot` is a short script you
   write before this step, not something that ships today. It reads, as shell env vars (not Vercel):

   | Name                | Value                                                                                                                          |
   | ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
   | `ACCIDENT_ROOM`     | **Required.** The room code to join — the bot throws immediately if unset.                                                     |
   | `ACCIDENT_ROLE`     | Optional; `'host'` or `'guest'`, defaults to `'guest'`.                                                                        |
   | `ACCIDENT_RPC_URL`  | Optional; devnet RPC URL, defaults to the public devnet RPC. Separate from `SOLANA_RPC_URL` — the bot does not read that name. |
   | `ACCIDENT_HOST_KEY` | Optional; pins the host's public key when joining as `guest` (from the room's share link).                                     |

   The simpler path for this demo is still the Verifier page (`/verify`) — paste two reveals and a
   transcript, no wiring required.

3. **Two phones on mobile data.** The real target (spec tasks 4.3, 15, 17): confirm the 15-second
   first-guess goal, screen wake lock, the hidden-tab warning, and resilience (refresh mid-game,
   background 60 s, airplane blip, clear storage).

---

## Quick reference

```sh
# Local checks (no backend needed)
pnpm install
pnpm typecheck && pnpm lint && pnpm test

# Friend mode against a simulated chain and relay, two tabs
pnpm --filter @accident/web dev:sim        # open ?as=host and ?as=guest

# Real-browser tests on a phone-sized viewport
pnpm --filter @accident/web e2e

# Confirm a real Memo on devnet (needs a funded key)
DEVNET_FUNDED_SECRET_KEY='[...]' pnpm --filter @accident/solana devnet-check
```

## Troubleshooting

| Symptom                                    | Likely cause                                              | Fix                                                                                    |
| ------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| "Play a friend" shows a config explanation | Supabase web vars missing                                 | Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in Vercel, redeploy               |
| Drip never funds; funding state hangs      | Funding wallet empty or `FUNDING_WALLET_SECRET_KEY` unset | Fund the wallet at the faucet; set the server secret                                   |
| Relay chip stays amber                     | Supabase Realtime unreachable or anon key wrong           | Re-check `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`                                |
| `devnet-check` airdrop fails (429)         | Public faucet rate limit                                  | Fund a key yourself at <https://faucet.solana.com> and pass `DEVNET_FUNDED_SECRET_KEY` |
| Deploy workflow does nothing               | Missing GitHub Actions secrets                            | Add `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`                               |

See [`.kiro/specs/accident/`](.kiro/specs/accident/) for the full requirements, design, and task plan.
