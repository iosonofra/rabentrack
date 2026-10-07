import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRabenStatusEvent, normalizeRabenTimeline, parseRabenEventDate } from './raben-beta-client.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const storePath = join(projectRoot, 'data', 'shipments.json');
let database = null;
let writeChain = Promise.resolve();

async function load() {
  if (database) return database;
  try { database = JSON.parse(await readFile(storePath, 'utf8')); }
  catch { database = { shipments: {} }; }
  database.shipments ||= {};
  database.batches ||= [];
  database.operations ||= [];
  let migrated = false;
  for (const record of Object.values(database.shipments)) {
    const normalizedStatus = normalizeStoredRabenStatus(record.rabenStatus);
    if (record.rabenStatus !== normalizedStatus) {
      record.rabenStatus = normalizedStatus;
      migrated = true;
    }
    if ('rabenPhaseStatus' in record) {
      delete record.rabenPhaseStatus;
      migrated = true;
    }
    if (!Array.isArray(record.rabenTimeline)) continue;
    const normalizedTimeline = normalizeRabenTimeline(record.rabenTimeline);
    if (JSON.stringify(normalizedTimeline) !== JSON.stringify(record.rabenTimeline)) {
      record.rabenTimeline = normalizedTimeline;
      migrated = true;
    }
    const storedDate = parseRabenEventDate(record.rabenStatusDateRaw);
    if (record.rabenStatusAt || storedDate.local) continue;
    const event = findRabenStatusEvent(normalizeStoredRabenStatus(record.rabenStatus), normalizedTimeline);
    if (!event?.statusDateRaw) continue;
    record.rabenStatusAt = event.statusAt;
    record.rabenStatusDateRaw = event.statusDateRaw;
    record.rabenStatusDatePrecision = event.statusDatePrecision;
    migrated = true;
  }
  if (migrated) await persist();
  return database;
}

function now() { return new Date().toISOString(); }
function addEvent(record, type, label, detail = '') {
  const last = record.events?.at(-1);
  if (last?.type === type && last.label === label && last.detail === detail) return;
  record.events = [...(record.events || []), { at: now(), type, label, detail }].slice(-30);
}

export function normalizeStoredRabenStatus(value) {
  const normalized = String(value || '').trim().toLocaleLowerCase('it-IT');
  if (/^consegnata con riserva$|^consegnato con osservazioni$/.test(normalized)) return 'Consegnata con riserva';
  if (/^consegnat[oa]$|^delivered$/.test(normalized)) return 'Consegnata';
  if (/^in consegna$|^out for delivery$/.test(normalized)) return 'In consegna';
  if (/^consegnat[oa] al terminal$|terminal dal mittente/.test(normalized)) return 'Prenotata';
  if (/^partit[oa]$|^departed$/.test(normalized)) return 'In transito';
  if (/centro di distribuzione|distribution cent(?:er|re)/.test(normalized)) return 'Centro di distribuzione';
  if (/^in transito$|^in transit$/.test(normalized)) return 'In transito';
  if (/^caricat[oa]$|^loaded$/.test(normalized)) return 'Caricata';
  if (/^registrat[oa]$|^registered$/.test(normalized)) return 'Registrata';
  if (/^prenotat[oa]$|^booked$/.test(normalized)) return 'Prenotata';
  if (/eccezione raben|non consegnat|non ritirat|parere richiesto/.test(normalized)) return 'Eccezione Raben';
  return String(value || '').trim();
}

function operationalStatus(record) {
  const value = normalizeStoredRabenStatus(record.rabenStatus).toLocaleLowerCase('it-IT');
  if (/consegnata con riserva/.test(value)) return 'Da gestire';
  if (/consegnat|delivered/.test(value)) return 'Consegnata';
  if (/in consegna|out for delivery/.test(value)) return 'In consegna';
  if (/centro di distribuzione/.test(value)) return 'Centro di distribuzione';
  if (/in transito|transit/.test(value)) return 'In transito';
  if (/caricat|registrat|prenotat|booked/.test(value)) return 'Prenotata';
  if (/errore (?:beta|verifica)|verificare manualmente/.test(value)) return 'Verifica incompleta';
  if (/non trovata|intervento manuale|eccezione raben/.test(value)) return 'Da gestire';
  if (record.prestaStatus === 'Tracking già presente') return 'Tracking già presente';
  if (/errore|non trovato|ambiguo/.test(String(record.prestaStatus || '').toLocaleLowerCase('it-IT'))) return 'Da gestire';
  return 'In attesa di verifica Raben';
}

