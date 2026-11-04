// Vendored from zendfi/zend-appkit src/index.ts. Replace with the @zend/appkit package once it is published.
/**
 * @zend/appkit — runs inside a ZApp page opened by Zend (mobile WebView or the
 * app.usezend.app iframe). Every money action opens Zend's own confirmation
 * sheet; your page never sees keys or link secrets.
 *
 * `reference` (≤ 64 chars) comes back on every webhook so you can match it to your own records.
 *
 * Trust rule: never treat a resolved promise as proof of payment on your
 * server. Verify with the server API or signed webhooks.
 */

export type Environment = "zend-app" | "zend-web" | "external";

export interface Identity {
  /** Stable across every ZApp and across username changes. Use this as your user key. */
  appUserId: string;
  username: string | null;
  name: string;
  scopes: string[];
  /** Short-lived token. Send it to your server and exchange it at /apps/token/verify. */
  appSession: string;
}

export interface Interaction {
  id: string;
  app: string;
  type: string;
  state: string;
  data: Record<string, unknown>;
  participants: { appUserId: string; username: string | null; name: string; avatar: string | null }[];
  visibility: "participants" | "friends" | "public";
  version: number;
  url: string;
}

export class ZendError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ZendError";
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: ZendError) => void; timer: ReturnType<typeof setTimeout> };

const DEFAULT_ZEND_ORIGINS = ["https://app.usezend.app"];
const TIMEOUT_MS = 10 * 60 * 1000; // money sheets can stay open while the user decides

declare global {
  interface Window {
    ZendBridge?: { postMessage(message: string): void };
    __zendReceive?: (raw: string) => void;
  }
}

class Transport {
  private seq = 0;
  private pending = new Map<string, Pending>();
  readonly environment: Environment;

  private parentOrigin: string | null = null;

  constructor(zendOrigins: string[]) {
    if (typeof window !== "undefined" && window.ZendBridge) {
      this.environment = "zend-app";
      window.__zendReceive = (raw) => this.receive(raw);
    } else if (typeof window !== "undefined" && window.parent !== window) {
      this.environment = "zend-web";
      // The parent's origin, when the browser exposes it, picks which allowed origin to talk to.
      const ancestor = (location as any).ancestorOrigins?.[0] ?? (document.referrer ? new URL(document.referrer).origin : null);
      this.parentOrigin = zendOrigins.includes(ancestor) ? ancestor : zendOrigins[0];
      window.addEventListener("message", (e) => {
        if (!zendOrigins.includes(e.origin) || e.source !== window.parent) return;
        if (typeof e.data === "string") this.receive(e.data);
      });
    } else {
      this.environment = "external";
    }
  }

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.environment === "external") {
      return Promise.reject(new ZendError("NOT_IN_ZEND", "Open this app from Zend to use Zend features"));
    }
    const id = `z${++this.seq}`;
    const msg = JSON.stringify({ zend: 1, id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ZendError("TIMEOUT", `${method} timed out`));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      if (this.environment === "zend-app") window.ZendBridge!.postMessage(msg);
      else window.parent.postMessage(msg, this.parentOrigin!);
    });
  }

  private receive(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg?.zend !== 1) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new ZendError(msg.error.code, msg.error.message));
    else p.resolve(msg.result);
  }
}

export interface Launch {
  /** Set when opened from a chat action, a card button, or an /i/<id> link. */
  interaction: string | null;
  /** Set when a card's `start_interaction` button opened the app. */
  start: string | null;
  /** With `start`: the interaction whose card was tapped, to reuse its people. */
  from: string | null;
}

