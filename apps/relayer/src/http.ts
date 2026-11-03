/** Small helpers shared by the handlers. Everything works on standard `Request` and `Response`. */

export const MAX_BODY_BYTES = 2048;

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

export const error = (
  status: number,
  message: string,
  headers?: Record<string, string>,
): Response => json(status, { ok: false, error: message }, headers);

export type Parsed = { ok: true; value: unknown } | { ok: false; response: Response };

/**
 * Reads a small JSON body. Refuses other content types and anything over the size limit before
 * trusting a byte of it, including when the client lies about `content-length`.
 */
export async function readJson(request: Request): Promise<Parsed> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return { ok: false, response: error(415, 'Send JSON') };
  }
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return { ok: false, response: error(413, 'Request too large') };

  const text = await request.text();
  // The header can be wrong or missing, so measure what actually arrived.
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return { ok: false, response: error(413, 'Request too large') };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: error(400, 'That is not valid JSON') };
  }
}

/**
 * The caller's address, for rate limiting only. Hosts put the real client first in
 * `x-forwarded-for`; without a usable header everything falls into one shared bucket, which is
 * stricter, not looser.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded && forwarded.length <= 64 ? forwarded : 'unknown';
}

/** The start of the current UTC day, as a label that changes at midnight. */
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Counts things per key, per day. The real version is backed by a database; tests use memory.
 * `increment` must be atomic, or two simultaneous requests could both slip under a limit.
 */
export interface Counter {
  /** Adds one and returns the new total for this key and day. */
  increment(key: string, day: string): Promise<number>;
  /** Takes one back, for a request that was counted but then not carried out. */
  decrement(key: string, day: string): Promise<void>;
}

export class MemoryCounter implements Counter {
  private readonly counts = new Map<string, number>();

  async increment(key: string, day: string): Promise<number> {
    const id = `${day}|${key}`;
    const next = (this.counts.get(id) ?? 0) + 1;
    this.counts.set(id, next);
    return next;
  }

  async decrement(key: string, day: string): Promise<void> {
    const id = `${day}|${key}`;
    this.counts.set(id, Math.max(0, (this.counts.get(id) ?? 0) - 1));
  }

  peek(key: string, day: string): number {
    return this.counts.get(`${day}|${key}`) ?? 0;
  }
}
