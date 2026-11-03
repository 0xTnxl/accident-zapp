import { isValidRoom } from '@accident/protocol';

/** Every screen the app can show, parsed from the URL. */
export type Route =
  | { name: 'home' }
  | { name: 'how' }
  | { name: 'stats' }
  | { name: 'practice' }
  | { name: 'friend' }
  /** The Verifier: check a finished game from its transcript and the two reveal signatures. */
  | { name: 'verify' }
  /** A friend game. The host made the room; a guest arrived from a link or typed the code. */
  | { name: 'room'; code: string; role: 'host' | 'guest'; hostKey: string | undefined }
  | { name: 'notfound' };

/**
 * Reads a URL into a route.
 *
 * - `/r/ABC234` is a guest joining. The share link is `/r/ABC234#<host key>`, so the host's public
 *   key travels in the fragment, which browsers never send to any server.
 * - `/r/ABC234?host` is the host's own view of the room it created.
 */
export function parseRoute(pathname: string, search = '', hash = ''): Route {
  const path = pathname.replace(/\/+$/, '') || '/';
  switch (path) {
    case '/':
      return { name: 'home' };
    case '/how':
      return { name: 'how' };
    case '/stats':
      return { name: 'stats' };
    case '/practice':
      return { name: 'practice' };
    case '/friend':
      return { name: 'friend' };
    case '/verify':
      return { name: 'verify' };
  }
  const match = /^\/r\/([^/]+)$/.exec(path);
  if (match) {
    let code: string;
    try {
      code = decodeURIComponent(match[1] as string).toUpperCase();
    } catch {
      // A link mangled in transit, such as a truncated percent escape, must not crash the app.
      return { name: 'notfound' };
    }
    if (!isValidRoom(code)) return { name: 'notfound' };
    const host = new URLSearchParams(search).has('host');
    const key = hash.replace(/^#/, '');
    return {
      name: 'room',
      code,
      role: host ? 'host' : 'guest',
      hostKey: key.length > 0 ? key : undefined,
    };
  }
  return { name: 'notfound' };
}

/** The URL for a route: the inverse of {@link parseRoute}. */
export function routePath(route: Route): string {
  switch (route.name) {
    case 'home':
      return '/';
    case 'how':
      return '/how';
    case 'stats':
      return '/stats';
    case 'practice':
      return '/practice';
    case 'friend':
      return '/friend';
    case 'verify':
      return '/verify';
    case 'room':
      return route.role === 'host'
        ? `/r/${route.code}?host`
        : `/r/${route.code}${route.hostKey ? `#${route.hostKey}` : ''}`;
    case 'notfound':
      return '/';
  }
}

/** The link a host shares. It carries the host's key so the guest can tell the real host apart. */
export function shareLink(origin: string, code: string, hostKey: string): string {
  return `${origin}/r/${code}#${hostKey}`;
}
