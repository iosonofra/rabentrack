import { mkdir, readFile, rename, writeFile, stat, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const DAY = 86400000;
const STATES = new Set(['pending', 'sending', 'retry', 'paused', 'sent', 'failed', 'uncertain', 'expired', 'cancelled']);
const unresolved = (entry) => Boolean(entry.payload);
export const notificationDay = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

export function channelIdentity(channel, config = {}) {
  return hash(channel === 'telegram'
    ? [config.chatId || '', String(config.botToken || '').split(':')[0]]
    : [config.host || '', config.port || 587, Boolean(config.secure), config.user || '', config.from || '', config.to || '']);
}

export class NotificationOutbox {
  constructor({ path = new URL('../data/notification-outbox.json', import.meta.url), getConfig, deliver, logger = console, now = Date.now, maxEntries = 2000, maxPending = 200, maxBytes = 4 * 1024 * 1024, retryDelays = [30000, 300000], pollMs = 5000 } = {}) {
    Object.assign(this, { path, getConfig, deliver, logger, now, maxEntries, maxPending, maxBytes, retryDelays, pollMs });
    this.state = { version: 1, entries: [] };
    this.chain = Promise.resolve();
    this.pendingChanges = 0;
    this.storageError = '';
    this.started = false;
    this.stopping = false;
    this.timer = null;
    this.running = null;
    this.controller = null;
  }
  async start() {
    try {
      try {
        const info = await stat(this.path);
        if (info.size > this.maxBytes) throw new Error('Coda notifiche oltre il limite del file.');
        const state = JSON.parse(await readFile(this.path, 'utf8'));
        if (state.version !== 1 || !Array.isArray(state.entries) || state.entries.length > this.maxEntries
          || state.entries.some((entry) => !/^[a-f0-9]{64}$/.test(entry.id) || !['email', 'telegram'].includes(entry.channel) || !STATES.has(entry.status) || !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.expiresAt))) throw new Error('Formato coda notifiche non valido.');
        this.state = state;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await this.change((state) => {
        let changed = this.prune(state);
        for (const entry of state.entries) if (entry.status === 'sending') {
          entry.status = 'uncertain';
          entry.lastError = 'Invio interrotto dal riavvio: verificare la consegna prima di riprovare.';
          changed = true;
        }
        return { changed };
      }, true);
      this.started = true;
      this.wake();
    } catch (error) { this.storageError = error.message; throw error; }
  }
  async persist(state, reserve = 0) {
    const body = JSON.stringify(state);
    if (Buffer.byteLength(body) > this.maxBytes - reserve) throw new Error('Spazio massimo della coda notifiche raggiunto.');
    const path = this.path instanceof URL ? (await import('node:url')).fileURLToPath(this.path) : this.path;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true });
      await rename(temporary, path);
      if (process.platform !== 'win32') {
        const directory = await open(dirname(path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (error) {
      await unlink(temporary).catch(() => {});
      this.storageError = 'Scrittura coda notifiche fallita: ' + error.message;
      throw error;
    }
  }
  change(update, internal = false) {
    if (this.storageError) return Promise.reject(new Error(this.storageError));
    if (!internal && this.pendingChanges >= 32) return Promise.reject(new Error('Coda notifiche occupata: riprova più tardi.'));
    this.pendingChanges++;
    const work = this.chain.then(async () => {
      if (this.storageError) throw new Error(this.storageError);
      const draft = structuredClone(this.state);
      const result = update(draft) || {};
      if (result.changed) { await this.persist(draft, result.reserve || 0); this.state = draft; }
      return result.value;
    });
    this.chain = work.catch(() => {}).finally(() => { this.pendingChanges--; });
    return work;
  }
  prune(state) {
    const before = state.entries.length;
    state.entries = state.entries.filter((entry) => entry.createdAt > this.now() - 7 * DAY || entry.status === 'sending');
    let changed = before !== state.entries.length;
    for (const entry of state.entries) {
      if (entry.status !== 'sending' && entry.payload && entry.expiresAt <= this.now()) {
        entry.status = 'expired'; entry.payload = null;
        entry.lastError = 'Notifica scaduta: invio automatico non più previsto.';
        changed = true;
      }
    }
    return changed;
  }
  policy(entry) {
    const config = this.getConfig() || {};
    const channel = config[entry.channel] || {};
    if (!channel.enabled || config.triggers?.[entry.trigger] === false) return 'Canale o tipo di notifica disattivato nelle impostazioni.';
    if (entry.destination !== channelIdentity(entry.channel, channel)) return 'Destinatario o account cambiato: annulla questa notifica o ripristina la configurazione originale.';
    if (entry.channel === 'telegram' ? !channel.botToken || !channel.chatId : !channel.host || !channel.to) return 'Configurazione del canale incompleta.';
    return '';
  }
  async enqueue({ key, label, trigger, telegramText, emailSubject, emailHtml, signal }) {
    if (!this.started || this.stopping) throw new Error(this.storageError || 'Coda notifiche non disponibile.');
    signal?.throwIfAborted();
    const config = this.getConfig() || {};
    const channels = ['telegram', 'email'].filter((channel) => config[channel]?.enabled);
    if (!channels.length) return { skipped: true, queued: 0, duplicates: 0 };
    const entries = channels.map((channel) => {
      const destination = channelIdentity(channel, config[channel]);
      const payload = channel === 'telegram' ? { text: String(telegramText || '') } : { subject: String(emailSubject || ''), html: String(emailHtml || '') };
      if (Buffer.byteLength(JSON.stringify(payload)) > 16384) throw new Error('Contenuto della notifica troppo grande (massimo 16 KiB per canale).');
      return { id: hash([key, channel, destination]), channel, destination, label: String(label || '').slice(0, 160), trigger, payload, status: 'pending', attempts: 0, totalAttempts: 0, createdAt: this.now(), expiresAt: this.now() + DAY, nextAttemptAt: this.now(), lastError: '' };
    });
    const result = await this.change((state) => {
      signal?.throwIfAborted();
      const changed = this.prune(state);
      const fresh = entries.filter((entry) => !state.entries.some((old) => old.id === entry.id));
      if (state.entries.length + fresh.length > this.maxEntries || state.entries.filter(unresolved).length + fresh.length > this.maxPending) throw new Error('Coda notifiche piena: controlla gli invii in attesa.');
      state.entries.push(...fresh);
      return { changed: changed || fresh.length > 0, reserve: Math.min(262144, this.maxBytes / 4), value: { queued: fresh.length, duplicates: entries.length - fresh.length, accepted: true } };
    });
    this.wake();
    return result;
  }
  wake(delay = 0) {
    if (!this.started || this.stopping || this.storageError || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.drain().catch((error) => this.logger.error('[NOTIFICATIONS-OUTBOX]', error.message)).finally(() => { this.running = null; this.wake(this.pollMs); });
    }, delay);
    this.timer.unref();
  }
  async claim() {
    return this.change((state) => {
      let changed = this.prune(state);
      for (const entry of state.entries) {
        if (!['pending', 'retry', 'paused'].includes(entry.status) || entry.nextAttemptAt > this.now()) continue;
        const reason = this.policy(entry);
        if (reason) {
          if (entry.status !== 'paused' || entry.lastError !== reason) { entry.status = 'paused'; entry.lastError = reason; changed = true; }
          continue;
        }
        entry.status = 'sending'; entry.attempts++; entry.totalAttempts++;
        entry.lastError = ''; entry.startedAt = this.now();
        return { changed: true, value: structuredClone(entry) };
      }
      return { changed, value: null };
    }, true);
  }
  async drain() {
    while (!this.stopping && !this.storageError) {
      const entry = await this.claim();
      if (!entry) return;
      if (this.stopping) {
        await this.change((state) => {
          const current = state.entries.find((item) => item.id === entry.id);
          Object.assign(current, { status: 'pending', attempts: entry.attempts - 1, totalAttempts: entry.totalAttempts - 1 });
          return { changed: true };
        }, true);
        return;
      }
      this.controller = new AbortController();
      let outcome;
      try {
        const result = await this.deliver(entry.channel, entry.payload, this.controller.signal);
        if (!result?.ok) throw Object.assign(new Error('Consegna non confermata dal canale.'), { deliveryUnknown: true });
        outcome = { status: 'sent', sentAt: this.now(), payload: null, lastError: '' };
      } catch (error) {
        let message = String(error.message || 'Errore invio');
        for (const secret of [this.getConfig()?.telegram?.botToken, this.getConfig()?.email?.pass]) if (secret) message = message.split(secret).join('[omesso]');
        const known = error.deliveryUnknown === false;
        const retry = known && error.retryable && entry.attempts <= this.retryDelays.length && !this.stopping;
        outcome = { status: !known ? 'uncertain' : retry ? 'retry' : 'failed', lastError: message.slice(0, 400) };
        if (retry) outcome.nextAttemptAt = this.now() + Math.max(this.retryDelays[entry.attempts - 1], Math.min(3600000, Number(error.retryAfterMs) || 0));
      } finally { this.controller = null; }
      await this.change((state) => {
        const current = state.entries.find((item) => item.id === entry.id);
        if (current) Object.assign(current, outcome);
        return { changed: Boolean(current) };
      }, true);
    }
  }
  async retry(id, { confirmUncertain = false } = {}) {
    if (this.stopping) throw new Error('Coda notifiche in arresto.');
    await this.change((state) => {
      this.prune(state);
      const entry = state.entries.find((item) => item.id === id);
      if (!entry || !entry.payload || !['failed', 'uncertain', 'paused'].includes(entry.status)) throw new Error('Notifica non disponibile per un nuovo tentativo.');
      if (entry.status === 'uncertain' && !confirmUncertain) throw new Error('Consegna incerta: conferma il rischio di duplicare il messaggio.');
      const reason = this.policy(entry);
      if (reason) throw new Error(reason);
      entry.status = 'pending'; entry.attempts = 0; entry.nextAttemptAt = this.now(); entry.lastError = '';
      return { changed: true };
    });
    this.wake();
  }
  async discard(id) {
    await this.change((state) => {
      const entry = state.entries.find((item) => item.id === id);
      if (!entry || ['sending', 'sent'].includes(entry.status)) throw new Error('Notifica già inviata o in corso: impossibile annullarla.');
      entry.status = 'cancelled'; entry.payload = null; entry.lastError = '';
      return { changed: true };
    });
  }
  status(limit = 50) {
    const counts = {};
    for (const entry of this.state.entries) counts[entry.status] = (counts[entry.status] || 0) + 1;
    const rank = { uncertain: 0, failed: 1, paused: 2, sending: 3, retry: 4, pending: 5 };
    const entries = [...this.state.entries].sort((a, b) => (rank[a.status] ?? 6) - (rank[b.status] ?? 6) || b.createdAt - a.createdAt).slice(0, Math.min(100, Math.max(1, Number(limit) || 50))).map((entry) => ({
      id: entry.id, channel: entry.channel, label: entry.label, status: entry.status, attempts: entry.attempts, totalAttempts: entry.totalAttempts,
      createdAt: entry.createdAt, nextAttemptAt: entry.nextAttemptAt, sentAt: entry.sentAt, expiresAt: entry.expiresAt, lastError: entry.lastError,
      canRetry: Boolean(entry.payload && entry.expiresAt > this.now() && ['failed', 'uncertain', 'paused'].includes(entry.status) && !this.policy(entry)),
      canDiscard: Boolean(entry.payload && !['sending', 'sent'].includes(entry.status)),
    }));
    return { available: this.started && !this.storageError, storageError: this.storageError, counts, total: this.state.entries.length, maxEntries: this.maxEntries, maxPending: this.maxPending, entries };
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    await this.running;
    await this.chain;
  }
}
