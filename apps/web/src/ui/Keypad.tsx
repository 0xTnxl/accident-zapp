import { useEffect } from 'react';

interface KeypadProps {
  /** The digits entered so far, up to four, with no repeats. */
  value: string;
  onChange: (value: string) => void;
  /** Called when four digits are confirmed. */
  onSubmit: (value: string) => void;
  submitLabel: string;
  disabled?: boolean;
  /** Digits to show as already ruled out, for the player's own notes. */
  dim?: ReadonlySet<string>;
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const;

/** Adds a digit, ignoring repeats and anything past four. */
export function addDigit(value: string, digit: string): string {
  if (value.length >= 4 || value.includes(digit) || !/^[0-9]$/.test(digit)) return value;
  return value + digit;
}

export function removeDigit(value: string): string {
  return value.slice(0, -1);
}

/**
 * Four slots and ten digit buttons. A digit already used is disabled, because a code never repeats
 * a digit, so a wrong entry is impossible rather than reported after the fact. Hardware keys work
 * too: digits, Backspace and Enter.
 */
export function Keypad({
  value,
  onChange,
  onSubmit,
  submitLabel,
  disabled = false,
  dim,
}: KeypadProps) {
  useEffect(() => {
    if (disabled) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (/^[0-9]$/.test(event.key)) onChange(addDigit(value, event.key));
      else if (event.key === 'Backspace') onChange(removeDigit(value));
      else if (event.key === 'Enter' && value.length === 4) onSubmit(value);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [disabled, onChange, onSubmit, value]);

  return (
    <div className="flex flex-col gap-3">
      <div
        role="group"
        aria-label={`Your code: ${value.length === 0 ? 'empty' : value.split('').join(' ')}`}
        className="flex justify-center gap-2"
      >
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            data-testid={`slot-${i}`}
            className={`grid size-14 place-items-center rounded-lg border-2 font-mono text-3xl font-bold ${
              value[i] ? 'border-ink bg-paper' : 'border-rule bg-paper-deep/60'
            }`}
          >
            {value[i] ?? ''}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-2">
        {DIGITS.map((digit) => {
          const used = value.includes(digit);
          return (
            <button
              key={digit}
              type="button"
              disabled={disabled || used || value.length >= 4}
              onClick={() => onChange(addDigit(value, digit))}
              aria-label={digit}
              className={`grid h-14 place-items-center rounded-xl border-2 font-mono text-2xl font-bold transition-colors ${
                used
                  ? 'border-rule bg-paper-deep text-rule'
                  : dim?.has(digit)
                    ? 'border-rule bg-paper text-ink-soft line-through active:bg-paper-deep'
                    : 'border-ink bg-paper text-ink active:bg-paper-deep'
              } disabled:cursor-not-allowed`}
            >
              {digit}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-[1fr_2fr] gap-2">
        <button
          type="button"
          disabled={disabled || value.length === 0}
          onClick={() => onChange(removeDigit(value))}
          aria-label="Delete last digit"
          className="grid min-h-12 place-items-center rounded-xl border-2 border-ink active:bg-paper-deep disabled:border-rule disabled:text-rule"
        >
          {/* An SVG, not the ⌫ character: many phone fonts have no glyph for it and show a box. */}
          <svg
            viewBox="0 0 24 24"
            className="size-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7z" />
            <path d="m13 10 5 5m0-5-5 5" />
          </svg>
        </button>
        <button
          type="button"
          disabled={disabled || value.length !== 4}
          onClick={() => onSubmit(value)}
          className="min-h-12 rounded-xl bg-ink px-4 text-base font-bold text-paper active:bg-ink-soft disabled:bg-rule disabled:text-ink-soft"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
