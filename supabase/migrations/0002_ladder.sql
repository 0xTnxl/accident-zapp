-- Ratings, the global leaderboard and tournaments for Accident inside Zend.
-- Run once in the Supabase SQL editor, or with `supabase db push`, after 0001_relayer.sql.
--
-- Players are Zend users, keyed by their Zend app user id (`zu_...`). Only the server functions
-- (service role) read or write these tables: Row Level Security is on with no policies.
--
-- Every rated game is checked on the server from the signed game record and Zend's receipts
-- before it touches a rating (apps/relayer/src/ladder/results.ts), so nothing a browser reports
-- is trusted on its own.

create table if not exists public.players (
  id          text primary key check (id ~ '^zu_[0-9a-f]{24}$'),
  name        text not null default '',
  username    text,
  avatar      text,
  rating      double precision not null default 1500,
  rd          double precision not null default 350,
  volatility  double precision not null default 0.06,
  games       integer not null default 0,
  wins        integer not null default 0,
  draws       integer not null default 0,
  losses      integer not null default 0,
  -- Games that couldn't be rated because the two players' records disagreed.
  disputes    integer not null default 0,
  version     integer not null default 0,
  last_game_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.players enable row level security;
create index if not exists players_rating on public.players (rating desc) where games > 0;

create table if not exists public.tournaments (
  id          text primary key check (id ~ '^t_[a-z0-9]{10}$'),
  name        text not null check (char_length(name) between 3 and 40),
  created_by  text not null references public.players(id),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null check (ends_at > starts_at),
  created_at  timestamptz not null default now()
);
alter table public.tournaments enable row level security;
create index if not exists tournaments_ends on public.tournaments (ends_at desc);
create index if not exists tournaments_creator on public.tournaments (created_by, ends_at);

create table if not exists public.tournament_players (
  tournament_id text not null references public.tournaments(id) on delete cascade,
  player_id     text not null references public.players(id),
  points        integer not null default 0,
  games         integer not null default 0,
  wins          integer not null default 0,
  draws         integer not null default 0,
  losses        integer not null default 0,
  joined_at     timestamptz not null default now(),
  -- Set while the player is looking for a game. Refreshed by every pairing poll, so a player who
  -- closed the app stops being matched within a minute.
  waiting_since timestamptz,
  last_seen_at  timestamptz,
  last_opponent text,
  -- The game the tournament put this player in, until it is rated or goes stale.
  current_game  text,
  current_since timestamptz,
  primary key (tournament_id, player_id)
);
alter table public.tournament_players enable row level security;
create index if not exists tournament_players_points
  on public.tournament_players (tournament_id, points desc, wins desc);

-- A game the tournament paired. Only these count for tournament points.
create table if not exists public.tournament_games (
  interaction_id text primary key,
  tournament_id  text not null references public.tournaments(id) on delete cascade,
  host_id        text not null references public.players(id),
  guest_id       text not null references public.players(id),
  paired_at      timestamptz not null default now()
);
alter table public.tournament_games enable row level security;

-- One row per Zend challenge that was checked and rated (or found disputed).
create table if not exists public.rated_games (
  interaction_id text primary key,
  host_id        text not null references public.players(id),
  guest_id       text not null references public.players(id),
  -- 'seat0' (host won), 'seat1' (guest won), 'draw', or 'disputed' (not rated).
  result         text not null check (result in ('seat0', 'seat1', 'draw', 'disputed')),
  reason         text,
  host_before    double precision,
  host_after     double precision,
  guest_before   double precision,
  guest_after    double precision,
  tournament_id  text references public.tournaments(id) on delete set null,
  transcript     jsonb,
  rated_at       timestamptz not null default now()
);
alter table public.rated_games enable row level security;
create index if not exists rated_games_host on public.rated_games (host_id, rated_at desc);
create index if not exists rated_games_guest on public.rated_games (guest_id, rated_at desc);

-- Records a checked game and both new ratings in one transaction. Each player row must still be at
-- the version the server read; if either moved (another game finished at the same moment), nothing
-- is written and the caller recomputes. Returns 'recorded', 'duplicate' or 'conflict'.
create or replace function public.ladder_record_game(
  p_interaction text,
  p_host text,
  p_guest text,
  p_result text,
  p_reason text,
  p_host_version integer,
  p_guest_version integer,
  p_host_rating jsonb,
  p_guest_rating jsonb,
  p_transcript jsonb
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament text;
  v_rows integer;
  v_host_points integer;
  v_guest_points integer;
begin
  if exists (select 1 from rated_games where interaction_id = p_interaction) then
    return 'duplicate';
  end if;

  if p_result <> 'disputed' then
    update players set
      rating = (p_host_rating->>'rating')::double precision,
      rd = (p_host_rating->>'rd')::double precision,
      volatility = (p_host_rating->>'volatility')::double precision,
      games = games + 1,
      wins = wins + (p_result = 'seat0')::int,
      draws = draws + (p_result = 'draw')::int,
      losses = losses + (p_result = 'seat1')::int,
      version = version + 1, last_game_at = now(), updated_at = now()
    where id = p_host and version = p_host_version;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then return 'conflict'; end if;

    update players set
      rating = (p_guest_rating->>'rating')::double precision,
      rd = (p_guest_rating->>'rd')::double precision,
      volatility = (p_guest_rating->>'volatility')::double precision,
      games = games + 1,
      wins = wins + (p_result = 'seat1')::int,
      draws = draws + (p_result = 'draw')::int,
      losses = losses + (p_result = 'seat0')::int,
      version = version + 1, last_game_at = now(), updated_at = now()
    where id = p_guest and version = p_guest_version;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      raise exception 'ladder_conflict';
    end if;
  else
    update players set disputes = disputes + 1, updated_at = now() where id in (p_host, p_guest);
  end if;

  -- Tournament points: win 2, draw 1, loss 0. Only for games the tournament paired.
  select tournament_id into v_tournament from tournament_games where interaction_id = p_interaction;
  if v_tournament is not null and p_result <> 'disputed' then
    v_host_points := case p_result when 'seat0' then 2 when 'draw' then 1 else 0 end;
    v_guest_points := case p_result when 'seat1' then 2 when 'draw' then 1 else 0 end;
    update tournament_players set
      points = points + v_host_points, games = games + 1,
      wins = wins + (p_result = 'seat0')::int, draws = draws + (p_result = 'draw')::int,
      losses = losses + (p_result = 'seat1')::int
    where tournament_id = v_tournament and player_id = p_host;
    update tournament_players set
      points = points + v_guest_points, games = games + 1,
      wins = wins + (p_result = 'seat1')::int, draws = draws + (p_result = 'draw')::int,
      losses = losses + (p_result = 'seat0')::int
    where tournament_id = v_tournament and player_id = p_guest;
  end if;
  update tournament_players set current_game = null, current_since = null
  where current_game = p_interaction;

  insert into rated_games (interaction_id, host_id, guest_id, result, reason, host_before, host_after,
                           guest_before, guest_after, tournament_id, transcript)
  values (p_interaction, p_host, p_guest, p_result, p_reason,
          (p_host_rating->>'before')::double precision, (p_host_rating->>'rating')::double precision,
          (p_guest_rating->>'before')::double precision, (p_guest_rating->>'rating')::double precision,
          v_tournament, p_transcript);
  return 'recorded';
exception
  when raise_exception then
    if sqlerrm = 'ladder_conflict' then return 'conflict'; end if;
    raise;
end;
$$;

-- Whether a player is tied up: matched and waiting for the game to be created (up to a minute),
-- or in a created game (up to 30 minutes, or until the server sees it finished and clears it).
create or replace function public.ladder_busy(p_game text, p_since timestamptz)
returns boolean
language sql
stable
as $$
  select case
    when p_game is null then false
    when p_game = 'pending' then p_since > now() - interval '1 minute'
    else p_since > now() - interval '30 minutes'
  end;
$$;

-- Pairing poll. Marks the caller as looking for a game and, if someone else in the same live
-- tournament is looking too, claims them atomically (SKIP LOCKED, so two polls can't grab the same
-- person). Returns one of:
--   {"status":"playing","game":"int_..."}            already in a game the tournament paired
--   {"status":"matched","opponent":"zu_..."}         caller must now create the game
--   {"status":"waiting"} / {"status":"not_live"} / {"status":"not_joined"}
create or replace function public.ladder_pair(p_tournament text, p_player text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_live boolean;
  v_me tournament_players%rowtype;
  v_other text;
begin
  select now() >= starts_at and now() < ends_at into v_live from tournaments where id = p_tournament;
  if v_live is null or not v_live then return jsonb_build_object('status', 'not_live'); end if;

  select * into v_me from tournament_players
  where tournament_id = p_tournament and player_id = p_player for update;
  if not found then return jsonb_build_object('status', 'not_joined'); end if;

  -- 'pending' holds a player for the moment between being matched and the game existing.
  -- A real game that's still unrated after 30 minutes is treated as abandoned.
  if ladder_busy(v_me.current_game, v_me.current_since) then
    update tournament_players set last_seen_at = now()
    where tournament_id = p_tournament and player_id = p_player;
    if v_me.current_game = 'pending' then return jsonb_build_object('status', 'waiting'); end if;
    return jsonb_build_object('status', 'playing', 'game', v_me.current_game);
  end if;

  select player_id into v_other from tournament_players
  where tournament_id = p_tournament and player_id <> p_player
    and waiting_since is not null and last_seen_at > now() - interval '45 seconds'
    and not ladder_busy(current_game, current_since)
  -- Prefer someone other than the last opponent, then whoever has waited longest.
  order by (player_id = coalesce(v_me.last_opponent, '')), waiting_since
  limit 1
  for update skip locked;

  if v_other is null then
    update tournament_players set
      waiting_since = coalesce(waiting_since, now()), last_seen_at = now(),
      current_game = null, current_since = null
    where tournament_id = p_tournament and player_id = p_player;
    return jsonb_build_object('status', 'waiting');
  end if;

  update tournament_players set waiting_since = null, last_seen_at = now(), last_opponent = v_other,
    current_game = 'pending', current_since = now()
  where tournament_id = p_tournament and player_id = p_player;
  update tournament_players set waiting_since = null, last_opponent = p_player,
    current_game = 'pending', current_since = now()
  where tournament_id = p_tournament and player_id = v_other;
  return jsonb_build_object('status', 'matched', 'opponent', v_other);
end;
$$;

-- Records the game created for a match, for both players.
create or replace function public.ladder_set_game(
  p_tournament text, p_interaction text, p_host text, p_guest text
) returns void
language sql
security definer
set search_path = public
as $$
  insert into tournament_games (interaction_id, tournament_id, host_id, guest_id)
  values (p_interaction, p_tournament, p_host, p_guest)
  on conflict do nothing;
  update tournament_players set current_game = p_interaction, current_since = now()
  where tournament_id = p_tournament and player_id in (p_host, p_guest);
$$;

-- Creating the game failed: put a matched player back in the queue.
create or replace function public.ladder_unpair(p_tournament text, p_player text)
returns void
language sql
security definer
set search_path = public
as $$
  update tournament_players set waiting_since = now(), current_game = null, current_since = null
  where tournament_id = p_tournament and player_id = p_player and current_game = 'pending';
$$;

-- The player's game is over on Zend (finished or expired): free them for the next pairing. Its
-- points still arrive when the result is checked, through tournament_games.
create or replace function public.ladder_clear_game(p_tournament text, p_player text, p_interaction text)
returns void
language sql
security definer
set search_path = public
as $$
  update tournament_players set current_game = null, current_since = null
  where tournament_id = p_tournament and player_id = p_player and current_game = p_interaction;
$$;

revoke all on function public.ladder_record_game(text, text, text, text, text, integer, integer, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.ladder_pair(text, text) from public, anon, authenticated;
revoke all on function public.ladder_set_game(text, text, text, text) from public, anon, authenticated;
revoke all on function public.ladder_unpair(text, text) from public, anon, authenticated;
revoke all on function public.ladder_clear_game(text, text, text) from public, anon, authenticated;
grant execute on function public.ladder_record_game(text, text, text, text, text, integer, integer, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.ladder_pair(text, text) to service_role;
grant execute on function public.ladder_set_game(text, text, text, text) to service_role;
grant execute on function public.ladder_unpair(text, text) to service_role;
grant execute on function public.ladder_clear_game(text, text, text) to service_role;
