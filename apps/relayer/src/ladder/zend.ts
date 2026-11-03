import type { AttestReceipt } from '@accident/zend';

/**
 * The parts of Zend's API the ladder uses. Server calls carry the app key (`ZEND_APP_KEY`, a host
 * secret); receipts and the receipt key are public.
 */
export interface ZendPlayer {
  appUserId: string;
  name: string;
  username: string | null;
  avatar: string | null;
}

export interface ZendInteraction {
  id: string;
  app: string;
  type: string;
  state: string;
  data: Record<string, unknown>;
  participants: ZendPlayer[];
  createdAt: string;
  updatedAt: string;
}

export interface ZendApi {
  /** Exchanges a player's app session (from `zend.identity.get()`) for who they are. */
  verifySession(appSession: string): Promise<ZendPlayer | undefined>;
  interaction(id: string): Promise<ZendInteraction | undefined>;
  receipts(interactionId: string): Promise<AttestReceipt[]>;
  attestKey(): Promise<string | undefined>;
  /** A new challenge, created on behalf of `createdBy` (the host) with `guest`. */
  createChallenge(createdBy: string, guest: string, expiresInSecs: number): Promise<string>;
}

export const DEFAULT_ZEND_API = 'https://api.usezend.app';

interface RawPlayer {
  app_user_id?: string;
  appUserId?: string;
  name?: string;
  username?: string | null;
  avatar?: string | null;
}

function player(raw: RawPlayer): ZendPlayer | undefined {
  const id = raw.app_user_id ?? raw.appUserId;
  if (typeof id !== 'string') return undefined;
  return {
    appUserId: id,
    name: typeof raw.name === 'string' ? raw.name : '',
    username: typeof raw.username === 'string' ? raw.username : null,
    avatar: typeof raw.avatar === 'string' ? raw.avatar : null,
  };
}

export class HttpZendApi implements ZendApi {
  private keyCache: { value: string | undefined; at: number } | undefined;

  constructor(
    private readonly appKey: string,
    private readonly base: string = DEFAULT_ZEND_API,
    private readonly http: typeof fetch = fetch,
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    return this.http(`${this.base}/api/zend/v2${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.appKey}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
  }

  async verifySession(appSession: string): Promise<ZendPlayer | undefined> {
    const r = await this.call('/apps/token/verify', {
      method: 'POST',
      body: JSON.stringify({ app_session: appSession }),
    });
    if (r.status === 401 || r.status === 403) return undefined;
    if (!r.ok) throw new Error(`token/verify ${r.status}`);
    return player((await r.json()) as RawPlayer);
  }

  async interaction(id: string): Promise<ZendInteraction | undefined> {
    const r = await this.call(`/apps/server/interactions/${encodeURIComponent(id)}`);
    if (r.status === 404 || r.status === 403) return undefined;
    if (!r.ok) throw new Error(`interaction ${r.status}`);
    const raw = (await r.json()) as Record<string, unknown>;
    const people = Array.isArray(raw.participants) ? (raw.participants as RawPlayer[]) : [];
    return {
      id: String(raw.id),
      app: String(raw.app),
      type: String(raw.type),
      state: String(raw.state),
      data: (raw.data && typeof raw.data === 'object' ? raw.data : {}) as Record<string, unknown>,
      participants: people.map(player).filter((p): p is ZendPlayer => p !== undefined),
      createdAt: String(raw.created_at),
      updatedAt: String(raw.updated_at),
    };
  }

  async receipts(interactionId: string): Promise<AttestReceipt[]> {
    const r = await this.http(
      `${this.base}/api/zend/v2/apps/attest/interactions/${encodeURIComponent(interactionId)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!r.ok) throw new Error(`receipts ${r.status}`);
    return ((await r.json()) as { receipts: AttestReceipt[] }).receipts;
  }

  async attestKey(): Promise<string | undefined> {
    // The key changes only on rotation; an hour of caching per warm function is plenty.
    if (this.keyCache && Date.now() - this.keyCache.at < 3_600_000) return this.keyCache.value;
    const r = await this.http(`${this.base}/api/zend/v2/apps/attest/key`, {
      signal: AbortSignal.timeout(10_000),
    });
    const value = r.ok ? ((await r.json()) as { public_key?: string }).public_key : undefined;
    this.keyCache = { value, at: Date.now() };
    return value;
  }

  async createChallenge(createdBy: string, guest: string, expiresInSecs: number): Promise<string> {
    const r = await this.call('/apps/server/interactions', {
      method: 'POST',
      body: JSON.stringify({
        type: 'challenge',
        created_by: createdBy,
        participants: [guest],
        expires_in_secs: expiresInSecs,
        data: { tournament: true },
      }),
    });
    if (!r.ok) throw new Error(`create challenge ${r.status}`);
    const id = ((await r.json()) as { id?: unknown }).id;
    if (typeof id !== 'string') throw new Error('create challenge: no id');
    return id;
  }
}
