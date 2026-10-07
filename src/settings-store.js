import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRabenSpeedProfile } from './raben-speed-profile.js';
import { CRON_PRESETS, CRON_TIME_ZONE, parseCronExpression } from './cron-scheduler.js';

export { normalizeRabenSpeedProfile } from './raben-speed-profile.js';

export const RABEN_CRON_STATE_PRIORITIES = Object.freeze({
  'In consegna': 'high',
  'Eccezione Raben': 'high',
  'Non verificato': 'medium',
  'Caricata': 'medium',
  'In transito': 'medium',
  'Centro di distribuzione': 'medium',
  'Registrata': 'low',
  'Prenotata': 'low',
  'Spedizione non trovata': 'low',
  'Errore verifica': 'low',
  'Da verificare manualmente': 'low',
  'Intervento manuale richiesto': 'low',
  'Consegnata con riserva': 'excluded',
  'Consegnata': 'excluded',
});

const CRON_TIERS = new Set(['high', 'medium', 'low', 'excluded']);

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const settingsPath = join(projectRoot, 'data', 'settings.json');

export function normalizeRabenStateMappings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value).slice(0, 100).reduce((mappings, [rabenStatus, target]) => {
    const status = String(rabenStatus || '').trim().slice(0, 160);
    const stateId = String(target?.stateId || '').trim().slice(0, 32);
    const stateName = String(target?.stateName || '').trim().slice(0, 160);
    const autoSync = Boolean(target?.autoSync);
    if (status && /^\d+$/.test(stateId) && stateName) mappings[status] = { stateId, stateName, autoSync };
    return mappings;
  }, {});
}

export function normalizeNotificationSettings(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const telegram = {
    enabled: Boolean(raw.telegram?.enabled),
    botToken: String(raw.telegram?.botToken || '').trim(),
    chatId: String(raw.telegram?.chatId || '').trim(),
  };

  const email = {
    enabled: Boolean(raw.email?.enabled),
    host: String(raw.email?.host || '').trim(),
    port: Math.min(Math.max(Number(raw.email?.port) || 587, 1), 65535),
    secure: Boolean(raw.email?.secure),
    user: String(raw.email?.user || '').trim(),
    pass: String(raw.email?.pass || '').trim(),
    from: String(raw.email?.from || '').trim(),
    to: String(raw.email?.to || '').trim(),
  };

  const triggers = {
    exceptions: raw.triggers?.exceptions !== undefined ? Boolean(raw.triggers?.exceptions) : true,
    sla48h: raw.triggers?.sla48h !== undefined ? Boolean(raw.triggers?.sla48h) : true,
    autoSyncSuccess: raw.triggers?.autoSyncSuccess !== undefined ? Boolean(raw.triggers?.autoSyncSuccess) : true,
    dailyDigest: raw.triggers?.dailyDigest !== undefined ? Boolean(raw.triggers?.dailyDigest) : true,
    digestHour: Math.min(Math.max(Number(raw.triggers?.digestHour ?? 8), 0), 23),
    digestMinute: Math.min(Math.max(Number(raw.triggers?.digestMinute ?? 30), 0), 59),
  };

  return { telegram, email, triggers };
}

