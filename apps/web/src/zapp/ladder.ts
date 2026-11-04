import type { Zend } from './appkit.js';

/** Client for /api/ladder on Accident's own origin. Signed in with the player's Zend app session. */

export interface LadderPlayer {
  id: string;
  name: string;
  username: string | null;
  avatar: string | null;
  rating: number;
  provisional: boolean;
}

export interface BoardRow extends LadderPlayer {
  rank: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
}

export interface Tournament {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  status: 'upcoming' | 'live' | 'finished';
  players: number;
  joined: boolean;
  openedBy: LadderPlayer;
}

export interface Standing {
  rank: number;
  player: LadderPlayer;
  points: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
}

export interface RatedGame {
  interactionId: string;
  outcome: 'win' | 'loss' | 'draw' | 'disputed';
  ratingBefore: number | null;
  ratingAfter: number | null;
  change: number | null;
}

export class LadderError extends Error {}

export class Ladder {
  private session: string | undefined;
  constructor(private readonly zend: Zend) {}

  private async token(fresh = false): Promise<string> {
    if (!this.session || fresh) this.session = (await this.zend.identity.get()).appSession;
    return this.session;
  }

  private async call<T>(path: string, init: RequestInit = {}, retried = false): Promise<{ status: number; body: T }> {
    const r = await fetch(`/api/ladder/${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await this.token(retried)}` },
    });
    // App sessions are short-lived: get a fresh one once.
    if (r.status === 401 && !retried) return this.call(path, init, true);
    const body = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (r.status >= 400 && r.status !== 422) throw new LadderError(body.error ?? "That didn't load. Try again.");
    return { status: r.status, body };
  }

  async leaderboard() {
    return (await this.call<{ players: BoardRow[]; you: (BoardRow & { rank: number }) | null }>('leaderboard?limit=100')).body;
  }

  async me() {
    return (await this.call<{ player: BoardRow & { rank: number | null }; recent: { opponent: LadderPlayer }[] }>('me')).body;
  }

  async tournaments() {
    return (await this.call<{ live: Tournament[]; upcoming: Tournament[]; finished: Tournament[] }>('tournaments')).body;
  }

  async tournament(id: string) {
    return (await this.call<{ tournament: Tournament; standings: Standing[]; you: Standing | null }>(`tournaments/${id}`)).body;
  }

  async create(name: string, startsInMinutes: number, durationMinutes: number) {
    const r = await this.call<{ tournament: Tournament }>('tournaments', {
      method: 'POST',
      body: JSON.stringify({ name, startsInMinutes, durationMinutes }),
    });
    return r.body.tournament;
  }

  async join(id: string) {
    await this.call(`tournaments/${id}/join`, { method: 'POST' });
  }

  async leave(id: string) {
    await this.call(`tournaments/${id}/leave`, { method: 'POST' });
  }

  async pair(id: string) {
    return (await this.call<{ status: string; game?: string }>(`tournaments/${id}/pair`, { method: 'POST' })).body;
  }

  /**
   * Sends the finished game's record for checking and rating. Waits while the server says the
   * other player's reveal may still arrive. Returns undefined when the game can't be rated.
   */
  async submit(interactionId: string, transcript: unknown): Promise<RatedGame | 'disputed' | undefined> {
    for (let i = 0; i < 12; i++) {
      const r = await this.call<{ status: string; retryAfterMs?: number; game?: RatedGame }>('results', {
        method: 'POST',
        body: JSON.stringify({ interactionId, transcript }),
      });
      if (r.status === 202) {
        await new Promise((ok) => setTimeout(ok, Math.min(30_000, r.body.retryAfterMs ?? 15_000)));
        continue;
      }
      if (r.body.status === 'disputed') return 'disputed';
      return r.body.game;
    }
    return undefined;
  }
}

export const ratingLabel = (p: { rating: number; provisional: boolean }) => `${p.rating}${p.provisional ? '?' : ''}`;
