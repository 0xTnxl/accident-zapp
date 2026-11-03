import { eventEntry, methodNotAllowed } from '../src/entry.js';
import { eventDeps } from '../src/wiring.js';

export const POST = (request: Request): Promise<Response> =>
  eventEntry(request, () => eventDeps(process.env));
export const GET = methodNotAllowed;