export function normalizeCronSettings(input = {}) {
  const enabled = Boolean(input.enabled);
  const scheduleMode = input.scheduleMode === 'cron' ? 'cron' : 'interval';
  const intervalMinutes = Math.min(Math.max(Number(input.intervalMinutes) || 60, 15), 1440);
  const defaultExpression = CRON_PRESETS[0].expression;
  const cronExpression = String(input.cronExpression || defaultExpression).trim().replace(/\s+/g, ' ').slice(0, 120);
  if (scheduleMode === 'cron') parseCronExpression(cronExpression);
  const presetIds = new Set(CRON_PRESETS.map((preset) => preset.id));
  const cronPreset = presetIds.has(String(input.cronPreset || '')) ? String(input.cronPreset) : '';
  const nightPause = input.nightPause !== undefined ? Boolean(input.nightPause) : true;
  const normalizeHour = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.min(Math.max(Math.trunc(numeric), 0), 23) : fallback;
  };
  // I nuovi campi descrivono direttamente la fascia di pausa. Le vecchie
  // configurazioni indicavano invece la finestra operativa (startHour/endHour),
  // quindi vengono convertite senza invertirne il comportamento al primo avvio.
  const pauseStartHour = normalizeHour(input.pauseStartHour, normalizeHour(input.endHour, 20));
  const pauseEndHour = normalizeHour(input.pauseEndHour, normalizeHour(input.startHour, 8));
  const batchSize = Math.min(Math.max(Number(input.batchSize) || 25, 1), 100);
  const minCheckIntervalHours = Math.min(Math.max(Number(input.minCheckIntervalHours) || 2, 0.5), 72);
  const rawPriorities = input.statePriorities && typeof input.statePriorities === 'object' && !Array.isArray(input.statePriorities)
    ? input.statePriorities
    : {};
  const statePriorities = { ...RABEN_CRON_STATE_PRIORITIES };
  for (const [status, tier] of Object.entries(rawPriorities).slice(0, 100)) {
    const normalizedStatus = String(status || '').trim().slice(0, 160);
    if (normalizedStatus && CRON_TIERS.has(tier)) statePriorities[normalizedStatus] = tier;
  }
  // Gli stati finali Raben non vengono mai interrogati nuovamente dal cron.
  statePriorities.Consegnata = 'excluded';
  statePriorities['Consegnata con riserva'] = 'excluded';
  const rawIntervals = input.tierMinIntervalHours && typeof input.tierMinIntervalHours === 'object'
    ? input.tierMinIntervalHours
    : {};
  const tierMinIntervalHours = {
    high: Math.min(Math.max(Number(rawIntervals.high) || 1, 0.5), 72),
    medium: Math.min(Math.max(Number(rawIntervals.medium) || 4, 0.5), 168),
    low: Math.min(Math.max(Number(rawIntervals.low) || 8, 0.5), 336),
  };
  return {
    enabled,
    scheduleMode,
    intervalMinutes,
    cronExpression,
    cronPreset,
    timeZone: CRON_TIME_ZONE,
    nightPause,
    pauseStartHour,
    pauseEndHour,
    batchSize,
    minCheckIntervalHours,
    statePriorities,
    tierMinIntervalHours,
  };
}

export async function loadSettings(defaults) {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
    const savedTrackingUrl = parsed.rabenBeta?.trackingUrl;
    const publicTrackingUrl = 'https://oftc.myraben.com/link/ShipmentInformation?ShipmentNumber=TRACKINGDAINSERIRE&Language=IT';
    const trackingUrl = !savedTrackingUrl || savedTrackingUrl === 'https://myraben.com/SSO/'
      ? (defaults.rabenBeta?.trackingUrl || publicTrackingUrl)
      : savedTrackingUrl;
    return {
      baseUrl: parsed.baseUrl || defaults.baseUrl || '',
      apiKey: parsed.apiKey || defaults.apiKey || '',
      rabenBeta: {
        enabled: Boolean(parsed.rabenBeta?.enabled),
        camofoxUrl: parsed.rabenBeta?.camofoxUrl || defaults.rabenBeta?.camofoxUrl || 'http://127.0.0.1:9377',
        trackingUrl,
        speedProfile: normalizeRabenSpeedProfile(parsed.rabenBeta?.speedProfile || defaults.rabenBeta?.speedProfile),
      },
      rabenStateMappings: normalizeRabenStateMappings(parsed.rabenStateMappings),
      defaultCarrierId: String(parsed.defaultCarrierId || defaults.defaultCarrierId || '').trim(),
      defaultCarrierName: String(parsed.defaultCarrierName || defaults.defaultCarrierName || '').trim(),
      cron: normalizeCronSettings(parsed.cron || defaults.cron),
      notifications: normalizeNotificationSettings(parsed.notifications || defaults.notifications),
    };
  } catch {
    return defaults;
  }
}

