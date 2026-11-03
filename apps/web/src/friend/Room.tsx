import type { SessionView } from '@accident/protocol';
import { useEffect, useState } from 'react';
import { faultText } from './faults.js';

export { faultText } from './faults.js';
import { useHidden } from '../lib/useHidden.js';
import { shareLink } from '../lib/route.js';
import { Board } from '../ui/Board.js';
import { CheckIcon } from '../ui/Icons.js';
import { Button } from '../ui/Button.js';
import { Keypad } from '../ui/Keypad.js';
import { Notepad } from '../ui/Notepad.js';
import { Shell } from '../ui/Shell.js';
import type { Backend } from './backend.js';
import type { Choice, SetupState } from './controller.js';
import { newChoice } from './controller.js';
import { copyText, shareText } from './copy.js';
import { QrCode } from './QrCode.js';
import { SimulationBanner } from './Lobby.js';

const seconds = (ms: number): number => Math.max(0, Math.ceil(ms / 1000));

export interface RoomProps {
  room: string;
  role: 'host' | 'guest';
  hostKey: string;
  backend: Backend;
  setup: SetupState;
  view: SessionView | undefined;
  /** True while a saved game is being looked for on this device. */
  resuming: boolean;
  origin: string;
  onBegin: (choice: Choice) => void;
  onGuess: (code: string) => void;
  onClaimTimeout: () => void;
  onRetry: () => void;
  onExport: () => void;
  onLeave: () => void;
  onRematch: () => void;
  /** Milliseconds, for countdowns. Injected so tests control time. */
  now: () => number;
}

/** The whole friend game screen. What it shows depends only on the setup state and the session view. */
export function Room(props: RoomProps) {
  const { view, resuming } = props;

  if (resuming) {
    return (
      <Shell title="Room" onBack={props.onLeave}>
        <p className="py-6 text-ink-soft">Looking for your game…</p>
      </Shell>
    );
  }
  if (!view) return <PickSecret {...props} />;
  switch (view.phase) {
    case 'connecting':
      return <Waiting {...props} view={view} />;
    case 'committing':
    case 'gate':
      return <Locking {...props} view={view} />;
    case 'playing':
      return <Playing {...props} view={view} />;
    case 'revealing':
      return <Revealing {...props} view={view} />;
    case 'final':
      return <Result {...props} view={view} />;
    case 'abandoned':
      return <Abandoned {...props} view={view} />;
    case 'closed':
      return (
        <Shell title="Room" onBack={props.onLeave}>
          <p className="py-6">This game was closed.</p>
        </Shell>
      );
  }
}

// ------------------------------------------------------------------------------------- pick secret

function PickSecret({ room, role, backend, setup, onBegin, onLeave }: RoomProps) {
  const [draft, setDraft] = useState('');
  const [choice, setChoice] = useState<Choice | undefined>();
  const busy = setup.step === 'funding';

  return (
    <Shell title={role === 'host' ? `Your room ${room}` : `Join room ${room}`} onBack={onLeave}>
      <div className="flex flex-1 flex-col gap-4 pb-2">
        {backend.kind === 'sim' ? <SimulationBanner /> : null}
        <p className="text-base">
          Pick your secret: <strong>four different digits</strong>. It stays on this phone until the
          game is over. Only a scrambled fingerprint of it goes on the public record.
        </p>
        {setup.step === 'funding-failed' ? (
          <p
            role="alert"
            className="rounded-xl border-2 border-dead bg-dead/5 p-3 text-sm text-dead"
          >
            Could not get test tokens for your game key: {setup.reason}. You can try again.
          </p>
        ) : null}
        <div className="mt-auto">
          <Keypad
            value={draft}
            onChange={setDraft}
            onSubmit={(secret) => {
              const next = choice?.secret === secret ? choice : newChoice(secret);
              setChoice(next);
              onBegin(next);
            }}
            submitLabel={
              busy
                ? 'Getting ready…'
                : role === 'host'
                  ? 'Lock it in and wait for a friend'
                  : 'Lock it in and join'
            }
            disabled={busy}
          />
        </div>
      </div>
    </Shell>
  );
}

// ------------------------------------------------------------------------------------- waiting

