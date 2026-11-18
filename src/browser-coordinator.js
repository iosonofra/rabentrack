// One browser operation at a time, across cron, manual checks and cleanup.
// The active lease is never released just because the caller aborted: its work
// must actually settle, including tab cleanup, before another lease starts.
export class BrowserCoordinator {
  constructor({ maxPending = 16, manualQuota = 3, waitTimeoutMs = 600000 } = {}) {
    Object.assign(this, { maxPending, manualQuota, waitTimeoutMs });
    this.queue = [];
    this.active = null;
    this.manualStreak = 0;
    this.completed = 0;
    this.cancelled = 0;
    this.rejected = 0;
  }
  run(work, { scope = 'manual', signal, cleanup = false, onWaiting, onStarted } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const waiting = this.queue.filter((task) => Boolean(task.cleanup) === cleanup).length;
    if (waiting >= (cleanup ? 4 : this.maxPending)) {
      this.rejected++;
      return Promise.reject(Object.assign(new Error('Coda browser occupata: attendi e riprova.'), { status: 429, code: 'BROWSER_QUEUE_FULL' }));
    }
    return new Promise((resolve, reject) => {
      const task = { work, scope: scope === 'cron' ? 'cron' : 'manual', signal, cleanup, resolve, reject, onStarted, queuedAt: Date.now() };
      const remove = (reason) => {
        const index = this.queue.indexOf(task);
        if (index < 0) return;
        this.queue.splice(index, 1);
        task.dispose();
        this.cancelled++;
        reject(reason);
      };
      const abort = () => remove(signal.reason);
      const timer = setTimeout(() => remove(Object.assign(new Error('Attesa del turno browser oltre il tempo massimo.'), { code: 'BROWSER_QUEUE_TIMEOUT' })), this.waitTimeoutMs);
      task.dispose = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      signal?.addEventListener('abort', abort, { once: true });
      if (this.active || this.queue.length) {
        try { onWaiting?.({ activeScope: this.active?.scope || null, queued: this.queue.length }); } catch {}
      }
      this.queue.push(task);
      void this.pump();
    });
  }
  async pump() {
    if (this.active) return;
    while (this.queue.length) {
      const maintenance = this.queue.findIndex((task) => task.cleanup);
      const cron = this.queue.findIndex((task) => task.scope === 'cron');
      const manual = this.queue.findIndex((task) => task.scope === 'manual');
      const index = maintenance >= 0 ? maintenance
        : cron >= 0 && (manual < 0 || this.manualStreak >= this.manualQuota) ? cron : manual;
      const task = this.active = this.queue.splice(index, 1)[0];
      task.dispose();
      if (!task.cleanup) this.manualStreak = task.scope === 'cron' ? 0 : Math.min(this.manualQuota, this.manualStreak + 1);
      try {
        task.signal?.throwIfAborted();
        try { task.onStarted?.({ waitedMs: Date.now() - task.queuedAt }); } catch {}
        task.resolve(await task.work());
      } catch (error) { task.reject(error); }
      finally { this.completed++; this.active = null; }
    }
    this.manualStreak = 0;
  }
  stats() {
    return { activeScope: this.active?.scope || null, active: Number(Boolean(this.active)), manualWaiting: this.queue.filter((task) => !task.cleanup && task.scope === 'manual').length, cronWaiting: this.queue.filter((task) => !task.cleanup && task.scope === 'cron').length, cleanupWaiting: this.queue.filter((task) => task.cleanup).length, maxPending: this.maxPending, maxCleanupPending: 4, manualQuota: this.manualQuota, waitTimeoutMs: this.waitTimeoutMs, completed: this.completed, cancelled: this.cancelled, rejected: this.rejected };
  }
}

export const browserCoordinator = new BrowserCoordinator();
