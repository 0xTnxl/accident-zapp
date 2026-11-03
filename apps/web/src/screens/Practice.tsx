import type { Level } from '@accident/engine';
import { decodeFeedback, randomCode, secureRng } from '@accident/engine';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ComputerPlayer } from '../practice/computer.js';
import { createComputer } from '../practice/createComputer.js';
import type { PracticeGame } from '../practice/game.js';
import {
  computerGuess,
  computerHistory,
  computerRows,
  newPracticeGame,
  playerGuess,
  playerRows,
  resultOf,
  turnOf,
} from '../practice/game.js';
import { analytics } from '../lib/analytics.js';
import { loadStats, recordGame, saveStats } from '../lib/stats.js';
import { Board } from '../ui/Board.js';
import { Button } from '../ui/Button.js';
import { Keypad } from '../ui/Keypad.js';
import { Notepad } from '../ui/Notepad.js';
import { Shell } from '../ui/Shell.js';

const LEVEL_NAMES: Record<Level, string> = { easy: 'Easy', medium: 'Medium', hard: 'Expert' };
const LEVEL_HINT: Record<Level, string> = {
  easy: 'Makes mistakes',
  medium: 'A fair match',
  hard: 'Very hard to beat',
};

/** How long the computer “thinks” at least, so its answer does not feel instant and robotic. */
const MIN_THINK_MS = 600;

type Stage = 'setup' | 'play';

interface State {
  stage: Stage;
  level: Level;
  draft: string;
  game: PracticeGame | undefined;
}

type Action =
  | { type: 'level'; level: Level }
  | { type: 'draft'; value: string }
  | { type: 'start'; game: PracticeGame }
  | { type: 'game'; game: PracticeGame }
  | { type: 'again' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'level':
      return { ...state, level: action.level };
    case 'draft':
      return { ...state, draft: action.value };
    case 'start':
      return { ...state, stage: 'play', game: action.game, draft: '' };
    case 'game':
      return { ...state, game: action.game };
    case 'again':
      return { ...state, stage: 'setup', game: undefined, draft: '' };
  }
}

interface PracticeProps {
  onBack: () => void;
  /** Supplies the computer. Tests pass a fast fake. */
  makeComputer?: () => ComputerPlayer;
  /** Supplies randomness. Tests pass a fixed one. */
  rng?: () => number;
  thinkMs?: number;
}

