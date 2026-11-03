import { error, json, readJson } from '../http.js';
import { checkGame } from './check.js';
import { PROVISIONAL_RD, rateGame } from './ratings.js';
import type { LadderStore, PlayerRow, RatedGameRow, TournamentRow } from './store.js';
import type { ZendApi, ZendPlayer } from './zend.js';

/**
 * /api/ladder/* — the global leaderboard and tournaments for Accident inside Zend.
 *
 * Every call needs `Authorization: Bearer <app session>` (from `zend.identity.get()`), checked
 * with Zend, so only people who opened Accident in Zend can read names on the board.
 *
 *   POST results                        {interactionId, transcript}  check and rate a finished game
 *   GET  leaderboard?limit=50           top players, plus your rank
 *   GET  me                             your rating and recent games
 *   GET  tournaments                    live, upcoming and recently finished
 *   POST tournaments                    {name, startsInMinutes, durationMinutes}
 *   GET  tournaments/:id                standings
 *   POST tournaments/:id/join | leave
 *   POST tournaments/:id/pair           poll while looking for a game; returns the game when matched
 */

export interface LadderDeps {
  zend: ZendApi;
  store: LadderStore;
  now: () => number;
}

const INTERACTION_ID = /^int_[a-z0-9]{12}$/;
const TOURNAMENT_ID = /^t_[a-z0-9]{10}$/;
const MAX_TRANSCRIPT_BYTES = 128 * 1024;
const MAX_OPEN_TOURNAMENTS = 3;
/** Long enough for one game plus its reveal window, short enough that stale games tidy up. */
const TOURNAMENT_GAME_SECS = 3600;

type Status = 'upcoming' | 'live' | 'finished';

function statusOf(t: TournamentRow, now: number): Status {
  if (now < Date.parse(t.starts_at)) return 'upcoming';
  if (now < Date.parse(t.ends_at)) return 'live';
  return 'finished';
}

const publicPlayer = (p: PlayerRow | undefined, id: string) => ({
  id,
  name: p?.name || (p?.username ? `@${p.username}` : 'Player'),
  username: p?.username ?? null,
  avatar: p?.avatar ?? null,
  rating: Math.round(p?.rating ?? 1500),
  provisional: (p?.rd ?? 350) > PROVISIONAL_RD,
});

/** One person's view of a checked game. */
function gameFor(g: RatedGameRow, me: string) {
  const seat = g.host_id === me ? 0 : 1;
  const before = seat === 0 ? g.host_before : g.guest_before;
  const after = seat === 0 ? g.host_after : g.guest_after;
  const outcome =
    g.result === 'disputed'
      ? 'disputed'
      : g.result === 'draw'
        ? 'draw'
        : (g.result === 'seat0') === (seat === 0)
          ? 'win'
          : 'loss';
  return {
    interactionId: g.interaction_id,
    opponentId: seat === 0 ? g.guest_id : g.host_id,
    outcome,
    ratingBefore: before === null ? null : Math.round(before),
    ratingAfter: after === null ? null : Math.round(after),
    change: before === null || after === null ? null : Math.round(after) - Math.round(before),
    tournamentId: g.tournament_id,
    ratedAt: g.rated_at,
  };
}

function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // Printable text only, single spaces.
  const name = raw.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  return name.length >= 3 && name.length <= 40 ? name : undefined;
}

function newTournamentId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `t_${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')}`;
}

async function signedIn(request: Request, deps: LadderDeps): Promise<ZendPlayer | Response> {
  const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!token || token.length > 4096) return error(401, 'Open Accident from Zend to see this');
  const me = await deps.zend.verifySession(token);
  if (!me) return error(401, 'Your session ended. Close Accident and open it again.');
  await deps.store.upsertPlayers([me]);
  return me;
}

export async function handleLadder(request: Request, path: string, deps: LadderDeps): Promise<Response> {
  const parts = path.split('/').filter(Boolean);
  const method = request.method;
  const me = await signedIn(request, deps);
  if (me instanceof Response) return me;

  if (parts[0] === 'results' && parts.length === 1 && method === 'POST') return results(request, me, deps);
  if (parts[0] === 'leaderboard' && parts.length === 1 && method === 'GET') return leaderboard(request, me, deps);
  if (parts[0] === 'me' && parts.length === 1 && method === 'GET') return mine(me, deps);
  if (parts[0] === 'tournaments') {
    if (parts.length === 1 && method === 'GET') return listTournaments(me, deps);
    if (parts.length === 1 && method === 'POST') return createTournament(request, me, deps);
    const id = parts[1] ?? '';
    if (!TOURNAMENT_ID.test(id)) return error(404, 'No such tournament');
    if (parts.length === 2 && method === 'GET') return tournamentDetail(id, me, deps);
    if (parts.length === 3 && method === 'POST') {
      if (parts[2] === 'join') return joinTournament(id, me, deps);
      if (parts[2] === 'leave') return leaveTournament(id, me, deps);
      if (parts[2] === 'pair') return pair(id, me, deps);
    }
  }
  return error(404, 'Not found');
}

// ── Results ─────────────────────────────────────────────────────────────────

