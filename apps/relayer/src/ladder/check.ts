import type { Verdict } from '@accident/protocol';
import { selectReveal, sha256Hex, utf8, verifyGame } from '@accident/protocol';
import type { AttestReceipt, ZendPort } from '@accident/zend';
import { ZendChain, roomForInteraction, verifyReceipt } from '@accident/zend';
import type { ZendInteraction, ZendPlayer } from './zend.js';

/**
 * Decides a finished Zend challenge on the server, from the game record a player uploads and the
 * records Zend holds. Nothing the browser says about the result is used:
 *
 * - The uploaded messages are each signed by a player's game key; forgeries are dropped.
 * - Commit and reveal records come from the interaction and count only with a Zend receipt.
 * - Each seat's game key must have been claimed (a `key` receipt) by the Zend user in that seat.
 * - Each reveal carries a hash of the game record as its sender saw it. If the uploaded record
 *   doesn't match a reveal's hash, the two players' records disagree and the game isn't rated.
 * - A missing reveal only counts against a player once the reveal window has passed.
 */

/** Matches the protocol's reveal window (180 s), plus slack for clock and network. */
export const REVEAL_WINDOW_MS = 180_000 + 30_000;

export type CheckOutcome =
  | { kind: 'final'; result: 'seat0' | 'seat1' | 'draw'; reason: string; host: ZendPlayer; guest: ZendPlayer }
  | { kind: 'disputed'; host: ZendPlayer; guest: ZendPlayer }
  | { kind: 'pending'; retryAfterMs: number }
  | { kind: 'not_rateable'; why: string };

export interface CheckInput {
  interaction: ZendInteraction;
  receipts: AttestReceipt[];
  zendPublicKey: string | undefined;
  /** The uploaded record: `{ room, messages }`, as the in-game export makes it. */
  transcript: unknown;
  now: number;
}

/** Earliest verified `key` receipt per game key decides which Zend user owns it. */
async function keyOwners(
  receipts: readonly AttestReceipt[],
  interactionId: string,
  zendPublicKey: string | undefined,
): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (const r of [...receipts].sort((a, b) => a.id - b.id)) {
    if (r.label !== 'key' || r.interaction_id !== interactionId) continue;
    if (owners.has(r.data_hash)) continue;
    if (zendPublicKey !== undefined && !(await verifyReceipt(r, zendPublicKey))) continue;
    owners.set(r.data_hash, r.app_user_id);
  }
  return owners;
}

const keyHash = (publicKey: string) => sha256Hex(utf8(`accident-key-v1|${publicKey}`));

/** A read-only port over data already fetched, so the check makes no further calls. */
function fixedPort(interaction: ZendInteraction, receipts: AttestReceipt[]): ZendPort {
  return {
    attest: () => Promise.reject(new Error('read only')),
    mergeData: () => Promise.reject(new Error('read only')),
    getInteraction: async () => ({ state: interaction.state, data: interaction.data }),
    receipts: async () => receipts,
  };
}

export async function checkGame(input: CheckInput): Promise<CheckOutcome> {
  const { interaction, receipts, zendPublicKey } = input;
  if (interaction.type !== 'challenge') return { kind: 'not_rateable', why: 'Not a challenge' };
  const [host, guest] = interaction.participants;
  if (interaction.participants.length !== 2 || !host || !guest || host.appUserId === guest.appUserId) {
    return { kind: 'not_rateable', why: 'A rated game needs exactly two players' };
  }
  const file = input.transcript as { room?: unknown; messages?: unknown } | null;
  const room = await roomForInteraction(interaction.id);
  if (!file || file.room !== room || !Array.isArray(file.messages)) {
    return { kind: 'not_rateable', why: "That game record isn't for this game" };
  }

  const chain = new ZendChain({
    port: fixedPort(interaction, receipts),
    interactionId: interaction.id,
    ...(zendPublicKey === undefined ? {} : { zendPublicKey }),
  });

  // First pass: who are the two game keys, and what are their reveals?
  const first = await verifyGame({ transcript: file, revealSigs: ['', ''] }, { chain });
  if (!first.ok) return { kind: 'not_rateable', why: first.error };
  const players = first.transcript.players;

  const owners = await keyOwners(receipts, interaction.id, zendPublicKey);
  if (
    owners.get(await keyHash(players[0])) !== host.appUserId ||
    owners.get(await keyHash(players[1])) !== guest.appUserId
  ) {
    return { kind: 'not_rateable', why: "The players' game keys don't match their seats" };
  }

  const revealSigs: [string, string] = ['', ''];
  const revealAt: [number | undefined, number | undefined] = [undefined, undefined];
  for (const seat of [0, 1] as const) {
    const canonical = selectReveal(await chain.listMemoTxs(players[seat], room), room, players[seat]);
    if (canonical) {
      revealSigs[seat] = canonical.tx.sig;
      // Zend records always carry their receipt time; "now" keeps the window open if one didn't.
      revealAt[seat] = (canonical.tx.blockTime ?? Math.floor(input.now / 1000)) * 1000;
    }
  }
  const missing = revealAt.filter((t) => t === undefined).length;
  if (missing === 2) {
    // Nobody revealed. Either the game is still on, or it was abandoned and can't be judged.
    const last = Math.max(0, ...receipts.map((r) => r.unix_ms));
    return input.now - last > 30 * 60_000
      ? { kind: 'not_rateable', why: 'Neither player finished this game' }
      : { kind: 'pending', retryAfterMs: 15_000 };
  }
  if (missing === 1) {
    const at = (revealAt[0] ?? revealAt[1]) as number;
    const closesAt = at + REVEAL_WINDOW_MS;
    if (input.now < closesAt) return { kind: 'pending', retryAfterMs: Math.min(30_000, closesAt - input.now + 1000) };
  }

  // Second pass with the reveals located, so the record-hash check runs.
  const checked = await verifyGame({ transcript: file, revealSigs }, { chain });
  if (!checked.ok) return { kind: 'not_rateable', why: checked.error };
  if (checked.hashCheck.some((h) => h.present && !h.matches)) return { kind: 'disputed', host, guest };

  const verdict: Verdict = checked.verdict;
  if (verdict.kind !== 'final') return { kind: 'not_rateable', why: 'Neither player finished this game' };
  return { kind: 'final', result: verdict.result, reason: verdict.reason, host, guest };
}
