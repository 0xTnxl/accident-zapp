import { describe, expect, it } from 'vitest';

import { DEFAULT_RATING, type Glicko2Rating, updateRating } from '../src/index.js';

describe('updateRating', () => {
  it("reproduces Glickman's published worked example exactly", () => {
    // Mark Glickman, "Example of the Glicko-2 system": a player rated 1500 with RD 200 plays
    // three games in one period against opponents rated 1400/RD 30, 1550/RD 100 and 1700/RD 300,
    // winning the first and losing the other two. The paper (and every independent reference
    // implementation checked while writing this port) agrees on the same result to the precision
    // shown here: rating 1464.06, RD 151.52, volatility 0.05999.
    const player: Glicko2Rating = { rating: 1500, rd: 200, volatility: 0.06 };
    const result = updateRating(player, [
      { opponent: { rating: 1400, rd: 30, volatility: 0.06 }, score: 1 },
      { opponent: { rating: 1550, rd: 100, volatility: 0.06 }, score: 0 },
      { opponent: { rating: 1700, rd: 300, volatility: 0.06 }, score: 0 },
    ]);

    expect(result.rating).toBeCloseTo(1464.06, 1);
    expect(result.rd).toBeCloseTo(151.52, 1);
    expect(result.volatility).toBeCloseTo(0.05999, 4);
  });

  it('rewards beating a stronger opponent more than beating a weaker one', () => {
    const player: Glicko2Rating = { rating: 1500, rd: 60, volatility: 0.06 };
    const strongerOpponent: Glicko2Rating = { rating: 1700, rd: 60, volatility: 0.06 };
    const weakerOpponent: Glicko2Rating = { rating: 1300, rd: 60, volatility: 0.06 };

    const afterBeatingStronger = updateRating(player, [{ opponent: strongerOpponent, score: 1 }]);
    const afterBeatingWeaker = updateRating(player, [{ opponent: weakerOpponent, score: 1 }]);

    expect(afterBeatingStronger.rating).toBeGreaterThan(afterBeatingWeaker.rating);
  });

  it('penalises losing to a weaker opponent more than losing to a stronger one', () => {
    const player: Glicko2Rating = { rating: 1500, rd: 60, volatility: 0.06 };
    const strongerOpponent: Glicko2Rating = { rating: 1700, rd: 60, volatility: 0.06 };
    const weakerOpponent: Glicko2Rating = { rating: 1300, rd: 60, volatility: 0.06 };

    const afterLosingToStronger = updateRating(player, [{ opponent: strongerOpponent, score: 0 }]);
    const afterLosingToWeaker = updateRating(player, [{ opponent: weakerOpponent, score: 0 }]);

    expect(afterLosingToStronger.rating).toBeGreaterThan(afterLosingToWeaker.rating);
  });

  it('treats a draw as a half-point result, between a win and a loss', () => {
    const player: Glicko2Rating = { rating: 1500, rd: 60, volatility: 0.06 };
    const opponent: Glicko2Rating = { rating: 1500, rd: 60, volatility: 0.06 };

    const afterWin = updateRating(player, [{ opponent, score: 1 }]);
    const afterDraw = updateRating(player, [{ opponent, score: 0.5 }]);
    const afterLoss = updateRating(player, [{ opponent, score: 0 }]);

    expect(afterDraw.rating).toBeLessThan(afterWin.rating);
    expect(afterDraw.rating).toBeGreaterThan(afterLoss.rating);
    // Against an equally-rated opponent, a draw is close to a no-op on the rating itself (it is
    // exactly the expected outcome), though RD still shrinks either way since a game was played.
    expect(afterDraw.rating).toBeCloseTo(player.rating, 0);
  });

  it("narrows RD (grows more confident) regardless of a game's result", () => {
    const player: Glicko2Rating = { rating: 1500, rd: 200, volatility: 0.06 };
    const opponent: Glicko2Rating = { rating: 1500, rd: 200, volatility: 0.06 };

    for (const score of [0, 0.5, 1] as const) {
      const result = updateRating(player, [{ opponent, score }]);
      expect(result.rd).toBeLessThan(player.rd);
    }
  });

  it('is a pure function: the same inputs always produce the same output', () => {
    const player: Glicko2Rating = { rating: 1612, rd: 45, volatility: 0.0575 };
    const opponent: Glicko2Rating = { rating: 1480, rd: 85, volatility: 0.06 };
    const once = updateRating(player, [{ opponent, score: 1 }]);
    const again = updateRating({ ...player }, [{ opponent: { ...opponent }, score: 1 }]);
    expect(again).toEqual(once);
  });

  it('does not mutate its inputs', () => {
    const player: Glicko2Rating = { rating: 1500, rd: 200, volatility: 0.06 };
    const opponent: Glicko2Rating = { rating: 1400, rd: 30, volatility: 0.06 };
    const playerCopy = { ...player };
    const opponentCopy = { ...opponent };
    updateRating(player, [{ opponent, score: 1 }]);
    expect(player).toEqual(playerCopy);
    expect(opponent).toEqual(opponentCopy);
  });

  it('handles several games in one update, in any order, consistently', () => {
    const player: Glicko2Rating = { rating: 1500, rd: 200, volatility: 0.06 };
    const results = [
      { opponent: { rating: 1400, rd: 30, volatility: 0.06 }, score: 1 as const },
      { opponent: { rating: 1550, rd: 100, volatility: 0.06 }, score: 0 as const },
    ];
    const forward = updateRating(player, results);
    const backward = updateRating(player, [...results].reverse());
    expect(forward).toEqual(backward);
  });

  it('rejects an empty result list rather than silently doing nothing', () => {
    expect(() => updateRating(DEFAULT_RATING, [])).toThrow(RangeError);
  });

  it.each([
    { rating: NaN, rd: 350, volatility: 0.06 },
    { rating: 1500, rd: 0, volatility: 0.06 },
    { rating: 1500, rd: -1, volatility: 0.06 },
    { rating: 1500, rd: 350, volatility: 0 },
    { rating: 1500, rd: 350, volatility: -0.1 },
    { rating: 1500, rd: NaN, volatility: 0.06 },
    { rating: 1500, rd: 350, volatility: NaN },
  ])('rejects an out-of-domain player rating %j', (player) => {
    expect(() => updateRating(player, [{ opponent: DEFAULT_RATING, score: 1 }])).toThrow(
      RangeError,
    );
  });

  it.each([
    { rating: NaN, rd: 350, volatility: 0.06 },
    { rating: 1500, rd: 0, volatility: 0.06 },
    { rating: 1500, rd: 350, volatility: 0 },
  ])('rejects an out-of-domain opponent rating %j', (opponent) => {
    expect(() => updateRating(DEFAULT_RATING, [{ opponent, score: 1 }])).toThrow(RangeError);
  });

  it.each([-1, 0.25, 0.75, 2, NaN])('rejects an invalid score %p', (score) => {
    expect(() =>
      updateRating(DEFAULT_RATING, [{ opponent: DEFAULT_RATING, score: score as 0 | 0.5 | 1 }]),
    ).toThrow(RangeError);
  });
});

describe('DEFAULT_RATING', () => {
  it('matches the published Glicko-2 defaults for a brand-new player', () => {
    expect(DEFAULT_RATING).toEqual({ rating: 1500, rd: 350, volatility: 0.06 });
  });
});
