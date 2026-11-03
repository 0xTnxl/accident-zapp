import { FriendController } from './controller.js';
import type { ControllerInit } from './controller.js';

/**
 * One controller per room per page, created on first use and kept until the player leaves the room.
 *
 * Components mount and unmount freely: React's StrictMode does it on purpose in development, and a
 * tab can be re-rendered for many reasons. A controller created inside a component would be torn
 * down and rebuilt each time, and the rebuilt one would start a second game for the same room. Here
 * a remount gets the same live controller back.
 */
const controllers = new Map<string, FriendController>();

export function controllerFor(init: ControllerInit): FriendController {
  const key = `${init.room}:${init.role}`;
  const existing = controllers.get(key);
  if (existing) return existing;
  const created = new FriendController(init);
  controllers.set(key, created);
  return created;
}

/** Stops a room's controller and forgets it. The saved game stays on the device. */
export async function leaveRoom(room: string): Promise<void> {
  for (const [key, controller] of [...controllers]) {
    if (!key.startsWith(`${room}:`)) continue;
    controllers.delete(key);
    await controller.dispose();
  }
}

/** For tests: forget every controller without waiting for them to stop. */
export function resetRegistry(): void {
  controllers.clear();
}
