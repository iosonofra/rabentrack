// Synthetic data only. Never opens the application's data directory.
import { mkdtemp, readFile, rm, mkdir, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const baselineOnly = process.argv.includes('--baseline');
const { AtomicJsonWriter } = baselineOnly ? {} : await import('../src/atomic-json-writer.js');
const root = await mkdtemp(join(tmpdir(), 'raben-persistence-benchmark-'));
const results = [];
try {
  for (const size of [1000, 10000]) {
    for (const mode of baselineOnly ? ['legacy'] : ['legacy', 'coalesced']) {
      const db = { shipments: {}, operations: [] };
      for (let i = 0; i < size; i++) db.shipments['SYNTHETIC-' + i] = {
        trackingNumber: 'SYNTHETIC-' + i, rabenStatus: 'In transito',
        events: Array.from({ length: 10 }, (_, n) => ({ at: '2026-11-18T08:00:00Z', type: 'raben', label: 'In transito', detail: 'Evento sintetico ' + n })),
      };
      const path = join(root, `${mode}-${size}.json`);
      let chain = Promise.resolve();
      let writes = 0, stringifyMs = 0, bytes = 0;
      const writer = mode === 'coalesced' ? new AtomicJsonWriter({ path, getValue: () => db }) : null;
      const persist = () => {
        if (writer) return writer.request();
        const next = chain.then(async () => {
          await mkdir(root, { recursive: true });
          const start = performance.now();
          const body = JSON.stringify(db);
          stringifyMs += performance.now() - start;
          bytes += Buffer.byteLength(body);
          await writeFile(path + '.tmp', body, 'utf8');
          await rename(path + '.tmp', path);
          writes++;
        });
        chain = next.catch(() => {});
        return next;
      };
      const start = performance.now();
      const cpu = process.cpuUsage();
      const pending = [];
      for (let i = 0; i < 32; i++) { db.operations.push({ action: 'SYNTHETIC-' + i }); pending.push(persist()); }
      await Promise.all(pending);
      const burstMs = performance.now() - start;
      for (let i = 0; i < 8; i++) { db.operations.push({ action: 'SEQUENTIAL-' + i }); await persist(); }
      const cpuUsed = process.cpuUsage(cpu);
      const stored = JSON.parse(await readFile(path, 'utf8'));
      if (stored.operations.length !== 40 || Object.keys(stored.shipments).length !== size) throw new Error('Synthetic benchmark lost updates.');
      const metrics = writer?.stats();
      results.push({ mode, shipments: size, requests: 40, commits: metrics?.commits ?? writes, bytesWritten: metrics?.bytesWritten ?? bytes, stringifyMs: +(metrics?.stringifyTotalMs ?? stringifyMs).toFixed(2), burstMs: +burstMs.toFixed(2), totalMs: +(performance.now() - start).toFixed(2), cpuMs: +((cpuUsed.user + cpuUsed.system) / 1000).toFixed(2), lastBytes: Buffer.byteLength(JSON.stringify(stored)), durability: writer ? 'file sync + atomic rename + directory sync on Linux' : 'legacy rename, no fsync' });
    }
  }
  console.log(JSON.stringify({ synthetic: true, platform: process.platform, node: process.version, results }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
