# Requirements: Leaderboard (friend-to-friend ranked play)

Baseline: this spec extends `.kiro/specs/accident/requirements.md` (REQ-1 through REQ-19) and
`design.md`. Requirements here continue that numbering from REQ-20. Nothing in this document
changes REQ-1 through REQ-19; practice mode, the engine, the commit/reveal protocol and the
Verifier are unchanged.

Items marked **[Proposed]** need owner sign-off before implementation. Items marked **[Default]**
are decisions made to unblock work and can be changed without re-opening the whole spec.

## Glossary (additions)

- **Account**: a backend-registered login (REQ-20), distinct from a burner key. One account may
  own several burner keys over its lifetime (new device, cleared storage, rotated key).
- **Rated game**: a friend-mode game whose verdict the backend has independently verified from
  on-chain data (REQ-22), and that is eligible to change both players' ratings (REQ-23).
- **Rating**: a player's Glicko-2 `(rating, RD, volatility)` triple (REQ-24). "Rank" in the UI
  means position in the leaderboard ordered by `rating`, with RD and volatility never shown
  directly to players.
- **Credit**: the act of the backend recording a rated game's result and updating both players'
  ratings. A game is credited at most once (REQ-23.4).

---

## REQ-20 Accounts

**User story:** As a player, I want a login that survives losing my browser storage or switching
devices, so that my rank is mine, not my browser's.

1. THE product SHALL offer account creation and login (**[Default]** email + password to start;
   see design.md for whether a passwordless/magic-link option is added later).
2. WHEN a user is logged in, THE Client SHALL associate every burner key it generates or loads for
   that browser with the logged-in account on the backend.
3. THE Client SHALL continue to work with no account for practice mode and for friend mode started
   without logging in (REQ-1, REQ-2 unchanged); an anonymous player's games are never rated and
   never appear on the leaderboard.
4. IF a player logs in on a new device or after clearing storage, THEN THE Client SHALL generate a
   new burner key as today (REQ-5.1) and link it to the same account, so rating history is not
   lost.
5. THE backend SHALL never accept a burner-key-to-account link claim that is not accompanied by a
   valid, current login session for that account.
6. **[Proposed]** THE backend SHALL allow an account to have at most one burner key considered
   "active" for new rated games at a time, to keep "which key is this account's current rank"
   unambiguous; a newly linked key supersedes the previous one for future rated games, past
   results already credited are unaffected.
7. THE product SHALL state in its account/login copy that an account is only needed for ranked
   play; practice and casual friend games never require one (consistent with REQ-19.3's honesty
   requirement).

## REQ-21 Opting into a ranked game

**User story:** As a player, I want to choose whether a given friend game counts toward rank, so
that I can also just play casually.

1. WHEN both players in a room are logged in, THE Client SHALL offer a "ranked" toggle before
   secrets are picked (REQ-4, REQ-5 unchanged otherwise).
2. A game SHALL only be eligible to be rated if both players were logged in and both opted in
   before the first commit Memo was sent. A game started anonymously, or with only one player
   logged in, is never rated, even if that player logs in mid-game.
3. THE Client SHALL show, before the opt-in is confirmed, that a ranked game only counts if it
   reaches a real verdict (REQ-22) — a timeout or an abandoned game earns nothing (REQ-23.2).
4. Choosing not to opt in SHALL NOT change any other rule in `.kiro/specs/accident`: the same
   commit/reveal protocol, play gate and finalisation run either way (REQ-7 through REQ-12
   unchanged).

## REQ-22 Server-side verification before crediting

**User story:** As any player, I want the leaderboard to only reflect games that genuinely
happened on-chain the way they're reported, so that nobody can boost their rank by lying to the
backend.

1. THE backend SHALL NOT credit a rated game from a client's self-reported result. It SHALL
   independently recompute the verdict from the on-chain commit and reveal Memos, the same way the
   Verifier does (REQ-15.4; see design.md for reuse of `verifyGame`/`finalise`).
2. THE Client SHALL submit the exported transcript (REQ-15.2) and both reveal signatures to the
   backend once a ranked game reaches `FINAL`. Submission SHALL be retried on failure; a dropped
   submission SHALL NOT silently discard a real win (design.md covers the retry/backfill path).
3. THE backend's recomputed verdict, not the one either client displayed, SHALL decide whether the
   game is credited and who the winner is. A disagreement between a client's displayed verdict and
   the backend's recomputed one is itself worth logging (it would indicate a client bug, not
   grounds for a different leaderboard outcome).
4. A game whose recomputed verdict is `pending` or `abandoned` SHALL NOT be credited.
5. THE backend SHALL verify both players were logged in and had opted in (REQ-21.2) before
   crediting, independent of anything the client claims about opt-in status.

## REQ-23 What counts, what doesn't

**User story:** As a competitive player, I want the rules for what changes my rank to be simple
and hard to game, so that the number means something.

1. ONLY a ranked friend-to-friend game (REQ-21) that reaches a `final` verdict (REQ-22.1) with
   result `seat0`, `seat1` or `draw` SHALL change either player's rating.
2. A win claimed by timeout (REQ-13) SHALL NOT be credited, rated, or counted anywhere in either
   player's leaderboard stats, even informally. Only a verdict reached through the normal
   reveal-and-finalise path counts.
