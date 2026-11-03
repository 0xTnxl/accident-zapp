# Requirements: ACCIDENT (Memo-only, devnet)

Baseline: PRD v1.1 (Memo-only on-chain scope), plus the changes listed in `design.md` under "Deltas from PRD v1.1".
Items marked **[Proposed]** are additions to v1.1 that need owner sign-off. Items marked **[Default]** are decisions made to unblock work and can be changed.

## Glossary

- **Client**: the browser app (or the House Bot) acting for one player.
- **Seat**: 0 for the room creator (guesses first), 1 for the joiner.
- **Commitment**: SHA-256 of tag, room, player key, secret and salt (REQ-7).
- **Transcript**: the ordered signed HELLO, COMMIT, GUESS and ANSWER messages of one game (REQ-15).
- **Play gate**: the rule that no GUESS or ANSWER is sent until both commit Memos are verified on-chain.
- **Burner key**: an Ed25519 keypair generated in the browser. It signs Memo transactions and relay messages.

---

## REQ-1 Zero-friction start

**User story:** As a stranger with a link, I want to start playing without signing up or installing anything, so that I can judge the game in seconds.

1. WHEN a user opens the site for the first time, THE Client SHALL show the Home screen without requiring an account, email or wallet.
2. THE Home screen SHALL explain the game using the 1964 / 2604 = 1 dead, 1 injured example without any other instruction.
3. WHEN a user starts a practice game, THE Client SHALL allow a first guess within 15 seconds of page load on a mid-range phone over mobile data.
4. THE Client SHALL work in Chrome for Android, Safari on iOS and desktop Chrome.
5. THE Client shell SHALL target under about 300 KB gzipped. The exact size is measured, not assumed.

## REQ-2 Practice mode

**User story:** As a player, I want to play against the computer offline, so that I can learn the game and have a game available when no friend is around.

1. THE Client SHALL offer three computer levels: Easy, Medium (default) and Hard (labelled "Expert").
2. THE computer opponent SHALL run in a Web Worker so the UI stays responsive.
3. WHEN the service worker has cached the app shell, THE Client SHALL allow practice games with no network.
4. THE Practice screens SHALL state that practice is local and not provably fair.
5. THE Client SHALL record local wins, losses and average guesses per level (Should).

## REQ-3 Rules and engine

**User story:** As a player, I want identical rules on every client, so that results are not disputed.

1. THE engine SHALL accept only secrets and guesses made of 4 distinct digits 0-9, with leading zero allowed.
2. THE engine SHALL compute feedback as dead x 10 + injured, matching every vector in PRD Appendix A.1.
3. THE engine SHALL treat 31 and any value with dead + injured above 4 as invalid feedback. Exactly 14 feedback values are valid.
4. THE engine SHALL enumerate exactly 5,040 valid distinct codes.
5. THE engine SHALL implement the turn, equal-turns, 12-guess cap and draw rules of PRD section 4.
6. THE engine SHALL be pure TypeScript with no DOM, network or chain dependency.

## REQ-4 Rooms

**User story:** As a player, I want to create a room and share a code or link, so that a friend can join.

1. WHEN a user creates a room, THE Client SHALL generate a 6-character code from an unambiguous alphabet and show the code, a copy button and a share link `/r/<code>`.
2. WHEN a user opens a share link or enters a code, THE Client SHALL join the room's relay channel.
3. THE creator SHALL be seat 0 and the joiner seat 1.
4. THE creator's Client SHALL accept the first valid guest HELLO as the opponent and ignore HELLOs from any other key.
5. **[Proposed]** THE share link SHALL carry the host public key in the URL fragment so the joiner pins the host key. Manual code entry falls back to trust on first HELLO.
6. THE Client SHALL never reuse a room code for a second game. A rematch SHALL use a new room code and a new salt.
7. WHEN the creator cancels, THE Client SHALL close the channel and discard the room.

## REQ-5 Vault and burner key

**User story:** As a player, I want my secret and key to survive a refresh, so that a refresh does not lose the game.

1. ON first visit, THE Client SHALL generate a burner Ed25519 keypair and store it in localStorage and IndexedDB.
2. THE Client SHALL call `navigator.storage.persist()` where available.
3. THE Client SHALL write the secret and salt to the vault BEFORE the commit Memo is sent.
4. WHEN the page reloads during a game, THE Client SHALL restore the vault, rejoin the channel and resume (REQ-14).
5. IF the vault is lost mid-game, THEN THE Client SHALL tell the player they cannot reveal and will forfeit.
6. THE Client SHALL warn players not to clear browser data during a game.

## REQ-6 Funding (drip)

**User story:** As a new player with no SOL, I want to be funded automatically, so that I never see a faucet.

