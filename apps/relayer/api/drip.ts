import { dripEntry, methodNotAllowed } from '../src/entry.js';
import { dripDeps } from '../src/wiring.js';

// Thin on purpose: every decision is in src/, which is tested. This only connects it to the host's
// environment, and answers "unavailable" rather than guessing if anything is missing.
export const POST = (request: Request): Promise<Response> =>
  dripEntry(request, () => dripDeps(process.env));
export const GET = methodNotAllowed;
