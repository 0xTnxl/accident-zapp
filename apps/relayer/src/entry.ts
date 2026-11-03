import type { DripDeps } from './drip.js';
import { handleDrip } from './drip.js';
import type { EventDeps } from './event.js';
import { handleEvent } from './event.js';
import { error, json } from './http.js';

/**
 * The behaviour of the two Vercel functions, with their dependencies passed in. The files under
 * `api/` supply the real ones from the environment; tests supply fakes, so nothing here needs the
 * network.
 */
export async function dripEntry(
  request: Request,
  build: () => DripDeps | undefined,
): Promise<Response> {
  const deps = build();
  if (!deps) return error(503, 'Funding is not available right now');
  try {
    return await handleDrip(request, deps);
  } catch {
    // Any surprise becomes a plain error. The cause is never sent to the caller.
    return error(500, 'Something went wrong');
  }
}

/** Analytics must never get in a player's way, so every failure is a quick, soft refusal. */
export async function eventEntry(
  request: Request,
  build: () => EventDeps | undefined,
): Promise<Response> {
  const deps = build();
  if (!deps) return json(202, { ok: false });
  try {
    return await handleEvent(request, deps);
  } catch {
    return json(202, { ok: false });
  }
}

export const methodNotAllowed = (): Response => error(405, 'Use POST', { allow: 'POST' });
