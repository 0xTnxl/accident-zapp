import type { Feedback } from '@accident/engine';
import { decodeFeedback } from '@accident/engine';

export interface BoardRow {
  guess: string;
  /** The answer, or undefined while it is still being worked out. */
  feedback: Feedback | undefined;
}

interface BoardProps {
  rows: readonly BoardRow[];
  /** Shown above the list, for example "You" or "Computer". */
  title: string;
  emptyText?: string;
  /** Marks the last row as the newest. */
  highlightLast?: boolean;
}

export function Chips({ feedback }: { feedback: Feedback | undefined }) {
  if (feedback === undefined) {
    return <span className="text-sm text-ink-soft">waiting…</span>;
  }
  const { dead, injured } = decodeFeedback(feedback);
  return (
    <span className="flex items-center gap-1.5" aria-label={`${dead} dead, ${injured} injured`}>
      <span
        className={`inline-flex min-w-[3.1rem] items-center justify-center gap-1 rounded-full px-2 py-0.5 text-sm font-bold ${
          dead > 0 ? 'bg-dead text-paper' : 'bg-paper-deep text-ink-soft'
        }`}
      >
        {dead}
        <span className="text-xs font-semibold opacity-90">dead</span>
      </span>
      <span
        className={`inline-flex min-w-[3.6rem] items-center justify-center gap-1 rounded-full px-2 py-0.5 text-sm font-bold ${
          injured > 0 ? 'bg-injured text-paper' : 'bg-paper-deep text-ink-soft'
        }`}
      >
        {injured}
        <span className="text-xs font-semibold opacity-90">injured</span>
      </span>
    </span>
  );
}

/** A list of guesses with their answers, written like lines in an exercise book. */
export function Board({
  rows,
  title,
  emptyText = 'No guesses yet.',
  highlightLast = true,
}: BoardProps) {
  return (
    <section aria-label={title} className="min-h-0">
      <h2 className="mb-1 text-xs font-bold tracking-widest text-ink-soft uppercase">{title}</h2>
      {rows.length === 0 ? (
        <p className="py-2 text-sm text-ink-soft">{emptyText}</p>
      ) : (
        <ol className="flex flex-col">
          {rows.map((row, i) => (
            <li
              key={i}
              data-testid="board-row"
              className={`flex h-[1.9rem] items-center gap-3 ${
                highlightLast && i === rows.length - 1 ? 'font-bold' : ''
              }`}
            >
              <span className="w-5 text-right text-xs text-ink-soft">{i + 1}</span>
              <span className="font-mono text-xl tracking-[0.3em]">{row.guess}</span>
              <span className="ml-auto">
                <Chips feedback={row.feedback} />
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
