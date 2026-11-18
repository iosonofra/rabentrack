import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

// Bounded in-memory diagnostics: no tracking numbers, credentials or disk writes.
export function createRuntimeDiagnostics() {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let previousCpu = process.cpuUsage();
  let previousTime = performance.now();
  const samples = [];
  const sample = () => {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();
    const elapsedMs = now - previousTime;
    samples.push({
      at: new Date().toISOString(),
      windowMs: Math.round(elapsedMs),
      cpuPercentOfOneCore: Number((((cpu.user - previousCpu.user + cpu.system - previousCpu.system) / 1000 / Math.max(1, elapsedMs)) * 100).toFixed(2)),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      eventLoopP95Ms: histogram.count ? Number((histogram.percentile(95) / 1e6).toFixed(2)) : null,
      eventLoopP99Ms: histogram.count ? Number((histogram.percentile(99) / 1e6).toFixed(2)) : null,
      eventLoopMaxMs: histogram.count ? Number((histogram.max / 1e6).toFixed(2)) : null,
    });
    if (samples.length > 60) samples.shift();
    previousCpu = cpu;
    previousTime = now;
    histogram.reset();
  };
  const timer = setInterval(sample, 10000);
  timer.unref();
  return {
    snapshot() {
      return { pid: process.pid, uptimeSeconds: Math.round(process.uptime()), sampleIntervalMs: 10000, retentionSamples: 60, samples: samples.map((entry) => ({ ...entry })) };
    },
    close() { clearInterval(timer); histogram.disable(); },
  };
}