export interface Zend {
  environment: Environment;
  /** Why Zend opened this page. Read once on load. */
  launch: Launch;
  identity: { get(): Promise<Identity> };
  /** Send to a Zend user. Amount in USD for now. */
  pay(p: { to: `@${string}`; amount: number; note?: string; reference?: string }): Promise<{ paymentId: string; status: string }>;
  /** Make an ask link others can pay. Omit amount to let payers choose. */
  request(p: { amount?: number; note?: string; maxPayments?: number; reference?: string }): Promise<{ id: string; url: string }>;
  /** Make a money link. Zend shares it; you only get its id. */
  createLink(p: { amount: number; uses?: number; note?: string; reference?: string }): Promise<{ id: string; status: string }>;
  interaction: {
    create(p: {
      type: string;
      participants?: string[];
      data?: Record<string, unknown>;
      visibility?: Interaction["visibility"];
      expiresInSecs?: number;
      /** If these same people already have an unfinished one of this type (last 30 min), return it. */
      reuseOpen?: boolean;
    }): Promise<Interaction>;
    get(id: string): Promise<Interaction>;
    update(id: string, p: { state: string; data?: Record<string, unknown>; idempotencyKey: string; expectedVersion?: number }): Promise<Interaction>;
  };
  /**
   * Post a card about an interaction to the chat (two people) or the feed.
   * Templates: result, invite, status. Zend draws it and shows live status;
   * the user must have allowed this app to post.
   */
  postCard(p: {
    interactionId: string;
    template: "result" | "invite" | "status";
    placement: "chat" | "feed";
    idempotencyKey: string;
    slots: {
      title: string;
      subtitle?: string;
      emoji?: string;
      media?: string;
      buttons?: (
        | { label: string; action: "open_sheet"; path: string }
        | { label: string; action: "start_interaction"; type: string }
        | { label: string; action: "open_url"; url: string }
      )[];
    };
  }): Promise<unknown>;
  /** Tamper-evident record of a hash (e.g. a commitment). Returns a receipt signed by Zend. */
  attest(p: { label: string; dataHash: string; interactionId?: string }): Promise<AttestReceipt>;
  prize: {
    /** Host puts up a prize. Amount in USD, at least 1. Zend shows the rules before the host confirms. */
    create(p: { amount: number; joinInSecs: number; resolveInSecs: number; maxPlayers: number;
      disputeSecs?: number; reference?: string; interactionId?: string }): Promise<Prize>;
    /** Player joins (free). Only joined players can win. */
    join(id: string): Promise<Prize>;
    /** Host cancels during the wait after results; everything returns to the host. */
    cancel(id: string): Promise<Prize>;
    get(id: string): Promise<Prize>;
  };
  /** Let the user report something in your app to Zend. */
  report(p: { reason: "scam" | "unfair_result" | "offensive" | "broken" | "other"; detail?: string;
    interactionId?: string; prizeId?: string }): Promise<void>;
  close(result?: unknown): Promise<void>;
}

export interface AttestReceipt {
  id: number; app: string; app_user_id: string; interaction_id: string; label: string;
  data_hash: string; prev_hash: string; unix_ms: number; receipt_hash: string; signature: string;
}

export interface Prize {
  id: string; app: string; host: string; pot_usd: number; max_players: number; player_count: number;
  join_deadline: string; resolve_deadline: string; dispute_ends: string | null;
  status: "open" | "resolved" | "paid" | "refunded";
  winners: { address: string; app_user_id: string | null; amount_usd: number }[] | null;
  joined: boolean; is_host: boolean; reference: string | null;
}

export interface InitOptions {
  /**
   * Zend web origins allowed to host this page. Default: production only.
   * Add a staging origin while testing, e.g. ["https://app.usezend.app", "https://staging.usezend.app"].
   */
  zendOrigins?: string[];
}

/** Zend's API uses snake_case for participants; the SDK promises camelCase. */
function normalize(raw: any): Interaction {
  const participants = (raw?.participants ?? []).map((p: any) => ({
    appUserId: p.appUserId ?? p.app_user_id,
    username: p.username ?? null,
    name: p.name,
    avatar: p.avatar ?? null,
  }));
  // Older interactions can come back with null data; the type promises an object.
  const data = raw?.data && typeof raw.data === "object" ? raw.data : {};
  return { ...raw, data, participants };
}

export function init(opts: InitOptions = {}): Zend {
  const t = new Transport(opts.zendOrigins ?? DEFAULT_ZEND_ORIGINS);
  const q = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
  return {
    environment: t.environment,
    launch: { interaction: q.get("interaction"), start: q.get("start"), from: q.get("from") },
    identity: { get: () => t.call("identity.get") },
    pay: (p) => t.call("pay", p),
    request: (p) => t.call("request", p),
    createLink: (p) => t.call("createLink", p),
    interaction: {
      create: (p) => t.call<any>("interaction.create", {
        type: p.type, participants: p.participants ?? [], data: p.data ?? {},
        visibility: p.visibility ?? "participants", expires_in_secs: p.expiresInSecs,
        reuse_open: p.reuseOpen ?? false,
      }).then(normalize),
      get: (id) => t.call<any>("interaction.get", { id }).then(normalize),
      update: (id, p) => t.call<any>("interaction.update", {
        id, state: p.state, data: p.data, idempotency_key: p.idempotencyKey, expected_version: p.expectedVersion,
      }).then(normalize),
    },
    postCard: (p) => t.call("card.post", {
      interaction_id: p.interactionId, template: p.template, placement: p.placement,
      idempotency_key: p.idempotencyKey, slots: p.slots,
    }),
    attest: (p) => t.call("attest", p),
    prize: {
      create: (p) => t.call("prize.create", p),
      join: (id) => t.call("prize.join", { id }),
      cancel: (id) => t.call("prize.cancel", { id }),
      get: (id) => t.call("prize.get", { id }),
    },
    report: (p) => t.call("report", p),
    close: (result) => t.call("close", { result }),
  };
}

export default { init };
