/**
 * Unchecked fast paths. NOT exported from the package index.
 *
 * These assume every argument is already a valid code (4 distinct ASCII digits).
 * With anything else they return meaningless numbers without throwing. They exist for hot
 * loops (candidate filtering, strategy search) where the inputs were validated once up front.
 * Code that handles opponent-controlled input must use the checked functions in `rules.ts`.
 */

/** Number of set bits for every 10-bit digit mask. */
const POPCOUNT_10: Uint8Array = (() => {
  const table = new Uint8Array(1 << 10);
  for (let i = 1; i < table.length; i++) {
    let bits = 0;
    for (let n = i; n; n &= n - 1) bits++;
    table[i] = bits;
  }
  return table;
})();

/** Feedback (dead * 10 + injured) of `guess` against `secret`, with no validation and no allocation. */
export function scoreUnchecked(secret: string, guess: string): number {
  let dead = 0;
  let secretMask = 0;
  let guessMask = 0;
  for (let i = 0; i < 4; i++) {
    const s = secret.charCodeAt(i) - 48;
    const g = guess.charCodeAt(i) - 48;
    if (s === g) dead++;
    secretMask |= 1 << s;
    guessMask |= 1 << g;
  }
  const common = POPCOUNT_10[secretMask & guessMask] as number;
  return dead * 10 + (common - dead);
}
