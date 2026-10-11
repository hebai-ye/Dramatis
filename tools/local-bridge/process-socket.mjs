import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_WORKER = fileURLToPath(new URL('./ws-worker.mjs', import.meta.url));

/** A WebSocket-shaped IPC adapter. Killing its own worker guarantees native WS teardown. */
export class ProcessSocket {
  constructor(url, { workerPath = DEFAULT_WORKER, forkImpl = fork } = {}) {
    this.readyState = 0;
    this.listeners = new Map();
    this.child = forkImpl(workerPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.child.on('message', (message) => {
      if (message?.kind === 'open') {
        this.readyState = 1;
        this.emit('open');
      } else if (message?.kind === 'message') {
        this.emit('message', { data: message.data });
      } else if (message?.kind === 'error') {
        this.emit('error');
      }
    });
    this.child.on('error', () => this.emit('error'));
    this.child.on('close', () => {
      this.readyState = 3;
      this.emit('close');
      this.resolveExit();
    });
    this.child.send({ kind: 'connect', url }, (error) => {
      if (error) this.emit('error');
    });
  }

  addEventListener(name, listener, options = {}) {
    const entries = this.listeners.get(name) ?? new Set();
    entries.add({ listener, once: options.once === true });
    this.listeners.set(name, entries);
  }

  removeEventListener(name, listener) {
    const entries = this.listeners.get(name);
    if (!entries) return;
    for (const entry of entries) if (entry.listener === listener) entries.delete(entry);
    if (entries.size === 0) this.listeners.delete(name);
  }

  emit(name, event = {}) {
    for (const entry of [...(this.listeners.get(name) ?? [])]) {
      if (entry.once) this.removeEventListener(name, entry.listener);
      entry.listener(event);
    }
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('调试通道尚未打开或已关闭。');
    this.child.send({ kind: 'send', data }, (error) => {
      if (error) this.emit('error');
    });
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.child.send({ kind: 'close' }, (error) => {
      if (error) this.emit('error');
    });
  }

  async terminate() {
    if (this.readyState !== 3) this.child.kill();
    await this.exited;
  }
}

export function createProcessSocket(url) {
  return new ProcessSocket(url);
}
