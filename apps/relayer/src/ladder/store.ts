import type { SupabaseClient } from '@supabase/supabase-js';
import type { ZendPlayer } from './zend.js';

/** Supabase tables from supabase/migrations/0002_ladder.sql, behind a small typed surface. */

export interface PlayerRow {
  id: string;
  name: string;
  username: string | null;
  avatar: string | null;
  rating: number;
  rd: number;
  volatility: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  disputes: number;
  version: number;
}

export interface RatedGameRow {
  interaction_id: string;
  host_id: string;
  guest_id: string;
  result: 'seat0' | 'seat1' | 'draw' | 'disputed';
  reason: string | null;
  host_before: number | null;
  host_after: number | null;
  guest_before: number | null;
  guest_after: number | null;
  tournament_id: string | null;
  rated_at: string;
}

export interface TournamentRow {
  id: string;
  name: string;
  created_by: string;
  starts_at: string;
  ends_at: string;
  created_at: string;
}

export interface StandingRow {
  player_id: string;
  points: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
}

export interface RatingWrite {
  before: number;
  rating: number;
  rd: number;
  volatility: number;
}

export type PairStatus =
  | { status: 'playing'; game: string }
  | { status: 'matched'; opponent: string }
  | { status: 'waiting' | 'not_live' | 'not_joined' };

const PLAYER_COLUMNS =
  'id,name,username,avatar,rating,rd,volatility,games,wins,draws,losses,disputes,version';
const GAME_COLUMNS =
  'interaction_id,host_id,guest_id,result,reason,host_before,host_after,guest_before,guest_after,tournament_id,rated_at';

function check<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}

export class LadderStore {
  constructor(private readonly db: SupabaseClient) {}

  /** Keeps names and photos current. Ratings and counts are untouched for existing players. */
  async upsertPlayers(players: readonly ZendPlayer[]): Promise<void> {
    const rows = players.map((p) => ({
      id: p.appUserId,
      name: p.name.slice(0, 80),
      username: p.username,
      avatar: p.avatar,
      updated_at: new Date().toISOString(),
    }));
    check(await this.db.from('players').upsert(rows, { onConflict: 'id' }), 'upsert players');
  }

  async player(id: string): Promise<PlayerRow | undefined> {
    const data = check(
      await this.db.from('players').select(PLAYER_COLUMNS).eq('id', id).maybeSingle(),
      'player',
    );
    return (data as PlayerRow | null) ?? undefined;
  }

  async players(ids: readonly string[]): Promise<PlayerRow[]> {
    if (ids.length === 0) return [];
    return check(await this.db.from('players').select(PLAYER_COLUMNS).in('id', [...ids]), 'players') as PlayerRow[];
  }

  async ratedGame(interactionId: string): Promise<RatedGameRow | undefined> {
    const data = check(
      await this.db.from('rated_games').select(GAME_COLUMNS).eq('interaction_id', interactionId).maybeSingle(),
      'rated game',
    );
    return (data as RatedGameRow | null) ?? undefined;
  }

  async recordGame(p: {
    interactionId: string;
    hostId: string;
    guestId: string;
    result: RatedGameRow['result'];
    reason: string | null;
    hostVersion: number;
    guestVersion: number;
    host: RatingWrite | null;
    guest: RatingWrite | null;
    transcript: unknown;
  }): Promise<'recorded' | 'duplicate' | 'conflict'> {
    const data = check(
      await this.db.rpc('ladder_record_game', {
        p_interaction: p.interactionId,
        p_host: p.hostId,
        p_guest: p.guestId,
        p_result: p.result,
        p_reason: p.reason,
        p_host_version: p.hostVersion,
        p_guest_version: p.guestVersion,
        p_host_rating: p.host,
        p_guest_rating: p.guest,
        p_transcript: p.transcript,
      }),
      'record game',
    );
    if (data !== 'recorded' && data !== 'duplicate' && data !== 'conflict') {
      throw new Error('record game: unexpected reply');
    }
    return data;
  }

  async leaderboard(limit: number): Promise<PlayerRow[]> {
    return check(
      await this.db
        .from('players')
        .select(PLAYER_COLUMNS)
        .gt('games', 0)
        .order('rating', { ascending: false })
        .order('games', { ascending: false })
        .limit(limit),
      'leaderboard',
    ) as PlayerRow[];
  }

  /** 1-based position among rated players. */
  async rankOf(rating: number): Promise<number> {
    const res = await this.db
      .from('players')
      .select('id', { count: 'exact', head: true })
      .gt('games', 0)
      .gt('rating', rating);
    if (res.error) throw new Error(`rank: ${res.error.message}`);
    return (res.count ?? 0) + 1;
  }

