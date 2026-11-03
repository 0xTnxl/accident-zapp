import { mulberry32, randomCode } from '@accident/engine';
import { describe, expect, it } from 'vitest';
import type { Game } from './helpers.js';
import type { SignedMessage, Transcript } from '../src/index.js';
import {
  assembleTranscript,
  encodeMessage,
  parseMessage,
  signMessage,
  transcriptHash,
  transcriptLines,
  transcriptMessages,
} from '../src/index.js';
import { ROOM, Sender, fakeSig, identityFromByte, neverHit, playGame } from './helpers.js';

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function assemble(game: Game, messages: readonly unknown[] = game.messages): Transcript {
  const result = assembleTranscript(game.room, messages);
  if (!result.ok) throw new Error(result.reason);
  return result.transcript;
}

async function honestGame(seed = 1): Promise<Game> {
  const rng = mulberry32(seed);
  return playGame({ secrets: [randomCode(rng), randomCode(rng)], rng });
}

describe('assembling an honest game', () => {
  it('recovers players, guesses and answers', async () => {
    const game = await honestGame();
    const t = assemble(game);
    expect(t.room).toBe(ROOM);
    expect(t.players).toEqual([game.identities[0].publicKey, game.identities[1].publicKey]);
    expect(t.guessCodes).toEqual(game.guesses);
    expect(t.answerValues).toEqual(game.claimed);
    expect(t.guesses).toHaveLength(game.guesses.length);
    expect(t.answers).toHaveLength(game.guesses.length);
    expect(t.equivocation).toEqual([false, false]);
    expect(t.ignored).toEqual([]);
    expect(t.commits[0]?.from).toBe(t.players[0]);
    expect(t.commits[1]?.from).toBe(t.players[1]);
  });

  it('gives guess i to seat i % 2', async () => {
    const t = assemble(await honestGame(5));
    t.guesses.forEach((m, i) => expect(m.from).toBe(t.players[i % 2]));
    t.answers.forEach((m, i) => expect(m.from).toBe(t.players[1 - (i % 2)]));
  });

  it('is independent of the order the messages arrive in', async () => {
    const game = await honestGame(2);
    const reference = assemble(game);
    for (const seed of [1, 2, 3, 4, 5]) {
      const t = assemble(game, shuffled(game.messages, seed));
      expect(t).toEqual(reference);
      expect(await transcriptHash(t)).toBe(await transcriptHash(reference));
    }
  });

  it('accepts duplicates of the same message without complaint', async () => {
    const game = await honestGame(3);
    const t = assemble(game, [...game.messages, ...game.messages]);
    expect(t.equivocation).toEqual([false, false]);
    expect(t.guessCodes).toEqual(game.guesses);
  });

  it('ignores SYNC and REVEAL messages', async () => {
    const game = await honestGame(4);
    const extras = [
      game.senders[0].send({ type: 'SYNC', received: 3 }),
      game.senders[1].send({
        type: 'REVEAL',
        secret: game.secrets[1],
        saltHex: game.salts[1],
        txSig: fakeSig(8),
      }),
    ];
    const t = assemble(game, [...game.messages, ...extras]);
    expect(t.ignored).toEqual([]);
    expect(await transcriptHash(t)).toBe(await transcriptHash(assemble(game)));
  });

  it('survives a trip through the wire format', async () => {
    const game = await honestGame(6);
    const wire = game.messages.map(encodeMessage).map(parseMessage);
    expect(assemble(game, wire)).toEqual(assemble(game));
  });
});

