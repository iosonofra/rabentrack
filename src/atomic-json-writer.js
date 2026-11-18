import { mkdir, writeFile, rename, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export async function writeAtomicJson(path, body) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) {
        // Windows can briefly deny replacement while a reader has the file
        // open. Never remove the destination to work around a failed rename.
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 3) throw error;
        await delay([10, 25, 50][attempt]);
      }
    }
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

// At most one active snapshot and one pending group. Each caller waits for the
// group containing its revision, including requests arriving during disk I/O.
// No debounce, detached durability, or per-request snapshot/write-chain node.
export class AtomicJsonWriter {
  constructor({ path, getValue, write = writeAtomicJson } = {}) {
    Object.assign(this, { path, getValue, write });
    this.pending = null;
    this.active = null;
    this.scheduled = false;
    this.revision = 0;
    this.durableRevision = 0;
    this.lastFailure = null;
    this.samples = [];
    this.counters = { requests: 0, commits: 0, failures: 0, coalescedRequests: 0, bytesWritten: 0, lastBytes: 0, stringifyTotalMs: 0, stringifyMaxMs: 0, diskTotalMs: 0, diskMaxMs: 0, waitMaxMs: 0, lastErrorCode: '' };
  }
  request() {
    this.revision++;
    this.counters.requests++;
    if (this.pending) this.counters.coalescedRequests++;
    else {
      const group = { createdAt: performance.now(), requests: 0 };
      group.promise = new Promise((resolve, reject) => Object.assign(group, { resolve, reject }));
      // The original promise still rejects for callers; keep fire-and-forget
      // logging paths from generating an unhandled rejection during shutdown.
      group.promise.catch(() => {});
      this.pending = group;
    }
    this.pending.requests++;
    const promise = this.pending.promise;
    if (!this.scheduled && !this.active) {
      this.scheduled = true;
      queueMicrotask(() => { this.scheduled = false; void this.drain(); });
    }
    return promise;
  }
  async drain() {
    while (this.pending) {
      const group = this.pending;
      this.pending = null;
      this.active = group;
      const revision = this.revision;
      const sample = { requests: group.requests, waitMs: performance.now() - group.createdAt, stringifyMs: 0, diskMs: 0, bytes: 0, ok: false };
      try {
        const start = performance.now();
        let body;
        try { body = JSON.stringify(this.getValue()); }
        finally { sample.stringifyMs = performance.now() - start; }
        if (typeof body !== 'string') throw new Error('Archivio JSON non valido per il salvataggio.');
        sample.bytes = Buffer.byteLength(body);
        const diskStart = performance.now();
        try { await this.write(this.path, body); }
        finally { sample.diskMs = performance.now() - diskStart; }
        this.durableRevision = revision;
        this.lastFailure = null;
        this.counters.lastErrorCode = '';
        this.counters.commits++;
        this.counters.bytesWritten += sample.bytes;
        this.counters.lastBytes = sample.bytes;
        sample.ok = true;
        group.resolve();
      } catch (error) {
        this.lastFailure = error;
        this.counters.lastErrorCode = String(error.code || 'WRITE_FAILED').slice(0, 60);
        this.counters.failures++;
        group.reject(error);
      } finally {
        this.counters.stringifyTotalMs += sample.stringifyMs;
        this.counters.stringifyMaxMs = Math.max(this.counters.stringifyMaxMs, sample.stringifyMs);
        this.counters.diskTotalMs += sample.diskMs;
        this.counters.diskMaxMs = Math.max(this.counters.diskMaxMs, sample.diskMs);
        this.counters.waitMaxMs = Math.max(this.counters.waitMaxMs, sample.waitMs);
        this.samples.push(sample);
        if (this.samples.length > 60) this.samples.shift();
        this.active = null;
      }
    }
  }
  async flush() {
    while (this.pending || this.active) await (this.pending || this.active).promise.catch(() => {});
    if (this.durableRevision < this.revision) throw this.lastFailure || new Error('Modifiche non salvate su disco.');
  }
  stats() {
    return { ...this.counters, revision: this.revision, durableRevision: this.durableRevision, dirty: this.durableRevision < this.revision, activeGroups: Number(Boolean(this.active)), pendingGroups: Number(Boolean(this.pending)), pendingRequests: this.pending?.requests || 0, activeRequests: this.active?.requests || 0, retentionSamples: 60, samples: this.samples.map((sample) => ({ ...sample })) };
  }
}