export function matchesOperationalStatus(recordStatus, requestedStatus) {
  if (!requestedStatus) return true;
  if (requestedStatus === 'Da verificare') return ['In attesa di verifica Raben', 'Verifica incompleta'].includes(recordStatus);
  if (requestedStatus === 'In movimento') return ['Centro di distribuzione', 'In transito', 'In consegna'].includes(recordStatus);
  return recordStatus === requestedStatus;
}

export function buildRabenStatusCounts(records) {
  return records.reduce((output, record) => {
    const status = normalizeStoredRabenStatus(record.rabenStatus) || 'Non verificato';
    output[status] = (output[status] || 0) + 1;
    return output;
  }, {});
}

export function normalizeShipmentSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('it-IT')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compactShipmentSearchText(value) {
  return normalizeShipmentSearchText(value).replace(/\s+/g, '');
}

export function rankShipmentSearchMatch(record = {}, query = '') {
  const normalizedQuery = normalizeShipmentSearchText(query);
  if (!normalizedQuery) return null;
  const compactQuery = compactShipmentSearchText(query);
  const tokens = normalizedQuery.split(' ').filter(Boolean);
  const fields = [
    ['trackingNumber', 'Tracking', record.trackingNumber, 1_000, true],
    ['secondaryTrackingNumber', 'Tracking secondario', record.secondaryTrackingNumber, 950, true],
    ['orderReference', 'Riferimento ordine', record.orderReference, 900, true],
    ['orderReferenceRaw', 'Riferimento originale', record.orderReferenceRaw, 875, true],
    ['orderId', 'ID ordine', record.orderId, 850, true],
    ['recipient', 'Destinatario', record.recipient, 700, false],
    ['rabenStatus', 'Stato Raben', normalizeStoredRabenStatus(record.rabenStatus), 620, false],
    ['currentState', 'Stato PrestaShop', record.currentState, 600, false],
    ['deliveryCity', 'Città di consegna', record.deliveryCity, 540, false],
    ['deliveryLocation', 'Località di consegna', record.deliveryLocation, 520, false],
  ].filter(([, , value]) => String(value || '').trim());

  let best = null;
  for (const [field, label, rawValue, weight, isCode] of fields) {
    const value = String(rawValue).trim();
    const normalizedValue = normalizeShipmentSearchText(value);
    const compactValue = compactShipmentSearchText(value);
    const directNeedle = isCode && compactQuery.length >= 2 ? compactQuery : normalizedQuery;
    const directValue = isCode ? compactValue : normalizedValue;
    let score = 0;
    if (directValue === directNeedle) score = weight + 300;
    else if (directValue.startsWith(directNeedle)) score = weight + 180;
    else if (directValue.includes(directNeedle)) score = weight + 90;
    if (score && (!best || score > best.score)) best = { field, label, value, score };
  }

  if (best) return best;
  const corpus = fields.map(([, , value]) => normalizeShipmentSearchText(value)).join(' ');
  if (tokens.every((token) => corpus.includes(token))) {
    const field = fields.find(([, , value]) => tokens.some((token) => normalizeShipmentSearchText(value).includes(token)));
    return { field: field?.[0] || 'shipment', label: field?.[1] || 'Spedizione', value: String(field?.[2] || ''), score: 250 + tokens.length * 10 };
  }
  return null;
}

export function searchShipmentRecords(records = [], query = '', limit = 6) {
  const normalizedLimit = Math.min(20, Math.max(1, Number.parseInt(limit, 10) || 6));
  return records
    .map((record) => ({ record, match: rankShipmentSearchMatch(record, query) }))
    .filter(({ match }) => Boolean(match))
    .sort((left, right) => right.match.score - left.match.score
      || Number(Boolean(left.record.archived)) - Number(Boolean(right.record.archived))
      || String(right.record.rabenCheckedAt || right.record.lastSeenAt || '').localeCompare(String(left.record.rabenCheckedAt || left.record.lastSeenAt || '')))
    .slice(0, normalizedLimit)
    .map(({ record, match }) => ({
      trackingNumber: record.trackingNumber,
      secondaryTrackingNumber: record.secondaryTrackingNumber || '',
      orderReference: record.orderReference || '',
      orderId: record.orderId || '',
      recipient: record.recipient || '',
      rabenStatus: normalizeStoredRabenStatus(record.rabenStatus) || 'Non verificato',
      currentState: record.currentState || '',
      archived: Boolean(record.archived),
      checkedAt: record.rabenCheckedAt || record.lastSeenAt || '',
      match,
    }));
}