describe('canonical order and hash', () => {
  it('orders HELLOs, COMMITs, then guess and answer pairs', async () => {
    const t = assemble(await honestGame(7));
    const messages = transcriptMessages(t);
    expect(messages.slice(0, 2).map((m) => m.type)).toEqual(['HELLO', 'HELLO']);
    expect(messages[0]?.from).toBe(t.players[0]);
    expect(messages.slice(2, 4).map((m) => m.type)).toEqual(['COMMIT', 'COMMIT']);
    const rest = messages.slice(4).map((m) => m.type);
    rest.forEach((type, i) => expect(type).toBe(i % 2 === 0 ? 'GUESS' : 'ANSWER'));
    expect(rest).toHaveLength(t.guesses.length * 2);
  });

  it('writes one line per message: signed text, a pipe, then the signature', async () => {
    const t = assemble(await honestGame(8));
    const lines = transcriptLines(t);
    expect(lines).toHaveLength(transcriptMessages(t).length);
    expect(lines[0]).toBe(`ACC1|${ROOM}|0|HELLO|host|${t.hellos[0].sig}`);
  });

  it('is a 64-character lowercase hex SHA-256', async () => {
    expect(await transcriptHash(assemble(await honestGame(9)))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different games and is stable for the same game', async () => {
    const a = await transcriptHash(assemble(await honestGame(10)));
    const b = await transcriptHash(assemble(await honestGame(11)));
    expect(a).not.toBe(b);
    expect(await transcriptHash(assemble(await honestGame(10)))).toBe(a);
  });

  it('changes if any one answer is altered and re-signed', async () => {
    const game = await honestGame(12);
    const original = await transcriptHash(assemble(game));
    const index = game.messages.findIndex((m) => m.type === 'ANSWER');
    const victim = game.messages[index] as SignedMessage;
    const sender =
      victim.from === game.identities[0].publicKey ? game.identities[0] : game.identities[1];
    const changed = signMessage(sender, {
      room: ROOM,
      seq: victim.seq,
      body: { type: 'ANSWER', index: 0, feedback: victim.payload === '0:0' ? 1 : 0 },
    });
    const messages = [...game.messages];
    messages[index] = changed;
    const tampered = assemble(game, messages);
    expect(await transcriptHash(tampered)).not.toBe(original);
  });

  it('includes a final guess that has not been answered yet, and the hash covers it', async () => {
    const game = await honestGame(30);
    const lastAnswer = game.messages.map((m) => m.type).lastIndexOf('ANSWER');
    const midGame = assemble(
      game,
      game.messages.filter((_, i) => i !== lastAnswer),
    );
    const full = assemble(game);
    expect(midGame.guesses).toHaveLength(full.guesses.length);
    expect(midGame.answers).toHaveLength(full.answers.length - 1);
    const types = transcriptMessages(midGame).map((m) => m.type);
    expect(types[types.length - 1]).toBe('GUESS');
    expect(await transcriptHash(midGame)).not.toBe(await transcriptHash(full));
  });

  it('leaves out a commit that was never announced', async () => {
    const game = await honestGame(13);
    const messages = game.messages.filter(
      (m) => m.type !== 'COMMIT' || m.from !== game.identities[1].publicKey,
    );
    const t = assemble(game, messages);
    expect(t.commits[1]).toBeUndefined();
    expect(transcriptMessages(t).filter((m) => m.type === 'COMMIT')).toHaveLength(1);
  });
});

describe('assembly fails without a clear pair of players', () => {
  it('needs both HELLOs', async () => {
    const game = await honestGame(14);
    const noGuest = game.messages.filter((m) => !(m.type === 'HELLO' && m.payload === 'guest'));
    expect(assembleTranscript(game.room, noGuest)).toEqual({
      ok: false,
      reason: 'Could not identify exactly one host and one guest',
    });
    expect(assembleTranscript(game.room, [])).toMatchObject({ ok: false });
  });

  it('refuses a second key claiming to be the host', async () => {
    const game = await honestGame(15);
    const impostor = new Sender(identityFromByte(50)).send({ type: 'HELLO', role: 'host' });
    expect(assembleTranscript(game.room, [...game.messages, impostor])).toMatchObject({
      ok: false,
    });
  });

  it('refuses one key that says both host and guest', async () => {
    const same = new Sender(identityFromByte(60));
    const hello1 = same.send({ type: 'HELLO', role: 'host' });
    const hello2 = same.send({ type: 'HELLO', role: 'guest' });
    expect(assembleTranscript(ROOM, [hello1, hello2])).toEqual({
      ok: false,
      reason: 'Host and guest are the same key',
    });
  });

  it('reports a HELLO that is not the first message as unexpected', async () => {
    const game = await honestGame(16);
    const extraHello = game.senders[0].send({ type: 'HELLO', role: 'host' });
    const t = assemble(game, [...game.messages, extraHello]);
    expect(t.ignored.some((reason) => reason.includes('unexpected HELLO'))).toBe(true);
  });
});

describe('hostile messages are dropped, never trusted', () => {
  it('drops malformed junk, other rooms and bad signatures, and says why', async () => {
    const game = await honestGame(17);
    const guess = game.messages.find((m) => m.type === 'GUESS') as SignedMessage;
    const otherRoom = signMessage(game.identities[0], {
      room: 'ZZZ999',
      seq: 40,
      body: { type: 'GUESS', guess: '0123' },
    });
    const forged = { ...guess, payload: '9876' };
    const t = assemble(game, [...game.messages, 'junk', 42, null, otherRoom, forged]);
    expect(t.guessCodes).toEqual(game.guesses);
    expect(t.ignored).toEqual(
      expect.arrayContaining([
        'malformed message',
        'message for another room',
        expect.stringContaining('bad signature'),
      ]),
    );
  });

  it('ignores a stranger who signs correctly in this room', async () => {
    const game = await honestGame(18);
    const stranger = new Sender(identityFromByte(77));
    const t = assemble(game, [...game.messages, stranger.send({ type: 'GUESS', guess: '0123' })]);
    expect(t.guessCodes).toEqual(game.guesses);
    expect(t.ignored).toContain('message from a stranger');
  });

  it('drops an answer given by the wrong seat', async () => {
    const game = await honestGame(19);
    // Seat 0's first guess (index 0) must be answered by seat 1. Seat 0 answering itself is out of turn.
    const selfAnswer = game.senders[0].send({ type: 'ANSWER', index: 0, feedback: 40 });
    const t = assemble(game, [...game.messages, selfAnswer]);
    expect(t.answerValues).toEqual(game.claimed);
    expect(t.ignored.some((r) => r.includes('out of turn'))).toBe(true);
  });

  it('a guess out of turn cannot take over a slot: extra guesses by the same seat make a gap', async () => {
    const game = await honestGame(20);
    const extra = new Sender(game.identities[1], ROOM);
    extra.seq = 200;
    const tooMany = extra.send({ type: 'GUESS', guess: '0123' });
    const t = assemble(game, [...game.messages, tooMany]);
    expect(t.guessCodes).toEqual(game.guesses);
    expect(t.ignored.some((r) => r.includes('after a gap'))).toBe(true);
  });

  it('ignores guesses beyond twelve per seat', async () => {
    const rng = mulberry32(1);
    const game = await playGame({ secrets: ['4567', '8901'], rng, guessFor: neverHit });
    expect(game.guesses).toHaveLength(24);
    const spare = game.senders[0].send({ type: 'GUESS', guess: '0123' });
    const t = assemble(game, [...game.messages, spare]);
    expect(t.guesses).toHaveLength(24);
    expect(t.ignored.some((r) => r.includes('more than 12'))).toBe(true);
  });

  it('keeps answers only while they follow the guesses without a gap', async () => {
    const game = await honestGame(21);
    const firstAnswer = game.messages.findIndex((m) => m.type === 'ANSWER');
    const withGap = game.messages.filter((_, i) => i !== firstAnswer);
    const t = assemble(game, withGap);
    expect(t.answers).toHaveLength(0);
    expect(t.ignored).toContain('answers after a gap or without a guess');
  });

  it('notes guesses that come after a gap in the turn order', async () => {
    const game = await honestGame(22);
    const firstGuess = game.messages.findIndex((m) => m.type === 'GUESS');
    const t = assemble(
      game,
      game.messages.filter((_, i) => i !== firstGuess),
    );
    // Seat 0 lost its first guess, so seat 0's later guesses and all of seat 1's cannot be placed.
    expect(t.guesses.length).toBeLessThan(game.guesses.length);
    expect(t.ignored.some((r) => r.includes('after a gap'))).toBe(true);
  });
});

describe('equivocation is detected', () => {
  it('flags two different messages signed with the same seq', async () => {
    const game = await honestGame(23);
    const guessMessage = game.messages.find(
      (m) => m.type === 'GUESS' && m.from === game.identities[0].publicKey,
    ) as SignedMessage;
    const conflicting = signMessage(game.identities[0], {
      room: ROOM,
      seq: guessMessage.seq,
      body: { type: 'GUESS', guess: guessMessage.payload === '9876' ? '9875' : '9876' },
    });
    const t = assemble(game, [...game.messages, conflicting]);
    expect(t.equivocation).toEqual([true, false]);
  });

  it('is flagged the same way whichever message arrives first', async () => {
    const game = await honestGame(24);
    const original = game.messages.find(
      (m) => m.type === 'GUESS' && m.from === game.identities[0].publicKey,
    ) as SignedMessage;
    const conflicting = signMessage(game.identities[0], {
      room: ROOM,
      seq: original.seq,
      body: { type: 'GUESS', guess: original.payload === '9876' ? '9875' : '9876' },
    });
    const forward = assemble(game, [...game.messages, conflicting]);
    const backward = assemble(game, [conflicting, ...game.messages]);
    expect(forward).toEqual(backward);
  });

  it('flags two different answers to the same guess, and keeps the earlier one', async () => {
    const game = await honestGame(25);
    const answerIndex = game.messages.findIndex((m) => m.type === 'ANSWER');
    const original = game.messages[answerIndex] as SignedMessage;
    const liar = original.from === game.identities[0].publicKey ? 0 : 1;
    const second = game.senders[liar].send({
      type: 'ANSWER',
      index: 0,
      feedback: game.claimed[0] === 0 ? 1 : 0,
    });
    const t = assemble(game, [...game.messages, second]);
    expect(t.equivocation[liar]).toBe(true);
    expect(t.answerValues[0]).toBe(game.claimed[0]);
    expect(t.ignored.some((r) => r.includes('two answers'))).toBe(true);
  });

  it('does not flag an identical answer repeated under a new seq', async () => {
    const game = await honestGame(26);
    const original = game.messages.find((m) => m.type === 'ANSWER') as SignedMessage;
    const liar = original.from === game.identities[0].publicKey ? 0 : 1;
    const again = game.senders[liar].send({
      type: 'ANSWER',
      index: 0,
      feedback: game.claimed[0] as number,
    });
    const t = assemble(game, [...game.messages, again]);
    expect(t.equivocation).toEqual([false, false]);
  });

  it('ignores a second COMMIT announcement without calling it equivocation', async () => {
    const game = await honestGame(27);
    const second = game.senders[0].send({ type: 'COMMIT', txSig: fakeSig(99) });
    const t = assemble(game, [...game.messages, second]);
    expect(t.equivocation).toEqual([false, false]);
    expect(t.commits[0]?.payload).toBe(fakeSig(1));
    expect(t.ignored).toContain('extra COMMIT from seat 0');
  });
});
