# Tasks: ACCIDENT (Memo-only, devnet)

Ordered to the PRD build plan, 4 to 12 October 2026. Each task lists the requirements it serves. Tests are only named where a requirement asks for them.

## Day 0: Sun 4 Oct, foundation and practice

- [x] 1. Scaffold the monorepo (REQ-18)
  - [x] 1.1 pnpm workspace, `tsconfig.base.json` (strict), ESLint, Prettier, Vitest, pinned versions (TypeScript is pinned to 6.0.3 because typescript-eslint does not support TS 7 yet)
  - [x] 1.2 `LICENSE` (MIT default), `README.md` stub, `.gitignore` (includes `.env*`), `.env.example`
  - [x] 1.3 GitHub Actions: install, typecheck, lint, test
- [x] 2. Engine package (REQ-3)
  - [x] 2.1 `isValidCode`, `score`, `isValidFeedback`, `allCodes`
  - [x] 2.2 `filterCandidates`
  - [x] 2.3 Strategies: easy, medium, hard (minimax, sum of squares tie-break, opener 0123)
  - [x] 2.4 Tests: A.1 vectors, symmetry, 5,040 codes, candidate filtering, strategy averages (REQ-18.4)
- [ ] 3. Web app shell and practice mode (REQ-1, REQ-2)
  - [x] 3.1 Vite + React + Tailwind + Zustand app, PWA manifest and service worker (Zustand was not needed: state is a reducer plus a controller)
  - [x] 3.2 Home, How to play (1964 / 2604 example), keypad, pick secret, practice board
  - [x] 3.3 Web Worker for the computer; difficulty selector
  - [ ] 3.4 Deploy to Vercel; one person finishes a practice game on a phone
- [ ] 4. Day-1 checks (design section 12)
  - [ ] 4.1 Confirm Colosseum deadline, fields, and any custom-program requirement
  - [~] 4.2 Program ID, signer handling, sizes and the 526-byte limit confirmed on devnet by simulation, and read-back checked against real Memo transactions. Still to do: submit one real Memo (the public faucet returned 429)
  - [ ] 4.3 Latency and limits check for Supabase Realtime from Nigeria; decide relay

**Exit:** a friend finishes a practice game on the live URL; checks recorded in the README.

## Day 1: Mon 5 Oct, commitment, Memos, vault, drip

- [ ] 5. Commitment and Memo helpers in `protocol` (REQ-7, REQ-8)
  - [x] 5.1 `commitment()`; A.2 vector in Node; four negative tests
  - [x] 5.2 `encodeCommitMemo`, `encodeRevealMemo`, strict `parseMemo` (both reveal forms)
  - [x] 5.3 `Chain` adapter on web3.js v1 (`packages/solana`): `sendMemo`, `getMemoTx`, `listMemoTxs`. Retry and backoff live in the session
  - [x] 5.4 Memo tests: wrong signer, text or room rejected; first-wins canonical selection (pure selection logic done; fetching by signature belongs to 5.3)
- [x] 6. Vault and keys (REQ-5)
  - [x] 6.1 Burner keypair, localStorage plus `storage.persist()` (localStorage is enough for a 64-byte burner key; IndexedDB was not needed)
  - [x] 6.2 Save secret and salt before any commit send
- [~] 7. Relayer (REQ-6, REQ-16)
  - [x] 7.1 `POST /api/drip` with all protections and logging
  - [x] 7.2 `POST /api/event` with allow-list and rate limit
  - [ ] 7.3 Fund the wallet from several faucets; document top-up (the public faucet returned 429)

**Exit:** browser commitment equals the A.2 hash; one commit and one reveal Memo land on devnet and verify by signature.

## Day 2: Tue 6 Oct, protocol and full game

- [x] 8. Messages and transport (REQ-10)
  - [x] 8.1 `signMessage`, `verifyMessage`, parsing, and sequence handling with buffering
  - [x] 8.2 In-memory `Transport`, `Chain`, `Storage` and `Clock` for tests (`src/testing/`)
  - [x] 8.3 Supabase Realtime `Transport` adapter
  - [x] 8.4 SYNC and resend timer with backoff; drop, duplicate, reorder, disconnect and refresh tests