1. WHEN a user taps "Play a friend" and their burner balance is below the threshold, THE Client SHALL request `POST /api/drip` and show a "funding" state until the balance lands.
2. THE drip endpoint SHALL send a fixed small amount (default 0.01 SOL devnet) only to a valid base58 key below the threshold.
3. THE drip endpoint SHALL allow one drip per key per day, apply a per-IP daily cap, refuse below a reserve balance and log every drip.
4. THE funding wallet key SHALL exist only in host environment variables.
5. IF the drip fails, THEN THE Client SHALL show the player's address and a link to a public devnet faucet.

## REQ-7 Commitment

**User story:** As a player, I want a binding, hidden commitment to my secret, so that I cannot change it later and my opponent cannot read it.

1. THE Client SHALL compute `SHA-256("ACCIDENT_V1" || room(6 ASCII) || playerPubkey(32) || secret(4 bytes, one digit per byte) || salt(32))`.
2. THE Client SHALL generate a fresh 32-byte random salt per game using `crypto.getRandomValues`.
3. THE commitment function SHALL reproduce `525d7b2d31149cd7453b079bbaa25f6e170652683c478f5e06d19717f9ba7f15` for the PRD A.2 vector in both the browser and Node.
4. A wrong salt, secret, room or player key SHALL each produce a different commitment.

## REQ-8 Memo records

**User story:** As a player, I want public, signed, timestamped records of my commit and reveal, so that anyone can audit the game.

1. THE Client SHALL send the commit as a Memo transaction signed by the burner key: `ACC1|<room>|C|<64 hex>`.
2. THE Client SHALL send the reveal as a Memo transaction: `ACC1|<room>|R|<secret>|<64 hex salt>`, with the **[Proposed]** transcript anchor `|<64 hex transcript hash>` appended (REQ-15).
3. THE Client SHALL parse Memo text strictly and reject any deviation. A Memo only counts if the transaction succeeded, the instruction belongs to the Memo v2 program, it is the only Memo in the transaction, and the signer is the fee payer.
4. WHEN fetching an opponent record by signature, THE Client SHALL check that the transaction succeeded, the signer equals the opponent key, the Memo text matches and the room matches, and SHALL read the block time.
5. **[Proposed]** FOR each (room, key), THE earliest-landed commit Memo SHALL be canonical. A later, different commit Memo from the same key SHALL be treated as equivocation and a fault. The same first-wins rule SHALL apply to reveal Memos.
6. THE Client SHALL retry a failed Memo send up to 3 times, then show a clear message and a retry button.
7. IF the signature lookup is slow or missing, THEN THE Client SHALL poll with backoff and fall back to `getSignaturesForAddress` on the opponent key.

## REQ-9 Play gate

**User story:** As a player, I want to be sure my opponent locked in a secret before any guess is exchanged, so that they cannot choose it after seeing my guesses.

1. THE Client SHALL NOT send a GUESS or ANSWER until both commit Memos are verified as confirmed on-chain under REQ-8.4.
2. THE Client SHALL reject and ignore a GUESS or ANSWER received before its own gate is open, and SHALL re-request it after the gate opens.
3. THE Client SHALL show a plain-language "waiting for chain" state while the gate is closed.

## REQ-10 Signed relay protocol

**User story:** As a player, I want every message to be provably from my opponent, so that a relay cannot forge moves.

1. THE Client SHALL sign every message with the burner key using Ed25519 over `"ACC1|" + room + "|" + seq + "|" + type + "|" + payload`.
2. THE Client SHALL verify every received signature against the pinned opponent key and drop invalid messages.
3. THE Client SHALL keep a per-sender `seq` starting at 0 and SHALL drop duplicates and replays.
4. THE Client SHALL reject a GUESS that is out of turn or not a valid code, and an ANSWER that answers the wrong guess index or carries invalid feedback.
5. **[Proposed]** THE Client SHALL keep sent messages until acknowledged, and SHALL re-send unanswered messages on a timer and after any reconnect. A SYNC message carrying the highest seq received SHALL trigger re-sending of later messages. SYNC is not part of the transcript.
6. THE transport SHALL sit behind a `Transport` interface so the relay provider can be swapped.
7. THE Client SHALL accept at most two participants per room.

## REQ-11 Turn flow and auto-answer

**User story:** As a player, I want answers to appear instantly, so that the game feels real-time.

1. WHEN a verified GUESS arrives and the gate is open, THE Client SHALL compute feedback from the local secret and send a signed ANSWER with no user action and no wallet prompt.
2. WHEN a guess is due from the local player, THE Client SHALL enable the keypad and send GUESS on confirm.
3. THE Client SHALL display my guesses with results, the opponent's guess count, whose turn it is, chain status and relay status.
4. THE Client SHALL stop play when the end rules of PRD section 4 are met and SHALL then send the reveal Memo and a REVEAL message.
5. **[Proposed, Could]** WHEN the candidate set computed from the opponent's answers becomes empty, THE Client SHALL show that the opponent's answers are inconsistent and offer an early reveal.

