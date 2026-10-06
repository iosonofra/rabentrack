import { normalizeStoredRabenStatus } from './shipment-store.js';
import { CRON_TIME_ZONE, describeCronExpression, getNextCronOccurrence, getNextCronOccurrences } from './cron-scheduler.js';

const TIER_RANK = Object.freeze({ high: 1, medium: 2, low: 3 });
const FALLBACK_STATE_PRIORITIES = Object.freeze({
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

function hourInTimeZone(date, timeZone = CRON_TIME_ZONE) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(date));
}

export function isWithinActiveHours(config = {}, date = new Date()) {
  if (config.scheduleMode === 'cron') return true;
  if (!config.nightPause) return true;
  const hour = hourInTimeZone(date, config.timeZone || CRON_TIME_ZONE);
  const start = Number(config.startHour ?? 8);
  const end = Number(config.endHour ?? 20);
  if (start <= end) {
    return hour >= start && hour <= end;
  }
  // Finestra a cavallo della mezzanotte (es. 22:00 -> 06:00)
  return hour >= start || hour <= end;
}

export function selectCronCandidates(shipments = {}, options = {}) {
  const records = Array.isArray(shipments) ? shipments : Object.values(shipments || {});
  const batchSize = Math.max(1, Number(options.batchSize) || 25);
  const now = options.now instanceof Date ? options.now.getTime() : Number(options.now) || Date.now();
  const statePriorities = { ...FALLBACK_STATE_PRIORITIES, ...(options.statePriorities || {}) };
  const tierIntervals = {
    high: Number(options.tierMinIntervalHours?.high) || 1,
    medium: Number(options.tierMinIntervalHours?.medium) || 4,
    low: Number(options.tierMinIntervalHours?.low) || 8,
  };

  const candidates = records.flatMap((record) => {
    if (!record || !record.trackingNumber) return [];
    if (record.archived) return [];
    const status = normalizeStoredRabenStatus(record.rabenStatus) || 'Non verificato';
    const tier = statePriorities[status] || 'medium';
    if (tier === 'excluded' || !TIER_RANK[tier]) return [];

    const minIntervalMs = tierIntervals[tier] * 3_600_000;
    let checkedTime = 0;
    if (!options.force && record.rabenCheckedAt) {
      checkedTime = new Date(record.rabenCheckedAt).getTime();
      if (!Number.isNaN(checkedTime) && (now - checkedTime) < minIntervalMs) {
        return [];
      }
    }
    if (record.rabenCheckedAt && !checkedTime) {
      const parsed = new Date(record.rabenCheckedAt).getTime();
      checkedTime = Number.isNaN(parsed) ? 0 : parsed;
    }
    return [{ ...record, cronTier: tier, cronTierRank: TIER_RANK[tier], cronCheckedTime: checkedTime }];
  });

  // Prima le urgenze Raben; nella stessa fascia, prima le mai controllate e le più vecchie.
  candidates.sort((a, b) => {
    if (a.cronTierRank !== b.cronTierRank) return a.cronTierRank - b.cronTierRank;
    return a.cronCheckedTime - b.cronCheckedTime;
  });

  return candidates.slice(0, batchSize);
}

export class RabenCronService {
  constructor({
    getSettings,
    saveSettings,
    rabenBetaClientFactory,
    loadShipments,
    syncRabenShipments,
    applyOrderState,
    syncManualState,
    notificationService,
    logger = console,
    jitterFn = () => 4000 + Math.floor(Math.random() * 2000),
  }) {
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.rabenBetaClientFactory = rabenBetaClientFactory;
    this.loadShipments = loadShipments;
    this.syncRabenShipments = syncRabenShipments;
    this.applyOrderState = applyOrderState;
    this.syncManualState = syncManualState;
    this.notificationService = notificationService;
    this.logger = logger;
    this.jitterFn = jitterFn;

    this.timer = null;
    this.isRunning = false;
    this.cancelRequested = false;
    this.lastRunAt = null;
    this.nextRunAt = null;
    this.upcomingRuns = [];
    this.lastRunSummary = null;
    this.activeProgress = null;
    this.lastSlaCheckAt = 0;
    this.lastDigestSentDate = null;
  }

  start() {
    this.stop();
    const settings = this.getSettings();
    const config = settings?.cron;
    if (!config?.enabled) {
      this.nextRunAt = null;
      return;
    }
    this.scheduleNextRun();
    const scheduleLabel = config.scheduleMode === 'cron'
      ? describeCronExpression(config.cronExpression)
      : `ogni ${config.intervalMinutes} minuti`;
    this.logger.log(`[Raben-CRON] Servizio avviato: ${scheduleLabel}. Prossimo avvio: ${this.nextRunAt}`);
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRunAt = null;
    this.upcomingRuns = [];
  }

