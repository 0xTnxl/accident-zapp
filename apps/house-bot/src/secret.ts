import type { Code, Rng } from '@accident/engine';
import { randomCode, secureRng } from '@accident/engine';
import { generateSaltHex } from '@accident/protocol';

/** The secret and salt a bot commits to for one game. */
export interface Choice {
  secret: Code;
  saltHex: string;
}

/**
 * Picks a fresh secret and salt for the bot. `rng` defaults to {@link secureRng} so a real bot
 * commits to an unpredictable code; tests inject a seeded {@link mulberry32} for determinism.
 */
export function makeChoice(rng: Rng = secureRng()): Choice {
  return { secret: randomCode(rng), saltHex: generateSaltHex() };
}
