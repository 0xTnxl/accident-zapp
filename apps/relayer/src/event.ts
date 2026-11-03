import type { Counter } from './http.js';
import { clientIp, dayOf, error, json, readJson } from './http.js';

/** The only events accepted, and the only properties each may carry. Anything else is dropped. */
export const EVENTS = {
  app_open: [],
  cpu_game_start: ['level'],
  cpu_game_end: ['level', 'result', 'guesses'],
  room_created: [],
  room_joined: [],
  commit_confirmed: ['ms'],
  play_gate_open: ['ms'],
  pvp_first_guess: [],
  pvp_finished: ['result', 'guesses', 'durationMs'],
  rematch_clicked: [],
  tx_error: ['kind', 'code'],
  tx_latency_ms: ['ms'],
  relay_latency_ms: ['ms'],
} as const satisfies Record<string, readonly string[]>;

export type EventName = keyof typeof EVENTS;

export const MAX_STRING = 40;
const SESSION_ID = /^[A-Za-z0-9_-]{8,40}$/;

export interface EventRecord {
  name: EventName;
  /** A random id made by the browser. It identifies a visit, not a person. */
  session: string;
  at: number;
  props: Record<string, string | number>;
}

export interface EventDeps {
  counter: Counter;
  store: (record: EventRecord) => Promise<void>;
  /** Most events accepted per client address per day. */
  perIpPerDay: number;
  now: () => number;
}

export const DEFAULT_EVENT_LIMIT = 500;

/** Keeps only the properties an event is allowed, and only short strings or finite numbers. */
export function cleanProps(name: EventName, props: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (typeof props !== 'object' || props === null) return out;
  const allowed = EVENTS[name] as readonly string[];
  for (const key of allowed) {
    const value = (props as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string' && value.length <= MAX_STRING) out[key] = value;
  }
  return out;
}

/**
 * POST /api/event  {"name": "...", "session": "...", "props": {...}}
 *
 * Anonymous product analytics. It accepts a fixed list of event names, keeps a fixed list of
 * properties for each, and records a random visit id and a time. It never stores the caller's
 * address: that is used only, in memory, to count requests.
 */
export async function handleEvent(request: Request, deps: EventDeps): Promise<Response> {
  if (request.method !== 'POST') return error(405, 'Use POST', { allow: 'POST' });

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { name?: unknown; session?: unknown; props?: unknown } | null;

  const name = body?.name;
  if (typeof name !== 'string' || !Object.hasOwn(EVENTS, name)) return error(400, 'Unknown event');
  const session = body?.session;
  if (typeof session !== 'string' || !SESSION_ID.test(session))
    return error(400, 'Invalid session');

  const used = await deps.counter.increment(`event:${clientIp(request)}`, dayOf(deps.now()));
  if (used > deps.perIpPerDay) return error(429, 'Too many events');

  await deps.store({
    name: name as EventName,
    session,
    at: deps.now(),
    props: cleanProps(name as EventName, body?.props),
  });
  return json(200, { ok: true });
}
