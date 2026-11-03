import type { ReactNode } from 'react';
import { useState } from 'react';
import { CheckIcon, CrossIcon, QuestionIcon } from './Icons.js';

type Mark = '' | 'yes' | 'no' | 'maybe';

const NEXT: Record<Mark, Mark> = { '': 'no', no: 'yes', yes: 'maybe', maybe: '' };
const SYMBOL: Record<Mark, ReactNode> = {
  '': null,
  no: <CrossIcon className="size-3" />,
  yes: <CheckIcon className="size-3" />,
  maybe: <QuestionIcon className="size-3" />,
};
const LABEL: Record<Mark, string> = {
  '': 'unmarked',
  no: 'ruled out',
  yes: 'in the code',
  maybe: 'maybe',
};

/** A scrap of paper for keeping track of digits, as players do with a pencil. Purely for the player. */
export function Notepad() {
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  return (
    <section aria-label="Notepad" className="rounded-xl border-2 border-dashed border-rule p-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold tracking-widest text-ink-soft uppercase">Notepad</h2>
        <button
          type="button"
          onClick={() => setMarks({})}
          className="px-2 py-1 text-xs font-semibold text-ink-soft underline"
        >
          Clear
        </button>
      </div>
      <div className="mt-1 grid grid-cols-10 gap-1">
        {'0123456789'.split('').map((digit) => {
          const mark = marks[digit] ?? '';
          return (
            <button
              key={digit}
              type="button"
              onClick={() => setMarks((m) => ({ ...m, [digit]: NEXT[m[digit] ?? ''] }))}
              aria-label={`Digit ${digit}: ${LABEL[mark]}. Tap to change.`}
              className={`flex aspect-[3/4] flex-col items-center justify-center rounded-md border font-mono text-sm leading-none ${
                mark === 'no'
                  ? 'border-rule text-rule'
                  : mark === 'yes'
                    ? 'border-good bg-good/10 text-good'
                    : 'border-ink/40'
              }`}
            >
              <span className={mark === 'no' ? 'line-through' : ''}>{digit}</span>
              <span className="grid h-3 place-items-center">{SYMBOL[mark]}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
