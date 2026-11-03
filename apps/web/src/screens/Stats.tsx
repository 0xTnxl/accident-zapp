import { LEVELS } from '@accident/engine';
import { averageGuesses, loadStats } from '../lib/stats.js';
import { Shell } from '../ui/Shell.js';

const NAMES = { easy: 'Easy', medium: 'Medium', hard: 'Expert' } as const;

export function Stats({ onBack }: { onBack: () => void }) {
  const stats = loadStats();
  const total = LEVELS.reduce((n, l) => n + stats[l].played, 0);
  return (
    <Shell title="My stats" onBack={onBack}>
      {total === 0 ? (
        <p className="py-6 text-ink-soft">
          No games yet. Play the computer and your record appears here.
        </p>
      ) : (
        <div className="space-y-4 pt-2">
          {LEVELS.map((level) => {
            const s = stats[level];
            const avg = averageGuesses(s);
            return (
              <section
                key={level}
                aria-label={NAMES[level]}
                className="rounded-xl border-2 border-rule p-3"
              >
                <h2 className="font-bold">{NAMES[level]}</h2>
                <dl className="mt-1 grid grid-cols-4 gap-2 text-center">
                  {(
                    [
                      ['Played', s.played],
                      ['Won', s.won],
                      ['Lost', s.lost],
                      ['Drawn', s.drawn],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs text-ink-soft">{label}</dt>
                      <dd className="font-mono text-xl font-bold">{value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-1 text-sm text-ink-soft">
                  {avg === undefined
                    ? 'No wins yet.'
                    : `Average ${avg.toFixed(1)} guesses in games you won.`}
                </p>
              </section>
            );
          })}
          <p className="text-xs text-ink-soft">Kept on this device only.</p>
        </div>
      )}
    </Shell>
  );
}