function Waiting({
  room,
  role,
  hostKey,
  origin,
  onLeave,
  backend,
}: RoomProps & { view: SessionView }) {
  const link = shareLink(origin, room, hostKey);
  const [copied, setCopied] = useState<'yes' | 'no' | undefined>();

  async function share(): Promise<void> {
    const shared = await shareText({
      title: 'Accident',
      text: `Play Accident with me. Room ${room}.`,
      url: link,
    });
    if (!shared) setCopied((await copyText(link)) ? 'yes' : 'no');
  }

  if (role === 'guest') {
    return (
      <Shell title={`Room ${room}`} onBack={onLeave}>
        <div className="flex flex-1 flex-col justify-center gap-3 text-center">
          <p className="text-lg font-bold">Finding the host…</p>
          <p className="text-sm text-ink-soft">
            Waiting for the person who made room <span className="font-mono">{room}</span>. If
            nothing happens, check the code or ask them to send a new link.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title={`Room ${room}`} onBack={onLeave}>
      <div className="flex flex-1 flex-col items-center gap-4 pt-2 text-center">
        {backend.kind === 'sim' ? <SimulationBanner /> : null}
        <p className="text-sm text-ink-soft">Tell your friend this code, or send the link.</p>
        <p className="font-mono text-5xl font-black tracking-[0.2em]" data-testid="room-code">
          {room}
        </p>
        <QrCode value={link} label={`QR code for the link to room ${room}`} />
        <div className="grid w-full gap-2">
          <Button onClick={() => void share()}>Share link</Button>
          <Button
            tone="plain"
            onClick={async () => setCopied((await copyText(link)) ? 'yes' : 'no')}
          >
            Copy link
          </Button>
          <p aria-live="polite" className="min-h-5 text-sm">
            {copied === 'yes' ? 'Link copied.' : null}
            {copied === 'no' ? (
              <span>
                Could not copy. Select it instead:{' '}
                <span className="font-mono break-all">{link}</span>
              </span>
            ) : null}
          </p>
        </div>
        <p className="mt-auto text-sm text-ink-soft" data-testid="waiting">
          Waiting for your friend to join…
        </p>
      </div>
    </Shell>
  );
}

// ------------------------------------------------------------------------------------- locking in

function Step({ done, active, children }: { done: boolean; active: boolean; children: string }) {
  return (
    <li
      className={`flex items-center gap-3 ${done ? 'text-good' : active ? 'font-bold' : 'text-ink-soft'}`}
    >
      <span
        className="grid size-6 place-items-center rounded-full border-2 text-sm"
        aria-hidden="true"
      >
        {done ? <CheckIcon /> : active ? '…' : ''}
      </span>
      <span>{children}</span>
      <span className="sr-only">{done ? 'done' : active ? 'in progress' : 'waiting'}</span>
    </li>
  );
}

function Locking({ view, backend, onRetry, onLeave }: RoomProps & { view: SessionView }) {
  const mine = view.myCommit;
  const peer = view.peerCommit;
  return (
    <Shell title="Locking in secrets" onBack={onLeave}>
      <div className="flex flex-1 flex-col gap-4 pt-2">
        {backend.kind === 'sim' ? <SimulationBanner /> : null}
        <p>
          Both secrets are locked in on {backend.kind === 'sim' ? 'the pretend chain' : backend.kind === 'zend' ? 'Zend' : 'Solana'}{' '}
          before anyone guesses, so nobody can pick theirs after seeing the other’s guesses.
        </p>
        <ol className="flex flex-col gap-3 text-base" aria-label="Progress">
          <Step done={view.peerKey !== undefined} active={view.peerKey === undefined}>
            Friend connected
          </Step>
          <Step done={mine === 'verified'} active={mine !== 'verified'}>
            Your secret locked in
          </Step>
          <Step done={peer === 'verified'} active={mine === 'verified' && peer !== 'verified'}>
            Friend’s secret locked in
          </Step>
        </ol>
        <ErrorNotice view={view} onRetry={onRetry} />
        <p className="mt-auto text-sm text-ink-soft" data-testid="gate-status">
          {backend.kind === 'zend' ? 'Locking in your secret…' : 'Waiting for the chain… this usually takes a few seconds.'}
        </p>
      </div>
    </Shell>
  );
}

function ErrorNotice({ view, onRetry }: { view: SessionView; onRetry: () => void }) {
  if (!view.error) return null;
  return (
    <div role="alert" className="rounded-xl border-2 border-dead bg-dead/5 p-3 text-sm">
      <p className="font-bold text-dead">Something went wrong</p>
      <p className="mt-1">{friendlyError(view.error.code, view.error.message)}</p>
      {view.error.retryable ? (
        <Button tone="danger" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Plain-language text for an error. The technical message is kept short and shown underneath. */
export function friendlyError(code: string, message: string): string {
  const lead =
    code === 'commit-failed'
      ? 'Your secret could not be locked in.'
      : code === 'reveal-failed'
        ? 'Your secret could not be revealed.'
        : 'Something unexpected happened.';
  return `${lead} (${message.slice(0, 120)})`;
}

// ------------------------------------------------------------------------------------- playing

function useCountdown(deadline: number | undefined, now: () => number): number | undefined {
  const [, tick] = useState(0);
  useEffect(() => {
    if (deadline === undefined) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [deadline]);
  return deadline === undefined ? undefined : Math.max(0, deadline - now());
}

function rowsOf(view: SessionView, seat: 0 | 1) {
  // Guess i is made by seat i % 2 and answered by the other seat.
  return view.guesses
    .map((guess, index) => ({ guess, index, feedback: view.answers[index] }))
    .filter(({ index }) => index % 2 === seat)
    .map(({ guess, feedback }) => ({ guess, feedback }));
}

function Playing(props: RoomProps & { view: SessionView }) {
  const { view, now, onGuess, onClaimTimeout, onRetry, onLeave, backend } = props;
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState<'mine' | 'theirs'>('mine');
  const left = useCountdown(view.onClock?.deadline, now);
  const mine = rowsOf(view, view.seat);
  const theirs = rowsOf(view, (1 - view.seat) as 0 | 1);
  const myTurn = view.canGuess;
  const waitingOnMe = view.onClock?.seat === view.seat;

  const status = myTurn
    ? 'Your turn'
    : waitingOnMe
      ? 'Answering…'
      : view.guesses.length > view.answers.length
        ? 'Waiting for your friend’s answer…'
        : 'Your friend is thinking…';

  return (
    <Shell
      wide
      title={`Room ${view.room}`}
      onBack={() => {
        if (window.confirm('Leave this game? You can come back to it on this phone.')) onLeave();
      }}
      right={<RelayDot relay={view.relay} />}
    >
      {backend.kind === 'sim' ? <SimulationBanner /> : null}
      <HiddenWarning />
      {/* Below the md breakpoint there is only room for one board, so a tab switches between them. */}
      <div
        role="tablist"
        aria-label="Guesses"
        className="mb-1 grid grid-cols-2 gap-1 text-sm font-bold md:hidden"
      >
        {(
          [
            ['mine', `You (${mine.length})`],
            ['theirs', `Friend (${theirs.length})`],
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

      <div className="min-h-0 flex-1 overflow-y-auto md:grid md:grid-cols-2 md:gap-6 md:overflow-visible">
        <div className={tab === 'mine' ? 'block' : 'hidden md:block'}>
          <Board
            title="Your guesses"
            rows={mine}
            emptyText={view.seat === 0 ? 'You guess first.' : 'Your friend guesses first.'}
          />
          <div className="mt-3">
            <Notepad />
          </div>
        </div>
        <div className={tab === 'theirs' ? 'block' : 'hidden md:block'}>
          <Board
            title="Friend’s guesses at your number"
            rows={theirs}
            emptyText="No guesses from your friend yet."
          />
        </div>
      </div>

      <div className="pt-2">
        <ErrorNotice view={view} onRetry={onRetry} />
        <p className="mb-2 text-center text-sm font-semibold" data-testid="turn">
          {status}
          {left !== undefined ? (
            <span
              className={`ml-2 font-mono ${left < 30_000 ? 'text-dead' : 'text-ink-soft'}`}
              data-testid="countdown"
            >
              {Math.floor(seconds(left) / 60)}:{String(seconds(left) % 60).padStart(2, '0')}
            </span>
          ) : null}
        </p>
        {view.timeoutClaimable ? (
          <Button tone="danger" className="mb-2" onClick={onClaimTimeout}>
            Your friend ran out of time: claim the win
          </Button>
        ) : null}
        <Keypad
          value={draft}
          onChange={setDraft}
          onSubmit={(code) => {
            setDraft('');
            onGuess(code);
          }}
          submitLabel="Guess"
          disabled={!myTurn}
        />
      </div>
    </Shell>
  );
}

function HiddenWarning() {
  const hidden = useHidden();
  if (!hidden) return null;
  return (
    <p
      role="alert"
      data-testid="hidden-warning"
      className="mb-2 rounded-xl border-2 border-dead bg-dead/5 p-2 text-center text-sm font-semibold text-dead"
    >
      Keep this tab open: your phone must stay awake to answer your friend.
    </p>
  );
}

function RelayDot({ relay }: { relay: 'up' | 'down' }) {
  return (
    <span
      role="status"
      aria-label={relay === 'up' ? 'Connected' : 'Reconnecting'}
      title={relay === 'up' ? 'Connected' : 'Reconnecting…'}
      className={`mr-1 inline-flex items-center gap-1 text-xs font-semibold ${relay === 'up' ? 'text-good' : 'text-dead'}`}
    >
      <span
        className={`size-2.5 rounded-full ${relay === 'up' ? 'bg-good' : 'animate-pulse bg-dead'}`}
      />
      {relay === 'up' ? 'Live' : 'Offline'}
    </span>
  );
}

// ------------------------------------------------------------------------------------- after the game

function Revealing({ view, onRetry, onLeave }: RoomProps & { view: SessionView }) {
  return (
    <Shell title="Checking the game" onBack={onLeave}>
      <div className="flex flex-1 flex-col gap-4 pt-2">
        <p className="text-lg font-bold">The game is over.</p>
        <p>
          Both players now reveal their secrets so anyone can check every answer was honest.
        </p>
        <ol className="flex flex-col gap-3" aria-label="Progress">
          <Step done={view.myReveal === 'sent'} active={view.myReveal !== 'sent'}>
            Your secret revealed
          </Step>
          <Step
            done={view.peerReveal === 'verified'}
            active={view.myReveal === 'sent' && view.peerReveal !== 'verified'}
          >
            Friend’s secret revealed
          </Step>
        </ol>
        <ErrorNotice view={view} onRetry={onRetry} />
        <p className="mt-auto text-sm text-ink-soft" data-testid="reveal-status">
          If your friend never reveals, they lose after a few minutes.
        </p>
      </div>
    </Shell>
  );
}

function Result(props: RoomProps & { view: SessionView }) {
  const { view, backend, onExport, onRematch, onLeave } = props;
  const verdict = view.verdict;

  if (view.outcome === 'timeout-win') {
    return (
      <Shell title="You win" onBack={onLeave}>
        <div className="flex flex-1 flex-col justify-center gap-3 text-center">
          <h2 className="text-3xl font-black text-good" data-testid="result">
            You win by timeout
          </h2>
          <p className="text-sm text-ink-soft">
            Your friend stopped responding. Timeouts are a convention in this app.
          </p>
          <Button onClick={onRematch}>New game</Button>
          <Button tone="plain" onClick={onLeave}>
            Home
          </Button>
        </div>
      </Shell>
    );
  }
  if (verdict?.kind !== 'final') return <Revealing {...props} />;

  const me = view.seat;
  const headline =
    verdict.result === 'draw'
      ? 'A draw'
      : verdict.result === (me === 0 ? 'seat0' : 'seat1')
        ? 'You win!'
        : 'Your friend wins';
  const tone =
    headline === 'You win!' ? 'text-good' : headline === 'A draw' ? 'text-ink' : 'text-dead';
  const myFaults = verdict.faults.filter((f) => f.seat === me);
  const theirFaults = verdict.faults.filter((f) => f.seat !== me);
  const [mySecret, theirSecret] =
    me === 0 ? verdict.verifiedSecrets : [verdict.verifiedSecrets[1], verdict.verifiedSecrets[0]];

  const links: Array<[string, string | undefined]> = [
    ['Your lock-in', view.records.mine.commit],
    ['Your reveal', view.records.mine.reveal],
    ['Friend’s lock-in', view.records.peer.commit],
    ['Friend’s reveal', view.records.peer.reveal],
  ];

  return (
    <Shell title="Result" onBack={onLeave}>
      <div className="flex-1 space-y-4 overflow-y-auto pt-1 pb-3">
        {backend.kind === 'sim' ? <SimulationBanner /> : null}
        <h2 className={`text-center text-3xl font-black ${tone}`} data-testid="result">
          {headline}
        </h2>

        <section className="grid grid-cols-2 gap-2 text-center" aria-label="Secrets">
          {[
            ['Your number', mySecret],
            ['Friend’s number', theirSecret],
          ].map(([label, secret]) => (
            <div key={label} className="rounded-xl border-2 border-rule p-2">
              <p className="text-xs text-ink-soft">{label}</p>
              <p className="font-mono text-2xl font-bold">{secret ?? '????'}</p>
              <p
                className={`flex items-center justify-center gap-1 text-xs font-semibold ${secret ? 'text-good' : 'text-dead'}`}
              >
                {secret ? <CheckIcon className="size-3.5" /> : null}
                {secret ? 'Checked against the lock-in' : 'Not verified'}
              </p>
            </div>
          ))}
        </section>

        {verdict.reason === 'cap' ? (
          <p className="text-center text-sm text-ink-soft">
            Nobody found the other’s number in 12 guesses each.
          </p>
        ) : null}

        {myFaults.length + theirFaults.length > 0 ? (
          <section
            aria-label="What the record shows"
            className="rounded-xl border-2 border-dead bg-dead/5 p-3 text-sm"
          >
            <h3 className="font-bold text-dead">The record shows a problem</h3>
            <ul className="mt-1 list-disc pl-5">
              {myFaults.map((f, i) => (
                <li key={`m${i}`}>
                  <strong>You:</strong> {faultText(f)}
                </li>
              ))}
              {theirFaults.map((f, i) => (
                <li key={`t${i}`}>
                  <strong>Friend:</strong> {faultText(f)}
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <p className="text-center text-sm text-good">
            Every answer matched the revealed secrets.
          </p>
        )}

        <section aria-label="Public records">
          <h3 className="text-xs font-bold tracking-widest text-ink-soft uppercase">
            Public records
          </h3>
          <ul className="mt-1 space-y-1">
            {links.map(([label, sig]) => {
              const url = sig ? backend.explorerUrl(sig) : undefined;
              return (
                <li key={label} className="flex items-center justify-between gap-2 text-sm">
                  <span>{label}</span>
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="font-mono underline"
                    >
                      {sig?.slice(0, 6)}…{sig?.slice(-4)}
                    </a>
                  ) : (
                    <span className="font-mono text-ink-soft">
                      {sig ? `${sig.slice(0, 6)}… (simulated)` : 'none'}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <div className="grid gap-2">
        <Button onClick={onRematch}>Play again</Button>
        <Button tone="plain" onClick={onExport}>
          Save the signed record
        </Button>
        <Button tone="plain" onClick={onLeave}>
          Home
        </Button>
      </div>
    </Shell>
  );
}

function Abandoned({ view, onRematch, onLeave }: RoomProps & { view: SessionView }) {
  const reason =
    view.abandonReason ??
    (view.verdict?.kind === 'abandoned'
      ? 'Neither player revealed, so there is nothing to judge.'
      : 'The game ended early.');
  return (
    <Shell title="Game ended" onBack={onLeave}>
      <div className="flex flex-1 flex-col justify-center gap-3 text-center">
        <h2 className="text-2xl font-black" data-testid="result">
          No result
        </h2>
        <p className="text-ink-soft">{reason}</p>
        <Button onClick={onRematch}>Try again</Button>
        <Button tone="plain" onClick={onLeave}>
          Home
        </Button>
      </div>
    </Shell>
  );
}
