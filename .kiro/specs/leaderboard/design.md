# Design: Leaderboard (friend-to-friend ranked play)

Implements `requirements.md` (REQ-20 through REQ-27). Builds on `.kiro/specs/accident/design.md`
without changing it: the commit/reveal protocol, play gate, finalisation and Verifier are reused
as-is, not modified.

## 1. Architecture

Two new pieces slot into the existing shape; nothing already drawn in the accident design's
section 1 diagram moves.

```
 apps/web (React PWA)
   + Login/Account screens (new)
   + Leaderboard screen (new)
   + ranked opt-in on the existing room flow
            |
            v
     packages/protocol  (UNCHANGED: session, finalise, verifyGame reused as a library call)
            |
            v
 apps/relayer (Vercel functions)
   existing: POST /api/drip, POST /api/event
   + POST /api/auth/*      (account creation, login, session)      (new)
   + POST /api/credit      (submit a finished ranked game)         (new)
   + GET  /api/leaderboard (read current ratings, paginated)       (new)
            |
            v
   Supabase (existing project)
     existing: rate_counters, events
     + accounts, sessions, burner_links, rated_games, ratings      (new tables)
            |
            v
   Supabase Realtime (existing relay infra, reused for leaderboard pushes too)
```

The engine and protocol packages stay exactly as described in the accident design's section 1:
pure TypeScript, no DOM/network/RPC. The new rating math (section 5 below) is new pure code with
the same property, but it does not live inside `packages/protocol` since it has nothing to do with
game rules — it is a new, equally pure package or module, not a change to the existing one.

### 1.1 What does NOT change

- The commit/reveal wire protocol, Memo formats, play gate and `finalise()` (accident design
  sections 3-6) are untouched. A ranked game and a casual game run through identical protocol code;
  "ranked" is purely a backend bookkeeping decision made before the first commit (REQ-21.2) and
  checked again after the fact (REQ-22.5).
- The Verifier page (`apps/web/src/verify`) is untouched and remains independently usable by
  anyone, for any game, ranked or not.
- Practice mode, the engine, and the House Bot are untouched.

## 2. Accounts and login

### 2.1 Why a backend login, not an on-chain identity

The user explicitly chose a backend login over an on-chain identity scheme: burner keys stay
exactly what they are today (REQ-5, generated per-browser, used to sign Memos and relay messages),
and an account is a separate backend concept that a burner key gets *linked to*, not replaced by.
This keeps every existing REQ-5 through REQ-14 behaviour unchanged for a logged-out player.

### 2.2 Schema

```sql
-- One row per registered player. Password hashing and session handling can use Supabase Auth
-- directly (it already exists in the project's dependency, @supabase/supabase-js, and the
-- relayer's own createClient call already has auth explicitly turned off for the SERVICE role,
-- not for end users) rather than hand-rolling password storage.
-- accounts.id = the Supabase Auth user id (uuid), so this table is a thin profile row, not a
-- credential store. No password hash is ever stored by code in this repo.
create table public.accounts (
  id uuid primary key,                 -- references auth.users(id)
  display_name text not null,
  created_at timestamptz not null default now()
);

-- Which burner public key is currently "active" for an account's new rated games (REQ-20.6).
-- History of past links is kept (never deleted) so already-credited games stay attributable.
create table public.burner_links (
  public_key text primary key,         -- base58, same format used everywhere else in the repo
  account_id uuid not null references public.accounts(id),
  linked_at timestamptz not null default now(),
  active boolean not null default true
);
create index burner_links_account_idx on public.burner_links(account_id);

-- At most one active link per account at a time (REQ-20.6); enforced in the crediting/link path,
-- not as a DB constraint, since "becomes inactive" is a write, not a uniqueness rule a plain
-- unique index can express cleanly against a boolean column.
```

Row Level Security is enabled with no public policies, same convention as `rate_counters` and
`events` (REQ-27.2): only the relayer's service-role key writes these tables. Reads for the
leaderboard go through a dedicated read endpoint (section 6.3), not direct client access to
Supabase, so RLS staying fully closed is simplest and matches the existing posture.

### 2.3 Login flow

