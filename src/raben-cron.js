import { normalizeStoredRabenStatus } from './shipment-store.js';
import { CRON_TIME_ZONE, describeCronExpression } from './cron-scheduler.js';
import { cronCalculator } from './cron-calculator.js';
import { deadline, pause } from './operation-control.js';
import { buildNotificationSummary } from './raben-notification-summary.js';
import { romeDay, romeParts } from './raben-event-time.js';
import { channelIdentity } from './notification-outbox.js';

const TIER_RANK = Object.freeze({ high: 1, medium: 2, low: 3 });
const BENIGN_RABEN_REASON_CODES = new Set(['', 'STATUS_CONFIRMED', 'STATUS_INFERRED', 'STATUS_DISCOVERED', 'ALREADY_DELIVERED']);
const FALLBACK_STATE_PRIORITIES = Object.freeze({
  'In consegna': 'high',
  'Eccezione Raben': 'high',
  'Non verificato': 'medium',
  'Caricata': 'medium',
  'In transito': 'medium',
  'Centro di distribuzione': 'medium',
  'In corso': 'medium',
  'Inventario a magazzino': 'medium',
  'Scaricato': 'medium',
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
  // Compatibilità: i vecchi campi rappresentavano la finestra attiva 08:00-20:00.
  const pauseStart = Number(config.pauseStartHour ?? config.endHour ?? 20);
  const pauseEnd = Number(config.pauseEndHour ?? config.startHour ?? 8);
  if (pauseStart === pauseEnd) return true;
  const isPaused = pauseStart < pauseEnd
    ? hour >= pauseStart && hour < pauseEnd
    : hour >= pauseStart || hour < pauseEnd;
  return !isPaused;
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

export function isRabenExceptionOutcome(outcome = {}) {
  const status = String(outcome.status || '');
  const detail = String(outcome.detail || '');
  const reasonCode = String(outcome.reasonCode || '');
  return status === 'Eccezione Raben'
    || status === 'Intervento manuale richiesto'
    || !BENIGN_RABEN_REASON_CODES.has(reasonCode)
    || /giacenza|fallit|mancat|rifiut/i.test(status)
    || /giacenza|fallit|mancat|rifiut/i.test(detail);
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
    recordOperation,
    logger = console,
    jitterFn = () => 4000 + Math.floor(Math.random() * 2000),
    cycleTimeoutMs,
  }) {
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.rabenBetaClientFactory = rabenBetaClientFactory;
    this.loadShipments = loadShipments;
    this.syncRabenShipments = syncRabenShipments;
    this.applyOrderState = applyOrderState;
    this.syncManualState = syncManualState;
    this.notificationService = notificationService;
    this.recordOperation = recordOperation;
    this.logger = logger;
    this.jitterFn = jitterFn;
    this.cycleTimeoutMs = cycleTimeoutMs;

    this.timer = null;
    this.scheduleGeneration = 0;
    this.scheduleError = '';
    this.isRunning = false;
    this.cancelRequested = false;
    this.lastRunAt = null;
    this.nextRunAt = null;
    this.upcomingRuns = [];
    this.lastRunSummary = null;
    this.activeProgress = null;
    this.lastSlaContext = null;
    this.lastDigestContext = null;
    this.notificationTimer = null;
    this.notificationGeneration = 0;
    this.notificationEvaluation = null;
    this.previewPromise = null;
    this.lastNotificationCheck = null;
  }

  async addOperation(action, detail = '', level = 'info', metadata = {}) {
    if (!this.recordOperation) return;
    try {
      await this.recordOperation({ action, detail, level, metadata });
    } catch (error) {
      this.logger.error('[Raben-CRON] Impossibile registrare il log operativo:', error.message);
    }
  }

  async queueNotification(work) {
    try { return await work(); }
    catch (error) {
      this.logger.error('[Raben-CRON] Notifica non accodata:', error.message);
      await this.addOperation('Notifica non accodata', error.message, 'error');
      return { queued: false, error: error.message };
    }
  }

  async start(precomputed) {
    this.stop();
    const settings = this.getSettings();
    const config = settings?.cron;
    if (!config?.enabled) {
      this.nextRunAt = null;
      return;
    }
    this.startNotificationChecks();
    await this.scheduleNextRun(new Date(), precomputed);
    const scheduleLabel = config.scheduleMode === 'cron'
      ? describeCronExpression(config.cronExpression)
      : `ogni ${config.intervalMinutes} minuti`;
    this.logger.log(`[Raben-CRON] Servizio avviato: ${scheduleLabel}. Prossimo avvio: ${this.nextRunAt}`);
  }

  stop() {
    this.notificationGeneration += 1;
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    this.notificationTimer = null;
    this.notificationController?.abort();
    this.scheduleGeneration += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRunAt = null;
    this.upcomingRuns = [];
  }

  async scheduleNextRun(fromDate = new Date(), precomputed) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const generation = ++this.scheduleGeneration;
    const config = this.getSettings()?.cron || {};
    if (!config.enabled) {
      this.nextRunAt = null;
      this.upcomingRuns = [];
      return;
    }
    if (config.scheduleMode === 'cron') {
      let preview;
      try {
        preview = precomputed || await cronCalculator.calculate(config.cronExpression, { fromDate, count: 5, timeZone: config.timeZone || CRON_TIME_ZONE });
      } catch (error) {
        if (generation === this.scheduleGeneration) {
          this.scheduleError = error.message;
          this.nextRunAt = null;
          this.upcomingRuns = [];
          await this.addOperation('Pianificazione cron non avviata', error.message, 'error');
        }
        throw error;
      }
      if (generation !== this.scheduleGeneration) return;
      this.upcomingRuns = preview.nextRuns.map((date) => new Date(date));
    } else {
      this.upcomingRuns = [new Date(fromDate.getTime() + Math.max(15, Number(config.intervalMinutes) || 60) * 60_000)];
    }
    const nextDate = this.upcomingRuns[0];
    this.scheduleError = '';
    this.nextRunAt = nextDate.toISOString();
    const delay = Math.max(250, Math.min(nextDate.getTime() - Date.now(), 2_147_000_000));
    this.timer = setTimeout(async () => {
      if (generation !== this.scheduleGeneration) return;
      this.timer = null;
      if (Date.now() + 500 < nextDate.getTime()) {
        await this.scheduleNextRun(new Date()).catch((error) => this.logger.error('[Raben-CRON] Ripianificazione fallita:', error.message));
        return;
      }
      try {
        await this.triggerScan({ manual: false });
      } catch (error) {
        this.logger.error('[Raben-CRON] Errore durante il ciclo automatico:', error.message);
      } finally {
        if (generation === this.scheduleGeneration && this.getSettings()?.cron?.enabled) {
          try {
            await this.scheduleNextRun(new Date());
          } catch (error) {
            this.logger.error('[Raben-CRON] Ripianificazione fallita:', error.message);
          }
        }
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
    const preview = merged.cron.scheduleMode === 'cron'
      ? await cronCalculator.calculate(merged.cron.cronExpression, { count: 5, timeZone: merged.cron.timeZone || CRON_TIME_ZONE }) : undefined;
    if (this.saveSettings) {
      await this.saveSettings(merged);
    }
    await this.start(preview);
    const effective = this.getSettings()?.cron || merged.cron;
    const schedule = effective.scheduleMode === 'cron'
      ? describeCronExpression(effective.cronExpression)
      : `ogni ${effective.intervalMinutes} minuti`;
    await this.addOperation(
      effective.enabled ? 'Configurazione cron aggiornata' : 'Controllo automatico disattivato',
      effective.enabled
        ? `${schedule}${effective.scheduleMode === 'interval' && effective.nightPause ? ` · pausa ${effective.pauseStartHour}:00–${effective.pauseEndHour}:00` : ''}`
        : 'Le verifiche automatiche non verranno avviate.',
      effective.enabled ? 'success' : 'warning',
      { scheduleMode: effective.scheduleMode, enabled: Boolean(effective.enabled) },
    );
    return this.getStatus();
  }

  getStatus() {
    const settings = this.getSettings();
    const config = settings?.cron || {};
    const withinHours = isWithinActiveHours(config);

    return {
      enabled: Boolean(config.enabled),
      scheduleError: this.scheduleError,
      scheduleMode: config.scheduleMode === 'cron' ? 'cron' : 'interval',
      intervalMinutes: Number(config.intervalMinutes) || 60,
      cronExpression: config.cronExpression || '0 8-19 * * 1-5',
      cronPreset: config.cronPreset || '',
      timeZone: config.timeZone || CRON_TIME_ZONE,
      scheduleDescription: config.scheduleMode === 'cron' ? describeCronExpression(config.cronExpression) : `Ogni ${Number(config.intervalMinutes) || 60} minuti`,
      nextRuns: this.upcomingRuns.map((date) => date.toISOString()),
      nightPause: Boolean(config.nightPause),
      pauseStartHour: Number(config.pauseStartHour ?? config.endHour ?? 20),
      pauseEndHour: Number(config.pauseEndHour ?? config.startHour ?? 8),
      batchSize: Number(config.batchSize) || 25,
      minCheckIntervalHours: Number(config.minCheckIntervalHours) || 2,
      statePriorities: config.statePriorities || FALLBACK_STATE_PRIORITIES,
      tierMinIntervalHours: config.tierMinIntervalHours || { high: 1, medium: 4, low: 8 },
      isRunning: this.isRunning,
      isNightPaused: Boolean(!this.isRunning && config.enabled && config.nightPause && !withinHours),
      operatingPolicy: { pauseAppliesAt: 'cycle-start', intervalFrom: 'cycle-end', missedRuns: 'skip', notificationsIndependent: true },
      lastRunAt: this.lastRunAt,
      nextRunAt: this.timer ? this.nextRunAt : null,
      lastRunSummary: this.lastRunSummary,
      activeProgress: this.activeProgress,
    };
  }

  stopScan() {
    if (this.isRunning) {
      this.cancelRequested = true;
      this.cycleController?.abort(Object.assign(new Error('Ciclo interrotto dall’operatore.'), { name: 'AbortError' }));
      void this.addOperation('Interruzione richiesta', 'Interruzione delle attese e delle operazioni di rete in corso. Le scritture già ricevute da PrestaShop potrebbero essere completate.', 'warning');
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
          reason: `Pausa notturna attiva (${config.pauseStartHour ?? config.endHour ?? 20}:00 - ${config.pauseEndHour ?? config.startHour ?? 8}:00)`,
        };
        await this.addOperation('Ciclo automatico sospeso', this.lastRunSummary.reason, 'info', { trigger: 'automatic' });
        return;
      }
    }

    if (!rabenBetaConfig?.enabled) {
      await this.addOperation('Ciclo non avviato', 'La verifica Raben via Camofox non è abilitata.', 'error', { trigger: manual ? 'manual' : 'automatic' });
      throw new Error('La funzionalità Raben Beta deve essere abilitata nelle impostazioni per usare Camofox.');
    }

    this.isRunning = true;
    this.cancelRequested = false;
    const startTime = Date.now();
    this.cycleController = new AbortController();
    const budget = deadline(this.cycleTimeoutMs || (60000 + (Number(config.batchSize) || 25) * 240000), this.cycleController.signal, 'Ciclo cron oltre il tempo massimo complessivo.');
    const signal = budget.signal;
    let betaClient = null;

    try {
      await this.addOperation(
        manual ? 'Verifica manuale avviata' : 'Ciclo automatico avviato',
        `Limite del ciclo: ${Number(config.batchSize) || 25} spedizioni.`,
        'info',
        { trigger: manual ? 'manual' : 'automatic' },
      );
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
        await this.addOperation(
          manual ? 'Verifica manuale completata' : 'Ciclo automatico completato',
          this.lastRunSummary.reason,
          'success',
          { trigger: manual ? 'manual' : 'automatic', checked: 0, errors: 0 },
        );
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

      betaClient = this.rabenBetaClientFactory(rabenBetaConfig, { signal });
      const results = [];
      let deliveredCount = 0;
      let errorCount = 0;

      for (let i = 0; i < candidates.length; i++) {
        signal.throwIfAborted();
        if (this.cancelRequested) {
          this.logger.log('[Raben-CRON] Scansione interrotta dall\'operatore.');
          break;
        }

        const candidate = candidates[i];
        this.activeProgress.currentTracking = candidate.trackingNumber;

        try {
          const outcome = await betaClient.track(candidate.trackingNumber, {
            signal,
            onWaiting: () => { if (this.activeProgress) this.activeProgress.phase = 'browser-waiting'; },
            onStarted: () => { if (this.activeProgress) this.activeProgress.phase = 'checking'; },
          });
          results.push({ trackingNumber: candidate.trackingNumber, ...outcome });

          if (outcome.status === 'Consegnata') {
            deliveredCount++;
          }

          // Se compare captcha o blocco di accesso, effettua reset sessione e pausa prolungata
          if (outcome.reasonCode === 'ACCESS_GUARD' || outcome.status === 'Intervento manuale richiesto') {
            await betaClient.resetSession('Modalità affidabile attivata dopo una richiesta di verifica da parte di Raben.');
            await pause(8000, signal);
          }
        } catch (error) {
          signal.throwIfAborted();
          if (['BROWSER_QUEUE_TIMEOUT', 'BROWSER_QUEUE_FULL'].includes(error.code)) throw error;
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
          if (!mapping?.disabled && mapping?.autoSync && mapping.stateId && candidate.orderId && this.applyOrderState && this.syncManualState) {
            const currentNormalized = (candidate.currentState || '').trim().toLowerCase();
            const targetNormalized = (mapping.stateName || '').trim().toLowerCase();
            const sameId = candidate.prestaStateId && String(candidate.prestaStateId) === String(mapping.stateId);
            const sameName = currentNormalized && currentNormalized === targetNormalized;

            if (!sameId && !sameName) {
              try {
                signal.throwIfAborted();
                await this.applyOrderState({ orderId: candidate.orderId, stateId: mapping.stateId, signal });
                await this.syncManualState({
                  trackingNumber: candidate.trackingNumber,
                  orderId: candidate.orderId,
                  prestaStateId: String(mapping.stateId),
                  stateName: mapping.stateName,
                  origin: 'cron-auto-sync',
                });
                this.logger.log(`[Raben-CRON] Auto-allineato ordine ${candidate.orderId} allo stato "${mapping.stateName}"`);
                if (this.notificationService) {
                  await this.queueNotification(() => this.notificationService.notifyAutoSyncSuccess(candidate, mapping.stateName, { signal, eventAt: latestOutcome.statusAt, stateId: mapping.stateId }));
                }
              } catch (syncErr) {
                this.logger.error(`[Raben-CRON] Errore auto-allineamento ordine ${candidate.orderId}:`, syncErr.message);
                await this.addOperation('Allineamento PrestaShop non confermato', syncErr.message, 'warning', { orderId: candidate.orderId, trackingNumber: candidate.trackingNumber, outcomeUnknown: syncErr.code === 'WRITE_OUTCOME_UNKNOWN' });
                signal.throwIfAborted();
              }
            }
          }

          // 2. Alert per Eccezioni e Blocchi
          const isExceptionStatus = isRabenExceptionOutcome(latestOutcome);

          if (isExceptionStatus && this.notificationService) {
            await this.queueNotification(() => this.notificationService.notifyException(candidate, latestOutcome, { signal }));
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
          this.activeProgress.phase = 'waiting';
          await pause(delayMs, signal);
        }
      }

      signal.throwIfAborted();
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

      const completionLevel = errorCount > 0 ? 'warning' : 'success';
      const completionAction = this.cancelRequested
        ? 'Ciclo interrotto'
        : (manual ? 'Verifica manuale completata' : 'Ciclo automatico completato');
      await this.addOperation(
        completionAction,
        `${this.lastRunSummary.checked} di ${candidates.length} spedizioni verificate · ${deliveredCount} consegnate · ${errorCount} errori · ${durationSeconds}s`,
        this.cancelRequested ? 'warning' : completionLevel,
        {
          trigger: manual ? 'manual' : 'automatic',
          checked: this.lastRunSummary.checked,
          total: candidates.length,
          delivered: deliveredCount,
          errors: errorCount,
          durationSeconds,
        },
      );

      return this.lastRunSummary;
    } catch (error) {
      if (signal.aborted) {
        this.lastRunAt = new Date().toISOString();
        this.lastRunSummary = { at: this.lastRunAt, type: this.cancelRequested ? 'cancelled' : 'timed-out', checked: this.activeProgress?.completed || 0, totalCandidates: this.activeProgress?.total || 0, durationSeconds: Math.round((Date.now() - startTime) / 1000), reason: signal.reason?.message || error.message };
        await this.addOperation('Ciclo interrotto', this.lastRunSummary.reason, 'warning', { trigger: manual ? 'manual' : 'automatic' });
        return this.lastRunSummary;
      }
      await this.addOperation(
        manual ? 'Verifica manuale fallita' : 'Ciclo automatico fallito',
        error.message || 'Errore imprevisto durante il controllo.',
        'error',
        { trigger: manual ? 'manual' : 'automatic' },
      );
      throw error;
    } finally {
      try {
        await betaClient?.close?.();
      } catch (error) {
        this.logger.error('[Raben-CRON] Errore chiusura client:', error.message);
      } finally {
        budget.dispose();
        this.cycleController = null;
        this.isRunning = false;
        this.cancelRequested = false;
        this.activeProgress = null;
      }
    }
  }

  notificationChecksEnabled() {
    const settings = this.getSettings();
    const config = settings?.notifications;
    return Boolean(settings?.cron?.enabled && this.notificationService
      && (config?.telegram?.enabled || config?.email?.enabled)
      && (config.triggers?.sla48h || config.triggers?.dailyDigest));
  }

  startNotificationChecks() {
    const generation = ++this.notificationGeneration;
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    this.notificationTimer = null;
    this.notificationController?.abort();
    const arm = (delay) => {
      if (generation !== this.notificationGeneration || !this.notificationChecksEnabled()) return;
      this.notificationTimer = setTimeout(async () => {
        if (generation !== this.notificationGeneration) return;
        this.notificationTimer = null;
        if (this.notificationEvaluation) { arm(60000); return; }
        const controller = new AbortController();
        this.notificationController = controller;
        const budget = deadline(30000, controller.signal, 'Controllo notifiche oltre il limite.');
        try { await this.checkOperationalNotifications({ signal: budget.signal }); }
        catch (error) {
          if (!controller.signal.aborted) {
            this.logger.error('[Raben-CRON] Controllo notifiche fallito:', error.message);
            await this.addOperation('Controllo notifiche fallito', error.message, 'error');
          }
        } finally {
          budget.dispose();
          if (this.notificationController === controller) this.notificationController = null;
          arm(60000);
        }
      }, delay);
      this.notificationTimer.unref?.();
    };
    arm(0);
  }

  async previewNotifications(signal) {
    if (this.previewPromise) return this.previewPromise;
    const now = new Date();
    const work = (async () => buildNotificationSummary((await this.loadShipments())?.shipments || {}, { now, signal }))();
    this.previewPromise = work;
    try { return await work; }
    finally { if (this.previewPromise === work) this.previewPromise = null; }
  }

  async checkOperationalNotifications({ signal, now = new Date() } = {}) {
    if (this.notificationEvaluation) return this.notificationEvaluation;
    const work = this.evaluateNotifications(signal, now);
    this.notificationEvaluation = work;
    try { return await work; }
    finally { if (this.notificationEvaluation === work) this.notificationEvaluation = null; }
  }

  async evaluateNotifications(signal, now) {
    signal?.throwIfAborted();
    if (!this.notificationChecksEnabled()) return { skipped: true };
    const config = this.getSettings().notifications;
    const triggers = config.triggers || {};
    const channels = ['telegram', 'email'].filter((channel) => config[channel]?.enabled).map((channel) => [channel, channelIdentity(channel, config[channel])]);
    const context = JSON.stringify([romeDay(now), channels]);
    const p = romeParts(now);
    const digestDue = +p.hour * 60 + +p.minute >= Number(triggers.digestHour ?? 8) * 60 + Number(triggers.digestMinute ?? 30);
    const checkSla = triggers.sla48h && this.lastSlaContext !== context;
    const checkDigest = triggers.dailyDigest && digestDue && this.lastDigestContext !== context;
    if (!checkSla && !checkDigest) return { skipped: true };
    const summary = await buildNotificationSummary((await this.loadShipments())?.shipments || {}, { now, signal });
    signal?.throwIfAborted();
    this.lastNotificationCheck = { at: now.toISOString(), day: summary.day, delayed: summary.delayed, missingEventDate: summary.missingEventDate, futureEventDate: summary.futureEventDate, totalActive: summary.totalActive };
    const accepted = (result) => result?.accepted === true || result?.queued > 0 || result?.duplicates > 0;
    const results = {};
    // Each channel's persistent marker is the phase-4 outbox entry, not these
    // in-memory shortcuts. A restart deduplicates against that durable entry.
    for (const kind of ['sla', 'digest']) {
      if (kind === 'sla' ? !checkSla || !summary.delayed : !checkDigest) continue;
      signal?.throwIfAborted();
      try {
        const result = kind === 'sla'
          ? await this.notificationService.notifySlaBreach(summary.delayedExamples, { signal, date: now, count: summary.delayed })
          : await this.notificationService.sendDailyDigest(summary, { signal, date: now });
        results[kind] = result;
        if (accepted(result)) {
          if (kind === 'sla') this.lastSlaContext = context;
          else this.lastDigestContext = context;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        results[kind] = { error: true };
        await this.addOperation(kind === 'sla' ? 'Notifica SLA non accodata' : 'Riepilogo non accodato', error.message, 'error');
      }
    }
    return { summary, results };
  }
}
