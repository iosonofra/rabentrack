import { setImmediate as yieldTurn } from 'node:timers/promises';
import { normalizeStoredRabenStatus } from './shipment-store.js';
import { findRabenStatusEvent } from './raben-beta-client.js';
import { isTechnicalRabenStatus, latestRabenEvent, parseOperationalDate, romeDay } from './raben-event-time.js';

const terminal = new Set(['Consegnata', 'Consegnata con riserva']);
export async function buildNotificationSummary(shipments = {}, { now = new Date(), signal } = {}) {
  const today = romeDay(now), timestamp = now.getTime();
  const summary = { asOf: now.toISOString(), day: today, timeZone: 'Europe/Rome', totalActive: 0, deliveredToday: 0, exceptions: 0, delayed: 0, missingEventDate: 0, futureEventDate: 0, missingDeliveryDate: 0, legacyDelayed: 0, newlyDelayed: 0, noLongerDelayed: 0, delayedExamples: [] };
  let index = 0;
  for (const record of Object.values(shipments)) {
    signal?.throwIfAborted();
    if (++index % 200 === 0) await yieldTurn(undefined, { signal });
    if (!record || typeof record !== 'object') continue;
    const status = normalizeStoredRabenStatus(record.rabenStatus);
    const final = terminal.has(status);
    if (final) {
      const delivered = parseOperationalDate(record.rabenStatusAt || record.rabenStatusDateRaw || findRabenStatusEvent(status, record.rabenTimeline || [])?.statusAt);
      if (!delivered) summary.missingDeliveryDate++;
      else if (delivered.day === today && (delivered.precision === 'date' || delivered.time <= timestamp)) summary.deliveredToday++;
    }
    if (record.archived) continue;
    // Kept for the read-only comparison with the previous implementation.
    const legacy = status !== 'Consegnata' && timestamp - new Date(record.rabenCheckedAt || record.createdAt || 0).getTime() > 48 * 3600000;
    if (legacy) summary.legacyDelayed++;
    if (!final) summary.totalActive++;
    if ((status === 'Eccezione Raben' && !['Risolta', 'Ignorata'].includes(record.caseStatus)) || ['Aperta', 'In lavorazione'].includes(record.caseStatus)) summary.exceptions++;
    let delayed = false;
    if (!final && !isTechnicalRabenStatus(status)) {
      const event = parseOperationalDate(record.rabenLastEventAt) || latestRabenEvent(record);
      if (!event) summary.missingEventDate++;
      else if (event.day > today || (event.precision !== 'date' && event.time > timestamp)) summary.futureEventDate++;
      else if (timestamp - event.time > 48 * 3600000) {
        delayed = true; summary.delayed++;
        if (summary.delayedExamples.length < 10) summary.delayedExamples.push({ trackingNumber: record.trackingNumber, orderReference: record.orderReference, orderId: record.orderId, rabenStatus: status, eventAt: event.value });
      }
    }
    if (delayed && !legacy) summary.newlyDelayed++;
    if (legacy && !delayed) summary.noLongerDelayed++;
  }
  signal?.throwIfAborted();
  return summary;
}
