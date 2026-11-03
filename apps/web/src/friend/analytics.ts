/**
 * Anonymous product analytics for the web app.
 *
 * It sends only the fixed event names and properties the relayer accepts, tagged with a random
 * visit id made in the browser. It never sends anything that identifies a person. Analytics must
 * never get in the player's way, so every send is fire-and-forget: failures are swallowed, and when
 * the browser offers `sendBeacon` it is used so an event survives the page closing.
 */

/** Event names, matching the relayer's allow-list (apps/relayer/src/event.ts). */
export type AnalyticsEvent =
  | { name: 'app_open' }
  | { name: 'cpu_game_start'; level: string }
  | { name: 'cpu_game_end'; level: string; result: string; guesses: number }
  | { name: 'room_created' }
  | { name: 'room_joined' }
  | { name: 'commit_confirmed'; ms: number }
  | { name: 'play_gate_open'; ms: number }
  | { name: 'pvp_first_guess' }
  | { name: 'pvp_finished'; result: string; guesses: number; durationMs: number }
  | { name: 'rematch_clicked' }
  | { name: 'tx_error'; kind: string; code: string }
  | { name: 'tx_latency_ms'; ms: number }
  | { name: 'relay_latency_ms'; ms: number };

const SESSION_KEY = 'accident:visit:v1';

/** A random visit id: it tags one visit, not a person, and is not shared across browsers. */
export function visitId(store: Pick<Storage, 'getItem' | 'setItem'> = localStorage): string {
  try {
    const existing = store.getItem(SESSION_KEY);
    if (existing && /^[A-Za-z0-9_-]{8,40}$/.test(existing)) return existing;
  } catch {
    // Storage blocked (private mode): fall through to a per-load id.
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  try {
    store.setItem(SESSION_KEY, id);
  } catch {
    // Still usable for this page load even if it cannot be saved.
  }
  return id;
}

/** How an event is sent. The default posts to the relayer; tests pass their own. */
export interface Transport {
  (url: string, body: string): void;
}

/** Prefers `sendBeacon` (survives the page unloading), falls back to a non-blocking fetch. */
export function browserTransport(): Transport {
  return (url, body) => {
    try {
      const beacon = navigator.sendBeacon?.bind(navigator);
      if (beacon && beacon(url, new Blob([body], { type: 'application/json' }))) return;
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => undefined);
    } catch {
      // Analytics must never throw into the app.
    }
  };
}

export interface AnalyticsOptions {
  endpoint?: string;
  transport?: Transport;
  session?: string;
  /** Turns sending off entirely (for example in the simulation build). */
  enabled?: boolean;
}

/** Sends anonymous events, or does nothing when disabled. */
export class Analytics {
  private readonly endpoint: string;
  private readonly transport: Transport;
  private readonly enabled: boolean;
  private readonly givenSession: string | undefined;
  private resolvedSession: string | undefined;

  constructor(options: AnalyticsOptions = {}) {
    this.endpoint = options.endpoint ?? '/api/event';
    this.transport = options.transport ?? browserTransport();
    this.givenSession = options.session;
    this.enabled = options.enabled ?? true;
  }

  /** The visit id, read from storage on first use so construction never touches the browser. */
  private session(): string {
    this.resolvedSession ??= this.givenSession ?? visitId();
    return this.resolvedSession;
  }

  send(event: AnalyticsEvent): void {
    if (!this.enabled) return;
    const { name, ...props } = event;
    try {
      this.transport(this.endpoint, JSON.stringify({ name, session: this.session(), props }));
    } catch {
      // Never let analytics break the caller.
    }
  }
}

/** An analytics object that sends nothing, for the simulation build and for tests. */
export const noopAnalytics = new Analytics({ enabled: false });
