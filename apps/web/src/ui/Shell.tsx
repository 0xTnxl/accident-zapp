import type { ReactNode } from 'react';

interface ShellProps {
  title?: string;
  /** Where the back arrow goes. Omit on the home screen. */
  onBack?: () => void;
  right?: ReactNode;
  children: ReactNode;
  /**
   * Lets a screen grow beyond the usual phone-width column on larger screens, for layouts that
   * put two boards side by side. Most screens leave this unset.
   */
  wide?: boolean;
}

/** The page frame: a slim header and a scrolling body that leaves room for the margin line. */
export function Shell({ title, onBack, right, children, wide = false }: ShellProps) {
  return (
    <div className={`mx-auto flex h-full flex-col ${wide ? 'max-w-md md:max-w-4xl' : 'max-w-md'}`}>
      <header className="flex items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2 pl-12">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="-ml-10 grid size-11 place-items-center rounded-full text-ink active:bg-paper-deep"
          >
            <svg
              viewBox="0 0 24 24"
              className="size-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m15 5-7 7 7 7" />
            </svg>
          </button>
        ) : null}
        <h1 className="flex-1 truncate text-lg font-bold tracking-tight">{title ?? 'Accident'}</h1>
        {right}
      </header>
      <main className="flex min-h-0 flex-1 flex-col px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pl-12">
        {children}
      </main>
    </div>
  );
}