export function Practice({
  onBack,
  makeComputer = createComputer,
  rng,
  thinkMs = MIN_THINK_MS,
}: PracticeProps) {
  const [state, dispatch] = useReducer(reducer, {
    stage: 'setup',
    level: 'medium',
    draft: '',
    game: undefined,
  });
  const [thinking, setThinking] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [tab, setTab] = useState<'mine' | 'theirs'>('mine');
  const computer = useRef<ComputerPlayer | undefined>(undefined);
  const recorded = useRef<PracticeGame | undefined>(undefined);

  // One computer for the life of the screen, however the caller builds it. Reading the factory from
  // a ref keeps a new inline function on every render from tearing the computer down mid-move.
  const factory = useRef(makeComputer);
  factory.current = makeComputer;
  useEffect(() => {
    computer.current = factory.current();
    return () => {
      computer.current?.dispose();
      computer.current = undefined;
    };
  }, []);

  const { game, level } = state;

  // The computer's move. The token guards against a reply arriving after the game was abandoned.
  useEffect(() => {
    if (!game || turnOf(game) !== 'computer') return;
    let cancelled = false;
    setThinking(true);
    const started = Date.now();
    void (async () => {
      try {
        const guess = await computer.current?.choose(level, computerHistory(game));
        if (guess === undefined || cancelled) return;
        const wait = Math.max(0, thinkMs - (Date.now() - started));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (cancelled) return;
        const next = computerGuess(game, guess);
        const answer = decodeFeedback(next.answers[next.answers.length - 1] as number);
        setAnnouncement(
          `Computer guessed ${guess}: ${answer.dead} dead, ${answer.injured} injured.`,
        );
        dispatch({ type: 'game', game: next });
      } catch {
        // The computer was stopped while thinking (the player left). Nothing to do.
      } finally {
        if (!cancelled) setThinking(false);
      }
    })();
    return () => {
      cancelled = true;
      setThinking(false);
    };
  }, [game, level, thinkMs]);

  // Record a finished game once.
  const result = game ? resultOf(game) : undefined;
  useEffect(() => {
    if (!game || !result || recorded.current === game) return;
    recorded.current = game;
    const guesses = playerRows(game).length;
    saveStats(recordGame(loadStats(), game.level, result, guesses));
    analytics().send({ name: 'cpu_game_end', level: game.level, result, guesses });
  }, [game, result]);

  const begin = useCallback(
    (secret: string) => {
      dispatch({ type: 'start', game: newPracticeGame(level, secret, rng ?? secureRng()) });
      setTab('mine');
      setAnnouncement('');
      analytics().send({ name: 'cpu_game_start', level });
    },
    [level, rng],
  );

  const guess = useCallback(
    (code: string) => {
      if (!game || turnOf(game) !== 'player') return;
      const next = playerGuess(game, code);
      const answer = decodeFeedback(next.answers[next.answers.length - 1] as number);
      setAnnouncement(`You guessed ${code}: ${answer.dead} dead, ${answer.injured} injured.`);
      dispatch({ type: 'game', game: next });
      dispatch({ type: 'draft', value: '' });
      setTab('mine');
    },
    [game],
  );

  if (state.stage === 'setup' || !game) {
    return (
      <Shell title="Play the computer" onBack={onBack}>
        <div className="flex flex-1 flex-col gap-5 pb-2">
          <fieldset>
            <legend className="mb-2 text-xs font-bold tracking-widest text-ink-soft uppercase">
              Difficulty
            </legend>
            <div className="grid grid-cols-3 gap-2">
              {(['easy', 'medium', 'hard'] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={level === l}
                  onClick={() => dispatch({ type: 'level', level: l })}
                  className={`flex min-h-16 flex-col items-center justify-center rounded-xl border-2 px-1 py-2 ${
                    level === l ? 'border-ink bg-ink text-paper' : 'border-ink bg-paper'
                  }`}
                >
                  <span className="font-bold">{LEVEL_NAMES[l]}</span>
                  <span className="text-[0.7rem] opacity-80">{LEVEL_HINT[l]}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-1 flex-col justify-end gap-3">
            <p className="text-center text-base">
              Pick your secret: <strong>four different digits</strong>
            </p>
            <Keypad
              value={state.draft}
              onChange={(value) => dispatch({ type: 'draft', value })}
              onSubmit={begin}
              submitLabel="Start"
            />
            <Button
              tone="plain"
              onClick={() => begin(randomCode(rng ?? secureRng()))}
              className="text-sm"
            >
              Pick one for me
            </Button>
          </div>
        </div>
      </Shell>
    );
  }

  const mine = playerRows(game);
  const theirs = computerRows(game);
  const yourTurn = turnOf(game) === 'player';

  return (
    <Shell
      wide
      title={`${LEVEL_NAMES[game.level]} · you vs computer`}
      onBack={() => {
        if (!result && !window.confirm('Leave this game? It will not be saved.')) return;
        onBack();
      }}
    >
      <p className="sr-only" aria-live="polite" data-testid="announcer">
        {announcement}
      </p>

      {/* Below the md breakpoint there is only room for one board, so a tab switches between them. */}
      <div
        role="tablist"
        aria-label="Guesses"
        className="mb-1 grid grid-cols-2 gap-1 text-sm font-bold md:hidden"
      >
        {(
          [
            ['mine', `You (${mine.length})`],
            ['theirs', `Computer (${theirs.length})`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`min-h-11 rounded-lg px-2 ${tab === id ? 'bg-ink text-paper' : 'bg-paper-deep'}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto md:grid md:grid-cols-2 md:gap-6 md:overflow-visible"
        data-testid="boards"
      >
        <div className={tab === 'mine' ? 'block' : 'hidden md:block'}>
          <Board title="You" rows={mine} emptyText="Make your first guess below." />
          <div className="mt-3">
            <Notepad />
          </div>
        </div>
        <div className={tab === 'theirs' ? 'block' : 'hidden md:block'}>
          <Board
            title="Computer, guessing your number"
            rows={theirs}
            emptyText="The computer has not guessed yet."
          />
        </div>
      </div>

      {result ? (
        <Finished
          game={game}
          result={result}
          onAgain={() => dispatch({ type: 'again' })}
          onHome={onBack}
        />
      ) : (
        <div className="pt-2">
          <p className="mb-2 text-center text-sm font-semibold" data-testid="turn">
            {yourTurn ? 'Your turn' : thinking ? 'Computer is thinking…' : 'Computer’s turn'}
            <span className="ml-2 text-ink-soft">
              · your number <span className="font-mono">{game.playerSecret}</span>
            </span>
          </p>
          <Keypad
            value={state.draft}
            onChange={(value) => dispatch({ type: 'draft', value })}
            onSubmit={guess}
            submitLabel="Guess"
            disabled={!yourTurn}
          />
        </div>
      )}
    </Shell>
  );
}

function Finished({
  game,
  result,
  onAgain,
  onHome,
}: {
  game: PracticeGame;
  result: 'win' | 'loss' | 'draw';
  onAgain: () => void;
  onHome: () => void;
}) {
  const headline = { win: 'You win!', loss: 'The computer wins', draw: 'A draw' }[result];
  const tone = { win: 'text-good', loss: 'text-dead', draw: 'text-ink' }[result];
  return (
    <section
      aria-label="Result"
      className="rounded-2xl border-2 border-ink bg-paper p-4 text-center"
    >
      <h2 className={`text-2xl font-black ${tone}`} data-testid="result">
        {headline}
      </h2>
      <p className="mt-1 text-sm">
        Computer’s number: <span className="font-mono font-bold">{game.computerSecret}</span>
      </p>
      <p className="text-sm text-ink-soft">
        {playerRows(game).length} guesses by you. Practice games are not provably fair.
      </p>
      <div className="mt-3 grid gap-2">
        <Button onClick={onAgain}>Play again</Button>
        <Button tone="plain" onClick={onHome}>
          Home
        </Button>
      </div>
    </section>
  );
}
