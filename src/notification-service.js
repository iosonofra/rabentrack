import { Worker } from 'node:worker_threads';
import { deadline } from './operation-control.js';
import { notificationDay } from './notification-outbox.js';

let emailWorkers = 0;
const MAX_EMAIL_WORKERS = 2;
const markup = (value, limit = 300) => String(value || '').slice(0, limit).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

export class NotificationService {
  constructor({ getSettings, logger = console, fetchFn = globalThis.fetch, telegramTimeoutMs = 10000, emailTimeoutMs = 20000, emailWorkerUrl = new URL('./email-worker.js', import.meta.url) } = {}) {
    this.getSettings = getSettings || (() => ({}));
    this.logger = logger;
    this.fetchFn = fetchFn;
    Object.assign(this, { telegramTimeoutMs, emailTimeoutMs, emailWorkerUrl });
  }

  get config() {
    return this.getSettings()?.notifications || {};
  }

  async sendTelegram({ text, parseMode = 'HTML', config = this.config.telegram, signal }) {
    if (!config?.enabled) return { ok: false, skipped: true, reason: 'Telegram disabilitato' };
    if (!config.botToken || !config.chatId) {
      throw new Error('Configurazione Telegram incompleta: specificare Bot Token e Chat ID.');
    }

    const url = `https://api.telegram.org/bot${encodeURIComponent(config.botToken)}/sendMessage`;
    const budget = deadline(this.telegramTimeoutMs, signal, 'Tempo massimo invio Telegram superato.');
    try {
      const response = await this.fetchFn(url, {
        signal: budget.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: config.chatId, text, parse_mode: parseMode, disable_web_page_preview: true }),
      });
      const data = await response.json().catch(() => ({}));
      budget.signal.throwIfAborted();
      if (!response.ok || !data.ok) {
        const detail = data.description || `HTTP ${response.status}`;
        throw Object.assign(new Error(`Errore invio Telegram: ${detail}`), { deliveryUnknown: data.ok !== false, retryable: response.status === 429 || response.status >= 500, retryAfterMs: Number(data.parameters?.retry_after) * 1000 });
      }
      return { ok: true, result: data.result };
    } catch (error) {
      if (error.deliveryUnknown === undefined) {
        error.deliveryUnknown = !['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(error.cause?.code);
        error.retryable = !error.deliveryUnknown;
      }
      throw error;
    } finally { budget.dispose(); }
  }

  async sendEmail({ subject, html, text, config = this.config.email, signal }) {
    if (!config?.enabled) return { ok: false, skipped: true, reason: 'Email disabilitata' };
    if (!config.host || !config.to) {
      throw new Error('Configurazione Email incompleta: specificare Host SMTP e destinatario.');
    }

    const transportOptions = {
      host: config.host,
      port: Number(config.port) || 587,
      secure: Boolean(config.secure),
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 15000,
    };

    if (config.user) {
      transportOptions.auth = {
        user: config.user,
        pass: config.pass || '',
      };
    }

    const fromAddress = config.from || config.user || 'raben-tracking@localhost';
    const message = {
      from: fromAddress,
      to: config.to,
      subject,
      text: text || html?.replace(/<[^>]+>/g, ' '),
      html,
    };
    signal?.throwIfAborted();
    if (emailWorkers >= MAX_EMAIL_WORKERS) throw Object.assign(new Error('Invii email occupati: riprova più tardi.'), { deliveryUnknown: false, retryable: true });
    const budget = deadline(this.emailTimeoutMs, signal, 'Tempo massimo email superato: consegna non confermata.');
    emailWorkers++;
    let worker;
    let removeAbort = () => {};
    try {
      worker = new Worker(this.emailWorkerUrl, { execArgv: [], workerData: { options: transportOptions, message } });
      return await new Promise((resolve, reject) => {
        const abort = () => reject(budget.signal.reason);
        budget.signal.addEventListener('abort', abort, { once: true });
        removeAbort = () => budget.signal.removeEventListener('abort', abort);
        worker.once('message', (result) => {
          removeAbort();
          if (!result.error) return resolve(result);
          const explicitRejection = Number(result.responseCode) >= 400;
          const beforeMessage = ['CONN', 'EHLO', 'HELO', 'STARTTLS', 'AUTH'].includes(result.command);
          reject(Object.assign(new Error(result.error), { deliveryUnknown: !explicitRejection && !beforeMessage, retryable: Number(result.responseCode) >= 400 && Number(result.responseCode) < 500 || beforeMessage && ['ECONNREFUSED', 'EDNS', 'ESOCKET', 'ETIMEDOUT'].includes(result.code) }));
        });
        worker.once('error', reject);
        worker.once('exit', () => reject(new Error('Invio email terminato senza conferma.')));
        if (budget.signal.aborted) abort();
      });
    } finally {
      removeAbort();
      budget.dispose();
      if (worker) await worker.terminate();
      emailWorkers--;
    }
  }

  async testTelegram(config) {
    const message = `🤖 <b>Raben Tracking Center</b>\n\n✅ <i>Connessione Bot Telegram riuscita!</i>\nLe notifiche operative per le spedizioni verranno recapitate in questa chat.`;
    return this.sendTelegram({ text: message, config: { ...config, enabled: true } });
  }

  async testEmail(config) {
    const subject = `[Raben Tracking Center] Test Notifica Email`;
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #0b1528; margin-top: 0;">Raben Tracking Center</h2>
        <p style="color: #10b981; font-weight: bold; font-size: 16px;">✓ Connessione SMTP configurata con successo</p>
        <p style="color: #475569; font-size: 14px; line-height: 1.5;">Questo messaggio conferma che i parametri del server di posta sono corretti. Riceverai qui gli avvisi e i report configurati.</p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
        <small style="color: #94a3b8; font-size: 12px;">Inviato da Raben Tracking Center il ${new Date().toLocaleString('it-IT')}</small>
      </div>
    `;
    return this.sendEmail({ subject, html, config: { ...config, enabled: true } });
  }

  async notifyException(shipment, rabenOutcome = {}, { signal } = {}) {
    if (!this.config.triggers?.exceptions) return { skipped: true };

    const tracking = markup(shipment.trackingNumber, 80);
    const orderRef = markup(shipment.orderReference || shipment.orderId || 'N/D', 160);
    const status = markup(rabenOutcome.status || shipment.rabenStatus || 'Eccezione', 160);
    const detail = markup(rabenOutcome.detail || shipment.lastSeenDetail || 'Verificare sul portale Raben', 500);

    const textTelegram = [
      `🚨 <b>Raben Alert · Eccezione Spedizione</b>`,
      ``,
      `📦 <b>Tracking:</b> <code>${tracking}</code>`,
      `🛒 <b>Ordine PrestaShop:</b> <b>${orderRef}</b>`,
      `⚠️ <b>Stato Raben:</b> <b>${status}</b>`,
      `📍 <b>Dettaglio:</b> ${detail}`,
      `🕒 <i>Rilevato il: ${new Date().toLocaleString('it-IT')}</i>`,
    ].join('\n');

    const subjectEmail = `[Raben Alert] Eccezione spedizione ${tracking} (Ordine ${orderRef})`;
    const htmlEmail = `
      <div style="font-family: sans-serif; max-width: 560px; padding: 20px; border: 1px solid #fee2e2; border-radius: 8px; background: #fffaf0;">
        <h3 style="color: #b91c1c; margin-top: 0;">⚠️ Eccezione Raben Rilevata</h3>
        <p>Una spedizione attiva richiede attenzione operativa:</p>
        <ul style="line-height: 1.6; color: #334155;">
          <li><strong>Tracking:</strong> <code>${tracking}</code></li>
          <li><strong>Riferimento Ordine:</strong> <strong>${orderRef}</strong></li>
          <li><strong>Stato Raben:</strong> <span style="color: #b91c1c; font-weight: bold;">${status}</span></li>
          <li><strong>Dettaglio:</strong> ${detail}</li>
          <li><strong>Data evento:</strong> ${new Date().toLocaleString('it-IT')}</li>
        </ul>
      </div>
    `;

    return this.dispatchBoth({ key: ['exception', shipment.trackingNumber, rabenOutcome.status || shipment.rabenStatus, rabenOutcome.statusAt || rabenOutcome.statusDateRaw || rabenOutcome.detail || '', rabenOutcome.reasonCode || ''], label: `Eccezione · ${shipment.trackingNumber}`, trigger: 'exceptions', telegramText: textTelegram, emailSubject: subjectEmail, emailHtml: htmlEmail, signal });
  }

  async notifyAutoSyncSuccess(shipment, targetStateName, { signal, eventAt = '', stateId = '' } = {}) {
    if (!this.config.triggers?.autoSyncSuccess) return { skipped: true };

    const tracking = markup(shipment.trackingNumber, 80);
    const orderRef = markup(shipment.orderReference || shipment.orderId || 'N/D', 160);
    const targetLabel = markup(targetStateName, 160);

    const textTelegram = [
      `⚡ <b>Raben Cron · Ordine PrestaShop Allineato</b>`,
      ``,
      `📦 <b>Tracking:</b> <code>${tracking}</code>`,
      `🛒 <b>Ordine:</b> <b>${orderRef}</b>`,
      `🔄 <b>Nuovo Stato:</b> <b>${targetLabel}</b>`,
      `🛡️ <i>Nessuna email inviata al cliente</i>`,
      `🕒 <i>${new Date().toLocaleString('it-IT')}</i>`,
    ].join('\n');

    const subjectEmail = `[Raben Auto-Sync] Ordine ${orderRef} aggiornato a ${targetStateName}`;
    const htmlEmail = `
      <div style="font-family: sans-serif; max-width: 560px; padding: 20px; border: 1px solid #d1fae5; border-radius: 8px; background: #f0fdf4;">
        <h3 style="color: #047857; margin-top: 0;">✓ Ordine Allineato su PrestaShop</h3>
        <p>Il cron ha sincronizzato lo stato in background:</p>
        <ul style="line-height: 1.6; color: #334155;">
          <li><strong>Spedizione:</strong> <code>${tracking}</code></li>
          <li><strong>Rif. Ordine:</strong> <strong>${orderRef}</strong></li>
          <li><strong>Nuovo Stato:</strong> <strong>${targetLabel}</strong></li>
          <li><strong>Notifica cliente:</strong> Disattivata (zero email)</li>
        </ul>
      </div>
    `;

    return this.dispatchBoth({ key: ['auto-sync', shipment.trackingNumber, shipment.orderId || '', stateId || targetStateName, eventAt || shipment.rabenStatusAt || '', shipment.prestaStateId || shipment.currentState || ''], label: `Allineamento ordine · ${shipment.orderReference || shipment.orderId || shipment.trackingNumber}`, trigger: 'autoSyncSuccess', telegramText: textTelegram, emailSubject: subjectEmail, emailHtml: htmlEmail, signal });
  }

  async notifySlaBreach(delayedShipments = [], { signal, date = new Date(), count = delayedShipments.length } = {}) {
    if (!this.config.triggers?.sla48h || !delayedShipments.length) return { skipped: true };

    const itemsListTelegram = delayedShipments.slice(0, 8).map((s) => 
      `• <code>${markup(s.trackingNumber, 80)}</code> (${markup(s.orderReference || s.orderId || 'N/D', 160)}) - ${markup(s.rabenStatus || 'In attesa', 160)}`
    ).join('\n');

    const textTelegram = [
      `⏳ <b>Raben Alert · ${count} Spedizion${count === 1 ? 'e ferma' : 'i ferme'} da oltre 48h</b>`,
      ``,
      `Le seguenti spedizioni non registrano aggiornamenti recenti:`,
      itemsListTelegram,
      count > 8 ? `<i>...e altre ${count - 8} spedizioni</i>` : '',
      ``,
      `<i>Verifica il Centro di Controllo per gestire i ticket.</i>`,
    ].filter(Boolean).join('\n');

    const subjectEmail = `[Raben SLA Alert] ${count} spedizioni ferme da oltre 48 ore`;
    const htmlEmail = `
      <div style="font-family: sans-serif; max-width: 560px; padding: 20px; border: 1px solid #fed7aa; border-radius: 8px; background: #fffaf0;">
        <h3 style="color: #c2410c; margin-top: 0;">⏳ Allarme SLA: Spedizioni Ferme da > 48h</h3>
        <p>Sono state rilevate <strong>${count}</strong> spedizioni non consegnate senza aggiornamenti nelle ultime 48 ore:</p>
        <ul style="line-height: 1.6; color: #334155;">
          ${delayedShipments.slice(0, 10).map((s) => `<li><code>${markup(s.trackingNumber, 80)}</code> (Ordine: <strong>${markup(s.orderReference || s.orderId || 'N/D', 160)}</strong>) — ${markup(s.rabenStatus || 'In movimento', 160)}</li>`).join('')}
        </ul>
        ${count > 10 ? `<p><em>...più altre ${count - 10} spedizioni nel Centro di Controllo.</em></p>` : ''}
      </div>
    `;

    return this.dispatchBoth({ key: ['sla48h', notificationDay(date)], label: 'Spedizioni ferme · ' + notificationDay(date), trigger: 'sla48h', telegramText: textTelegram, emailSubject: subjectEmail, emailHtml: htmlEmail, signal });
  }

  async sendDailyDigest(summary = {}, { signal, date = new Date() } = {}) {
    if (!this.config.triggers?.dailyDigest) return { skipped: true };

    const { totalActive = 0, deliveredToday = 0, exceptions = 0, delayed = 0 } = summary;

    const textTelegram = [
      `📊 <b>Raben Tracking Center · Digest Mattutino</b>`,
      ``,
      `📦 Spedizioni attive in monitoraggio: <b>${totalActive}</b>`,
      `✅ Consegnate oggi (Europe/Rome): <b>${deliveredToday}</b>`,
      `⚠️ Eccezioni aperte da verificare: <b>${exceptions}</b>`,
      `⏳ Spedizioni ferme > 48h: <b>${delayed}</b>`,
      `Date evento mancanti: <b>${Number(summary.missingEventDate) || 0}</b> · future: <b>${Number(summary.futureEventDate) || 0}</b>`,
      ``,
      `<i>Buon lavoro dal tuo centro di controllo logistico!</i>`,
    ].join('\n');

    const subjectEmail = `[Raben Daily Digest] Riepilogo Spedizioni del ${date.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' })}`;
    const htmlEmail = `
      <div style="font-family: sans-serif; max-width: 560px; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h3 style="color: #0b1528; margin-top: 0;">📊 Riepilogo Giornaliero Spedizioni Raben</h3>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0;">Spedizioni attive:</td><td style="text-align: right; font-weight: bold;">${totalActive}</td></tr>
          <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; color: #10b981;">Consegnate oggi:</td><td style="text-align: right; font-weight: bold; color: #10b981;">${deliveredToday}</td></tr>
          <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; color: #ef4444;">Eccezioni aperte:</td><td style="text-align: right; font-weight: bold; color: #ef4444;">${exceptions}</td></tr>
          <tr><td style="padding: 8px 0; color: #f59e0b;">Ferme da > 48h:</td><td style="text-align: right; font-weight: bold; color: #f59e0b;">${delayed}</td></tr>
        </table>
        <p>Date evento mancanti: ${Number(summary.missingEventDate) || 0} · future: ${Number(summary.futureEventDate) || 0}. Escluse dal conteggio SLA.</p>
        <small style="color: #94a3b8;">Generato alle ${date.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome' })} (Europe/Rome)</small>
      </div>
    `;

    return this.dispatchBoth({ key: ['digest', notificationDay(date)], label: 'Riepilogo giornaliero · ' + notificationDay(date), trigger: 'dailyDigest', telegramText: textTelegram, emailSubject: subjectEmail, emailHtml: htmlEmail, signal });
  }

  async dispatchBoth({ key, label, trigger, telegramText, emailSubject, emailHtml, signal }) {
    if (this.outbox) return this.outbox.enqueue({ key, label, trigger, telegramText, emailSubject, emailHtml, signal });
    const results = {};
    if (this.config.telegram?.enabled) {
      try {
        results.telegram = await this.sendTelegram({ text: telegramText, signal });
      } catch (err) {
        this.logger.error('[NOTIFICATIONS] Errore invio Telegram:', err.message);
        results.telegram = { ok: false, error: err.message };
      }
    }
    if (this.config.email?.enabled) {
      try {
        results.email = await this.sendEmail({ subject: emailSubject, html: emailHtml, signal });
      } catch (err) {
        this.logger.error('[NOTIFICATIONS] Errore invio Email:', err.message);
        results.email = { ok: false, error: err.message };
      }
    }
    return results;
  }
}
