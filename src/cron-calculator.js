import { Worker } from 'node:worker_threads';
import { parseCronExpression } from './cron-scheduler.js';

export class CronCalculator {
  constructor({ timeoutMs = 3000, maxPending = 8, workerUrl = new URL('./cron-calculation-worker.js', import.meta.url) } = {}) {
    Object.assign(this, { timeoutMs, maxPending, workerUrl });
    this.worker = null;
    this.active = null;
    this.queue = [];
    this.serial = 0;
  }
  calculate(expression, options = {}, signal) {
    if (this.closed) return Promise.reject(new Error('Calcolatore cron arrestato.'));
    parseCronExpression(expression);
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.queue.length + Number(Boolean(this.active)) >= this.maxPending) return Promise.reject(new Error('Calcolo cron occupato: riprova tra pochi secondi.'));
    return new Promise((resolve, reject) => {
      const task = { id: ++this.serial, expression, options, resolve, reject, signal };
      task.abort = () => this.finish(task, signal.reason, null, true);
      task.timer = setTimeout(() => this.finish(task, new Error('Calcolo cron oltre il tempo massimo: pianificazione non modificata.'), null, true), this.timeoutMs);
      signal?.addEventListener('abort', task.abort, { once: true });
      this.queue.push(task);
      this.pump();
    });
  }
  pump() {
    if (this.closed || this.active || !this.queue.length) return;
    const task = this.active = this.queue.shift();
    if (!this.worker) {
      let worker;
      try { worker = this.worker = new Worker(this.workerUrl, { execArgv: [] }); }
      catch (error) { this.finish(task, error); return; }
      worker.on('message', ({ id, result, error }) => {
        if (this.worker === worker && this.active?.id === id) this.finish(this.active, error ? new Error(error) : null, result);
      });
      worker.on('error', (error) => { if (this.worker === worker && this.active) this.finish(this.active, error, null, true); });
      worker.on('exit', () => {
        if (this.worker !== worker) return;
        this.worker = null;
        if (this.active) this.finish(this.active, new Error('Worker cron terminato.'), null, true);
      });
    }
    this.worker.ref();
    this.worker.postMessage({ id: task.id, expression: task.expression, options: task.options });
  }
  finish(task, error, result, terminate = false) {
    if (task.done) return;
    task.done = true;
    clearTimeout(task.timer);
    task.signal?.removeEventListener('abort', task.abort);
    if (this.active === task) {
      this.active = null;
      if (terminate && this.worker) {
        const worker = this.worker;
        this.worker = null;
        // Wait for actual termination before admitting more CPU work.
        this.active = { terminating: true };
        void worker.terminate().finally(() => { this.active = null; this.pump(); });
      } else this.worker?.unref();
    } else this.queue = this.queue.filter((item) => item !== task);
    if (error) task.reject(error); else task.resolve(result);
    this.pump();
  }
  async close() {
    this.closed = true;
    for (const task of [...this.queue]) this.finish(task, new Error('Calcolatore cron arrestato.'));
    if (this.active && !this.active.terminating) this.finish(this.active, new Error('Calcolatore cron arrestato.'));
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }
}

export const cronCalculator = new CronCalculator();
