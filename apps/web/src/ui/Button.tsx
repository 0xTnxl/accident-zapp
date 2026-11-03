import type { ButtonHTMLAttributes } from 'react';

type Tone = 'primary' | 'plain' | 'danger';

const TONES: Record<Tone, string> = {
  primary: 'bg-ink text-paper active:bg-ink-soft disabled:bg-rule disabled:text-ink-soft',
  plain:
    'border-2 border-ink bg-transparent text-ink active:bg-paper-deep disabled:border-rule disabled:text-ink-soft',
  danger: 'bg-dead text-paper active:opacity-80 disabled:opacity-40',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: Tone;
  block?: boolean;
}

export function Button({ tone = 'primary', block = true, className = '', ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={`${block ? 'w-full' : ''} min-h-12 rounded-xl px-5 py-3 text-base font-bold transition-colors disabled:cursor-not-allowed ${TONES[tone]} ${className}`}
    />
  );
}