function ratedReply(g: RatedGameRow, me: string): Response {
  return json(200, { ok: true, status: g.result === 'disputed' ? 'disputed' : 'rated', game: gameFor(g, me) });
}

async function results(request: Request, me: ZendPlayer, deps: LadderDeps): Promise<Response> {
  const parsed = await readJson(request, MAX_TRANSCRIPT_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { interactionId?: unknown; transcript?: unknown } | null;
  const id = body?.interactionId;
  if (typeof id !== 'string' || !INTERACTION_ID.test(id)) return error(400, 'Unknown game');

  const done = await deps.store.ratedGame(id);
  if (done) return ratedReply(done, me.appUserId);

  const interaction = await deps.zend.interaction(id);
  if (!interaction) return error(404, 'Unknown game');
  if (!interaction.participants.some((p) => p.appUserId === me.appUserId)) {
    return error(403, "You weren't in this game");
  }
  const [receipts, zendPublicKey] = await Promise.all([
    deps.zend.receipts(id),
    deps.zend.attestKey(),
  ]);
  const outcome = await checkGame({
    interaction,
    receipts,
    zendPublicKey,
    transcript: body?.transcript,
    now: deps.now(),
  });

  if (outcome.kind === 'pending') {
    return json(202, { ok: true, status: 'pending', retryAfterMs: outcome.retryAfterMs });
  }
  if (outcome.kind === 'not_rateable') {
    return json(422, { ok: false, status: 'not_rated', error: outcome.why });
  }

  const { host, guest } = outcome;
  await deps.store.upsertPlayers([host, guest]);
  for (let attempt = 0; attempt < 4; attempt++) {
    const [h, g] = await Promise.all([deps.store.player(host.appUserId), deps.store.player(guest.appUserId)]);
    if (!h || !g) throw new Error('players missing after upsert');
    const ratings = outcome.kind === 'final' ? rateGame(h, g, outcome.result) : null;
    const written = await deps.store.recordGame({
      interactionId: id,
      hostId: h.id,
      guestId: g.id,
      result: outcome.kind === 'final' ? outcome.result : 'disputed',
      reason: outcome.kind === 'final' ? outcome.reason : 'records-disagree',
      hostVersion: h.version,
      guestVersion: g.version,
      host: ratings?.host ?? null,
      guest: ratings?.guest ?? null,
      transcript: body?.transcript,
    });
    if (written === 'conflict') continue; // another game moved a rating; recompute
    const row = await deps.store.ratedGame(id);
    if (!row) throw new Error('rated game missing after write');
    return ratedReply(row, me.appUserId);
  }
  return json(503, { ok: false, error: 'Busy. Try again in a moment.' });
}

// ── Leaderboard ─────────────────────────────────────────────────────────────

async function leaderboard(request: Request, me: ZendPlayer, deps: LadderDeps): Promise<Response> {
  const asked = Number(new URL(request.url).searchParams.get('limit') ?? 50);
  const limit = Number.isInteger(asked) ? Math.min(100, Math.max(1, asked)) : 50;
  const [top, mine] = await Promise.all([deps.store.leaderboard(limit), deps.store.player(me.appUserId)]);
  const you =
    mine && mine.games > 0
      ? { ...publicPlayer(mine, mine.id), rank: await deps.store.rankOf(mine.rating), games: mine.games }
      : null;
  return json(200, {
    ok: true,
    players: top.map((p, i) => ({
      rank: i + 1,
      ...publicPlayer(p, p.id),
      games: p.games,
      wins: p.wins,
      draws: p.draws,
      losses: p.losses,
    })),
    you,
  });
}

async function mine(me: ZendPlayer, deps: LadderDeps): Promise<Response> {
  const p = await deps.store.player(me.appUserId);
  const recent = await deps.store.recentGames(me.appUserId, 15);
  const opponents = await deps.store.players([...new Set(recent.map((g) => (g.host_id === me.appUserId ? g.guest_id : g.host_id)))]);
  const byId = new Map(opponents.map((o) => [o.id, o]));
  return json(200, {
    ok: true,
    player: {
      ...publicPlayer(p, me.appUserId),
      games: p?.games ?? 0,
      wins: p?.wins ?? 0,
      draws: p?.draws ?? 0,
      losses: p?.losses ?? 0,
      rank: p && p.games > 0 ? await deps.store.rankOf(p.rating) : null,
    },
    recent: recent.map((g) => {
      const view = gameFor(g, me.appUserId);
      return { ...view, opponent: publicPlayer(byId.get(view.opponentId), view.opponentId) };
    }),
  });
}

// ── Tournaments ─────────────────────────────────────────────────────────────

function tournamentView(t: TournamentRow, now: number, players: number, joined: boolean, host: PlayerRow | undefined) {
  return {
    id: t.id,
    name: t.name,
    startsAt: t.starts_at,
    endsAt: t.ends_at,
    status: statusOf(t, now),
    players,
    joined,
    openedBy: publicPlayer(host, t.created_by),
  };
}

async function listTournaments(me: ZendPlayer, deps: LadderDeps): Promise<Response> {
  const now = deps.now();
  const all = await deps.store.tournaments();
  const { counts, joined } = await deps.store.entries(all.map((t) => t.id), me.appUserId);
  const hosts = new Map((await deps.store.players([...new Set(all.map((t) => t.created_by))])).map((p) => [p.id, p]));
  const views = all.map((t) => tournamentView(t, now, counts.get(t.id) ?? 0, joined.has(t.id), hosts.get(t.created_by)));
  return json(200, {
    ok: true,
    live: views.filter((v) => v.status === 'live'),
    upcoming: views.filter((v) => v.status === 'upcoming'),
    finished: views.filter((v) => v.status === 'finished').reverse().slice(0, 20),
  });
}

async function createTournament(request: Request, me: ZendPlayer, deps: LadderDeps): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { name?: unknown; startsInMinutes?: unknown; durationMinutes?: unknown } | null;
  const name = cleanName(body?.name);
  if (!name) return error(400, 'Give it a name of 3 to 40 characters');
  const startsIn = body?.startsInMinutes;
  const duration = body?.durationMinutes;
  if (typeof startsIn !== 'number' || !Number.isInteger(startsIn) || startsIn < 0 || startsIn > 7 * 24 * 60) {
    return error(400, 'Start it within the next 7 days');
  }
  if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 10 || duration > 240) {
    return error(400, 'A tournament runs for 10 minutes to 4 hours');
  }
  if ((await deps.store.openTournamentsBy(me.appUserId)) >= MAX_OPEN_TOURNAMENTS) {
    return error(429, `You can have ${MAX_OPEN_TOURNAMENTS} tournaments open at a time`);
  }
  const startsAt = deps.now() + startsIn * 60_000;
  const t = await deps.store.createTournament({
    id: newTournamentId(),
    name,
    created_by: me.appUserId,
    starts_at: new Date(startsAt).toISOString(),
    ends_at: new Date(startsAt + duration * 60_000).toISOString(),
  });
  // Whoever opens it plays in it.
  await deps.store.join(t.id, me.appUserId);
  const host = await deps.store.player(me.appUserId);
  return json(201, { ok: true, tournament: tournamentView(t, deps.now(), 1, true, host) });
}

