# Design: ACCIDENT (Memo-only, devnet)

Implements `requirements.md`. Baseline is PRD v1.1. Section 10 lists the deltas from v1.1.

## 1. Architecture

No game server and no custom Solana program.

```
 apps/web (React PWA)                     apps/house-bot (Node)
   UI, vault, worker ---------+              uses same packages
            |                 |                      |
            v                 v                      v
     packages/protocol  (session state machine, messages, commitment, finalisation)
        |          |                   |
   Transport    Chain              Clock/Storage (injected)
  (interface)  (interface)
        |          |
   Supabase     web3.js v1 adapter ---> Solana devnet (Memo program)
   Realtime
   adapter

 packages/engine: pure rules, scoring, candidate filtering, computer strategies

 apps/relayer (Vercel functions): POST /api/drip, POST /api/event
```

The protocol package touches no browser API, RPC client or socket directly. It receives a `Transport`, a `Chain`, a `Storage` and a `Clock`. Tests run whole games in Node with an in-memory transport and a fake chain. The House Bot and the web app use the same code paths.

### 1.1 Repository layout **[Default]**

```
accident/
  .kiro/specs/accident/{requirements,design,tasks}.md
  .kiro/steering/project.md
  packages/engine/      pure TS, Vitest
  packages/protocol/    pure TS, Vitest
  apps/web/             Vite + React + Tailwind + Zustand
  apps/relayer/         Vercel functions
  apps/house-bot/       Node script
  pnpm-workspace.yaml  tsconfig.base.json  LICENSE  README.md
  .github/workflows/ci.yml
```

Stack: pnpm workspaces, TypeScript strict, Vite, React, Tailwind, Vitest, `@solana/web3.js` v1 behind one adapter module, `tweetnacl`, WebCrypto SHA-256. Versions pinned.

## 2. Interfaces

```ts
// packages/protocol/src/ports.ts
export interface Transport {
  join(room: string, handlers: { onMessage(raw: string): void; onStatus(status: 'up' | 'down'): void }): Promise<void>;
  send(room: string, raw: string): Promise<void>;
  leave(room: string): Promise<void>;
}

export interface Chain {
  sendMemo(signer: Keypair, text: string): Promise<string>;            // returns tx signature
  getMemoTx(sig: string): Promise<MemoTx | null>;                      // null = not found/confirmed yet
  listMemoTxs(address: string, room: string): Promise<MemoTx[]>;       // audit path
}
export interface MemoTx { sig: string; signer: string; text: string; slot: number; blockTime: number | null; ok: boolean; }

export interface Storage { get(k: string): Promise<string|null>; set(k: string, v: string): Promise<void>; }
export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): () => void; }
```

Engine API (`packages/engine`, implemented). Every exported function validates its input and throws `RangeError`, so it is safe on opponent-controlled data. Unchecked fast paths live in an internal module and are not exported.

