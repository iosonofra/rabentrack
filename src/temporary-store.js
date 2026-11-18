export function capacityError(message = 'Limite delle operazioni temporanee raggiunto. Attendi la conclusione dei lavori attivi e riprova.') {
  return Object.assign(new Error(message), { status: 429 });
}

// Approximation for admission control, not an exact measurement of V8 heap.
// Bounded traversal; no JSON serialization of large payloads on the event loop.
export function estimateBytes(value, limit = 32 * 1024 * 1024) {
  const seen = new Set();
  const stack = [value];
  let bytes = 0;
  let visited = 0;
  while (stack.length) {
    if (++visited > 100000 || bytes > limit) return Infinity;
    const item = stack.pop();
    if (typeof item === 'string') bytes += 24 + item.length * 2;
    else if (item && typeof item === 'object') {
      if (seen.has(item)) continue;
      seen.add(item);
      bytes += 64;
      for (const key of Object.keys(item)) { bytes += 16 + key.length * 2; stack.push(item[key]); }
    } else bytes += 8;
  }
  return bytes > limit ? Infinity : bytes;
}

export class TemporaryStore {
  constructor({ name, maxEntries, maxBytes, ttlMs, protectedValue = () => false, optional = false, now = Date.now }) {
    Object.assign(this, { name, maxEntries, maxBytes, ttlMs, protectedValue, optional, now });
    this.entries = new Map();
    this.bytes = 0;
    this.evicted = 0;
    this.rejected = 0;
    this.cursor = null;
  }
  get size() { return this.entries.size; }
  *values() { for (const entry of this.entries.values()) yield entry.value; }
  expired(entry) { return !this.protectedValue(entry.value) && entry.expiresAt <= this.now(); }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.expired(entry)) { this.delete(key); return undefined; }
    return entry.value;
  }
  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.bytes -= entry.bytes;
    return this.entries.delete(key);
  }
  set(key, value, reservedBytes) {
    const bytes = reservedBytes ?? estimateBytes(value, this.maxBytes);
    if (!Number.isFinite(bytes) || bytes > this.maxBytes) {
      this.rejected++;
      if (this.optional) return this;
      throw capacityError('Operazione troppo grande per lo spazio temporaneo disponibile. Riduci il numero di righe.');
    }
    const previous = this.entries.get(key);
    if (previous && this.protectedValue(previous.value)) throw capacityError('Operazione ancora in uso: impossibile sostituirla.');
    let count = this.size - Number(Boolean(previous));
    let total = this.bytes - (previous?.bytes || 0) + bytes;
    const fits = () => count < this.maxEntries && total <= this.maxBytes;
    const removals = [];
    if (!fits()) {
      for (const [oldKey, entry] of this.entries) {
        if (fits()) break;
        if (oldKey !== key && !this.protectedValue(entry.value)) { removals.push(oldKey); count--; total -= entry.bytes; }
      }
    }
    if (!fits()) {
      this.rejected++;
      if (this.optional) return this;
      throw capacityError();
    }
    for (const oldKey of removals) { this.delete(oldKey); this.evicted++; }
    if (previous) this.delete(key);
    this.entries.set(key, { value, bytes, expiresAt: typeof value.expiresAt === 'number' ? value.expiresAt : this.now() + this.ttlMs });
    this.bytes += bytes;
    return this;
  }
  finish(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.expiresAt = typeof entry.value.expiresAt === 'number' ? entry.value.expiresAt : this.now() + this.ttlMs;
    // Result growth never discards an operation that has already run. Admission
    // of later work applies pressure until retained results fit the budget again.
    const actual = estimateBytes(entry.value, this.maxBytes * 2);
    const measured = Number.isFinite(actual) ? actual : this.maxBytes * 2;
    this.bytes += measured - entry.bytes;
    entry.bytes = measured;
  }
  prune(limit = 100) {
    this.cursor ||= this.entries.entries();
    for (let index = 0; index < limit; index++) {
      const next = this.cursor.next();
      if (next.done) { this.cursor = null; break; }
      const [key, entry] = next.value;
      if (this.expired(entry)) this.delete(key);
    }
  }
  stats() {
    return { entries: this.size, estimatedBytes: this.bytes, maxEntries: this.maxEntries, maxEstimatedBytes: this.maxBytes, overBudget: this.bytes > this.maxBytes, evicted: this.evicted, rejected: this.rejected };
  }
}

export function startTemporaryCleanup(stores) {
  const timer = setInterval(() => { for (const store of stores) store.prune(100); }, 30000);
  timer.unref();
  return () => clearInterval(timer);
}
