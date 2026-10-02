const READY_STATUSES = new Set(['Pronta per aggiornamento', 'Tracking già presente']);

export function normalizeImportOptions(input = {}) {
  const updateTracking = input.updateTracking === true;
  const updateState = input.updateState === true;
  return {
    updateTracking,
    updateState,
    overwriteTracking: input.overwriteTracking === true && updateTracking,
  };
}

export function hasTrackingConflict(row = {}) {
  const existingTracking = String(row.existingTracking || '').trim();
  const requestedTracking = String(row.trackingNumber || '').trim();
  return Boolean(existingTracking && requestedTracking && existingTracking !== requestedTracking);
}

export function importRowEligibility(row = {}, input = {}) {
  const options = normalizeImportOptions(input);
  const verification = String(row.verification || '').trim();

  if (row.alreadyImported) return { eligible: false, reason: 'Spedizione già importata nel tracking center.', options };
  if (row.duplicateReference) return { eligible: false, reason: 'Più spedizioni fanno riferimento allo stesso ordine.', options };
  if (!READY_STATUSES.has(verification)) return { eligible: false, reason: verification || row.validation || 'Riga non verificata.', options };
  if (!options.updateTracking && !options.updateState) return { eligible: false, reason: 'Nessun aggiornamento selezionato.', options };

  const trackingConflict = hasTrackingConflict(row);
  if (trackingConflict && !options.updateState && !(options.updateTracking && options.overwriteTracking)) {
    return { eligible: false, reason: 'Tracking diverso già presente su PrestaShop.', trackingConflict, options };
  }

  return { eligible: true, reason: '', trackingConflict, options };
}

export function isImportRowEligible(row, input) {
  return importRowEligibility(row, input).eligible;
}