- Rules: `isValidCode`, `assertCode`, `score`, `scoreParts`, `isValidFeedback`, `assertFeedback`, `encodeFeedback`, `decodeFeedback`, `VALID_FEEDBACK`, `guesserOf`, `answererOf`, `roundOf`.
- Candidates: `allCodes`, `filterCandidates`, `candidatesFromHistory`.
- Game: `gameStatus(feedbacks)` for live play; `findHits`, `verdictFromSecrets`, `findLies` for the post-reveal checks the protocol finalisation uses.
- Computer: `chooseGuess(level, candidates, rng)`, `chooseGuessHard`, `LEVELS`, `OPENING_GUESS`.
- Randomness: `secureRng()` (WebCrypto; use for a player's real secret), `mulberry32(seed)` (tests only), `randomCode(rng)`, `randomInt`, `pick`.

Protocol API (`packages/protocol`, pure core implemented; session and adapters pending). WebCrypto and tweetnacl only; no DOM, network or RPC.

- Identifiers and bytes: `generateRoomCode`, `isValidRoom`, `generateSaltHex`, `isValidPublicKey`, `isValidSignature`, hex and SHA-256 helpers.
- Commitment: `commitment`, `verifyCommitment` (hex strings for salt and commitment, base58 for keys).
- Memo records: `encodeCommitMemo`, `encodeRevealMemo`, `parseMemo`, `selectCommit`, `selectReveal` (earliest successful record wins; a different later one sets `equivocated` or `conflicting`).
- Messages: `generateIdentity`, `identityFromSecretKey`, `signMessage`, `verifyMessage`, `createVerifier`, `encodeMessage`, `parseMessage`, `openMessage`, `encodeBody`, `decodeBody`. Payloads use a strict grammar: canonical decimals, no extra fields, 1,024-character limit.
- Transcript: `assembleTranscript(room, messages)` (order-independent, drops forgeries and strangers, flags equivocation), `transcriptMessages`, `transcriptLines`, `transcriptHash`.
- Verdict: `finalise({transcript, commits, reveals, revealWindowClosed})` returns `pending`, `abandoned` or `final`. A final verdict carries `result`, `reason` (`fault`, `both-at-fault`, `first-hit`, `equal-round`, `cap`) and the evidence for every `Fault`. `toChainCommit` and `toChainReveal` adapt the Memo selectors.

## 3. Wire format

Signed text: `"ACC1|" + room + "|" + seq + "|" + type + "|" + payload`. Message: `{ room, from, seq, type, payload, sig }` where `from` and `sig` are base58.

| Type | Payload | In transcript | Notes |
| --- | --- | --- | --- |
| HELLO | `host` or `guest` | yes | seq 0. Declares seat. |
| COMMIT | commit tx signature | yes | seq 1 |
| GUESS | 4 digits | yes | seat `i % 2` sends guess `i` |
| ANSWER | `<i>:<feedback>` | yes | feedback integer in the 14 valid values |
| REVEAL | `<secret>:<salt hex>:<reveal tx sig>` | no | sent after the game ends |
| SYNC | highest seq received from peer, or `-1` | no | carries the sender's next unsent seq as its `seq` and does not consume one |

Rules enforced on receipt, in order: parse, room match, sender equals pinned opponent key (or first HELLO when unpinned), signature valid, `seq` equals expected (lower is a duplicate and is dropped; higher is buffered up to 4 messages, then a SYNC is sent to request re-send), type-specific checks (turn, index, feedback, gate).

### 3.1 Delivery

The game is turn-based, so at most one or two messages are in flight. Each client:
- keeps every sent message in the vault;
- re-sends the last sent message every 3 seconds until it sees the peer's next message or a SYNC that acknowledges it;
- sends SYNC on every (re)connect and on tab resume, and re-sends anything after the peer's acknowledged seq.

This makes phone sleep a pause, not a failure, within the 180 s clock.

### 3.2 Room pinning

- Host creates the room and knows its own key. The share link is `/r/<room>#<hostPubkey>`.
- Guest pins the fragment key if present; otherwise it pins the first HELLO with payload `host`.
- Host pins the first HELLO with payload `guest` and ignores later guests. Conflicting HELLOs are ignored.
- Signatures keep a hijacker from forging anything. The pinning only limits denial of service.

## 4. Session state machine

```
IDLE -> SECRET_PICKED -> FUNDING -> CONNECTED(HELLO) -> COMMITTING -> GATE_WAIT -> PLAYING
PLAYING -> ENDED(local end rule met) -> REVEALING -> FINAL
any -> ABANDONED (cancel, vault lost)
```

| State | Entry condition | Exit condition |
| --- | --- | --- |
| SECRET_PICKED | valid secret, salt generated, vault written | balance ok |
| FUNDING | balance below threshold | drip lands or user shown fallback |
| CONNECTED | both HELLOs pinned | commit Memo sent |
| COMMITTING | commit Memo sent (retry up to 3) | COMMIT sig published |
| GATE_WAIT | own commit published | both commit Memos verified (REQ-8.4) |
| PLAYING | gate open | end rule met from signed ANSWERs |
| REVEALING | reveal Memo sent and REVEAL published | both reveals verified, or 180 s forfeit offer |
| FINAL | verdict computed | rematch or exit |

Persisted after every transition and every message: state, secret, salt, outgoing messages, incoming transcript.

### 4.1 Session (implemented in `packages/protocol/src/session.ts`)

The state machine above is realised as an event-sourced `Session`:

- **State is derived from a log** of accepted, signed messages from both players. A refresh reloads the log; there is no second copy of the state to disagree with it.
- **Persist before transmit.** Every message is written to storage before it is sent, so a crash can never lead to a sequence number being reused for a different message (which would look like cheating). The secret and salt are saved before the commit Memo is sent, and an acknowledgement is only sent after what it acknowledges has been saved.
- **One serial queue** for every mutation. Chain polling and timers run detached but apply their results through the queue.
- **Acceptance rules.** A message is applied, held, ignored or counted as a violation. Guesses and answers are held until the play gate opens; a REVEAL is held until the game is over; anything out of turn, for the wrong index or from the wrong seat is a violation. A violation still consumes its sequence number so it is not resent forever.
- **Delivery.** SYNC acknowledgements and resends. Repeats start at 3 s, double up to 30 s while nothing is heard, reset when the opponent proves alive, and stop a few attempts after the game is settled. A newly pinned opponent is told everything at once.
- **Chain polling** starts at 250 ms and doubles to 2 s. It scans the opponent's address when a signature is missing or not found, and stops when the game is settled.
- **Timers.** 90 s to open the play gate once the opponent has joined (a host waiting for a friend never times out); 180 s per move (UI only); 180 s reveal window.
- **Errors.** A failed Memo is retried three times, then the session waits for `retry()` and shows a retryable error. Internal failures are reported in `view().error`, never swallowed.

Known limit: both players compute the transcript hash at their own game end. If one side learned of the other's commit by scanning the chain and never received the COMMIT message, the hashes can differ. The verdict does not depend on the hash, so this is reported as a transcript dispute, not a fault.

## 5. Finalisation

### 5.1 Inputs

`room`, `pubkeys[2]`, `canonicalCommit[2]` (from chain, first-wins), `reveals[2]` (verified against chain, or `null`), `answers`: ordered signed ANSWERs with guess indices, `guesses`: ordered signed GUESSes.

### 5.2 Algorithm

```
fault = [false, false]
for s in {0,1}:
  if reveals[s] == null: continue              # handled by step 6
  r = reveals[s]
  if !isValidCode(r.secret)                               -> fault[s] = true
  if sha256(tag||room||pubkeys[s]||r.secret||r.salt) != canonicalCommit[s] -> fault[s] = true
  if r.memoSigner != pubkeys[s]                           -> fault[s] = true
for each guess i with signed ANSWER a_i:
  g = i % 2;  ans = 1 - g                                 # answerer seat
  if reveals[ans] valid and score(reveals[ans].secret, guess_i) != a_i -> fault[ans] = true
if any seat sent two different signed ANSWERs for the same index       -> fault[seat] = true
if any seat posted a different later commit Memo                      -> fault[seat] = true

if fault[0] && fault[1]: DRAW
elif fault[0]: SEAT1_WINS (lie)
elif fault[1]: SEAT0_WINS (lie)
else:
  hit[g] = min { i : i % 2 == g and guess_i == reveals[1-g].secret }   # or none
  round(i) = floor(i / 2)
  if hit[0] and hit[1]: compare round; lower wins, equal draws
  elif hit[0] or hit[1]: that seat wins
  else DRAW (cap)
```

### 5.3 Missing reveals and the transcript hash

- One reveal missing and the other valid: the revealer wins by UI forfeit after 180 s. The verdict is marked "unverified: opponent did not reveal".
- Both missing: abandoned, no verdict.
- Transcript hash: `sha256` of lines `signedText + "|" + base58(sig)` joined by `\n`, in this canonical order: HELLO seat 0, HELLO seat 1, COMMIT seat 0, COMMIT seat 1, then for each guess index `i`: GUESS `i`, ANSWER `i`. REVEAL and SYNC are excluded.
- Both clients should compute the same hash. A mismatch is reported as a transcript dispute. It is not a fault, because the verdict depends only on signed messages and chain data.

### 5.4 Verifier page **[Proposed]**

Input: two reveal tx signatures plus a transcript file. Steps: fetch both reveal Memos, read the commit for each player via the COMMIT messages in the transcript and the earliest-commit rule on-chain, check every message signature, check the transcript hash equals the Memo `T` field for both, run `finalise`, render the verdict with evidence (the offending ANSWER, the revealed secret, the recomputed score).

## 6. Memo formats

| Record | Text | Bytes |
| --- | --- | --- |
| Commit | `ACC1\|<room>\|C\|<64 hex>` | 78 |
| Reveal | `ACC1\|<room>\|R\|<secret>\|<64 hex salt>\|<64 hex transcript hash>` | 148 **[Proposed]** |
| Reveal (v1.1 form, accepted for compatibility) | `ACC1\|<room>\|R\|<secret>\|<64 hex salt>` | 83 |

Memo program ID: Memo v2 `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`. The signer is listed as a signer account on the instruction, so the program verifies the signature and logs `Signed by <key>`.

**Measured on devnet (task 4.2), by simulating the exact transaction the game sends** (`packages/solana/devnet-simulate.result.json`, reproduce with `pnpm --filter @accident/solana devnet-simulate`):

| Record | Memo bytes | Transaction bytes | Compute units | Result |
| --- | --- | --- | --- | --- |
| Commit | 78 | 248 | 42,841 | succeeds, memo echoed in the log |
| Reveal (v1.1) | 83 | 253 | 44,458 | succeeds |
| Reveal with transcript hash | 148 | 319 | 67,277 | succeeds |

- **The longest signed Memo that works is 526 bytes** (527 fails with `ProgramFailedToComplete`). The documented 566 bytes applies to an unsigned instruction. With a signer attached the program runs out of its default 200,000 compute units first. Our largest record is 148 bytes, so there are more than three times that to spare.
- **The fee is 5,000 lamports per transaction**, so a four-Memo game costs 0.00002 SOL and a 0.01 SOL drip covers about 500 transactions.
- The real program exists on devnet as an executable account, and real Memo transactions from other programs read back correctly through the adapter, including Memos mixed with ComputeBudget and token instructions.
- **Not yet done:** actually submitting a Memo. The public devnet faucet returned 429 ("airdrop limit reached or faucet dry") for this sandbox, so there was no SOL to pay the fee. `pnpm --filter @accident/solana devnet-check` does the full send, read-back and address-scan round trip once a funded key is available (set `DEVNET_FUNDED_SECRET_KEY`, or try again after the faucet limit resets).

The chain adapter sends at `confirmed` commitment. Lookup polls `getTransaction` with backoff (250 ms up to 2 s), with a 20 s ceiling before the `getSignaturesForAddress` fallback.

## 7. Computer opponent

Engine strategies exactly as PRD section 7. The Worker receives `{level, history}` and replies with a guess. Hard uses minimax over consistent codes with the smallest sum of squared bucket sizes as tie-break, opening guess 0123. Budget for a low-end phone is up to 10x the 146 ms server figure. Benchmark on a real phone before Wednesday.

## 8. Backend functions

- `POST /api/drip {pubkey}`: validate base58, check balance, one per key per day, per-IP cap, reserve floor, send fixed amount, log. Idempotent per key.
- `POST /api/event {name, props}`: allow-list, size limit, per-IP rate limit, insert row.
- Secrets in Vercel env vars only. `.env.example` lists names, never values.
- Analytics store **[Default]**: Supabase Postgres table, same project as the relay.

## 9. Error handling

| Failure | Behaviour |
| --- | --- |
| Memo send fails | Retry up to 3 with backoff, then message plus retry button |
| Opponent commit not found | "Waiting for chain", poll, then address scan fallback |
| Relay drops | Status chip turns amber, SYNC on reconnect, resend timer |
| Tab hidden | Banner, wake lock re-request on visible |
| Invalid or forged message | Dropped, counted in debug panel, never shown as opponent action |
| Vault lost | Explicit forfeit message, no reveal possible |
| Drip fails | Show address and public faucet link |

## 10. Deltas from PRD v1.1

| # | Change | Reason |
| --- | --- | --- |
| D1 | First commit and first reveal Memo per (room, key) are canonical; a differing second is a fault | Closes commit equivocation |
| D2 | SYNC message plus resend timer; HELLO payload carries `host` or `guest` | Relay has no retries or history; needed to derive seats for third parties |
| D3 | Host key in share-link fragment; first-HELLO pinning | Limits room hijack |
| D4 | Reveal Memo carries a transcript hash; Verifier page | Makes "provable to anyone" true |
| D5 | Contradiction detection from empty candidate set (Could) | Early end for hidden-40 lies |
| D6 | House Bot promoted from Could to Should | Odd numbers at the meetup; scripted lie demo |
| D7 | Stale 7 Oct fallback replaced (see tasks.md fallback ladder) | v1.1 already is "commit and reveal only" |
| D8 | Risk reference in PRD 8.5 should be R1, not R3 | Typo |
| D9 | Protocol split into a transport-agnostic package | Fast Node tests and the bot |

## 11. Testing strategy

- **engine**: PRD A.1 vectors, symmetry, 5,040 codes, candidate filtering, strategy averages.
- **protocol/commitment**: A.2 vector in Node and in the browser (Playwright later), four negative cases.
- **protocol/memo**: encode and parse round trips, strict rejection of malformed text, wrong room or signer rejected.
- **protocol/session**: in-memory transport and fake chain. One file per attack from REQ-18.3, plus dropped-message, duplicated-message and reorder tests for the SYNC logic.
- **web**: component tests for keypad and board, manual device matrix on 7 Oct.
- **integration**: two browser sessions on devnet, 6 Oct.

## 12. Open items

1. Relay provider: Supabase Realtime **[Default]** or Cloudflare-based. Decide after a latency check from Nigeria.
2. Hosting: Vercel **[Default]**.
3. Licence: MIT **[Default]**.
4. ~~Memo program ID and signer behaviour~~ confirmed by devnet simulation. A real submitted transaction is still to do (faucet rate-limited).
5. Colosseum deadline and any on-chain program requirement.
6. Test phones.
