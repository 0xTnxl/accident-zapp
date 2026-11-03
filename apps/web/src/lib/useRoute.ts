import { useCallback, useEffect, useState } from 'react';
import type { Route } from './route.js';
import { parseRoute, routePath } from './route.js';

/** Adds `as=player` to a path, keeping any query it already has. */
export function withPlayer(path: string, player: string | null): string {
  if (!player) return path;
  const [beforeHash = '', hash] = path.split('#');
  const [pathname = '', query] = beforeHash.split('?');
  const params = new URLSearchParams(query ?? '');
  params.set('as', player);
  return `${pathname}?${params.toString()}${hash === undefined ? '' : `#${hash}`}`;
}

function current(): Route {
  return parseRoute(window.location.pathname, window.location.search, window.location.hash);
}

/** The current route and a way to move to another one without reloading the page. */
export function useRoute(): [Route, (route: Route, options?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState<Route>(current);

  useEffect(() => {
    const onChange = (): void => setRoute(current());
    window.addEventListener('popstate', onChange);
    return () => window.removeEventListener('popstate', onChange);
  }, []);

  const go = useCallback((next: Route, options?: { replace?: boolean }) => {
    // Carry the simulation's `?as=player` across screens, or a tab would quietly change player.
    const as = new URLSearchParams(window.location.search).get('as');
    const path = withPlayer(routePath(next), as);
    if (options?.replace) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
    setRoute(current());
    window.scrollTo?.(0, 0);
  }, []);

  return [route, go];
}
