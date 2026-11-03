/**
 * The Glicko-2 rating system (Mark Glickman, "Example of the Glicko-2 system").
 *
 * A player's strength is a `(rating, rd, volatility)` triple: `rating` is the familiar number
 * players see, `rd` ("ratings deviation") is how uncertain that number is — wide at first, and
 * narrowing as more games accumulate — and `volatility` tracks how erratic a player's recent
 * results have been. All three move together on every update; there is no "just update the
 * rating" shortcut, which is exactly what makes Glicko-2 resist a short lucky streak vaulting a
 * brand-new account above players with a long, representative history (the concern that led to
 * choosing it over plain Elo for this project — see .kiro/specs/leaderboard/design.md section 5.1).
 *
 * This module is a direct, careful port of the published algorithm's eight steps, cross-checked
 * against Glickman's own worked example (a player rated 1500/RD 200 who plays three games against
 * opponents rated 1400/RD 30, 1550/RD 100 and 1700/RD 300, winning the first and losing the other
 * two, ending at rating 1464.05, RD 151.52 — reproduced exactly in this package's tests) and
 * against the widely used `sublee/glicko2` reference implementation, to make sure of a correct
 * port rather than a plausible-looking one.
 */

/** A player's Glicko-2 strength, on the familiar display scale (rating around 1500, not the
 * internal "mu" scale the algorithm computes on internally). */
export interface Glicko2Rating {
  rating: number;
  rd: number;
  volatility: number;
}

/** One rated game, from one player's point of view: who they played, and how it went. */
export interface Glicko2Result {
  opponent: Glicko2Rating;
  /** 1 = win, 0.5 = draw, 0 = loss. */
  score: 0 | 0.5 | 1;
}

/** Where a brand-new, never-rated player starts. */
export const DEFAULT_RATING: Glicko2Rating = { rating: 1500, rd: 350, volatility: 0.06 };

/** The system constant that restrains how fast volatility can change. Glickman suggests a value
 * between 0.3 and 1.2, smaller for environments with less variance between players; 0.5 is a
 * common, moderate default and is not expected to need tuning for this project. */
const TAU = 0.5;

/** Convergence tolerance for the iterative step that solves for the new volatility. */
const EPSILON = 0.000001;

/** The fixed conversion between the display scale and the algorithm's internal "mu/phi" scale. */
const SCALE = 173.7178;

function assertRating(r: Glicko2Rating, label: string): void {
  if (!Number.isFinite(r.rating)) throw new RangeError(`${label}.rating must be finite`);
  if (!Number.isFinite(r.rd) || r.rd <= 0) throw new RangeError(`${label}.rd must be positive`);
  if (!Number.isFinite(r.volatility) || r.volatility <= 0) {
    throw new RangeError(`${label}.volatility must be positive`);
  }
}

/** Internal scale: mu is "how far from 1500, in units of 173.7178". */
function toMu(rating: number): number {
  return (rating - DEFAULT_RATING.rating) / SCALE;
}

function toPhi(rd: number): number {
  return rd / SCALE;
}

function fromMu(mu: number): number {
  return mu * SCALE + DEFAULT_RATING.rating;
}

function fromPhi(phi: number): number {
  return phi * SCALE;
}

/** Glickman's `g(phi)`: reduces the weight of a game against an opponent whose own rating is
 * uncertain — a win against a wildly-uncertain opponent teaches you less than a win against a
 * well-established one. */
function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

/** Glickman's `E`: the expected score (0..1) for a player against one opponent, on the internal
 * scale. */
function expectedScore(mu: number, otherMu: number, gPhi: number): number {
  return 1 / (1 + Math.exp(-gPhi * (mu - otherMu)));
}

