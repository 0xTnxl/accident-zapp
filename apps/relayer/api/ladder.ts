import { ladderEntry } from '../src/entry.js';
import { ladderDeps } from '../src/wiring.js';

const handle = (request: Request): Promise<Response> => ladderEntry(request, () => ladderDeps(process.env));
export const GET = handle;
export const POST = handle;
