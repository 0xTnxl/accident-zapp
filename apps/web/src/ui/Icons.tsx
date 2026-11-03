/**
 * Icons drawn as SVG. Characters such as ✓ ✕ ⌫ are missing from many phone fonts and show up as an
 * empty box, which on a number pad or a verdict is not acceptable.
 */
const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 3,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

export function CheckIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

export function CrossIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

export function QuestionIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M9 9a3 3 0 1 1 4.2 2.7c-.8.4-1.2 1-1.2 1.8" />
      <path d="M12 18h.01" />
    </svg>
  );
}