async function tournamentDetail(id: string, me: ZendPlayer, deps: LadderDeps): Promise<Response> {
  const t = await deps.store.tournament(id);
  if (!t) return error(404, 'No such tournament');
  const standings = await deps.store.standings(id);
  const people = new Map(
    (await deps.store.players([...new Set([...standings.map((s) => s.player_id), t.created_by])])).map((p) => [p.id, p]),
  );
  const rows = standings.map((s, i) => ({
    rank: i + 1,
    player: publicPlayer(people.get(s.player_id), s.player_id),
    points: s.points,
    games: s.games,
    wins: s.wins,
    draws: s.draws,
    losses: s.losses,
  }));
  const mineRow = rows.find((r) => r.player.id === me.appUserId) ?? null;
  return json(200, {
    ok: true,
    tournament: tournamentView(t, deps.now(), rows.length, mineRow !== null, people.get(t.created_by)),
    standings: rows,
    you: mineRow,
  });
}

async function joinTournament(id: string, me: ZendPlayer, deps: LadderDeps): Promise<Response> {
  const t = await deps.store.tournament(id);
  if (!t) return error(404, 'No such tournament');
  if (statusOf(t, deps.now()) === 'finished') return error(409, 'This tournament has finished');
  await deps.store.join(id, me.appUserId);
  return json(200, { ok: true });
}

async function leaveTournament(id: string, me: ZendPlayer, deps: LadderDeps): Promise<Response> {
  const t = await deps.store.tournament(id);
  if (!t) return error(404, 'No such tournament');
  await deps.store.leave(id, me.appUserId, statusOf(t, deps.now()) !== 'upcoming');
  return json(200, { ok: true });
}

const FINISHED = new Set(['resolved', 'expired']);

async function pair(id: string, me: ZendPlayer, deps: LadderDeps): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await deps.store.pair(id, me.appUserId);
    if (s.status === 'playing') {
      // Finished on Zend: free this player for the next game. The result is credited separately.
      const game = await deps.zend.interaction(s.game);
      if (!game || FINISHED.has(game.state)) {
        await deps.store.clearGame(id, me.appUserId, s.game);
        continue;
      }
      return json(200, { ok: true, status: 'playing', game: s.game });
    }
    if (s.status === 'matched') {
      // The one who waited longer hosts (moves first in Accident's seat order).
      try {
        const game = await deps.zend.createChallenge(s.opponent, me.appUserId, TOURNAMENT_GAME_SECS);
        await deps.store.setGame(id, game, s.opponent, me.appUserId);
        return json(200, { ok: true, status: 'playing', game });
      } catch {
        await Promise.all([deps.store.unpair(id, s.opponent), deps.store.unpair(id, me.appUserId)]);
        return json(200, { ok: true, status: 'waiting' });
      }
    }
    return json(200, { ok: true, status: s.status });
  }
  return json(200, { ok: true, status: 'waiting' });
}