  async recentGames(playerId: string, limit: number): Promise<RatedGameRow[]> {
    // playerId is validated as zu_ + hex before it gets here, so it is safe inside the filter.
    return check(
      await this.db
        .from('rated_games')
        .select(GAME_COLUMNS)
        .or(`host_id.eq.${playerId},guest_id.eq.${playerId}`)
        .order('rated_at', { ascending: false })
        .limit(limit),
      'recent games',
    ) as RatedGameRow[];
  }

  // ── Tournaments ───────────────────────────────────────────────────────────

  async createTournament(row: Omit<TournamentRow, 'created_at'>): Promise<TournamentRow> {
    return check(
      await this.db.from('tournaments').insert(row).select('*').single(),
      'create tournament',
    ) as TournamentRow;
  }

  /** Not-yet-finished tournaments a player has opened, for the per-person limit. */
  async openTournamentsBy(playerId: string): Promise<number> {
    const res = await this.db
      .from('tournaments')
      .select('id', { count: 'exact', head: true })
      .eq('created_by', playerId)
      .gt('ends_at', new Date().toISOString());
    if (res.error) throw new Error(`open tournaments: ${res.error.message}`);
    return res.count ?? 0;
  }

  /** Live and upcoming, plus those that finished in the last week. */
  async tournaments(): Promise<TournamentRow[]> {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    return check(
      await this.db
        .from('tournaments')
        .select('*')
        .gt('ends_at', since)
        .order('starts_at', { ascending: true })
        .limit(100),
      'tournaments',
    ) as TournamentRow[];
  }

  async tournament(id: string): Promise<TournamentRow | undefined> {
    const data = check(
      await this.db.from('tournaments').select('*').eq('id', id).maybeSingle(),
      'tournament',
    );
    return (data as TournamentRow | null) ?? undefined;
  }

  async standings(tournamentId: string, limit = 200): Promise<StandingRow[]> {
    return check(
      await this.db
        .from('tournament_players')
        .select('player_id,points,games,wins,draws,losses')
        .eq('tournament_id', tournamentId)
        .order('points', { ascending: false })
        .order('wins', { ascending: false })
        .order('joined_at', { ascending: true })
        .limit(limit),
      'standings',
    ) as StandingRow[];
  }

  /** Player counts per tournament, and which of them `playerId` has joined. */
  async entries(
    tournamentIds: readonly string[],
    playerId: string,
  ): Promise<{ counts: Map<string, number>; joined: Set<string> }> {
    const counts = new Map<string, number>();
    const joined = new Set<string>();
    if (tournamentIds.length === 0) return { counts, joined };
    const rows = check(
      await this.db
        .from('tournament_players')
        .select('tournament_id,player_id')
        .in('tournament_id', [...tournamentIds])
        .limit(10_000),
      'entries',
    ) as { tournament_id: string; player_id: string }[];
    for (const r of rows) {
      counts.set(r.tournament_id, (counts.get(r.tournament_id) ?? 0) + 1);
      if (r.player_id === playerId) joined.add(r.tournament_id);
    }
    return { counts, joined };
  }

  async join(tournamentId: string, playerId: string): Promise<void> {
    const res = await this.db
      .from('tournament_players')
      .upsert({ tournament_id: tournamentId, player_id: playerId }, { onConflict: 'tournament_id,player_id', ignoreDuplicates: true });
    if (res.error) throw new Error(`join: ${res.error.message}`);
  }

  /** Before the start: leave entirely. After: just stop being matched; points stay. */
  async leave(tournamentId: string, playerId: string, started: boolean): Promise<void> {
    const q = started
      ? this.db
          .from('tournament_players')
          .update({ waiting_since: null })
          .eq('tournament_id', tournamentId)
          .eq('player_id', playerId)
      : this.db.from('tournament_players').delete().eq('tournament_id', tournamentId).eq('player_id', playerId);
    const res = await q;
    if (res.error) throw new Error(`leave: ${res.error.message}`);
  }

  async pair(tournamentId: string, playerId: string): Promise<PairStatus> {
    const data = check(
      await this.db.rpc('ladder_pair', { p_tournament: tournamentId, p_player: playerId }),
      'pair',
    ) as PairStatus;
    return data;
  }

  async setGame(tournamentId: string, interactionId: string, hostId: string, guestId: string): Promise<void> {
    check(
      await this.db.rpc('ladder_set_game', {
        p_tournament: tournamentId,
        p_interaction: interactionId,
        p_host: hostId,
        p_guest: guestId,
      }),
      'set game',
    );
  }

  async clearGame(tournamentId: string, playerId: string, interactionId: string): Promise<void> {
    check(
      await this.db.rpc('ladder_clear_game', {
        p_tournament: tournamentId,
        p_player: playerId,
        p_interaction: interactionId,
      }),
      'clear game',
    );
  }

  async unpair(tournamentId: string, playerId: string): Promise<void> {
    check(await this.db.rpc('ladder_unpair', { p_tournament: tournamentId, p_player: playerId }), 'unpair');
  }
}
