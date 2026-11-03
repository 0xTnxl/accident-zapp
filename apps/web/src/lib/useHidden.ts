import { useEffect, useState } from 'react';

/**
 * Whether the tab is currently hidden. A hidden tab cannot answer the opponent automatically, so
 * the friend board shows a warning. Returns false where there is no document (tests, SSR).
 */
export function useHidden(): boolean {
  const [hidden, setHidden] = useState(() =>
    typeof document === 'undefined' ? false : document.visibilityState === 'hidden',
  );
  useEffect(() => {
    const update = (): void => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', update);
    update();
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return hidden;
}