- [ ] 9. Session state machine (REQ-4, REQ-9, REQ-11)
  - [x] 9.1 Host/guest HELLO and pinning, including the host key from the share link (the room code and link UI belong to the web app)
  - [x] 9.2 Commit, publish COMMIT, verify the opponent commit (by signature, with address-scan fallback), open the play gate
  - [x] 9.3 Auto-answer, guess turn flow, end rules, reveal Memo and REVEAL
- [ ] 10. Finalisation (REQ-12, REQ-15.3)
  - [x] 10.1 Pure `finalise` and `transcriptHash` (plus `assembleTranscript`)
  - [x] 10.2 Attack tests (REQ-18.3): lying answer, false 40, hidden 40, invalid secret, forged signature, replay, out-of-order sequence, out-of-turn guess, feedback 31, commit equivocation, missing reveal
- [ ] 11. House Bot (REQ-17), decision point
  - [ ] 11.1 Node bot using `protocol`; honest mode
  - [ ] 11.2 Cheating mode for the demo and tests
  - [ ] 11.3 If Tuesday slips, cut 11.2 before cutting anything in tasks 8 to 10

**Exit:** two browsers complete one full game on devnet, including a caught lie.

## Day 3: Wed 7 Oct, UX, resilience, go or no-go

- [ ] 12. Friend board and result (REQ-11.3, REQ-15, REQ-13)
  - [x] 12.1 Create room, join room, friend board with status chips
  - [x] 12.2 180 s countdown, timeout claim, forfeit offer
  - [x] 12.3 Result screen with Memo links; transcript export; rematch with new room
- [ ] 13. Resilience (REQ-14)
  - [x] 13.1 Wake lock (re-acquires on return to foreground), hidden-tab warning, resume from vault (resume via the controller). Not yet checked on a real phone.
  - [x] 13.2 Retry UI for Memo failures; plain-language errors
- [x] 14. Analytics wiring (REQ-16): POST /api/event (relayer) plus the web client (`app_open`, `cpu_game_*`, `room_*`, `play_gate_open`, `pvp_*`, `tx_error`). A round-trip test checks every client event against the real handler. Not yet sent to a live analytics backend.
- [ ] 15. Device matrix and resilience tests: refresh mid-game, background 60 s, airplane blip, clear storage
- [ ] 16. Verifier page (REQ-15.4), decision point: build if 1 to 15 are green, otherwise defer to Friday

**Exit:** two phones on mobile data finish a game. Go or no-go for Thursday.

## Day 4: Thu 8 Oct, field test

- [ ] 17. Run the field test per PRD 12.1; capture Section 3 metrics, screen recording and quotes

## Day 5: Fri 9 Oct, fix and freeze

- [ ] 18. Fix the top 3 problems only
- [ ] 19. README with real results; tag the release candidate; feature freeze at end of day

## Day 6: Sat 10 Oct, media

- [ ] 20. Record pitch video (2 to 3 minutes) with real field-test numbers
- [ ] 21. Record technical demo: Memo records, one full game with links, a lie being caught (House Bot cheating mode or Verifier page)
- [ ] 22. Clean the repo

## Day 7: Sun 11 Oct, submit

- [ ] 23. Final repo check (README, licence, no secrets); submit; confirm receipt

Mon 12 Oct is buffer only.

## Fallback ladder (replaces the stale 7 Oct line in PRD 11.1)

| Trigger | Action |
| --- | --- |
| Opponent commit lookup slow or flaky | Backoff polling, then address scan, with a clear "waiting for chain" state |
| Relay unreliable on test day | Switch `Transport` to the alternate provider; pair players on the same Wi-Fi; repeat on Fri 9 Oct |
| Devnet or RPC unstable | Public RPC fallback; keep a recorded successful game |
| Wed 7 Oct go/no-go fails on friend mode | Ship friend mode labelled beta; lead the field test and pitch with Practice and the House Bot; show a recorded two-phone game |
| Verifier page not ready | Demonstrate the caught lie with the House Bot cheating mode and the result screen |
| Field-test numbers weak | Report them honestly and show the fixes from 9 Oct |