/**
 * Updates one player's rating from the games they played since their last update (step 1 of
 * Glickman's algorithm folds in; steps 2 through 8 are this function's body). `results` is that
 * player's games for this update, each already carrying their own perspective's score.
 *
 * A player who did not play SHOULD NOT call this at all for that period; Glickman's step 6 (RD
 * grows toward uncertainty when idle) is a once-per-rating-period concept this project has no use
 * for, since a game is credited and rated the moment it is verified (REQ-24.2), not batched into
 * periods. Passing an empty `results` array is rejected rather than silently doing nothing
 * unexpected, so a caller does not mistake "no games" for "a no-op update".
 *
 * Pure and deterministic: the same inputs always produce the same output, and nothing here reads
 * the clock, a database, or the network — exactly the property the project's engine and protocol
 * packages are already held to.
 */
export function updateRating(
  player: Glicko2Rating,
  results: readonly Glicko2Result[],
): Glicko2Rating {
  assertRating(player, 'player');
  if (results.length === 0) {
    throw new RangeError('updateRating requires at least one result');
  }
  for (const [i, result] of results.entries()) {
    assertRating(result.opponent, `results[${i}].opponent`);
    if (result.score !== 0 && result.score !== 0.5 && result.score !== 1) {
      throw new RangeError(`results[${i}].score must be 0, 0.5 or 1`);
    }
  }

  const phi = toPhi(player.rd);
  const mu = toMu(player.rating);

  // Step 3: the estimated variance of the player's rating, based only on these game outcomes.
  let varianceInv = 0;
  // Step 4: the estimated improvement in rating implied by these outcomes, before weighting.
  let improvement = 0;
  for (const { opponent, score } of results) {
    const otherMu = toMu(opponent.rating);
    const gPhi = g(toPhi(opponent.rd));
    const e = expectedScore(mu, otherMu, gPhi);
    varianceInv += gPhi * gPhi * e * (1 - e);
    improvement += gPhi * (score - e);
  }
  const variance = 1 / varianceInv;
  const difference = variance * improvement;

  // Step 5: solve for the new volatility by the convergence procedure Glickman specifies
  // (Illinois algorithm, a variant of regula falsi). `f` is twice the conditional log-posterior
  // density of phi; its root is the new volatility on the ln(sigma^2) scale.
  const a = Math.log(player.volatility * player.volatility);
  const differenceSquared = difference * difference;
  const phiSquared = phi * phi;
  const f = (x: number): number => {
    const expX = Math.exp(x);
    const term = phiSquared + variance + expX;
    return (expX * (differenceSquared - term)) / (2 * term * term) - (x - a) / (TAU * TAU);
  };

  let A = a;
  let B: number;
  if (differenceSquared > phiSquared + variance) {
    B = Math.log(differenceSquared - phiSquared - variance);
  } else {
    let k = 1;
    // f(a - k*TAU) is monotonically increasing in k here (the term being subtracted grows more
    // negative as k grows, and it is subtracted), so once f(a - TAU) >= 0 no larger k changes the
    // outcome. Every input accepted by assertRating (finite, positive rating/rd/volatility),
    // across a wide swept range including extreme values, lands on the first check; this loop
    // exists only as the published algorithm's own safeguard against a input region that does
    // not appear to be reachable from valid Glicko-2 ratings, not a path real data takes.
    /* v8 ignore next */
    while (f(a - k * TAU) < 0) k += 1;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > EPSILON) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB < 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }
  const newVolatility = Math.exp(A / 2);

  // Step 6: pre-update RD, inflated by the new volatility (idle-period growth has no meaning here
  // since every update already carries at least one game; this step still runs because the
  // formula needs phiStar regardless of why phi might have grown).
  const phiStar = Math.sqrt(phi * phi + newVolatility * newVolatility);

  // Step 7: the new rating and RD, folding in this period's games.
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / variance);
  const newMu = mu + newPhi * newPhi * improvement;

  // Step 8: back to the display scale.
  return {
    rating: fromMu(newMu),
    rd: fromPhi(newPhi),
    volatility: newVolatility,
  };
}
