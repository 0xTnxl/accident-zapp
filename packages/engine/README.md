# @accident/engine

Pure TypeScript rules for Accident (Bulls and Cows). No DOM, network, or chain dependencies.
Source of truth for the rules: `.kiro/specs/accident/requirements.md` (REQ-3) and PRD section 4.

## Conventions

- A **code** is a string of 4 distinct digits, leading zero allowed: `"0123"`.
- **Feedback** is `dead * 10 + injured`, for example `11`. Exactly 14 values can occur; `31` cannot.
- **Seat 0** guesses first. Guess `i` is made by seat `i % 2` and answered by the other seat.
- Every exported function validates its input and throws `RangeError`. Use it on untrusted data.

## Quick use

```ts
import { score, gameStatus, candidatesFromHistory, chooseGuess, secureRng } from '@accident/engine';

score('1964', '2604'); // 11  (1 dead, 1 injured)

// Live play from the answers claimed so far
gameStatus([0, 11, 40]); // { over: false, next: 1, index: 3, finalGuess: true }

// Computer opponent
const candidates = candidatesFromHistory([{ guess: '0123', feedback: 11 }]);
chooseGuess('hard', candidates, secureRng());
```

After both secrets are revealed, the protocol uses `findLies`, `findHits` and `verdictFromSecrets`.

## Randomness

Use `secureRng()` for a player's real secret. `mulberry32` is deterministic and for tests only.

## Testing

```sh
pnpm --filter @accident/engine test            # fast
pnpm --filter @accident/engine test:coverage   # enforces 100% statements, branches, functions, lines
```

The suite includes the PRD vectors, an independent reference implementation, a referee that reads
answers by round and is fuzzed against `gameStatus`, model-based full games that check the live
result against the post-reveal verdict, and golden values that pin the Hard strategy.
