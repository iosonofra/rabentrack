import { randomUUID } from 'node:crypto';
import { normalizeRabenSpeedProfile } from './raben-speed-profile.js';
import { deadline, pause } from './operation-control.js';
import { browserCoordinator } from './browser-coordinator.js';

export { normalizeRabenSpeedProfile } from './raben-speed-profile.js';

const Raben_HOSTS = new Set([
  'oftc.myraben.com',
  'myraben.com',
  'www.myraben.com',
  'italia.raben-group.com',
  'www.raben-group.com',
]);
const REQUEST_TIMEOUT_MS = 20_000;
const TRACKING_POLL_TIMEOUT_MS = 18_000;
const TRACKING_POLL_INTERVAL_MS = 700;
const FAST_TRACKING_POLL_INTERVALS_MS = [250, 500, 800, 1200];
const ULTRA_TRACKING_POLL_INTERVALS_MS = [100, 200, 350, 600];
export const Raben_PARSER_VERSION = 11;
export const DEFAULT_Raben_TRACKING_URL = 'https://oftc.myraben.com/link/ShipmentInformation?ShipmentNumber=TRACKINGDAINSERIRE&Language=IT';

export const Raben_SPEED_PROFILES = Object.freeze({
  safe: Object.freeze({ id: 'safe', reuseTab: false, initialDelayMs: 500, manualDelayMs: [2000, 3200], cronDelayMs: [4000, 6000] }),
  fast: Object.freeze({ id: 'fast', reuseTab: true, initialDelayMs: 150, manualDelayMs: [1200, 2000], cronDelayMs: [1800, 3000] }),
  ultra: Object.freeze({ id: 'ultra', reuseTab: true, initialDelayMs: 50, manualDelayMs: [350, 700], cronDelayMs: [700, 1200] }),
});

function assertLoopback(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('Il servizio Camofox deve essere disponibile solo in locale (127.0.0.1 o localhost).');
  }
  return url.toString().replace(/\/$/, '');
}

export function normalizeBetaSettings(input = {}) {
  const camofoxUrl = assertLoopback(input.camofoxUrl || 'http://127.0.0.1:9377');
  const trackingUrl = new URL(input.trackingUrl || DEFAULT_Raben_TRACKING_URL);
  if (trackingUrl.protocol !== 'https:' || !Raben_HOSTS.has(trackingUrl.hostname)) {
    throw new Error('Per la verifica è consentita solo una pagina HTTPS ufficiale oftc.myraben.com, myRaben o raben-group.com.');
  }
  if (trackingUrl.hostname === 'oftc.myraben.com') {
    if (trackingUrl.pathname !== '/link/ShipmentInformation') {
      throw new Error('Il portale pubblico Raben deve usare il percorso /link/ShipmentInformation.');
    }
    if (trackingUrl.searchParams.get('ShipmentNumber') !== 'TRACKINGDAINSERIRE') {
      throw new Error('L’URL Raben deve contenere ShipmentNumber=TRACKINGDAINSERIRE.');
    }
    trackingUrl.searchParams.set('Language', trackingUrl.searchParams.get('Language') || 'IT');
  }
  return { enabled: Boolean(input.enabled), camofoxUrl, trackingUrl: trackingUrl.toString(), speedProfile: normalizeRabenSpeedProfile(input.speedProfile) };
}

function cleanSnapshot(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 700);
}

function findRef(snapshot, expression) {
  const line = String(snapshot).split(/\r?\n/).find((item) => expression.test(item));
  return line?.match(/\b(e\d+)\b/i)?.[1] || null;
}

const Raben_STATUS_RULES = [
  { status: 'Consegnata con riserva', expression: /\b(?:consegnat[ao] con (?:osservazioni|riserva)|delivered with remarks?)\b/i },
  { status: 'Prenotata', expression: /\b(?:consegnat[ao] al terminal(?: dal mittente)?|terminal dal mittente|delivered to (?:the )?(?:sender )?terminal)\b/i },
  { status: 'In corso', expression: /\bin corso(?:\s*-\s*parere richiesto)?\b/i },
  { status: 'Inventario a magazzino', expression: /\binventario(?: a magazzino)?\b/i },
  { status: 'Scaricato', expression: /\bscaricat[ao]\b/i },
  { status: 'Eccezione Raben', expression: /\b(?:non consegnat[ao]|non ritirat[ao]|parere richiesto|parametri errati|delivery failed|exception)\b/i },
  { status: 'Consegnata', expression: /\b(?:consegnat[ao]|delivered)\b/i },
  { status: 'In consegna', expression: /\b(?:in consegna|out for delivery)\b/i },
  { status: 'In transito', expression: /\b(?:partit[ao]|departed)\b/i },
  { status: 'In transito', expression: /\b(?:in transito|in transit|nuova data di consegna)\b/i },
  { status: 'Prenotata', expression: /\b(?:prenotat[ao]|booked)\b/i },
  { status: 'Caricata', expression: /\b(?:caricat[ao]|loaded)\b/i },
  { status: 'Registrata', expression: /\b(?:registrat[ao] a sistema|registered)\b/i },
];

