// @vitest-environment jsdom
import './nodeRealm.js';
import { createHash, webcrypto } from 'node:crypto';
import type { Code, Feedback } from '@accident/engine';
import { decodeFeedback, score } from '@accident/engine';
import type { Body, Identity, SignedMessage } from '@accident/protocol';
import {
  commitment,
  encodeCommitMemo,
  encodeRevealMemo,
  generateIdentity,
  signMessage,
} from '@accident/protocol';
import { MemoryChain } from '@accident/protocol/testing';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VerifierPage } from '../src/verify/VerifierPage.js';

/** Deterministic SHA-256 so transcriptHash and verifyCommitment resolve, as in controller.test.tsx. */
beforeEach(() => {
  vi.stubGlobal('crypto', {
    subtle: {
      digest: async (_a: string, data: Uint8Array): Promise<ArrayBuffer> => {
        const h = createHash('sha256').update(data).digest();
        return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength) as ArrayBuffer;
      },
    },
    getRandomValues: (a: Uint8Array): Uint8Array => webcrypto.getRandomValues(a),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ROOM = 'ABC234';
const SALT0 = 'a'.repeat(64);
const SALT1 = 'b'.repeat(64);

interface Player {
  identity: Identity;
  secret: Code;
  salt: string;
}

interface Game {
  host: Player;
  guest: Player;
  messages: SignedMessage[];
}

function sign(player: Player, seq: number, body: Body): SignedMessage {
  return signMessage(player.identity, { room: ROOM, seq, body });
}

async function makeGame(options?: { lyingAnswer?: Feedback }): Promise<Game> {
  const host: Player = { identity: generateIdentity(), secret: '1234', salt: SALT0 };
  const guest: Player = { identity: generateIdentity(), secret: '5678', salt: SALT1 };

  const commit0 = await commitment({
    room: ROOM,
    playerKey: host.identity.publicKey,
    secret: host.secret,
    saltHex: host.salt,
  });
  const commit1 = await commitment({
    room: ROOM,
    playerKey: guest.identity.publicKey,
    secret: guest.secret,
    saltHex: guest.salt,
  });

  const guess0: Code = '5678';
  const guess1: Code = '1234';
  const answer0 = options?.lyingAnswer ?? score(guest.secret, guess0);
  const answer1 = score(host.secret, guess1);

  const chain = new MemoryChain();
  const commitSig0 = chain.post(host.identity.publicKey, encodeCommitMemo(ROOM, commit0));
  const commitSig1 = chain.post(guest.identity.publicKey, encodeCommitMemo(ROOM, commit1));

  // Per-player sequence numbers: host 0..3, guest 0..3.
  const messages: SignedMessage[] = [
    sign(host, 0, { type: 'HELLO', role: 'host' }),
    sign(guest, 0, { type: 'HELLO', role: 'guest' }),
    sign(host, 1, { type: 'COMMIT', txSig: commitSig0 }),
    sign(guest, 1, { type: 'COMMIT', txSig: commitSig1 }),
    sign(host, 2, { type: 'GUESS', guess: guess0 }),
    sign(guest, 2, { type: 'ANSWER', index: 0, feedback: answer0 }),
    sign(guest, 3, { type: 'GUESS', guess: guess1 }),
    sign(host, 3, { type: 'ANSWER', index: 1, feedback: answer1 }),
  ];

  return { host, guest, messages };
}

function fileObject(game: Game): { room: string; messages: SignedMessage[] } {
  return { room: ROOM, messages: game.messages };
}

async function seedChain(
  game: Game,
): Promise<{ chain: MemoryChain; revealSigs: [string, string] }> {
  const chain = new MemoryChain();
  const c0 = await commitment({
    room: ROOM,
    playerKey: game.host.identity.publicKey,
    secret: game.host.secret,
    saltHex: game.host.salt,
  });
  const c1 = await commitment({
    room: ROOM,
    playerKey: game.guest.identity.publicKey,
    secret: game.guest.secret,
    saltHex: game.guest.salt,
  });
  chain.post(game.host.identity.publicKey, encodeCommitMemo(ROOM, c0));
  chain.post(game.guest.identity.publicKey, encodeCommitMemo(ROOM, c1));

  const revealSig0 = chain.post(
    game.host.identity.publicKey,
    encodeRevealMemo(ROOM, game.host.secret, game.host.salt),
  );
  const revealSig1 = chain.post(
    game.guest.identity.publicKey,
    encodeRevealMemo(ROOM, game.guest.secret, game.guest.salt),
  );
  return { chain, revealSigs: [revealSig0, revealSig1] };
}

function jsonFile(data: unknown, name = 'record.json'): File {
  return new File([JSON.stringify(data)], name, { type: 'application/json' });
}

async function fillAndSubmit(options: { file: File; sigs: [string, string] }): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByTestId('sig0'), options.sigs[0]);
  await user.type(screen.getByTestId('sig1'), options.sigs[1]);
  await user.upload(screen.getByTestId('transcript'), options.file);
  await user.click(screen.getByTestId('check'));
}

describe('VerifierPage', () => {
  it('shows an honest verdict with both secrets verified and no faults', async () => {
    const game = await makeGame();
    const { chain, revealSigs } = await seedChain(game);
    render(<VerifierPage onBack={() => undefined} createChain={() => chain} />);

    await fillAndSubmit({ file: jsonFile(fileObject(game)), sigs: revealSigs });

    await waitFor(() => expect(screen.getByTestId('verdict')).toBeTruthy());
    expect(screen.getByText('Every answer matched the revealed secrets.')).toBeTruthy();
    expect(screen.queryByTestId('faults')).toBeNull();
    expect(screen.getAllByText('Verified against the lock-in').length).toBe(2);
    expect(screen.getByText(game.host.secret)).toBeTruthy();
    expect(screen.getByText(game.guest.secret)).toBeTruthy();
  });

  it('renders the wrong-answer evidence when an answer was a lie', async () => {
    const truth = score('5678', '5678'); // seat 0 guesses seat 1's own number: 4 dead
    const lie = (truth === 0 ? 1 : 0) as Feedback;
    const game = await makeGame({ lyingAnswer: lie });
    const { chain, revealSigs } = await seedChain(game);
    render(<VerifierPage onBack={() => undefined} createChain={() => chain} />);

    await fillAndSubmit({ file: jsonFile(fileObject(game)), sigs: revealSigs });

    await waitFor(() => expect(screen.getByTestId('faults')).toBeTruthy());
    const claimed = decodeFeedback(lie);
    const actual = decodeFeedback(truth);
    const text = screen.getByTestId('faults').textContent ?? '';
    expect(text).toContain('Seat 1 (guest):');
    expect(text).toContain(`${claimed.dead} dead, ${claimed.injured} injured`);
    expect(text).toContain(`${actual.dead} dead, ${actual.injured} injured`);
  });

  it('shows a friendly error for a malformed file', async () => {
    const game = await makeGame();
    const { chain, revealSigs } = await seedChain(game);
    render(<VerifierPage onBack={() => undefined} createChain={() => chain} />);

    const user = userEvent.setup();
    await user.type(screen.getByTestId('sig0'), revealSigs[0]);
    await user.type(screen.getByTestId('sig1'), revealSigs[1]);
    await user.upload(
      screen.getByTestId('transcript'),
      new File(['this is not json {{{'], 'bad.json', { type: 'application/json' }),
    );
    await user.click(screen.getByTestId('check'));

    await waitFor(() => expect(screen.getByTestId('error')).toBeTruthy());
    expect(screen.getByTestId('error').textContent).toContain('not valid JSON');
  });
});