export async function saveSettings(settings) {
  await mkdir(dirname(settingsPath), { recursive: true });
  const temporaryPath = `${settingsPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    rabenBeta: settings.rabenBeta,
    rabenStateMappings: normalizeRabenStateMappings(settings.rabenStateMappings),
    defaultCarrierId: String(settings.defaultCarrierId || '').trim(),
    defaultCarrierName: String(settings.defaultCarrierName || '').trim(),
    cron: normalizeCronSettings(settings.cron),
    notifications: normalizeNotificationSettings(settings.notifications),
  }), 'utf8');
  await rename(temporaryPath, settingsPath);
}

export function exportSettingsData(settings) {
  if (!settings || typeof settings !== 'object') return {};
  return {
    baseUrl: settings.baseUrl || '',
    apiKey: settings.apiKey || '',
    rabenBeta: {
      enabled: Boolean(settings.rabenBeta?.enabled),
      camofoxUrl: settings.rabenBeta?.camofoxUrl || 'http://127.0.0.1:9377',
      trackingUrl: settings.rabenBeta?.trackingUrl || 'https://oftc.myraben.com/link/ShipmentInformation?ShipmentNumber=TRACKINGDAINSERIRE&Language=IT',
      speedProfile: normalizeRabenSpeedProfile(settings.rabenBeta?.speedProfile),
    },
    rabenStateMappings: normalizeRabenStateMappings(settings.rabenStateMappings),
    defaultCarrierId: String(settings.defaultCarrierId || '').trim(),
    defaultCarrierName: String(settings.defaultCarrierName || '').trim(),
    cron: normalizeCronSettings(settings.cron),
    notifications: normalizeNotificationSettings(settings.notifications),
  };
}

export async function restoreSettingsData(importedSettings, defaults = {}) {
  if (!importedSettings || typeof importedSettings !== 'object' || Array.isArray(importedSettings)) {
    throw new Error('Dati impostazioni non validi per il ripristino.');
  }
  try {
    const existingContent = await readFile(settingsPath, 'utf8');
    await writeFile(`${settingsPath}.bak`, existingContent, 'utf8');
  } catch {
    // Nessun backup precedente se non esisteva
  }
  const merged = {
    baseUrl: importedSettings.baseUrl || defaults.baseUrl || '',
    apiKey: importedSettings.apiKey || defaults.apiKey || '',
    rabenBeta: {
      enabled: Boolean(importedSettings.rabenBeta?.enabled),
      camofoxUrl: importedSettings.rabenBeta?.camofoxUrl || defaults.rabenBeta?.camofoxUrl || 'http://127.0.0.1:9377',
      trackingUrl: importedSettings.rabenBeta?.trackingUrl || defaults.rabenBeta?.trackingUrl || 'https://oftc.myraben.com/link/ShipmentInformation?ShipmentNumber=TRACKINGDAINSERIRE&Language=IT',
      speedProfile: normalizeRabenSpeedProfile(importedSettings.rabenBeta?.speedProfile || defaults.rabenBeta?.speedProfile),
    },
    rabenStateMappings: normalizeRabenStateMappings(importedSettings.rabenStateMappings),
    defaultCarrierId: String(importedSettings.defaultCarrierId || defaults.defaultCarrierId || '').trim(),
    defaultCarrierName: String(importedSettings.defaultCarrierName || defaults.defaultCarrierName || '').trim(),
    cron: normalizeCronSettings(importedSettings.cron || defaults.cron),
    notifications: normalizeNotificationSettings(importedSettings.notifications || defaults.notifications),
  };
  await saveSettings(merged);
  return merged;
}
