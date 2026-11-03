import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/Button.js';
import { Shell } from '../ui/Shell.js';
import type { Zend } from './appkit.js';
import type { BoardRow, LadderPlayer, Standing, Tournament } from './ladder.js';
import { Ladder, ratingLabel } from './ladder.js';

/** Remembers the tournament a game came from, so finishing it returns to the lobby. */
export const TOURNAMENT_KEY = 'accident:tournament';

export type LadderView =
  | { name: 'board' }
  | { name: 'tournaments' }
  | { name: 'create' }
  | { name: 'tournament'; id: string };

function Avatar({ p }: { p: LadderPlayer }) {
  return p.avatar ? (
    <img src={p.avatar} alt="" className="size-9 shrink-0 rounded-full object-cover" />
  ) : (
    <div className="grid size-9 shrink-0 place-items-center rounded-full bg-paper-deep font-bold">
      {p.name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
    load().then(setData, (e: unknown) => setError(e instanceof Error ? e.message : "That didn't load."));
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

function Status({ error }: { error: string | undefined }) {
  return <p className="py-6 text-ink-soft" role="status">{error ?? 'Loading…'}</p>;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

function minutesLeft(iso: string) {
  const m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
}

export function LadderRoot({
  zend,
  view,
  go,
  onBack,
}: {
  zend: Zend;
  view: LadderView;
  go: (v: LadderView) => void;
  onBack: () => void;
}) {
  const ladder = useMemo(() => new Ladder(zend), [zend]);
  if (view.name === 'board') return <Board ladder={ladder} onBack={onBack} />;
  if (view.name === 'tournaments') return <Tournaments ladder={ladder} go={go} onBack={onBack} />;
  if (view.name === 'create') return <Create ladder={ladder} go={go} />;
  return <Lobby ladder={ladder} id={view.id} go={go} />;
}

function Board({ ladder, onBack }: { ladder: Ladder; onBack: () => void }) {
  const { data, error } = useLoad(() => ladder.leaderboard(), [ladder]);
  return (
    <Shell title="Leaderboard" onBack={onBack}>
      {!data ? (
        <Status error={error} />
      ) : (
        <div className="flex flex-col gap-3 pb-6">
          {data.you ? (
            <div className="rounded-xl bg-paper-deep p-4">
              <p className="text-sm text-ink-soft">You</p>
              <p className="text-2xl font-bold">
                #{data.you.rank} · {ratingLabel(data.you)}
              </p>
            </div>
          ) : (
            <p className="text-ink-soft">Play a friend to get your rating. Everyone starts at 1500.</p>
          )}
          {data.players.length === 0 && <p className="text-ink-soft">No rated games yet. Be the first.</p>}
          <ol className="flex flex-col">
            {data.players.map((p: BoardRow) => (
              <li key={p.id} className="flex items-center gap-3 border-b border-rule py-2">
                <span className="w-8 text-right font-bold tabular-nums">{p.rank}</span>
                <Avatar p={p} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold">{p.name}</span>
                  <span className="text-sm text-ink-soft">
                    {p.wins}W {p.draws}D {p.losses}L
                  </span>
                </span>
                <span className="font-bold tabular-nums">{ratingLabel(p)}</span>
              </li>
            ))}
          </ol>
          <p className="text-sm text-ink-soft">
            Every rated game is checked against both players' records, so a result can't be faked. A ? means
            the rating is still settling.
          </p>
        </div>
      )}
    </Shell>
  );
}

function TournamentRow({ t, onOpen }: { t: Tournament; onOpen: () => void }) {
  const line =
    t.status === 'live'
      ? `Live · ${minutesLeft(t.endsAt)} left`
      : t.status === 'upcoming'
        ? `Starts ${when(t.startsAt)}`
        : 'Finished';
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 border-b border-rule py-3 text-left">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-bold">{t.name}</span>
        <span className="text-sm text-ink-soft">
          {line} · {t.players} {t.players === 1 ? 'player' : 'players'}
          {t.joined ? ' · You’re in' : ''}
        </span>
      </span>
      <span aria-hidden>›</span>
    </button>
  );
}

function Tournaments({ ladder, go, onBack }: { ladder: Ladder; go: (v: LadderView) => void; onBack: () => void }) {
  const { data, error } = useLoad(() => ladder.tournaments(), [ladder]);
  const open = (t: Tournament) => go({ name: 'tournament', id: t.id });
  return (
    <Shell title="Tournaments" onBack={onBack}>
      <div className="flex flex-col gap-4 pb-6">
        <Button onClick={() => go({ name: 'create' })}>Open a tournament</Button>
        {!data ? (
          <Status error={error} />
        ) : (
          <>
            {(['live', 'upcoming', 'finished'] as const).map((k) =>
              data[k].length === 0 ? null : (
                <section key={k}>
                  <h2 className="font-bold capitalize">{k === 'live' ? 'Live now' : k}</h2>
                  {data[k].map((t) => (
                    <TournamentRow key={t.id} t={t} onOpen={() => open(t)} />
                  ))}
                </section>
              ),
            )}
            {data.live.length + data.upcoming.length + data.finished.length === 0 && (
              <p className="text-ink-soft">No tournaments yet. Open one and invite your friends.</p>
            )}
          </>
        )}
      </div>
    </Shell>
  );
}

const STARTS = [
  { label: 'Now', minutes: 0 },
  { label: 'In 15 min', minutes: 15 },
  { label: 'In 1 hour', minutes: 60 },
];
const LENGTHS = [30, 60, 120];

function Create({ ladder, go }: { ladder: Ladder; go: (v: LadderView) => void }) {
  const [name, setName] = useState('');
  const [start, setStart] = useState(0);
  const [length, setLength] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const t = await ladder.create(name.trim(), start, length);
      go({ name: 'tournament', id: t.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't go through. Try again.");
      setBusy(false);
    }
  };
  const chip = (on: boolean) =>
    `rounded-full border-2 px-4 py-2 font-bold ${on ? 'border-ink bg-ink text-paper' : 'border-rule'}`;
  return (
    <Shell title="Open a tournament" onBack={() => go({ name: 'tournaments' })}>
      <div className="flex flex-col gap-5 pb-6">
        <label className="flex flex-col gap-1">
          <span className="font-bold">Name</span>
          <input
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            placeholder="Friday night Accident"
            className="rounded-xl border-2 border-rule bg-transparent px-4 py-3"
          />
        </label>
        <div className="flex flex-col gap-2">
          <span className="font-bold">Starts</span>
          <div className="flex flex-wrap gap-2">
            {STARTS.map((s) => (
              <button key={s.label} type="button" className={chip(start === s.minutes)} onClick={() => setStart(s.minutes)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <span className="font-bold">Runs for</span>
          <div className="flex flex-wrap gap-2">
            {LENGTHS.map((m) => (
              <button key={m} type="button" className={chip(length === m)} onClick={() => setLength(m)}>
                {m < 60 ? `${m} min` : `${m / 60} ${m === 60 ? 'hour' : 'hours'}`}
              </button>
            ))}
          </div>
        </div>
        <p className="text-sm text-ink-soft">
          While it runs, players are matched with whoever else is free. A win is 2 points, a draw 1. Most points
          at the end wins.
        </p>
        {error && <p className="text-dead">{error}</p>}
        <Button disabled={busy || name.trim().length < 3} onClick={() => void submit()}>
          {busy ? 'Opening…' : 'Open it'}
        </Button>
      </div>
    </Shell>
  );
}

function Lobby({ ladder, id, go }: { ladder: Ladder; id: string; go: (v: LadderView) => void }) {
  const { data, error, reload } = useLoad(() => ladder.tournament(id), [ladder, id]);
  const [looking, setLooking] = useState(false);
  const [note, setNote] = useState<string>();
  const t = data?.tournament;

  // Looking for a game: poll every few seconds. The server pairs two free players and makes the
  // game; both of us then get its id here and open it.
  useEffect(() => {
    if (!looking) return;
    let stop = false;
    const tick = async () => {
      while (!stop) {
        try {
          const r = await ladder.pair(id);
          if (r.status === 'playing' && r.game) {
            sessionStorage.setItem(TOURNAMENT_KEY, id);
            window.location.search = `?interaction=${encodeURIComponent(r.game)}`;
            return;
          }
          if (r.status === 'not_live') {
            setNote('This tournament isn’t running right now.');
            setLooking(false);
            return;
          }
        } catch {
          /* keep trying */
        }
        await new Promise((ok) => setTimeout(ok, 4000));
      }
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [looking, ladder, id]);

  // Standings refresh while the tournament is live.
  useEffect(() => {
    if (t?.status !== 'live') return;
    const timer = setInterval(reload, 15_000);
    return () => clearInterval(timer);
  }, [t?.status, reload]);

  const join = async () => {
    try {
      await ladder.join(id);
      reload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "That didn't go through.");
    }
  };
  const leave = async () => {
    setLooking(false);
    sessionStorage.removeItem(TOURNAMENT_KEY);
    await ladder.leave(id).catch(() => undefined);
    reload();
  };

  return (
    <Shell title={t?.name ?? 'Tournament'} onBack={() => go({ name: 'tournaments' })}>
      {!data || !t ? (
        <Status error={error} />
      ) : (
        <div className="flex flex-col gap-4 pb-6">
          <p className="text-ink-soft">
            {t.status === 'live'
              ? `Live · ${minutesLeft(t.endsAt)} left`
              : t.status === 'upcoming'
                ? `Starts ${when(t.startsAt)}`
                : 'Finished'}{' '}
            · opened by {t.openedBy.name}
          </p>
          {data.you && (
            <div className="rounded-xl bg-paper-deep p-4">
              <p className="text-sm text-ink-soft">You</p>
              <p className="text-2xl font-bold">
                #{data.you.rank} · {data.you.points} {data.you.points === 1 ? 'point' : 'points'}
              </p>
            </div>
          )}
          {note && <p className="text-dead">{note}</p>}
          {t.status !== 'finished' && !t.joined && <Button onClick={() => void join()}>Join</Button>}
          {t.status === 'live' && t.joined && (
            <Button onClick={() => setLooking((v) => !v)} tone={looking ? 'plain' : 'primary'}>
              {looking ? 'Looking for a player… tap to stop' : 'Find a game'}
            </Button>
          )}
          {t.status === 'upcoming' && t.joined && (
            <p className="text-ink-soft">You’re in. Come back when it starts to get matched.</p>
          )}
          <ol className="flex flex-col">
            {data.standings.map((s: Standing) => (
              <li key={s.player.id} className="flex items-center gap-3 border-b border-rule py-2">
                <span className="w-8 text-right font-bold tabular-nums">{s.rank}</span>
                <Avatar p={s.player} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold">{s.player.name}</span>
                  <span className="text-sm text-ink-soft">
                    {s.wins}W {s.draws}D {s.losses}L · {ratingLabel(s.player)}
                  </span>
                </span>
                <span className="font-bold tabular-nums">{s.points}</span>
              </li>
            ))}
          </ol>
          {t.joined && t.status !== 'finished' && (
            <Button tone="plain" onClick={() => void leave()}>
              {t.status === 'upcoming' ? 'Leave' : 'Stop playing'}
            </Button>
          )}
        </div>
      )}
    </Shell>
  );
}