export async function searchShipments(query, limit = 6) {
  const db = await load();
  return searchShipmentRecords(Object.values(db.shipments || {}), query, limit);
}

export async function getExistingShipmentsIndex() {
  const db = await load();
  const byTracking = new Map();
  const byReference = new Map();
  for (const record of Object.values(db.shipments || {})) {
    if (record.trackingNumber) byTracking.set(record.trackingNumber, record);
    if (record.orderReference) byReference.set(record.orderReference, record);
  }
  return { byTracking, byReference };
}

async function persist() {
  const next = writeChain.then(async () => {
    await mkdir(dirname(storePath), { recursive: true });
    const temporaryPath = `${storePath}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(database), 'utf8');
    await rename(temporaryPath, storePath);
  });
  writeChain = next.catch(() => {});
  return next;
}

export async function syncVerifiedShipments(rows) {
  const db = await load();
  for (const row of rows) {
    if (!row.trackingNumber || row.alreadyImported) continue;
    const previous = db.shipments[row.trackingNumber] || { trackingNumber: row.trackingNumber, events: [] };
    const record = db.shipments[row.trackingNumber] = {
      ...previous,
      trackingNumber: row.trackingNumber,
      secondaryTrackingNumber: row.secondaryTrackingNumber || previous.secondaryTrackingNumber || '',
      orderReference: row.orderReference || previous.orderReference || '',
      orderReferenceRaw: row.orderReferenceRaw || previous.orderReferenceRaw || '',
      orderReferenceAdjusted: Boolean(row.orderReferenceAdjusted),
      orderId: row.orderId || previous.orderId || '',
      orderDate: row.orderDate || previous.orderDate || '',
      pickupDate: row.pickupDate || previous.pickupDate || '',
      plannedDeliveryDate: row.plannedDeliveryDate || previous.plannedDeliveryDate || '',
      etaFrom: row.etaFrom || previous.etaFrom || '',
      etaTo: row.etaTo || previous.etaTo || '',
      recipient: row.recipient || previous.recipient || '',
      deliveryLocation: row.deliveryLocation || previous.deliveryLocation || '',
      deliveryCountry: row.deliveryCountry || previous.deliveryCountry || '',
      deliveryCity: row.deliveryCity || previous.deliveryCity || '',
      sender: row.sender || previous.sender || '',
      palletPlaces: row.palletPlaces || previous.palletPlaces || '',
      duplicateReference: Boolean(row.duplicateReference),
      prestaStateId: row.prestaStateId || previous.prestaStateId || '',
      currentState: row.currentState || previous.currentState || '—',
      prestaStatus: row.verification || row.validation || previous.prestaStatus || '',
      existingTracking: row.existingTracking || previous.existingTracking || '',
      rabenStatus: normalizeStoredRabenStatus(row.rabenStatus || previous.rabenStatus),
      rabenRawStatus: row.rabenRawStatus || previous.rabenRawStatus || '',
      rabenEvidence: row.rabenStatus ? 'raben-export' : previous.rabenEvidence || '',
      rabenConfidence: row.rabenStatus ? 0.85 : Number(previous.rabenConfidence) || 0,
      rabenReasonCode: row.rabenStatus ? 'STATUS_FROM_EXPORT' : previous.rabenReasonCode || '',
      rabenCheckedAt: previous.rabenCheckedAt || '',
      createdAt: previous.createdAt || now(),
      lastSeenAt: now(),
      events: previous.events || [],
    };
    addEvent(record, 'prestashop', record.prestaStatus, record.currentState);
    if (row.rabenStatus) addEvent(record, 'raben', record.rabenStatus, `Stato iniziale importato dal file Raben${row.rabenRawStatus ? `: ${row.rabenRawStatus}` : ''}`);
  }
  await persist();
}

export async function syncRabenShipments(results) {
  const db = await load();
  for (const result of results) {
    const record = db.shipments[result.trackingNumber] ||= { trackingNumber: result.trackingNumber, events: [] };
    const nextRabenStatus = normalizeStoredRabenStatus(result.status);
    const sameRabenStatus = normalizeStoredRabenStatus(record.rabenStatus) === nextRabenStatus;
    record.rabenStatus = nextRabenStatus;
    record.rabenDetail = result.detail || '';
    record.rabenRawStatus = result.rawStatus || '';
    delete record.rabenPhaseStatus;
    record.rabenEvidence = result.evidence || '';
    record.rabenConfidence = Number(result.confidence) || 0;
    record.rabenReasonCode = result.reasonCode || '';
    record.rabenParserVersion = Number(result.parserVersion) || 1;
    record.rabenTrackingUrl = result.trackingUrl || record.rabenTrackingUrl || '';
    record.rabenTimeline = Array.isArray(result.timeline) ? result.timeline.slice(0, 60) : (record.rabenTimeline || []);
    record.portalTrackingNumber = result.portalTrackingNumber || record.portalTrackingNumber || '';
    record.plannedDeliveryDate = result.plannedDeliveryDate || record.plannedDeliveryDate || '';
    record.packages = result.packages || record.packages || '';
    record.grossWeight = result.grossWeight || record.grossWeight || '';
    record.cubicMeters = result.cubicMeters || record.cubicMeters || '';
    record.rabenStatusAt = result.statusAt || (sameRabenStatus ? record.rabenStatusAt || '' : '');
    record.rabenStatusDateRaw = result.statusDateRaw || (sameRabenStatus ? record.rabenStatusDateRaw || '' : '');
    record.rabenStatusDatePrecision = result.statusDatePrecision || (sameRabenStatus ? record.rabenStatusDatePrecision || '' : '');
    record.rabenCheckedAt = now();
    record.lastSeenAt = now();
    addEvent(record, 'raben', result.status, result.detail || '');
  }
  await persist();
}

export async function syncAppliedShipments(results) {
  const db = await load();
  for (const result of results) {
    if (!result.trackingNumber) continue;
    const record = db.shipments[result.trackingNumber] ||= { trackingNumber: result.trackingNumber, events: [] };
    record.lastImportResult = result.result;
    record.lastImportDetail = result.detail || '';
    record.lastImportedAt = now();
    record.lastSeenAt = now();
    if (result.result === 'Aggiornata' && result.currentState) record.currentState = result.currentState;
    addEvent(record, 'importazione', result.result, result.detail || '');
  }
  await persist();
}

export async function syncManualPrestaShopState(trackingNumber, { stateId, stateName }) {
  const db = await load();
  const record = db.shipments[trackingNumber];
  if (!record) throw new Error('Spedizione non presente nel centro di controllo.');
  record.currentState = String(stateName || '').trim() || record.currentState || '—';
  record.prestaStateId = String(stateId || '');
  record.prestaStatus = 'Stato aggiornato dal tracking center';
  record.prestaCheckedAt = now();
  record.lastSeenAt = now();
  addEvent(record, 'prestashop', 'Stato PrestaShop aggiornato', record.currentState);
  await persist();
  return { ...record, rabenStatus: normalizeStoredRabenStatus(record.rabenStatus), operationalStatus: operationalStatus(record) };
}

export async function syncShipmentPrestaShopShipping(trackingNumber, { orderId, orderReference, carrierId, carrierName, overwritten }) {
  const db = await load();
  const record = db.shipments[trackingNumber];
  if (!record) throw new Error('Spedizione non presente nel centro di controllo.');
  if (orderId && !record.orderId) record.orderId = orderId;
  if (orderReference && !record.orderReference) record.orderReference = orderReference;
  record.prestaCarrierId = carrierId ? String(carrierId) : record.prestaCarrierId;
  record.prestaCarrierName = carrierName ? String(carrierName) : record.prestaCarrierName;
  record.prestaTrackingSynced = true;
  record.prestaTrackingSyncedAt = now();
  record.lastSeenAt = now();
  const actionLabel = overwritten ? 'Tracking PrestaShop sovrascritto' : 'Tracking e corriere sincronizzati';
  const detail = [carrierName ? `Corriere: ${carrierName}` : '', carrierId ? `(ID ${carrierId})` : ''].filter(Boolean).join(' ');
  addEvent(record, 'prestashop', actionLabel, detail || 'Tracking aggiornato su PrestaShop');
  await persist();
  return { ...record, rabenStatus: normalizeStoredRabenStatus(record.rabenStatus), operationalStatus: operationalStatus(record) };
}

export async function linkShipmentToPrestaShopOrder(trackingNumber, {
  orderId,
  orderReference,
  orderDate,
  currentStateId,
  currentStateName,
  trackingNumberOnPrestaShop,
  carrierId,
  carrierName,
} = {}) {
  const db = await load();
  const record = db.shipments[trackingNumber];
  if (!record) throw new Error('Spedizione non presente nel centro di controllo.');
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) throw new Error('L’ordine PrestaShop selezionato non è valido.');

  record.orderId = normalizedOrderId;
  record.orderReference = String(orderReference || record.orderReference || '').trim();
  record.orderDate = String(orderDate || record.orderDate || '').trim();
  record.currentState = String(currentStateName || record.currentState || '—').trim() || '—';
  record.prestaStateId = String(currentStateId || '').trim();
  record.existingTracking = String(trackingNumberOnPrestaShop || '').trim();
  record.prestaCarrierId = String(carrierId || record.prestaCarrierId || '').trim();
  record.prestaCarrierName = String(carrierName || record.prestaCarrierName || '').trim();
  record.prestaStatus = 'Ordine collegato manualmente';
  record.prestaCheckedAt = now();
  record.linkedManuallyAt = record.prestaCheckedAt;
  record.lastSeenAt = record.prestaCheckedAt;
  const orderLabel = record.orderReference || normalizedOrderId;
  addEvent(record, 'prestashop', 'Ordine PrestaShop collegato', `Ordine ${orderLabel} · ID ${normalizedOrderId}`);
  await persist();
  return { ...record, archived: Boolean(record.archived), rabenStatus: normalizeStoredRabenStatus(record.rabenStatus), operationalStatus: operationalStatus(record) };
}

export function isShipmentTrackingUnsynced(record) {
  if (record.archived) return false;
  const hasOrder = Boolean(record.orderReference || record.orderId);
  if (!hasOrder) return false;
  if (record.prestaTrackingSynced === true) return false;
  if (record.lastImportResult === 'Aggiornata' && record.prestaStatus !== 'Errore') return false;
  return true;
}

export async function getControlCenter({ query = '', status = '', rabenStatus = '', prestaState = '', unsynced = false, checkedAfter = '', exceptionOnly = false, archived = false, checkSort = 'desc', page = 1, pageSize = 50 } = {}) {
  const db = await load();
  const searchQuery = String(query || '').trim().slice(0, 160);
  const isArchivedView = archived === true || archived === '1' || archived === 'true' || rabenStatus === 'Archiviate';
  const isUnsyncedView = unsynced === true || unsynced === '1' || unsynced === 'true';
  const allRecords = Object.values(db.shipments).map((record) => {
    const normRaben = normalizeStoredRabenStatus(record.rabenStatus);
    const opStatus = operationalStatus(record);
    return {
      ...record,
      archived: Boolean(record.archived),
      rabenStatus: normRaben,
      operationalStatus: opStatus,
      isUnsynced: isShipmentTrackingUnsynced(record),
      searchMatch: searchQuery ? rankShipmentSearchMatch(record, searchQuery) : null,
    };
  });

  const activeRecords = allRecords.filter((record) => !record.archived);
  const archivedRecords = allRecords.filter((record) => record.archived);
  const archivedCount = archivedRecords.length;
  const unsyncedCount = activeRecords.filter((record) => record.isUnsynced).length;

  const targetRecords = isArchivedView ? archivedRecords : activeRecords;

  const filteredWithoutPrestaState = targetRecords.filter((record) => {
    const matchesQuery = !searchQuery || Boolean(record.searchMatch);
    const matchesStatus = matchesOperationalStatus(record.operationalStatus, status);
    const matchesRabenStatus = (!rabenStatus || rabenStatus === 'Archiviate') ? true : (record.rabenStatus || 'Non verificato') === rabenStatus;
    const matchesCheckedAfter = !checkedAfter || String(record.rabenCheckedAt || record.lastSeenAt || '') >= `${checkedAfter}T00:00:00.000Z`;
    const matchesUnsynced = !isUnsyncedView || record.isUnsynced;
    const isException = ['Da gestire', 'Verifica incompleta'].includes(record.operationalStatus);
    return matchesQuery && matchesStatus && matchesRabenStatus && matchesCheckedAfter && matchesUnsynced && (!exceptionOnly || isException);
  });

  const prestaStateCounts = filteredWithoutPrestaState.reduce((output, record) => {
    const label = !record.orderId
      ? 'Ordine non collegato'
      : String(record.currentState || '').trim() || 'Stato non disponibile';
    output[label] = (output[label] || 0) + 1;
    return output;
  }, {});
  const normalizedPrestaState = String(prestaState || '').trim();
  const sortDirection = String(checkSort || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
  const filtered = filteredWithoutPrestaState.filter((record) => {
    if (!normalizedPrestaState) return true;
    if (normalizedPrestaState === '__unlinked__') return !record.orderId;
    if (normalizedPrestaState === '__unavailable__') return Boolean(record.orderId) && !String(record.currentState || '').trim();
    return String(record.currentState || '').trim().toLocaleLowerCase('it-IT') === normalizedPrestaState.toLocaleLowerCase('it-IT');
  }).sort((a, b) => {
    if (searchQuery && Number(b.searchMatch?.score || 0) !== Number(a.searchMatch?.score || 0)) {
      return Number(b.searchMatch?.score || 0) - Number(a.searchMatch?.score || 0);
    }
    const timeA = String(a.rabenCheckedAt || a.lastSeenAt || '');
    const timeB = String(b.rabenCheckedAt || b.lastSeenAt || '');
    if (!timeA && !timeB) return String(a.trackingNumber || '').localeCompare(String(b.trackingNumber || ''));
    if (!timeA) return 1;
    if (!timeB) return -1;
    const cmp = sortDirection === 'asc' ? timeA.localeCompare(timeB) : timeB.localeCompare(timeA);
    if (cmp !== 0) return cmp;
    return String(a.trackingNumber || '').localeCompare(String(b.trackingNumber || ''));
  });

  const counts = activeRecords.reduce((output, record) => {
    output[record.operationalStatus] = (output[record.operationalStatus] || 0) + 1;
    return output;
  }, {});

  const rabenCounts = buildRabenStatusCounts(activeRecords);
  const normalizedPageSize = Math.min(500, Math.max(1, Number.parseInt(pageSize, 10) || 50));
  const filteredTotal = filtered.length;
  const totalPages = Math.max(1, Math.ceil(filteredTotal / normalizedPageSize));
  const normalizedPage = Math.min(totalPages, Math.max(1, Number.parseInt(page, 10) || 1));
  const offset = (normalizedPage - 1) * normalizedPageSize;

  return {
    counts,
    rabenCounts,
    prestaStateCounts,
    prestaStateFacetTotal: filteredWithoutPrestaState.length,
    archivedCount,
    unsyncedCount,
    total: activeRecords.length,
    viewTotal: targetRecords.length,
    filteredTotal,
    page: normalizedPage,
    pageSize: normalizedPageSize,
    totalPages,
    checkSort: sortDirection,
    records: filtered.slice(offset, offset + normalizedPageSize),
  };
}

export async function getShipment(trackingNumber) {
  const db = await load();
  const record = db.shipments[trackingNumber];
  return record ? { ...record, archived: Boolean(record.archived), rabenStatus: normalizeStoredRabenStatus(record.rabenStatus), operationalStatus: operationalStatus(record) } : null;
}

export async function archiveShipment(trackingNumber, archived = true) {
  const db = await load();
  const record = db.shipments[trackingNumber];
  if (!record) throw new Error('Spedizione non presente nel centro di controllo.');
  const isArchived = Boolean(archived);
  record.archived = isArchived;
  record.archivedAt = isArchived ? now() : null;
  record.lastSeenAt = now();
  addEvent(record, 'gestione', isArchived ? 'Spedizione archiviata' : 'Spedizione ripristinata', isArchived ? 'Archiviata manualmente' : 'Ripristinata tra le spedizioni attive');
  await persist();
  return { ...record, archived: isArchived, rabenStatus: normalizeStoredRabenStatus(record.rabenStatus), operationalStatus: operationalStatus(record) };
}

export async function updateShipmentCase(trackingNumber, { note, assignee, caseStatus } = {}) {
  const db = await load();
  const record = db.shipments[trackingNumber];
  if (!record) throw new Error('Spedizione non presente nel centro di controllo.');
  const allowedStatuses = new Set(['Aperta', 'In lavorazione', 'Risolta', 'Ignorata']);
  if (note !== undefined) record.note = String(note).trim().slice(0, 2_000);
  if (assignee !== undefined) record.assignee = String(assignee).trim().slice(0, 120);
  if (caseStatus !== undefined) {
    if (!allowedStatuses.has(caseStatus)) throw new Error('Stato gestione non valido.');
    record.caseStatus = caseStatus;
  }
  record.caseUpdatedAt = now();
  record.lastSeenAt = now();
  addEvent(record, 'gestione', record.caseStatus || 'Aperta', record.assignee ? `Assegnata a ${record.assignee}` : record.note || 'Caso aggiornato');
  await persist();
  return { ...record, archived: Boolean(record.archived), rabenStatus: normalizeStoredRabenStatus(record.rabenStatus), operationalStatus: operationalStatus(record) };
}

export async function deleteShipment(trackingNumber) {
  const db = await load();
  if (db.shipments[trackingNumber]) {
    delete db.shipments[trackingNumber];
    await persist();
  }
}

export async function deleteArchivedShipment(trackingNumber) {
  const db = await load();
  const record = db.shipments[trackingNumber];
  if (!record) throw new Error('Spedizione non presente nel centro di controllo.');
  if (!record.archived) throw new Error('Puoi eliminare definitivamente solo una spedizione già archiviata.');
  delete db.shipments[trackingNumber];
  await persist();
  return { trackingNumber };
}

export async function exportShipmentsData() {
  const db = await load();
  return {
    count: Object.keys(db.shipments || {}).length,
    shipments: db.shipments || {},
    operations: db.operations || [],
  };
}

export async function restoreShipmentsData(importedShipments, importedOperations = null) {
  if (!importedShipments || typeof importedShipments !== 'object' || Array.isArray(importedShipments)) {
    throw new Error('Dati spedizioni non validi per il ripristino.');
  }
  await load();
  try {
    const existingContent = await readFile(storePath, 'utf8');
    await writeFile(`${storePath}.bak`, existingContent, 'utf8');
  } catch {
    // Nessun backup precedente da archiviare se il file non esisteva
  }
  database = {
    shipments: { ...importedShipments },
    batches: database?.batches || [],
    operations: Array.isArray(importedOperations)
      ? importedOperations.slice(0, 200).map((operation) => ({
        id: String(operation?.id || `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).slice(0, 120),
        at: String(operation?.at || now()).slice(0, 40),
        scope: String(operation?.scope || 'system').slice(0, 40),
        level: ['info', 'success', 'warning', 'error'].includes(operation?.level) ? operation.level : 'info',
        action: String(operation?.action || 'Operazione ripristinata').slice(0, 160),
        detail: String(operation?.detail || '').slice(0, 2_000),
        metadata: operation?.metadata && typeof operation.metadata === 'object' && !Array.isArray(operation.metadata) ? operation.metadata : {},
      }))
      : (database?.operations || []),
  };
  await persist();
  return {
    restoredCount: Object.keys(database.shipments).length,
  };
}