  scheduleNextRun(fromDate = new Date()) {
    const config = this.getSettings()?.cron || {};
    if (!config.enabled) {
      this.nextRunAt = null;
      this.upcomingRuns = [];
      return;
    }
    if (config.scheduleMode === 'cron') {
      this.upcomingRuns = getNextCronOccurrences(config.cronExpression, fromDate, 5, config.timeZone || CRON_TIME_ZONE);
    } else {
      this.upcomingRuns = [new Date(fromDate.getTime() + Math.max(15, Number(config.intervalMinutes) || 60) * 60_000)];
    }
    const nextDate = this.upcomingRuns[0] || getNextCronOccurrence(config.cronExpression, fromDate, config.timeZone || CRON_TIME_ZONE);
    this.nextRunAt = nextDate.toISOString();
    const delay = Math.max(250, Math.min(nextDate.getTime() - Date.now(), 2_147_000_000));
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (Date.now() + 500 < nextDate.getTime()) {
        this.scheduleNextRun(new Date());
        return;
      }
      try {
        await this.triggerScan({ manual: false });
      } catch (error) {
        this.logger.error('[Raben-CRON] Errore durante il ciclo automatico:', error.message);
      } finally {
        if (this.getSettings()?.cron?.enabled) this.scheduleNextRun(new Date());
      }
    }, delay);
  }

  async updateConfig(newConfig = {}) {
    const current = this.getSettings();
    const merged = {
      ...current,
      cron: {
        ...(current.cron || {}),
        ...newConfig,
      },
    };
    if (this.saveSettings) {
      await this.saveSettings(merged);
    }
    this.start();
    return this.getStatus();
  }

  getStatus() {
    const settings = this.getSettings();
    const config = settings?.cron || {};
    const withinHours = isWithinActiveHours(config);

    return {
      enabled: Boolean(config.enabled),
      scheduleMode: config.scheduleMode === 'cron' ? 'cron' : 'interval',
      intervalMinutes: Number(config.intervalMinutes) || 60,
      cronExpression: config.cronExpression || '0 8-19 * * 1-5',
      cronPreset: config.cronPreset || '',
      timeZone: config.timeZone || CRON_TIME_ZONE,
      scheduleDescription: config.scheduleMode === 'cron' ? describeCronExpression(config.cronExpression) : `Ogni ${Number(config.intervalMinutes) || 60} minuti`,
      nextRuns: this.upcomingRuns.map((date) => date.toISOString()),
      nightPause: Boolean(config.nightPause),
      startHour: Number(config.startHour ?? 8),
      endHour: Number(config.endHour ?? 20),
      batchSize: Number(config.batchSize) || 25,
      minCheckIntervalHours: Number(config.minCheckIntervalHours) || 2,
      statePriorities: config.statePriorities || FALLBACK_STATE_PRIORITIES,
      tierMinIntervalHours: config.tierMinIntervalHours || { high: 1, medium: 4, low: 8 },
      isRunning: this.isRunning,
      isNightPaused: Boolean(config.enabled && config.nightPause && !withinHours),
      lastRunAt: this.lastRunAt,
      nextRunAt: this.timer ? this.nextRunAt : null,
      lastRunSummary: this.lastRunSummary,
      activeProgress: this.activeProgress,
    };
  }

  stopScan() {
    if (this.isRunning) {
      this.cancelRequested = true;
      return { ok: true, message: 'Richiesta di interruzione inviata.' };
    }
    return { ok: false, message: 'Nessuna scansione in esecuzione.' };
  }

  async triggerScan({ manual = false } = {}) {
    if (this.isRunning) {
      throw new Error('Un ciclo di controllo delle spedizioni è già in corso.');
    }

    const settings = this.getSettings();
    const config = settings?.cron || {};
    const rabenBetaConfig = settings?.rabenBeta;

    // Se non manuale, verifica se abilitato e nella fascia oraria
    if (!manual) {
      if (!config.enabled) return;
      if (!isWithinActiveHours(config)) {
        this.lastRunSummary = {
          at: new Date().toISOString(),
          type: 'skipped',
          reason: `Pausa notturna attiva (orario attivo: ${config.startHour}:00 - ${config.endHour}:00)`,
        };
        return;
      }
    }

    if (!rabenBetaConfig?.enabled) {
      throw new Error('La funzionalità Raben Beta deve essere abilitata nelle impostazioni per usare Camofox.');
    }

    this.isRunning = true;
    this.cancelRequested = false;
    const startTime = Date.now();
    let betaClient = null;

    try {
      const db = await this.loadShipments();
      const candidates = selectCronCandidates(db?.shipments || {}, {
        ...config,
        force: manual,
      });

      if (!candidates.length) {
        this.lastRunAt = new Date().toISOString();
        this.lastRunSummary = {
          at: this.lastRunAt,
          type: 'complete',
          totalCandidates: 0,
          checked: 0,
          deliveredFound: 0,
          errors: 0,
          durationSeconds: 0,
          reason: 'Nessuna spedizione in attesa da verificare',
        };
        return this.lastRunSummary;
      }

      this.activeProgress = {
        completed: 0,
        total: candidates.length,
        currentTracking: candidates[0].trackingNumber,
        speedProfile: rabenBetaConfig.speedProfile || 'safe',
        effectiveSpeedProfile: rabenBetaConfig.speedProfile || 'safe',
        fallbackReason: '',
      };

      betaClient = this.rabenBetaClientFactory(rabenBetaConfig);
      const results = [];
      let deliveredCount = 0;
      let errorCount = 0;

      for (let i = 0; i < candidates.length; i++) {
        if (this.cancelRequested) {
          this.logger.log('[Raben-CRON] Scansione interrotta dall\'operatore.');
          break;
        }

        const candidate = candidates[i];
        this.activeProgress.currentTracking = candidate.trackingNumber;

        try {
          const outcome = await betaClient.track(candidate.trackingNumber);
          results.push({ trackingNumber: candidate.trackingNumber, ...outcome });

          if (outcome.status === 'Consegnata') {
            deliveredCount++;
          }

          // Se compare captcha o blocco di accesso, effettua reset sessione e pausa prolungata
          if (outcome.reasonCode === 'ACCESS_GUARD' || outcome.status === 'Intervento manuale richiesto') {
            await betaClient.resetSession('Modalità affidabile attivata dopo una richiesta di verifica da parte di Raben.');
            await new Promise((r) => setTimeout(r, 8000));
          }
        } catch (error) {
          errorCount++;
          results.push({
            trackingNumber: candidate.trackingNumber,
            status: 'Errore verifica',
            detail: error.message,
          });
          await betaClient.resetSession('Modalità affidabile attivata dopo un errore di navigazione Camoufox.');
        }

        // Sincronizza subito la spedizione nel database locale in modo progressivo
        if (results.length) {
          const latestOutcome = results[results.length - 1];
          await this.syncRabenShipments([latestOutcome]);

          // 1. Auto-allineamento PrestaShop se abilitato per lo stato Raben
          const mapping = settings?.rabenStateMappings?.[latestOutcome.status];
          if (mapping?.autoSync && mapping.stateId && candidate.orderId && this.applyOrderState && this.syncManualState) {
            const currentNormalized = (candidate.currentState || '').trim().toLowerCase();
            const targetNormalized = (mapping.stateName || '').trim().toLowerCase();
            const sameId = candidate.prestaStateId && String(candidate.prestaStateId) === String(mapping.stateId);
            const sameName = currentNormalized && currentNormalized === targetNormalized;

            if (!sameId && !sameName) {
              try {
                await this.applyOrderState({ orderId: candidate.orderId, stateId: mapping.stateId });
                await this.syncManualState({
                  trackingNumber: candidate.trackingNumber,
                  orderId: candidate.orderId,
                  prestaStateId: String(mapping.stateId),
                  stateName: mapping.stateName,
                  origin: 'cron-auto-sync',
                });
                this.logger.log(`[Raben-CRON] Auto-allineato ordine ${candidate.orderId} allo stato "${mapping.stateName}"`);
                if (this.notificationService) {
                  await this.notificationService.notifyAutoSyncSuccess(candidate, mapping.stateName).catch(() => {});
                }
              } catch (syncErr) {
                this.logger.error(`[Raben-CRON] Errore auto-allineamento ordine ${candidate.orderId}:`, syncErr.message);
              }
            }
          }

          // 2. Alert per Eccezioni e Blocchi
          const isExceptionStatus = latestOutcome.status === 'Eccezione Raben' ||
            latestOutcome.status === 'Intervento manuale richiesto' ||
            Boolean(latestOutcome.reasonCode) ||
            /giacenza|fallit|mancat|rifiut/i.test(latestOutcome.status || '') ||
            /giacenza|fallit|mancat|rifiut/i.test(latestOutcome.detail || '');

          if (isExceptionStatus && this.notificationService) {
            await this.notificationService.notifyException(candidate, latestOutcome).catch(() => {});
          }
        }

        this.activeProgress.completed = i + 1;
        const runtimeProfile = betaClient.getRuntimeProfile?.();
        if (runtimeProfile) {
          this.activeProgress.speedProfile = runtimeProfile.requested;
          this.activeProgress.effectiveSpeedProfile = runtimeProfile.effective;
          this.activeProgress.fallbackReason = runtimeProfile.fallbackReason;
        }

        // Pacing anti-blocco tra le richieste se ce ne sono altre
        if (i < candidates.length - 1 && !this.cancelRequested) {
          const delayMs = typeof betaClient.getPacingDelay === 'function'
            ? betaClient.getPacingDelay('cron')
            : this.jitterFn();
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      // 3. Controllo SLA > 48h e Daily Digest a fine scansione
      if (this.notificationService) {
        await this.checkSlaBreaches().catch((err) => {
          this.logger.error('[Raben-CRON] Errore verifica SLA:', err.message);
        });
        await this.checkDailyDigest().catch((err) => {
          this.logger.error('[Raben-CRON] Errore verifica daily digest:', err.message);
        });
      }

      this.lastRunAt = new Date().toISOString();
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);
      this.lastRunSummary = {
        at: this.lastRunAt,
        type: this.cancelRequested ? 'cancelled' : 'complete',
        totalCandidates: candidates.length,
        checked: this.activeProgress.completed,
        deliveredFound: deliveredCount,
        errors: errorCount,
        durationSeconds,
        speedProfile: betaClient.getRuntimeProfile?.().requested || rabenBetaConfig.speedProfile || 'safe',
        effectiveSpeedProfile: betaClient.getRuntimeProfile?.().effective || rabenBetaConfig.speedProfile || 'safe',
        fallbackReason: betaClient.getRuntimeProfile?.().fallbackReason || '',
      };

      return this.lastRunSummary;
    } finally {
      await betaClient?.close?.();
      this.isRunning = false;
      this.cancelRequested = false;
      this.activeProgress = null;

    }
  }

  async checkSlaBreaches() {
    const settings = this.getSettings();
    if (!settings?.notifications?.triggers?.sla48h || !this.notificationService) return;

    const now = Date.now();
    // Evita di ripetere l'alert SLA più di una volta ogni 24 ore
    if (this.lastSlaCheckAt && (now - this.lastSlaCheckAt) < 24 * 3600_000) return;

    const db = await this.loadShipments();
    const records = Object.values(db?.shipments || {});
    const thresholdMs = 48 * 3600_000;

    const delayed = records.filter((r) => {
      if (!r || r.archived || r.rabenStatus === 'Consegnata') return false;
      const refTime = r.rabenCheckedAt ? new Date(r.rabenCheckedAt).getTime() : new Date(r.createdAt || 0).getTime();
      return (now - refTime) > thresholdMs;
    });

    if (delayed.length) {
      this.lastSlaCheckAt = now;
      await this.notificationService.notifySlaBreach(delayed);
    }
  }

  async checkDailyDigest() {
    const settings = this.getSettings();
    const triggers = settings?.notifications?.triggers;
    if (!triggers?.dailyDigest || !this.notificationService) return;

    const now = new Date();
    const targetHour = Number(triggers.digestHour ?? 8);
    const targetMinute = Number(triggers.digestMinute ?? 30);
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    // Invia se siamo all'interno o oltre la finestra oraria del digest
    const isDigestTime = (currentHour === targetHour && currentMinute >= targetMinute) || (currentHour > targetHour);
    const todayKey = now.toISOString().slice(0, 10);

    if (isDigestTime && this.lastDigestSentDate !== todayKey) {
      const db = await this.loadShipments();
      const records = Object.values(db?.shipments || {});
      const totalActive = records.filter((r) => !r.archived && r.rabenStatus !== 'Consegnata').length;
      const deliveredToday = records.filter((r) => r.rabenStatus === 'Consegnata' && r.rabenCheckedAt && r.rabenCheckedAt.slice(0, 10) === todayKey).length;
      const exceptions = records.filter((r) => !r.archived && (r.rabenStatus === 'Eccezione Raben' || r.caseStatus === 'Aperta')).length;
      const thresholdMs = 48 * 3600_000;
      const delayed = records.filter((r) => !r.archived && r.rabenStatus !== 'Consegnata' && (now.getTime() - new Date(r.rabenCheckedAt || r.createdAt || 0).getTime()) > thresholdMs).length;

      this.lastDigestSentDate = todayKey;
      await this.notificationService.sendDailyDigest({
        totalActive,
        deliveredToday,
        exceptions,
        delayed,
      });
    }
  }
}
