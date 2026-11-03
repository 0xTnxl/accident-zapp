import { describe, expect, it } from 'vitest';
import type { Route } from '../src/lib/route.js';
import { parseRoute, routePath, shareLink } from '../src/lib/route.js';
import { withPlayer } from '../src/lib/useRoute.js';

const KEY = '4Nd1mYQTqHVbSkJj8iKxw7rT3uCmEFs2bLqZx9wRKpAa';

describe('parseRoute', () => {
  it.each([
    ['/', 'home'],
    ['/how', 'how'],
    ['/stats', 'stats'],
    ['/practice', 'practice'],
    ['/friend', 'friend'],
    ['/verify', 'verify'],
  ])('%s is the %s screen', (path, name) => {
    expect(parseRoute(path)).toEqual({ name });
  });

  it('ignores a trailing slash', () => {
    expect(parseRoute('/how/')).toEqual({ name: 'how' });
    expect(parseRoute('')).toEqual({ name: 'home' });
    expect(parseRoute('///')).toEqual({ name: 'home' });
  });

  it('reads a guest arriving from a share link, with the host key from the fragment', () => {
    expect(parseRoute('/r/ABC234', '', `#${KEY}`)).toEqual({
      name: 'room',
      code: 'ABC234',
      role: 'guest',
      hostKey: KEY,
    });
  });

  it('a guest who typed the code has no host key', () => {
    expect(parseRoute('/r/ABC234')).toEqual({
      name: 'room',
      code: 'ABC234',
      role: 'guest',
      hostKey: undefined,
    });
    expect(parseRoute('/r/ABC234', '', '#')).toMatchObject({ hostKey: undefined });
  });

  it('reads the host’s own view of a room', () => {
    expect(parseRoute('/r/ABC234', '?host')).toMatchObject({ role: 'host', code: 'ABC234' });
  });

  it('accepts a lowercase code and normalises it', () => {
    expect(parseRoute('/r/abc234')).toMatchObject({ code: 'ABC234' });
  });

  it.each(['/r/ABC23', '/r/ABC0O1', '/r/', '/r/ABC234/extra', '/nope'])(
    '%s is not found',
    (path) => {
      expect(parseRoute(path).name).toBe('notfound');
    },
  );

  it('does not crash on a mangled percent escape in a shared link', () => {
    expect(parseRoute('/r/%E0%A4%A').name).toBe('notfound');
    expect(parseRoute('/r/%').name).toBe('notfound');
    expect(parseRoute('/r/AB%43234')).toMatchObject({ name: 'room', code: 'ABC234' });
  });
});

describe('routePath', () => {
  const routes: Route[] = [
    { name: 'home' },
    { name: 'how' },
    { name: 'stats' },
    { name: 'practice' },
    { name: 'friend' },
    { name: 'verify' },
    { name: 'room', code: 'ABC234', role: 'host', hostKey: undefined },
    { name: 'room', code: 'ABC234', role: 'guest', hostKey: KEY },
    { name: 'room', code: 'ABC234', role: 'guest', hostKey: undefined },
  ];

  it.each(routes)('round-trips %o', (route) => {
    const path = routePath(route);
    const url = new URL(path, 'https://x.test');
    expect(parseRoute(url.pathname, url.search, url.hash)).toEqual(route);
  });

  it('sends an unknown route home', () => {
    expect(routePath({ name: 'notfound' })).toBe('/');
  });
});

describe('shareLink', () => {
  it('puts the host key in the fragment so it is never sent to a server', () => {
    const link = shareLink('https://accident.example', 'ABC234', KEY);
    expect(link).toBe(`https://accident.example/r/ABC234#${KEY}`);
    expect(new URL(link).search).toBe('');
    expect(new URL(link).hash).toBe(`#${KEY}`);
  });
});

describe('withPlayer', () => {
  it('leaves a path alone when there is no player', () => {
    expect(withPlayer('/friend', null)).toBe('/friend');
    expect(withPlayer('/r/ABC234?host', '')).toBe('/r/ABC234?host');
  });

  it('adds the player to a plain path', () => {
    expect(withPlayer('/friend', 'host')).toBe('/friend?as=host');
  });

  it('keeps an existing query and a fragment', () => {
    const path = withPlayer('/r/ABC234?host', 'bob');
    expect(path).toBe('/r/ABC234?host=&as=bob');
    expect(withPlayer(`/r/ABC234#${KEY}`, 'bob')).toBe(`/r/ABC234?as=bob#${KEY}`);
  });

  it('replaces a player already present rather than doubling it', () => {
    expect(withPlayer('/friend?as=old', 'new')).toBe('/friend?as=new');
  });

  it('produces URLs the router still understands', () => {
    const url = new URL(withPlayer('/r/ABC234?host', 'alice'), 'https://x.test');
    expect(parseRoute(url.pathname, url.search, url.hash)).toMatchObject({
      name: 'room',
      role: 'host',
      code: 'ABC234',
    });
  });
});
