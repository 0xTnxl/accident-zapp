import type { Glicko2Rating } from '@accident/rating';
import { updateRating } from '@accident/rating';
import type { PlayerRow, RatingWrite } from './store.js';

/**
 * A rating is shown as provisional ("?") for a player's first few rated games, while it still
 * moves a lot. This counts games rather than using Glicko's uncertainty (RD), because with a small
 * pool of players RD falls very slowly: two new players who only play each other are still at
 * RD 177 after 25 games, far above the 110 chess sites use, so everyone kept their "?".
 */
export const PROVISIONAL_GAMES = 5;

const asRating = (p: PlayerRow): Glicko2Rating => ({ rating: p.rating, rd: p.rd, volatility: p.volatility });

/**
 * Both players' new ratings after one game. Each game is its own rating period, which keeps a
 * live ladder simple and is how most online games apply Glicko-2.
 */
export function rateGame(
  host: PlayerRow,
  guest: PlayerRow,
  result: 'seat0' | 'seat1' | 'draw',
): { host: RatingWrite; guest: RatingWrite } {
  const hostScore = result === 'seat0' ? 1 : result === 'draw' ? 0.5 : 0;
  const guestScore = (1 - hostScore) as 0 | 0.5 | 1;
  const h = updateRating(asRating(host), [{ opponent: asRating(guest), score: hostScore }]);
  const g = updateRating(asRating(guest), [{ opponent: asRating(host), score: guestScore }]);
  return {
    host: { before: host.rating, ...h },
    guest: { before: guest.rating, ...g },
  };
}