## REQ-12 Reveal and finalisation

**User story:** As a player, I want the same verdict on both phones, so that nobody can dispute it.

1. THE Client SHALL verify each REVEAL by hashing the revealed secret, salt, room and player key and comparing with the canonical on-chain commitment. A mismatch SHALL be a fault for that player.
2. A revealed secret that is not a valid code SHALL be a fault.
3. FOR every guess a player answered, THE Client SHALL re-score it against that player's revealed secret. Any difference from the signed ANSWER SHALL be a fault.
4. IF exactly one player is at fault, THEN the other SHALL win with reason "lie". IF both are at fault, THEN the result SHALL be a draw.
5. IF neither is at fault, THEN THE Client SHALL apply the first-hit and round rules: lower round wins, equal rounds draw, one hit wins, no hit draws.
6. THE finalisation function SHALL be deterministic and pure, and SHALL give the same output on every client for the same inputs.
7. Each attack in REQ-18.3 SHALL have a test that shows it is caught.

## REQ-13 Timeouts (UI-only)

**User story:** As a player, I want to leave a stalled game, so that a sleeping opponent does not trap me.

1. THE Client SHALL show a visible 180-second countdown for the player on the clock.
2. WHEN the countdown expires, THE waiting Client SHALL offer "Claim win by timeout".
3. IF the opponent never posts a valid reveal within 180 seconds after the local player revealed, THEN THE Client SHALL offer a forfeit win.
4. THE UI and pitch SHALL state that timeouts are not enforced on-chain.

## REQ-14 Resilience

**User story:** As a player on a phone, I want the game to survive interruptions.

1. THE Client SHALL request a screen wake lock during friend games and SHALL warn when the tab is hidden.
2. WHEN the connection drops or the tab returns from background, THE Client SHALL reconnect, exchange SYNC and resume without losing state.
3. WHEN the page is refreshed mid-game, THE Client SHALL rebuild game state from the vault and persisted transcript.
4. THE Client SHALL never fail silently. Every failure state SHALL have a plain-language message.

## REQ-15 Result, transcript and verifier

**User story:** As a judge or player, I want to check a game myself, so that I do not have to trust either client.

1. THE Result screen SHALL show win, lose or draw, both secrets marked verified or not, and explorer links to both players' commit and reveal Memos.
2. THE Client SHALL export the transcript as a file.
3. **[Proposed]** THE reveal Memo SHALL carry `sha256` of the canonical transcript (design.md section 5.3). The hash is an anchor, not an input to the verdict.
4. **[Proposed]** A Verifier page SHALL accept two reveal signatures and a transcript, fetch the Memos, check the signatures, commitments and transcript hash, and display the verdict and any fault with its evidence.
5. THE Result screen SHALL offer a rematch, which creates a new room.

## REQ-16 Analytics

1. THE Client SHALL send only the events in PRD section 8.6, each with a random anonymous session ID and a timestamp.
2. THE event endpoint SHALL allow-list event names, limit payload size and rate-limit per IP.
3. THE Client SHALL collect no personal data.

## REQ-17 House Bot

**User story:** As a meetup player with no partner, I want an opponent that is always online.

1. **[Default: Should]** A Node House Bot SHALL play through the real protocol, funding, commit, relay, reveal, using the same `protocol` package as the Client.
2. THE House Bot SHALL support a cheating mode that lies about an answer, used to demonstrate and test lie detection.
3. THE House Bot SHALL be labelled as a bot in the room.

## REQ-18 Quality and open source

1. THE repo SHALL be public with README, licence (**[Default]** MIT), run instructions and the Memo program ID used.
2. CI SHALL run typecheck, lint and Vitest on every push.
3. THE protocol tests SHALL cover: lying answer, false 40, hidden 40, invalid secret, forged signature, replayed or out-of-order seq, out-of-turn guess, feedback 31, commit equivocation, missing reveal.
4. THE engine tests SHALL cover: A.1 vectors, score symmetry over 2,000 random pairs, `filterCandidates` keeps the true secret, 5,040 codes, Hard averages at most 5.4 with worst case at most 8.
5. THE commitment test SHALL reproduce the A.2 vector.
6. No secrets SHALL be committed. `.env` files are git-ignored.

## REQ-19 Security and disclosure

1. THE Client SHALL keep secrets and salts on the device until the reveal.
2. THE product SHALL use devnet only, with no money, escrow or tokens.
3. THE pitch and README SHALL state plainly: the chain records and proves, the clients enforce; timeouts are UI-only; solver-assisted play cannot be prevented.