**[Default]** Use Supabase Auth's own email+password flow (`supabase.auth.signUp` /
`signInWithPassword`) directly from the web client against the **anon** key — this is the one
place in the whole app where the anon key is used for something Supabase Auth is actually designed
for, rather than hand-building session/password handling. On successful login, the client holds a
Supabase session (JWT) and sends it as a bearer token on `/api/credit` and the burner-link call;
the relayer verifies it server-side with the service-role client before trusting any account id in
the request body (REQ-20.5 — never trust a client-claimed account id).

A thin `/api/account/link-burner` endpoint (POST, body `{publicKey}`, auth'd) does the actual
`burner_links` write: looks up the caller's account from the verified session, marks any existing
active link for that account `active = false`, inserts the new link as `active = true`. This
follows the existing `drip`/`event` handler shape (section 6.1).

### 2.4 Web app changes

- `apps/web/src/account/` (new directory, same flavour as `apps/web/src/friend/` and
  `apps/web/src/verify/`): login/signup screens, a small `AccountContext`
  (logged-out/logging-in/logged-in), and a `linkBurnerKey()` call fired once after a successful
  login or when a new burner key is created while already logged in (REQ-20.2, REQ-20.4).
- `FriendRoot.tsx`'s existing `identity = useMemo(() => loadOrCreateIdentity(...))` call is
  unchanged. Account linking is an *additional* side effect alongside identity creation, not a
  replacement for it — `loadOrCreateIdentity` keeps working exactly as today for a logged-out
  player (REQ-20.3).
- Lazy-loaded like `friend`/`verify` already are, so a logged-out player's always-loaded entry
  bundle does not grow (same bundle-size discipline the project already enforces via
  `apps/web/test/bundle.test.ts`).

## 3. Ranked opt-in

A new `ranked: boolean` field is added to the room's local setup state (`FriendController`'s setup
flow, not `Session`/`SessionOptions` — ranked-ness is bookkeeping about *whether to submit for
crediting afterwards*, not a rule that changes how the game is played, per REQ-21.4). It defaults
to `false` and is only offered as a toggle when `AccountContext` reports both... actually, a client
only knows its own login state, not the opponent's, until HELLO exchange. The toggle is offered to
a logged-in player; the game is only *actually* submitted for crediting if **both** sides, by their
own HELLO-era signal, were ranked-and-logged-in (REQ-21.2) — enforced server-side regardless
(REQ-22.5), so a client lying about the opponent's state cannot force a credit.

Concretely: the `HELLO` message's existing payload (`host`/`guest`, accident design section 3) is
not changed — the wire protocol stays exactly as specified. Instead, each client independently
decides, from its own login+toggle state, whether *it* will submit this game for crediting once it
reaches `FINAL`. The backend only credits a game once **both** players' independent submissions
agree on the room, the players, and the recomputed verdict (section 4.3) — this sidesteps needing
any new signed wire message type at all.

## 4. Server-side verification and crediting

### 4.1 Reusing `verifyGame`

`apps/web/src/verify/verifier.ts`'s `verifyGame(input, {chain})` is already exactly the function
needed: pure, takes a transcript + two reveal signatures, returns a structured `Verdict` recomputed
independently from on-chain data (REQ-22.1). It currently lives under `apps/web/src/verify` and
imports only from `@accident/protocol`, so it has no browser dependency itself — the only reason it
isn't already relayer-usable is its current location. It is moved (not copied) to
`packages/protocol/src/verify.ts` (or kept where it is and re-exported — either way, **one**
implementation) and imported by both the Verifier page and the new relayer endpoint, so the two
can never silently drift apart.

### 4.2 Submission

```
POST /api/credit
Authorization: Bearer <supabase session JWT>
{
  "room": "AB3F9K",
  "transcript": { "room": "...", "messages": [...] },   // the existing export shape, REQ-15.2
  "revealSigs": ["<sig0>", "<sig1>"],
  "ranked": true
}
```

