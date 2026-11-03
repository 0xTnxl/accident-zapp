/// <reference lib="webworker" />
import { chooseNow } from './computer.js';
import type { WorkerReply, WorkerRequest } from './computer.js';

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, level, history } = event.data;
  let reply: WorkerReply;
  try {
    reply = { id, guess: chooseNow(level, history, Math.random) };
  } catch (e) {
    reply = { id, error: e instanceof Error ? e.message : String(e) };
  }
  self.postMessage(reply);
};