3. Practice-mode results (REQ-2) SHALL NEVER contribute to rating or appear on the leaderboard, for
   any player, under any setting. They remain a personal, client-only stat as today (REQ-2.5).
4. A given room code SHALL be credited at most once. A resubmission of the same room's transcript
   (REQ-22.2's retry path, or a second device replaying an export) SHALL be a no-op, not a double
   count. (See design.md for the idempotency key.)
5. A player at fault under REQ-12.4 (a caught lie) SHALL be scored as a loss for rating purposes
   exactly like any other loss; a fault is not a special rating case, it is simply how that game's
   `result` was decided.
6. Average guesses per game and average finish time per game (REQ-24.4) SHALL only accumulate from
   credited rated games, for the same reason wins only count from credited rated games.

## REQ-24 Rating system

**User story:** As a player, I want a rank that reflects sustained performance against real
opponents, not luck or a few easy wins, so that climbing the board means something.

1. THE backend SHALL rate players using Glicko-2 (rating, ratings deviation "RD", volatility),
   initialised per the Glicko-2 reference defaults (**[Default]** rating 1500, RD 350,
   volatility 0.06) for a brand-new account's first rated game.
2. WHEN a rated game is credited (REQ-22, REQ-23), THE backend SHALL update both players' Glicko-2
   triples from that single result, treating a draw as the Glicko-2 "0.5" outcome.
3. THE leaderboard SHALL rank by `rating` only. RD and volatility are internal to the update
   calculation and SHALL NOT be shown to players as separate numbers (**[Default]**; a confidence
   indicator derived from RD, e.g. "provisional" vs "established", MAY be shown without exposing
   the raw value).
4. THE backend SHALL additionally track, per account, the running average number of guesses per
   credited rated game and the running average finish time per credited rated game (REQ-23.6).
5. WHEN two or more accounts are tied at the same displayed rating (**[Default]**: equal after
   rounding to the nearest whole rating point), THE leaderboard SHALL break the tie first by lower
   average guesses per game, then by lower average finish time per game, consistent with "goal
   difference" style tiebreakers.
6. **[Proposed]** THE leaderboard SHALL NOT display a rank for an account with fewer than 5
   credited rated games (shown instead as "provisional" or similar), so a short lucky streak
   cannot sit above players with a long, representative history.
7. THE rating update function SHALL be pure, deterministic and unit-tested against known Glicko-2
   reference vectors, consistent with the project's convention that `packages/engine` and
   `packages/protocol`-style logic stays side-effect-free and independently testable.

## REQ-25 Finish time

**User story:** As a player, I want finish time to mean the same thing for every game, so that the
stat is comparable across players.

1. THE backend SHALL compute a credited game's finish time from on-chain-anchored or
   session-state timestamps already established as trustworthy by REQ-22 (see design.md for which
   `Session` state fields need to be exposed to compute this; `useGameEffects.ts`'s current
   browser-clock-only duration, reset by a refresh, is NOT a trustworthy source and SHALL NOT be
   the system of record).
2. Finish time SHALL be measured from the moment the play gate opens (REQ-9, both commits verified)
   to the moment the game's `final` verdict is reached, not from room creation (time spent waiting
   for an opponent to join, or waiting on commit Memos to confirm, SHALL NOT count against either
   player).
3. THE backend SHALL record one finish time per credited game (shared by both players), not a
   separate per-player time, since both players' games end at the same verdict.

## REQ-26 Leaderboard display and real-time updates

**User story:** As a player, I want to see the leaderboard update as games finish, so that it feels
alive, not like a static page.

1. THE Client SHALL show a leaderboard screen listing ranked accounts by rating (REQ-24.3), with
   average guesses and average finish time visible as columns (REQ-24.4), reachable without being
   logged in (read access is public; only crediting requires login, per REQ-20.3).
2. WHEN a rated game is credited, THE Client SHALL reflect both players' updated ratings on the
   leaderboard without requiring a manual refresh, using the existing Realtime relay infrastructure
   (REQ-10.6's `Transport` seam) rather than introducing a second real-time mechanism.
3. THE leaderboard SHALL show a player's own account's rank and stats prominently when that player
   is logged in, even if they are far outside the visible top of the board.
4. THE leaderboard screen SHALL state plainly, consistent with REQ-19.3, that only verified
   friend-to-friend games count, that solver-assisted play cannot be prevented, and that a
   competitive incentive makes that disclosure more important, not less.

## REQ-27 Quality

1. THE rating engine, the server-side verification/crediting path and any new relayer endpoints
   SHALL follow the existing relayer convention (`apps/relayer`'s port/adapter/entry layering) and
   SHALL be covered by the same 100%-statement/branch/function/line test bar already enforced for
   `apps/relayer`.
2. New Supabase tables SHALL enable Row Level Security with no public write policies, consistent
   with the existing `rate_counters`/`events` tables; only the service-role key may write ratings
   or credited-game records.
3. CI SHALL continue to run typecheck, lint and Vitest on every push (REQ-18.2 unchanged) and SHALL
   fail if a new table or endpoint lowers coverage below the existing bar.
4. No account credential (password hash, session token, etc.) SHALL ever be logged, included in
   analytics (REQ-16), or committed to the repository (REQ-18.6 unchanged).
