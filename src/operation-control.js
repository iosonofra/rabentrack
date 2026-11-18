import { setTimeout as sleep } from 'node:timers/promises';

export function deadline(milliseconds, parent, message = 'Tempo massimo operazione superato.') {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  const timer = setTimeout(() => controller.abort(Object.assign(new Error(message), { name: 'TimeoutError' })), milliseconds);
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, { once: true });
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
}

export async function pause(milliseconds, signal) {
  signal?.throwIfAborted();
  if (milliseconds > 0) await sleep(milliseconds, undefined, { signal });
}

// For queue waits; the queued operation separately checks signal before starting.
export function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class RequestGate {
  constructor(intervalMs = 800, maxPending = 100) {
    Object.assign(this, { intervalMs, maxPending });
    this.queue = [];
    this.active = false;
    this.nextAvailableAt = 0;
  }
  run(work, { signal, waitTimeoutMs = 120000 } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.queue.length >= this.maxPending) return Promise.reject(new Error('Coda richieste piena: riprova più tardi.'));
    return new Promise((resolve, reject) => {
      const task = { work, signal, resolve, reject };
      task.remove = () => {
        const index = this.queue.indexOf(task);
        if (index < 0) return;
        this.queue.splice(index, 1);
        task.cleanup();
        reject(signal?.aborted ? signal.reason : new Error('Tempo massimo di attesa in coda superato.'));
      };
      task.timer = setTimeout(task.remove, waitTimeoutMs);
      task.cleanup = () => { clearTimeout(task.timer); signal?.removeEventListener('abort', task.remove); };
      signal?.addEventListener('abort', task.remove, { once: true });
      this.queue.push(task);
      void this.pump();
    });
  }
  async pump() {
    if (this.active) return;
    this.active = true;
    try {
      while (this.queue.length) {
        const task = this.queue[0];
        try {
          // Leave it queued during pacing so timeout/abort can still remove it.
          await pause(Math.max(0, this.nextAvailableAt - Date.now()), task.signal);
          if (this.queue[0] !== task) continue;
          this.queue.shift();
          task.cleanup();
          task.signal?.throwIfAborted();
          this.nextAvailableAt = Date.now() + this.intervalMs;
          task.resolve(await task.work());
        } catch (error) {
          const index = this.queue.indexOf(task);
          if (index >= 0) this.queue.splice(index, 1);
          task.cleanup();
          task.reject(error);
        }
      }
    } finally { this.active = false; }
  }
}