export function canonicalRabenStatus(value) {
  if (isRabenTableHeader(value)) return null;
  return Raben_STATUS_RULES.find((rule) => rule.expression.test(String(value)))?.status || null;
}

export function isRabenTableHeader(value) {
  const label = cleanSnapshot(value).replace(/["'“”]/g, '').trim();
  return /(?:paese|country)\s+(?:città\s*\/\s*deposito|city\s*\/\s*depot|location)/i.test(label)
    || /^(?:data\s+(?:ora\s+)?stato della spedizione|date\s+(?:time\s+)?shipment status)/i.test(label)
    || /^(?:paese|città\s*\/\s*deposito|osservazioni|country|city\s*\/\s*depot|remarks)$/i.test(label);
}

export function normalizeDiscoveredRabenStatus(value) {
  if (isRabenTableHeader(value)) return '';
  const label = cleanSnapshot(value)
    .replace(/^(?:stato(?: della)? spedizione|shipment status)\s*[:\-]\s*/i, '')
    .replace(/[.:;,\-\s]+$/, '')
    .slice(0, 80);
  if (label.length < 3 || label.split(/\s+/).length > 12 || !/[a-zà-öø-ÿ]{2}/i.test(label)) return '';
  if (/^(?:__proto__|prototype|constructor)$/i.test(label)) return '';
  if (/^(?:status|stato|tracking|spedizione|shipment|dettagli|details|n\/a|non disponibile|not available)$/i.test(label)) return '';
  if (/captcha|access denied|single sign-on|\bsso\b|autenticazione|password|errore|error|non trovat|not found|riprova|try again/i.test(label)) return '';
  return label.charAt(0).toLocaleUpperCase('it-IT') + label.slice(1);
}

function statusResult(status, detail, { evidence = 'none', confidence = 0, reasonCode = 'STATUS_UNRESOLVED', rawStatus = '', statusDateRaw = '', statusAt = '', statusDatePrecision = '' } = {}) {
  return { status, detail, rawStatus: cleanSnapshot(rawStatus).slice(0, 160), evidence, confidence, reasonCode, statusDateRaw, statusAt, statusDatePrecision, parserVersion: Raben_PARSER_VERSION };
}

export function parseRabenStatusSnapshot(snapshot) {
  const raw = String(snapshot ?? '');
  const text = cleanSnapshot(raw);
  const guarded = /captcha|recaptcha|verify you are human|access denied|sign in|log in|password|accedi|autenticazione|single sign-on|\bsso\b/i.test(raw);
  if (guarded) return statusResult('Intervento manuale richiesto', 'Il portale Raben richiede una verifica manuale. Apri il collegamento nel browser e riprova.', { evidence: 'guard', confidence: 1, reasonCode: 'ACCESS_GUARD' });
  if (/spedizione non trovata|shipment not found/i.test(raw)) return statusResult('Spedizione non trovata', 'Raben non trova il numero di riferimento indicato.', { evidence: 'message', confidence: .98, reasonCode: 'SHIPMENT_NOT_FOUND' });

  const headlinePatterns = [
    /la tua spedizione\s+(?:è|e')\s+([^\n!?.]{2,100})/i,
    /your shipment\s+is\s+([^\n!?.]{2,100})/i,
    /lo status attuale della tua spedizione(?:\s+è|\s+is)\s*[:\-]?\s*([^\n.!]{2,140})/i,
    /(?:current status of your shipment)(?:\s+is)?\s*[:\-]?\s*([^\n.!]{2,140})/i,
  ];
  for (const pattern of headlinePatterns) {
    const match = raw.match(pattern);
    const canonical = match && canonicalRabenStatus(match[1]);
    const status = canonical || (match && normalizeDiscoveredRabenStatus(match[1]));
    if (status) return statusResult(status, canonical ? 'Stato corrente letto dal riepilogo della pagina pubblica Raben.' : 'Nuovo stato corrente scoperto nel riepilogo Raben.', { evidence: 'headline', confidence: .99, reasonCode: canonical ? 'STATUS_CONFIRMED' : 'STATUS_DISCOVERED', rawStatus: match[1] });
  }

  const activeLine = raw.split(/\r?\n/).find((line) => /\b(?:selected|current|active|aria-current|stato attuale|step attuale)\b/i.test(line) && canonicalRabenStatus(line));
  if (activeLine) return statusResult(canonicalRabenStatus(activeLine), 'Stato corrente letto dallo step attivo della pagina pubblica Raben.', { evidence: 'active-step', confidence: .96, reasonCode: 'STATUS_CONFIRMED', rawStatus: activeLine });

  const labelledPatterns = [
    /(?:shipment|tracking|delivery)\s+status\s*[:\-]?\s*([^\n|]{2,100})/i,
    /(?:stato(?: della)? spedizione)\s*[:\-]?\s*([^\n|]{2,100})/i,
  ];
  for (const pattern of labelledPatterns) {
    const match = raw.match(pattern);
    const canonical = match && canonicalRabenStatus(match[1]);
    // A table's column heading is not an explicit current-status field.
    const status = canonical || (match && !/\b(?:row|columnheader)\b/i.test(match.input.slice(Math.max(0, match.index - 40), match.index)) && normalizeDiscoveredRabenStatus(match[1]));
    if (status) return statusResult(status, canonical ? 'Stato corrente letto dalla pagina pubblica Raben.' : 'Nuovo stato corrente scoperto nel campo stato Raben.', { evidence: 'label', confidence: .9, reasonCode: canonical ? 'STATUS_CONFIRMED' : 'STATUS_DISCOVERED', rawStatus: match[1] });
  }

  if (!raw.includes('\n') && text.length <= 200) {
    const compactStatus = canonicalRabenStatus(raw);
    if (compactStatus) return statusResult(compactStatus, 'Stato riconosciuto nel riepilogo Raben.', { evidence: 'compact-text', confidence: .82, reasonCode: 'STATUS_INFERRED', rawStatus: raw });
  }

  const statusesFound = new Set(Raben_STATUS_RULES.filter((rule) => rule.expression.test(raw)).map((rule) => rule.status));
  if (statusesFound.size === 1) return statusResult([...statusesFound][0], 'Unico stato riconoscibile nella pagina pubblica Raben.', { evidence: 'unique-text', confidence: .72, reasonCode: 'STATUS_INFERRED', rawStatus: [...statusesFound][0] });
  return statusResult('Da verificare manualmente', text ? 'La pagina non espone ancora uno stato corrente riconoscibile.' : 'Nessun contenuto leggibile restituito dalla pagina.', { evidence: 'none', confidence: 0, reasonCode: text ? 'STATUS_NOT_READY' : 'EMPTY_PAGE' });
}

export function normalizeRabenTimeline(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 60).map((row) => {
    let date = cleanSnapshot(row?.date).slice(0, 80);
    let location = cleanSnapshot(row?.location).slice(0, 160);
    if (!parseRabenEventDate(date).local && parseRabenEventDate(location).local) [date, location] = [location, date];
    return {
      event: cleanSnapshot(row?.event).slice(0, 160),
      country: cleanSnapshot(row?.country).slice(0, 40),
      date,
      location,
      reason: cleanSnapshot(row?.reason).slice(0, 300),
    };
  }).filter((row) => !isRabenTableHeader(row.event) && (row.event || row.date || row.location || row.reason));
}

// Recover dated history from accessibility snapshots if DOM evaluation fails.
export function parseRabenSnapshotEvidence(snapshot) {
  const timeline = [];
  let cells = [];
  let rowText = '';
  let inHistory = false;
  let previousText = '';
  const summary = {};
  const unquote = (value) => {
    try { return JSON.parse(value); } catch { return value.replace(/^"|"$/g, ''); }
  };
  const flush = () => {
    if (!inHistory) return;
    if (cells.length >= 3 && parseRabenEventDate(cells[0]).local) {
      const separateTime = /^\d{1,2}:\d{2}$/.test(cells[1]);
      const index = separateTime ? 2 : 1;
      timeline.push({ date: [cells[0], separateTime ? cells[1] : ''].filter(Boolean).join(' '), event: cells[index], country: cells[index + 1], location: cells[index + 2], reason: cells[index + 3] });
    } else {
      const match = rowText.match(/^(\d{1,2}[./-]\d{1,2}[./-]\d{4})\s+(\d{1,2}:\d{2})\s+(.+)$/);
      if (match) {
        const [, date, time, rest] = match;
        const country = rest.match(/\s+(Italia|Italy|Polonia|Poland|Germania|Germany|Francia|France|Paesi Bassi|Netherlands)\b/i);
        const event = country ? rest.slice(0, country.index) : rest;
        timeline.push({ date: date + ' ' + time, event, country: country?.[1] || '', location: country ? rest.slice(country.index + country[0].length).trim() : '' });
      }
    }
  };
  for (const line of String(snapshot || '').split(/\r?\n/)) {
    if (/^\s*- table(?:\s|:|$)/.test(line)) { flush(); cells = []; rowText = ''; inHistory = false; }
    const row = line.match(/^\s*- row\s+(".*?")\s*:?\s*$/);
    if (row) {
      flush(); cells = []; rowText = unquote(row[1]);
      if (/stato della spedizione|shipment status/i.test(rowText) && /data|date/i.test(rowText)) inHistory = true;
    }
    const cell = line.match(/^\s*- (?:cell|gridcell)\s+(".*?")\s*:?\s*$/);
    if (cell) cells.push(unquote(cell[1]));
    const text = line.match(/^\s*- (?:generic|text|paragraph):\s*(.+)$/);
    if (text) {
      const value = unquote(text[1]).trim();
      if (/^Status$/i.test(value) && previousText && !isRabenTableHeader(previousText)) summary.status = previousText;
      previousText = value;
    }
  }
  flush();
  return { summary, timeline: normalizeRabenTimeline(timeline) };
}

export function parseRabenEventDate(value) {
  const raw = cleanSnapshot(value).slice(0, 80);
  if (!raw) return { raw: '', local: '', precision: '' };
  const italian = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[,\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (italian) {
    const [, day, month, year, hour, minute, second] = italian;
    const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    return hour === undefined
      ? { raw, local: date, precision: 'date' }
      : { raw, local: `${date}T${hour.padStart(2, '0')}:${minute}:${second || '00'}`, precision: 'datetime' };
  }
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) return iso[2]
    ? { raw, local: `${iso[1]}T${iso[2]}:${iso[3]}:${iso[4] || '00'}`, precision: 'datetime' }
    : { raw, local: iso[1], precision: 'date' };
  return { raw, local: '', precision: 'raw' };
}

function timelineRowStatus(row) {
  const value = `${row.event} ${row.reason}`;
  if (/\bnon consegnat|non caricat|rifiutat|eccezion|exception|failed delivery/i.test(value)) return 'Eccezione Raben';
  if (/consegnat[ao] al terminal|terminal dal mittente|sender terminal|delivered to (?:the )?(?:sender )?terminal/i.test(value)) return 'Prenotata';
  if (/\b(?:partit[ao]|departed)\b/i.test(value)) return 'In transito';
  const canonical = canonicalRabenStatus(row.event);
  if (canonical) return canonical;
  if (/fuori per la consegna|out for delivery/i.test(value)) return 'In consegna';
  if (/\b(?:arrivat|arrived)\b/i.test(value)) return 'In transito';
  return null;
}

export function findRabenStatusEvent(status, timeline) {
  const row = newestTimelineRows(timeline).find((item) => timelineRowStatus(item) === status);
  if (!row) return null;
  const parsedDate = parseRabenEventDate(row.date);
  return { ...row, statusDateRaw: parsedDate.raw, statusAt: parsedDate.local, statusDatePrecision: parsedDate.precision };
}

function statusFromTimeline(timeline) {
  for (const row of newestTimelineRows(timeline)) {
    const status = timelineRowStatus(row);
    if (!status) continue;
    const eventDate = parseRabenEventDate(row.date);
    const options = { evidence: 'timeline', confidence: status === 'In transito' ? .76 : status === 'Prenotata' ? .72 : .82, reasonCode: status === 'Eccezione Raben' ? 'EXCEPTION_INFERRED' : 'STATUS_INFERRED', rawStatus: row.event, statusDateRaw: eventDate.raw, statusAt: eventDate.local, statusDatePrecision: eventDate.precision };
    return statusResult(status, status === 'Eccezione Raben' ? 'Stato inferito dall’ultimo evento anomalo dello storico Raben.' : 'Stato inferito dall’ultimo evento utile dello storico Raben.', options);
  }
  return null;
}

function newestTimelineRows(timeline) {
  return normalizeRabenTimeline(timeline)
    .map((row, index) => ({ row, index, local: parseRabenEventDate(row.date).local }))
    .sort((a, b) => {
      if (a.local && b.local) return b.local.localeCompare(a.local);
      if (a.local) return -1;
      if (b.local) return 1;
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

export function parseRabenDomEvidence(evidence = {}) {
  const summaryStatus = canonicalRabenStatus(evidence.summary?.status);
  const timelineStatus = statusFromTimeline(evidence.timeline);
  if (summaryStatus) {
    return statusResult(summaryStatus, 'Stato corrente letto dal riepilogo della spedizione Raben.', { evidence: 'dom-summary', confidence: .995, reasonCode: 'STATUS_CONFIRMED', rawStatus: evidence.summary.status });
  }
  for (const summary of evidence.summaryTexts || []) {
    const status = canonicalRabenStatus(summary);
    if (status) {
      return statusResult(status, 'Stato corrente letto dal riepilogo della spedizione Raben.', { evidence: 'dom-summary', confidence: .99, reasonCode: 'STATUS_CONFIRMED', rawStatus: summary });
    }
  }
  const discoveredStatus = normalizeDiscoveredRabenStatus(evidence.summary?.status);
  if (discoveredStatus) {
    return statusResult(discoveredStatus, 'Nuovo stato corrente scoperto automaticamente nel riepilogo Raben. Configura la mappatura PrestaShop nelle impostazioni.', { evidence: 'dom-summary', confidence: .99, reasonCode: 'STATUS_DISCOVERED', rawStatus: evidence.summary.status });
  }
  for (const heading of evidence.headings || []) {
    const result = parseRabenStatusSnapshot(heading);
    if (result.status !== 'Da verificare manualmente') return { ...result, evidence: 'dom-headline', confidence: Math.max(result.confidence, .98) };
  }
  for (const activeText of evidence.activeTexts || []) {
    const statuses = Raben_STATUS_RULES.filter((rule) => rule.expression.test(String(activeText))).map((rule) => rule.status);
    if (statuses.length === 1) return statusResult(statuses[0], 'Stato letto dall’elemento attivo della pagina Raben.', { evidence: 'dom-active-step', confidence: .97, reasonCode: 'STATUS_CONFIRMED', rawStatus: activeText });
  }
  return timelineStatus;
}

export class RabenBetaClient {
  constructor(settings, { signal, trackingTimeoutMs = 120000, scope = 'manual', coordinator = browserCoordinator } = {}) {
    this.settings = normalizeBetaSettings(settings);
    this.userId = 'prestashop-raben-beta';
    this.activeSessionKey = `raben-${scope}-${randomUUID()}`;
    this.requestedSpeedProfile = this.settings.speedProfile;
    this.effectiveSpeedProfile = this.requestedSpeedProfile;
    this.activeTabId = '';
    this.unstableResultCount = 0;
    this.fallbackReason = '';
    this.cookieConsentChecked = false;
    this.signal = signal;
    this.trackingTimeoutMs = trackingTimeoutMs;
    this.scope = scope;
    this.coordinator = coordinator;
  }

  async resetSession(reason = 'La sessione Camoufox è stata reimpostata dopo un errore.') {
    return this.coordinator.run(() => this.resetSessionExclusive(reason), { scope: this.scope, cleanup: true });
  }

  async resetSessionExclusive(reason) {
    const staleTabId = this.activeTabId;
    this.activeTabId = '';
    this.cookieConsentChecked = false;
    this.activeSessionKey = `raben-session-${randomUUID()}`;
    if (this.requestedSpeedProfile !== 'safe') {
      this.effectiveSpeedProfile = 'safe';
      this.fallbackReason = reason;
    }
    await this.closeTab(staleTabId);
  }

  getRuntimeProfile() {
    return {
      requested: this.requestedSpeedProfile,
      effective: this.effectiveSpeedProfile,
      fallback: this.requestedSpeedProfile !== this.effectiveSpeedProfile,
      fallbackReason: this.fallbackReason,
    };
  }

  getPacingDelay(scope = 'manual', random = Math.random) {
    const profile = Raben_SPEED_PROFILES[this.effectiveSpeedProfile];
    const [min, max] = scope === 'cron' ? profile.cronDelayMs : profile.manualDelayMs;
    return min + Math.floor(random() * (max - min + 1));
  }

  async closeTab(tabId) {
    if (!tabId) return;
    await this.request(`/tabs/${encodeURIComponent(tabId)}?userId=${encodeURIComponent(this.userId)}`, { method: 'DELETE', cleanup: true }).catch(() => {});
    if (this.activeTabId === tabId) this.activeTabId = '';
  }

  async close() {
    if (!this.activeTabId) return;
    return this.coordinator.run(() => this.closeExclusive(), { scope: this.scope, cleanup: true });
  }

  async closeExclusive() {
    const tabId = this.activeTabId;
    this.activeTabId = '';
    await this.closeTab(tabId);
  }

  noteTrackingResult(result) {
    const accessGuard = result?.reasonCode === 'ACCESS_GUARD' || result?.status === 'Intervento manuale richiesto';
    const unstable = result?.status === 'Da verificare manualmente' || result?.reasonCode === 'STATUS_TIMEOUT';
    this.unstableResultCount = unstable ? this.unstableResultCount + 1 : 0;
    if (accessGuard && this.effectiveSpeedProfile !== 'safe') {
      this.effectiveSpeedProfile = 'safe';
      this.fallbackReason = 'Modalità affidabile attivata dopo un blocco o una verifica richiesta da Raben.';
      return;
    }
    if (this.effectiveSpeedProfile === 'ultra' && unstable) {
      this.effectiveSpeedProfile = 'fast';
      this.unstableResultCount = 0;
      this.fallbackReason = 'Modalità rapida attivata dopo un risultato non stabile in modalità ultra.';
      return;
    }
    if (this.effectiveSpeedProfile === 'fast' && this.unstableResultCount >= 2) {
      this.effectiveSpeedProfile = 'safe';
      this.fallbackReason = 'Modalità affidabile attivata dopo due risultati consecutivi non stabili.';
    }
  }

  async acquireTab(url) {
    const reuseTab = Raben_SPEED_PROFILES[this.effectiveSpeedProfile].reuseTab;
    if (reuseTab && this.activeTabId) {
      try {
        await this.request(`/tabs/${encodeURIComponent(this.activeTabId)}/navigate`, {
          method: 'POST',
          body: JSON.stringify({ userId: this.userId, sessionKey: this.activeSessionKey, url }),
        });
        return this.activeTabId;
      } catch {
        await this.closeTab(this.activeTabId);
      }
    }
    const tab = await this.request('/tabs', { method: 'POST', body: JSON.stringify({ userId: this.userId, sessionKey: this.activeSessionKey, url }) });
    const tabId = tab.tabId || tab.id;
    if (!tabId) throw new Error('Camofox non ha restituito una scheda di navigazione.');
    if (reuseTab) this.activeTabId = tabId;
    return tabId;
  }

  async request(path, options = {}) {
    const { cleanup, ...fetchOptions } = options;
    const budget = deadline(REQUEST_TIMEOUT_MS, cleanup ? undefined : this.trackSignal || this.signal, 'Camofox non ha risposto entro 20 secondi.');
    try {
      const response = await fetch(`${this.settings.camofoxUrl}${path}`, {
        ...fetchOptions,
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.CAMOFOX_ACCESS_KEY ? { Authorization: `Bearer ${process.env.CAMOFOX_ACCESS_KEY}` } : {}),
          ...(options.headers || {}),
        },
        signal: budget.signal,
      });
      const body = await response.text();
      let data;
      try { data = body ? JSON.parse(body) : {}; } catch { data = { raw: body }; }
      if (!response.ok) throw new Error(data.error || data.message || `Camofox ha risposto HTTP ${response.status}.`);
      return data;
    } catch (error) {
      if (budget.signal.aborted) throw budget.signal.reason;
      if (error instanceof TypeError && error.message === 'fetch failed') throw new Error('Camofox locale non è raggiungibile. Avvialo con npm run camofox e riprova.');
      throw error;
    } finally { budget.dispose(); }
  }

  async testConnection() {
    return this.coordinator.run(() => this.testConnectionExclusive(), { scope: this.scope, signal: this.signal });
  }

  async testConnectionExclusive() {
    // /health conferma soltanto che il server HTTP risponde. /start verifica
    // anche schema, binario, display virtuale e avvio effettivo del browser.
    await this.request('/start', { method: 'POST' });
    return { ok: true };
  }

  async extractDomEvidence(tabId) {
    const expression = `(() => {
      const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      // Cache valido solo per questa lettura: nessun dato sopravvive al polling.
      const textCache = new WeakMap();
      const text = (node) => {
        if (!node) return '';
        if (!textCache.has(node)) textCache.set(node, clean(node.innerText || node.textContent));
        return textCache.get(node);
      };
      const makeRow = (cells) => ({ event: clean(cells[0]), country: clean(cells[1]), date: clean(cells[2]), location: clean(cells[3]), reason: clean(cells[4]) });
      const makeRabenRow = (cells) => ({ date: clean([cells[0], cells[1]].filter(Boolean).join(' ')), event: clean(cells[2]), country: clean(cells[3]), location: clean(cells[4]), reason: clean(cells[5]) });
      const documents = [document];
      for (const frame of document.querySelectorAll('iframe')) { try { if (frame.contentDocument) documents.push(frame.contentDocument); } catch {} }
      const labels = documents.map((doc) => Array.from(doc.querySelectorAll('label')));
      const fieldValue = (labelPattern) => {
        for (const documentLabels of labels) {
          const label = documentLabels.find((node) => labelPattern.test(text(node)));
          const value = label?.parentElement?.querySelector('.form-control-static');
          if (value) return text(value);
        }
        return '';
      };
      const summary = {
        trackingNumber: fieldValue(/^Numero di spedizione \(1\)$/i),
        status: fieldValue(/^Status$/i),
        plannedDeliveryDate: fieldValue(/^Data di consegna pianificata$/i),
        packages: fieldValue(/^Colli$/i),
        grossWeight: fieldValue(/^Peso lordo/i),
        cubicMeters: fieldValue(/^Metri cubi$/i),
      };
      const statusPattern = /^(?:registrat[ao](?: a sistema)?|caricat[ao]|scaricat[ao]|in transito|in consegna|in corso(?: - parere richiesto)?|inventario a magazzino|consegnat[ao](?: con osservazioni)?|non consegnat[ao].*|non ritirat[ao].*)$/i;
      // Un riepilogo noto ha già precedenza su tutte le ricerche generiche.
      // In sua assenza si mantiene integralmente il percorso di recupero.
      const knownSummary = ${JSON.stringify(Raben_STATUS_RULES.map((rule) => ({ source: rule.expression.source, flags: rule.expression.flags })))}.some((rule) => new RegExp(rule.source, rule.flags).test(summary.status));
      const headings = knownSummary ? [] : documents.flatMap((doc) => Array.from(doc.querySelectorAll('h1,h2,h3,[role="heading"]')).map(text)).filter(Boolean).slice(0, 30);
      const summaryTexts = knownSummary ? [] : documents.flatMap((doc) => Array.from(doc.querySelectorAll('span,div,td,dd,strong')).filter((node) => node.children.length === 0).map(text).filter((value) => statusPattern.test(value))).slice(0, 12);
      const activeSelector = '[aria-current="true"],[aria-current="step"],[aria-selected="true"],.active,.selected,.current,[class*="active"],[class*="selected"],[class*="current"]';
      const activeTexts = knownSummary ? [] : documents.flatMap((doc) => Array.from(doc.querySelectorAll(activeSelector)).map(text).filter((value) => value.length <= 160 && /registrat|caricat|scaricat|transit|consegn|deliver|inventario|in corso|parere|ritirat|loaded|exception/i.test(value))).slice(0, 20);
      const timeline = [];
      for (const doc of documents) {
        const tables = Array.from(doc.querySelectorAll('table'));
        const rabenTable = tables.find((item) => /stato della spedizione|shipment status/i.test(text(item)) && /data|date/i.test(text(item)));
        if (rabenTable) timeline.push(...Array.from(rabenTable.querySelectorAll('tr')).map((row) => Array.from(row.querySelectorAll('td')).map(text)).filter((cells) => cells.length >= 3 && /^\\d{1,2}[./-]\\d{1,2}[./-]\\d{4}/.test(cells[0])).map(makeRabenRow));
        const genericTable = tables.find((item) => /evento|event/i.test(text(item)) && /data|date/i.test(text(item)) && /localit|location/i.test(text(item)));
        if (genericTable) timeline.push(...Array.from(genericTable.querySelectorAll('tbody tr')).map((row) => makeRow(Array.from(row.querySelectorAll('td')).map((cell) => cell.innerText))));
        const rows = Array.from(doc.querySelectorAll('[role="row"]')).map((row) => Array.from(row.querySelectorAll('[role="cell"], [role="gridcell"]')).map((cell) => cell.innerText));
        timeline.push(...rows.filter((cells) => cells.length >= 6 && !/data|date/i.test(cells[0] || '')).map(makeRabenRow));
      }
      return { headings, summary, summaryTexts, activeTexts, timeline: timeline.filter((row) => row.event || row.date), frameCount: documents.length - 1 };
    })()`;
    const response = await this.request(`/tabs/${encodeURIComponent(tabId)}/evaluate`, { method: 'POST', body: JSON.stringify({ userId: this.userId, expression }) });
    const result = response.result || {};
    return { headings: Array.isArray(result.headings) ? result.headings.slice(0, 30) : [], summary: result.summary && typeof result.summary === 'object' ? result.summary : {}, summaryTexts: Array.isArray(result.summaryTexts) ? result.summaryTexts.slice(0, 12) : [], activeTexts: Array.isArray(result.activeTexts) ? result.activeTexts.slice(0, 20) : [], timeline: normalizeRabenTimeline(result.timeline), frameCount: Number(result.frameCount) || 0 };
  }

  async waitForTrackingResult(tabId, snapshot) {
    const deadline = Date.now() + TRACKING_POLL_TIMEOUT_MS;
    const acceleratedMode = this.effectiveSpeedProfile !== 'safe';
    const pollIntervals = this.effectiveSpeedProfile === 'ultra'
      ? ULTRA_TRACKING_POLL_INTERVALS_MS
      : FAST_TRACKING_POLL_INTERVALS_MS;
    let best = null;
    let stableStatus = '';
    let stableReads = 0;
    let pollIndex = 0;
    let lastEvidence = { headings: [], summary: {}, summaryTexts: [], activeTexts: [], timeline: [], frameCount: 0 };
    do {
      const domEvidence = await this.extractDomEvidence(tabId).catch((error) => {
        (this.trackSignal || this.signal)?.throwIfAborted();
        return lastEvidence;
      });
      lastEvidence = domEvidence;
      const domResult = parseRabenDomEvidence(domEvidence);
      if (acceleratedMode && domEvidence.timeline.length && domResult?.status !== 'Da verificare manualmente' && domResult?.confidence >= .9) {
        return { result: domResult, timeline: domEvidence.timeline, summary: domEvidence.summary };
      }
      const page = await snapshot();
      const recovered = parseRabenSnapshotEvidence(page);
      if (!domEvidence.timeline.length && recovered.timeline.length) domEvidence.timeline = recovered.timeline;
      if (!domEvidence.summary.status && recovered.summary.status) domEvidence.summary = { ...domEvidence.summary, ...recovered.summary };
      const candidates = [parseRabenStatusSnapshot(page), parseRabenDomEvidence(domEvidence), domResult].filter(Boolean).sort((a, b) => b.confidence - a.confidence);
      const current = candidates[0];
      if (!best || current.confidence > best.confidence) best = current;
      if (current.status !== 'Da verificare manualmente') {
        if (stableStatus === current.status) stableReads += 1;
        else { stableStatus = current.status; stableReads = 1; }
        if (current.confidence >= .9 || stableReads >= 2) return { result: current, timeline: domEvidence.timeline, summary: domEvidence.summary };
      }
      if (Date.now() < deadline) {
        const delayMs = acceleratedMode
          ? pollIntervals[Math.min(pollIndex, pollIntervals.length - 1)]
          : TRACKING_POLL_INTERVAL_MS;
        pollIndex += 1;
        await pause(delayMs, this.trackSignal || this.signal);
      }
    } while (Date.now() < deadline);
    const fallback = best?.status !== 'Da verificare manualmente' ? best : statusResult('Da verificare manualmente', 'Il tracking Raben non ha esposto uno stato stabile entro il tempo previsto. Puoi riprovare.', { evidence: best?.evidence || 'none', confidence: best?.confidence || 0, reasonCode: 'STATUS_TIMEOUT', rawStatus: best?.rawStatus || '' });
    return { result: fallback, timeline: lastEvidence.timeline, summary: lastEvidence.summary };
  }

  async track(trackingNumber, { signal, onWaiting, onStarted } = {}) {
    const parent = signal && this.signal ? AbortSignal.any([signal, this.signal]) : signal || this.signal;
    return this.coordinator.run(() => this.trackExclusive(trackingNumber, { signal: parent }), { scope: this.scope, signal: parent, onWaiting, onStarted });
  }

  async trackExclusive(trackingNumber, { signal } = {}) {
    const parent = signal && this.signal ? AbortSignal.any([signal, this.signal]) : signal || this.signal;
    const budget = deadline(this.trackingTimeoutMs, parent, 'Verifica Raben oltre il tempo massimo complessivo.');
    this.trackSignal = budget.signal;
    let tabId;
    try {
    const trackingUrl = this.settings.trackingUrl.includes('TRACKINGDAINSERIRE')
      ? this.settings.trackingUrl.replaceAll('TRACKINGDAINSERIRE', encodeURIComponent(trackingNumber))
      : this.settings.trackingUrl;
    tabId = await this.acquireTab(trackingUrl);
    const snapshot = async () => {
      const value = await this.request(`/tabs/${encodeURIComponent(tabId)}/snapshot?userId=${encodeURIComponent(this.userId)}`);
      return value.snapshot || value.data?.snapshot || value.raw || '';
    };
    const officialTrackingUrl = trackingUrl;
    const enrich = (statusResult, source, timeline = [], summary = {}) => {
      const normalizedTimeline = normalizeRabenTimeline(timeline);
      const statusEvent = findRabenStatusEvent(statusResult.status, normalizedTimeline);
      const output = { ...statusResult, statusDateRaw: statusEvent?.statusDateRaw || statusResult.statusDateRaw || '', statusAt: statusEvent?.statusAt || statusResult.statusAt || '', statusDatePrecision: statusEvent?.statusDatePrecision || statusResult.statusDatePrecision || '', source, trackingUrl: officialTrackingUrl, timeline: normalizedTimeline, portalTrackingNumber: cleanSnapshot(summary.trackingNumber), plannedDeliveryDate: cleanSnapshot(summary.plannedDeliveryDate), packages: cleanSnapshot(summary.packages), grossWeight: cleanSnapshot(summary.grossWeight), cubicMeters: cleanSnapshot(summary.cubicMeters) };
      this.noteTrackingResult(output);
      return output;
    };
      await pause(Raben_SPEED_PROFILES[this.effectiveSpeedProfile].initialDelayMs, this.trackSignal);
      const directUrl = this.settings.trackingUrl.includes('TRACKINGDAINSERIRE');
      const shouldInspectEntryPage = this.effectiveSpeedProfile === 'safe' || !directUrl || !this.cookieConsentChecked;
      let page = '';
      if (shouldInspectEntryPage) {
        page = await snapshot();
        const necessaryOnlyRef = findRef(page, /use necessary cookies only|rifiuta tutto|solo cookie necessari|reject all/i);
        if (necessaryOnlyRef) {
          await this.request(`/tabs/${encodeURIComponent(tabId)}/click`, { method: 'POST', body: JSON.stringify({ userId: this.userId, ref: necessaryOnlyRef }) });
          await pause(350, this.trackSignal);
          page = await snapshot();
        }
        this.cookieConsentChecked = true;
      }

      if (directUrl) {
        const observed = await this.waitForTrackingResult(tabId, snapshot);
        return enrich(observed.result, 'Portale pubblico Raben.', observed.timeline, observed.summary);
      }

      const accessState = parseRabenStatusSnapshot(page);
      if (accessState.reasonCode === 'ACCESS_GUARD') return enrich(accessState, 'Sessione myRaben.');

      const trackingMenuRef = findRef(page, /(?:button|link).*\b(?:track|tracking|spedizioni|ricerca spedizioni)\b/i);
      if (trackingMenuRef) {
        await this.request(`/tabs/${encodeURIComponent(tabId)}/click`, { method: 'POST', body: JSON.stringify({ userId: this.userId, ref: trackingMenuRef }) });
        await pause(500, this.trackSignal);
        page = await snapshot();
      }

      const inputRef = findRef(page, /(?:textbox|input).*?(?:numero di spedizione|shipment number|shipment|tracking|reference|riferimento)/i);
      if (!inputRef) return enrich(statusResult('Da verificare manualmente', 'Pagina Raben aperta, campo di ricerca non riconosciuto.', { evidence: 'form', confidence: 0, reasonCode: 'TRACKING_INPUT_NOT_FOUND' }), 'Pagina Raben aperta, campo di ricerca non riconosciuto.');
      await this.request(`/tabs/${encodeURIComponent(tabId)}/type`, { method: 'POST', body: JSON.stringify({ userId: this.userId, ref: inputRef, text: trackingNumber, clear: true, submit: true }) });
      const observed = await this.waitForTrackingResult(tabId, snapshot);
      return enrich(observed.result, 'Portale pubblico Raben tramite Camofox.', observed.timeline, observed.summary);
    } finally {
      const aborted = budget.signal.aborted;
      budget.dispose();
      this.trackSignal = null;
      if (aborted || !Raben_SPEED_PROFILES[this.effectiveSpeedProfile].reuseTab || this.activeTabId !== tabId) await this.closeTab(tabId);
    }
  }
}