Each player's own client calls this once, independently, when their `Session` reaches `FINAL` and
they had opted into ranked (section 3). The server does not need both calls to arrive together: it
holds the first submission for a room (keyed by room code) and credits once it has verified
**either**:
- both players submitted (ordinary case), or
- one submission plus the server's own `verifyGame()` recomputation of the *other* player's
  identity, independently confirmed from the on-chain commit Memo under that room (available
  without the second player's cooperation, since commit Memos are public — this covers the case
  where one player's browser closes before the submit call fires, matching REQ-22.2's "a dropped
  submission SHALL NOT silently discard a real win").

### 4.3 Crediting logic (`apps/relayer/src/credit.ts`, new, same shape as `drip.ts`/`event.ts`)

```ts
export interface CreditDeps {
  chain: Chain;                                   // reused Chain port, same adapter as elsewhere
  db: DatabaseLike;                                // extended as needed
  verifySession(jwt: string): Promise<string | undefined>; // -> account id, or undefined
  clock: Clock;
}

export async function handleCredit(request: Request, deps: CreditDeps): Promise<Response> {
  // 1. Verify the bearer session -> accountId. Reject (401) if absent/invalid.
  // 2. Parse body; reject (400) on shape errors, same style as event.ts's cleanProps.
  // 3. Look up accountId's active burner_links row; reject (403) if the transcript's claimed
  //    seat for this account does not match the linked public key (REQ-20.5, REQ-22.5).
  // 4. Idempotency check (REQ-23.4): a `rated_games` row already existing for this room with
  //    status 'credited' -> return the existing result, 200, no further work, no second rating
  //    update. This is the idempotency key the requirements doc calls out.
  // 5. Run verifyGame({transcript, revealSigs}, {chain}) -- the SAME function the Verifier page
  //    calls, imported from the moved/shared location (section 4.1).
  // 6. If verdict.kind !== 'final' (REQ-22.4) or result implies a timeout-only outcome
  //    (REQ-23.2 -- `verifyGame`'s recomputed verdict never has a timeout branch at all, since
  //    `finalise()` only ever returns 'pending'/'abandoned'/'final'; a client's local
  //    "timeout win" claim literally cannot reach this far, because it has no corresponding
  //    on-chain reveal to verify -- this is why REQ-23.2 falls out of the design for free rather
  //    than needing a special check).
  // 7. Resolve both seats to accounts via burner_links (a seat with no linked account, or two
  //    seats mapping to the same account, voids crediting -- can't rate a game against yourself).
  // 8. Compute finish time (section 5.3) and each seat's guess count (len of that seat's guesses
  //    in the transcript).
  // 9. Run the Glicko-2 update (section 5) for both accounts' current (rating, RD, volatility).
  // 10. Single transaction: insert `rated_games` (status 'credited'), update both `ratings` rows,
  //     update both accounts' running guess/finish-time averages.
  // 11. Return the updated ratings so the submitting client can show its own new number
  //     immediately, without waiting on the Realtime push (section 6.2).
}
```

### 4.4 Schema (continued)

```sql
create table public.rated_games (
  room text primary key,                         -- the idempotency key, REQ-23.4
  seat0_account uuid references public.accounts(id),
  seat1_account uuid references public.accounts(id),
  result text not null check (result in ('seat0', 'seat1', 'draw')),
  reason text not null,                           -- finalise()'s FinalReason, for audit/debugging
  guesses_seat0 int not null,
  guesses_seat1 int not null,
  finish_ms bigint not null,                      -- section 5.3
  credited_at timestamptz not null default now()
);

create table public.ratings (
  account_id uuid primary key references public.accounts(id),
  rating double precision not null default 1500,
  rd double precision not null default 350,
  volatility double precision not null default 0.06,
  games_played int not null default 0,
  avg_guesses double precision,                   -- running average, credited games only
  avg_finish_ms double precision,                 -- running average, credited games only
  updated_at timestamptz not null default now()
);
```

RLS enabled, no public write policies (REQ-27.2); reads happen through `/api/leaderboard`
(section 6.3), not direct table access, so no public read policy is needed either.

## 5. Rating system (Glicko-2)

### 5.1 Why Glicko-2 over plain Elo

Both were discussed with the user; Glicko-2 was chosen because its ratings deviation (RD) and
volatility terms mean a new account's rating moves fast on its first few games and stabilises as
more games accumulate, so a short lucky streak cannot park a new account above players with a long
track record (directly addresses the "boost rank" concern raised when scoping this feature) in a
way plain Elo does not model at all.

### 5.2 Implementation

A new, independently testable pure module — **not** inside `packages/protocol` (it has nothing to
do with game rules) but held to the exact same standard: no DOM/network, deterministic, unit tested
against the published Glicko-2 reference example vectors (REQ-24.7) before it is trusted with real
accounts.

```ts
// packages/rating/src/glicko2.ts (new package, mirrors packages/engine's shape: pure TS, Vitest,
// 100% coverage, exports validated functions only)
export interface Glicko2Rating { rating: number; rd: number; volatility: number; }

/** One rated game's result from one player's perspective. 1 = win, 0.5 = draw, 0 = loss. */
export interface Glicko2Result { opponent: Glicko2Rating; score: 0 | 0.5 | 1; }

/** Updates a single player's rating from one or more games since their last update, per the
 * Glicko-2 algorithm (Glickman, "Example of the Glicko-2 system"). Pure function: no I/O. */
export function updateRating(
  player: Glicko2Rating,
  results: readonly Glicko2Result[],
): Glicko2Rating;

export const DEFAULT_RATING: Glicko2Rating = { rating: 1500, rd: 350, volatility: 0.06 };
```

A credited game calls `updateRating` once per player with that single game as the one-element
`results` array (REQ-24.2 — one game credited at a time, not batched, since crediting is
per-submission). The accident project's existing convention of validated, throwing pure functions
(engine's `assertCode`-style validation) is followed: malformed input (RD/volatility out of the
algorithm's valid domain) throws rather than silently producing a nonsensical rating.

### 5.3 Finish time

Per REQ-25.1-2, finish time is `gameOverAt - gateOpenedAt`, both already-tracked `Session.State`
fields (confirmed present internally in `packages/protocol/src/session.ts`'s private `State`
shape) that are **not currently exposed on `SessionView`**. Two small, additive changes close that
gap:

1. Add `gateOpenedAt?: number` and `gameOverAt?: number` to `SessionView` (session.ts's `view()`
   function already computes both internally; this just stops discarding them at the view
   boundary). This is a pure addition — no existing field changes shape, so no existing consumer
   of `SessionView` needs to change.
2. The exported transcript (REQ-15.2) is extended to optionally carry these two timestamps
   alongside the existing `{room, messages}` shape, so the server-side crediting path
   (section 4.3) can compute finish time from the **same transcript it is already verifying**,
   without a separate, un-verified "trust me, it took this long" field. If a timestamp is absent
   (older export format, or a resumed-from-storage game where one side's local clock view is
   incomplete), the server computes finish time from the two reveal Memos' on-chain block times
   instead (both already fetched during `verifyGame`) — slightly coarser (block time resolution,
   not millisecond), but still chain-anchored, never client-asserted.

This explicitly replaces `useGameEffects.ts`'s current browser-clock `durationMs`
(component-local, reset by a refresh) as the system of record for anything that touches rating or
the leaderboard (REQ-25.1); that existing field can stay exactly as it is for its current, lower-
stakes purpose (the `pvp_finished` analytics event), since analytics tolerating loss/imprecision was
always its documented design (accident design section 8, REQ-16).

### 5.4 Tie-breaking

Per REQ-24.5, when the leaderboard renders, accounts are sorted by `rating` (rounded to the nearest
whole point) descending, then `avg_guesses` ascending, then `avg_finish_ms` ascending. This is a
pure display-time sort over already-stored `ratings` rows — no new stored "combined score" field,
so changing the tiebreak rule later never requires a backfill.

## 6. Backend functions

Extends accident design section 8, same conventions (REQ-27.1): a `*Deps` interface, a pure
`handle*` function, `adapters.ts` holds the only real Supabase/Auth client calls, `wiring.ts` builds
deps from env, `entry.ts` wraps with the fail-closed/never-throw pattern, `api/*.ts` stays a 4-line
re-export.

### 6.1 Endpoints

- `POST /api/account/signup`, `POST /api/account/login` — thin wrappers if not delegating directly
  to Supabase Auth from the client (section 2.3 prefers the direct-from-client approach, which
  needs no new endpoint at all for signup/login itself).
- `POST /api/account/link-burner` — section 2.3.
- `POST /api/credit` — section 4.3.
- `GET /api/leaderboard?limit=&after=` — section 6.3.

### 6.2 Real-time leaderboard updates

REQ-26.2 asks for live updates without a second real-time mechanism. The existing Supabase
Realtime relay (`apps/web/src/friend/transports.ts`'s `SupabaseTransport`, already in production
use for game messages) is reused: `/api/credit`, after committing the rating update, broadcasts a
small `{accountId, rating, avgGuesses, avgFinishMs}` payload on a well-known public channel (e.g.
`accident:leaderboard`) via the same Supabase client the relayer already holds. The leaderboard
screen subscribes to that channel the way `Room.tsx` subscribes to its room channel today, patching
its in-memory sorted list on each message rather than re-fetching. This is additive to
`transports.ts`, not a new transport implementation — the existing `SupabaseTransport` class
already does everything needed (broadcast a message, receive a message); the leaderboard just
picks a fixed, well-known "room name" instead of a per-game one.

### 6.3 Reading the leaderboard

`GET /api/leaderboard` is public (no auth) per REQ-26.1, paginated, returns rows already sorted and
tie-broken per section 5.4, each row `{accountId, displayName, rating, gamesPlayed, avgGuesses,
avgFinishMs, provisional}` where `provisional = gamesPlayed < 5` (REQ-24.6) — a provisional account
is included in the response (so "my own rank" lookups still work, REQ-26.3) but the client renders
it outside/below the ranked list rather than omitting it outright.

## 7. Error handling (additions to accident design section 9)

| Failure | Behaviour |
| --- | --- |
| `/api/credit` called twice for the same room | Second call is a no-op: returns the already-stored result, 200, no second rating update (REQ-23.4) |
| Both players submit, verdicts somehow disagree (should be impossible: both ran the same deterministic `finalise()`) | Logged as a server-side anomaly; the room is NOT credited until investigated — never guess which client to believe |
| A seat's burner key has no `burner_links` row, or both seats resolve to the same account | Game is not credited; shown to the submitting player as "this game can't be rated" with a reason, not a silent failure |
| Account login session expired mid-game | The game still finishes normally (REQ-21.4 — ranked-ness doesn't change protocol behaviour); crediting is retried with a fresh login, same idempotent submission path |
| Glicko-2 update receives out-of-domain input | Throws (section 5.2); caught at the handler boundary, same never-throw-past-the-function-boundary rule as every other relayer handler, logged as a bug, game not credited rather than corrupting a rating |

## 8. Testing strategy (additions to accident design section 11)

- **rating package**: Glicko-2 reference vectors from the published algorithm description, draw
  handling, RD convergence over a simulated run of many games, out-of-domain inputs throw.
- **credit handler**: in-memory fakes for `chain`/`db`/`verifySession`, same `setup()`-helper shape
  as `event.test.ts`/`wiring.test.ts`. Explicit tests for: double-submission idempotency, one-sided
  submission with the server independently resolving the other seat from on-chain data, a
  deliberately mismatched account/seat claim being rejected, a non-final recomputed verdict never
  crediting, a timeout-flavoured client claim having no path to crediting at all (there is no
  "timeout" branch to even reject — the test proves the absence, not a rejection).
- **leaderboard read endpoint**: pagination, tie-break ordering, provisional-account inclusion.
- **account/link-burner**: rejecting an unverified session, correctly deactivating a prior link
  (REQ-20.6).

## 9. Open items

1. Supabase Auth vs a hand-rolled session table — section 2.3 defaults to Supabase Auth directly;
   confirm this is acceptable given the relayer's existing `auth: {persistSession: false}` setting
   is specifically about the *service-role* client having no end-user session, which is a different
   concern from end users having their own Supabase Auth sessions.
2. Display name moderation/uniqueness — not addressed in requirements.md; needs a decision before
   `accounts.display_name` ships (free text today).
3. Whether `packages/rating` is its own pnpm workspace package (as drafted) or a module inside
   `apps/relayer` — drafted as a separate package for the same reason `packages/engine` is separate
   from `apps/web`: independent testability and the possibility of the House Bot or a future client
   wanting to show a provisional/local rating estimate without a round-trip.
4. Exact minimum-games threshold for "provisional" (REQ-24.6 defaults to 5; not load-tested against
   real play patterns yet).