export async function registerImportBatch({
  origin = 'excel',
  filename = '',
  totalRows = 0,
  newCount = 0,
  skippedCount = 0,
  trackingNumbers = [],
} = {}) {
  const db = await load();
  db.batches ||= [];
  db.batchHistoryInitialized = true;
  const id = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const batch = {
    id,
    at: now(),
    origin: origin === 'manual' ? 'manual' : 'excel',
    filename: filename || (origin === 'manual' ? 'Inserimento manuale' : 'File Excel'),
    totalRows: Number(totalRows) || trackingNumbers.length,
    newCount: Number(newCount) || 0,
    skippedCount: Number(skippedCount) || 0,
    trackingNumbers: Array.isArray(trackingNumbers) ? trackingNumbers : [],
  };
  db.batches.unshift(batch);
  if (db.batches.length > 100) db.batches = db.batches.slice(0, 100);
  await persist();
  return batch;
}

export async function getImportBatches() {
  const db = await load();
  db.batches ||= [];

  let batches = db.batches;
  if (!batches.length && !db.batchHistoryInitialized && Object.keys(db.shipments || {}).length > 0) {
    const groups = new Map();
    for (const record of Object.values(db.shipments)) {
      const dateKey = (record.lastImportedAt || record.lastSeenAt || '2026-09-12').slice(0, 10);
      if (!groups.has(dateKey)) groups.set(dateKey, []);
      groups.get(dateKey).push(record.trackingNumber);
    }
    batches = Array.from(groups.entries()).map(([dateStr, trackings], idx) => ({
      id: `legacy-batch-${idx + 1}`,
      at: `${dateStr}T10:00:00.000Z`,
      origin: 'excel',
      filename: `Import storico del ${new Date(dateStr).toLocaleDateString('it-IT')}`,
      totalRows: trackings.length,
      newCount: trackings.length,
      skippedCount: 0,
      trackingNumbers: trackings,
      isLegacy: true,
    })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  const shipments = db.shipments || {};
  const deletedLegacyBatchIds = new Set(db.deletedLegacyBatchIds || []);
  return batches.filter((batch) => !deletedLegacyBatchIds.has(batch.id)).map((batch) => {
    const trackings = Array.isArray(batch.trackingNumbers) ? batch.trackingNumbers : [];
    let consegnate = 0;
    let inTransito = 0;
    let eccezioni = 0;
    let altre = 0;

    for (const t of trackings) {
      const rec = shipments[t];
      if (!rec) continue;
      const status = normalizeStoredRabenStatus(rec.rabenStatus);
      if (status === 'Consegnata') consegnate++;
      else if (['In transito', 'In consegna', 'Centro di distribuzione'].includes(status)) inTransito++;
      else if (status === 'Eccezione Raben' || rec.operationalStatus === 'Da gestire') eccezioni++;
      else altre++;
    }

    return {
      ...batch,
      stats: {
        totalTracked: trackings.length,
        consegnate,
        inTransito,
        eccezioni,
        altre,
      },
    };
  });
}

export async function deleteImportBatch(batchId) {
  const normalizedId = String(batchId || '').trim();
  if (!normalizedId || normalizedId.length > 160) throw new Error('Identificativo lotto non valido.');
  const db = await load();
  db.batches ||= [];
  const index = db.batches.findIndex((batch) => batch.id === normalizedId);
  if (index < 0) {
    const visibleBatch = (await getImportBatches()).find((batch) => batch.id === normalizedId);
    if (!visibleBatch?.isLegacy) throw new Error('Lotto di importazione non trovato.');
    db.deletedLegacyBatchIds ||= [];
    if (!db.deletedLegacyBatchIds.includes(normalizedId)) db.deletedLegacyBatchIds.push(normalizedId);
    await persist();
    return visibleBatch;
  }
  const [deleted] = db.batches.splice(index, 1);
  db.batchHistoryInitialized = true;
  await persist();
  return deleted;
}

export async function getAuditLog({ type = '', query = '', dateFrom = '', dateTo = '', limit = 300 } = {}) {
  const db = await load();
  const needle = String(query || '').trim().toLowerCase();
  const allEvents = [];

  for (const record of Object.values(db.shipments || {})) {
    if (!Array.isArray(record.events)) continue;
    for (const event of record.events) {
      allEvents.push({
        at: event.at,
        type: event.type || 'info',
        label: event.label || '',
        detail: event.detail || '',
        trackingNumber: record.trackingNumber,
        orderReference: record.orderReference || '',
        orderId: record.orderId || '',
        currentState: record.currentState || '—',
        rabenStatus: normalizeStoredRabenStatus(record.rabenStatus) || '—',
        archived: Boolean(record.archived),
      });
    }
  }

  for (const operation of db.operations || []) {
    allEvents.push({
      at: operation.at,
      type: operation.scope || 'sistema',
      label: operation.action || '',
      detail: operation.detail || '',
      trackingNumber: '',
      orderReference: '',
      orderId: '',
      currentState: '—',
      rabenStatus: '—',
      archived: false,
    });
  }

  allEvents.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const filtered = allEvents.filter((ev) => {
    if (type && ev.type !== type) return false;
    if (dateFrom && ev.at.slice(0, 10) < dateFrom) return false;
    if (dateTo && ev.at.slice(0, 10) > dateTo) return false;
    if (needle) {
      const match = [
        ev.trackingNumber,
        ev.orderReference,
        ev.orderId,
        ev.label,
        ev.detail,
        ev.currentState,
        ev.rabenStatus,
      ].some((v) => String(v || '').toLowerCase().includes(needle));
      if (!match) return false;
    }
    return true;
  });

  return {
    total: filtered.length,
    events: filtered.slice(0, Math.max(10, Number(limit) || 300)),
  };
}

export async function registerOperation({ scope = 'system', level = 'info', action = '', detail = '', metadata = {} } = {}) {
  const db = await load();
  const allowedLevels = new Set(['info', 'success', 'warning', 'error']);
  const normalizedScope = String(scope || 'system').trim().slice(0, 40) || 'system';
  const normalizedAction = String(action || '').trim().slice(0, 160);
  if (!normalizedAction) throw new Error('Azione del log operativo mancante.');
  const safeMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? Object.fromEntries(Object.entries(metadata).slice(0, 20).map(([key, value]) => [String(key).slice(0, 80), typeof value === 'string' ? value.slice(0, 500) : value]))
    : {};
  const operation = {
    id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: now(),
    scope: normalizedScope,
    level: allowedLevels.has(level) ? level : 'info',
    action: normalizedAction,
    detail: String(detail || '').trim().slice(0, 2_000),
    metadata: safeMetadata,
  };
  db.operations ||= [];
  db.operations.unshift(operation);
  db.operations = db.operations.slice(0, 200);
  await persist();
  return operation;
}

export async function getOperationLog({ scope = '', limit = 20 } = {}) {
  const db = await load();
  const normalizedScope = String(scope || '').trim();
  const normalizedLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
  const operations = (db.operations || []).filter((operation) => !normalizedScope || operation.scope === normalizedScope);
  return { total: operations.length, operations: operations.slice(0, normalizedLimit) };
}
