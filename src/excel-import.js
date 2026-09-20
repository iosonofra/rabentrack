import XLSX from 'xlsx';

export const REQUIRED_HEADERS = [
  'Numero di spedizione (1)',
  'Numero di spedizione (2)',
  'Stato della spedizione',
  'referenza',
];

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeOrderReference(value) {
  const raw = clean(value).toUpperCase();
  const match = raw.match(/^([A-Z0-9]{9})(?:-R|-)?$/);
  return {
    raw,
    normalized: match?.[1] || raw,
    adjusted: Boolean(match && match[1] !== raw),
    valid: Boolean(match),
  };
}

export function normalizeRabenExportStatus(value) {
  const raw = clean(value);
  const normalized = raw.toLocaleLowerCase('it-IT');
  if (/consegnato con osservazioni/.test(normalized)) return 'Consegnata con riserva';
  if (/^consegnat[oa]$/.test(normalized)) return 'Consegnata';
  if (/^in consegna$/.test(normalized)) return 'In consegna';
  if (/non consegnat|non ritirat|parere richiesto|parametri errati/.test(normalized)) return 'Eccezione Raben';
  if (/inventario|scaricat|in corso|nuova data di consegna/.test(normalized)) return 'In transito';
  if (/caricat/.test(normalized)) return 'Caricata';
  if (/registrat|parametri di spedizione aggiornati/.test(normalized)) return 'Registrata';
  return raw || 'Non verificato';
}

export function readRabenWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('Il file non contiene fogli di lavoro.');

  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  const headerIndex = matrix.findIndex((row) => {
    const values = row.map(clean);
    return REQUIRED_HEADERS.every((header) => values.includes(header));
  });
  if (headerIndex === -1) {
    throw new Error(`Intestazioni Raben non trovate: ${REQUIRED_HEADERS.join(', ')}.`);
  }

  const headers = matrix[headerIndex].map(clean);
  const column = (name) => headers.indexOf(name);
  const rows = matrix.slice(headerIndex + 1)
    .map((row, index) => {
      const reference = normalizeOrderReference(row[column('referenza')]);
      const trackingNumber = clean(row[column('Numero di spedizione (1)')]);
      const secondaryTrackingNumber = clean(row[column('Numero di spedizione (2)')]);
      const rawStatus = clean(row[column('Stato della spedizione')]);
      return {
        sourceRow: headerIndex + index + 2,
        trackingNumber,
        secondaryTrackingNumber,
        orderReference: reference.normalized,
        orderReferenceRaw: reference.raw,
        orderReferenceAdjusted: reference.adjusted,
        rabenStatus: normalizeRabenExportStatus(rawStatus),
        rabenRawStatus: rawStatus,
        pickupDate: clean(row[column('Data di ritiro')]),
        plannedDeliveryDate: clean(row[column('Data di consegna pianificata')]),
        etaFrom: clean(row[column('ETA da')]),
        etaTo: clean(row[column('ETA per')]),
        recipient: clean(row[column('destinatario')]),
        deliveryLocation: clean(row[column('Luogo di scarico')]),
        deliveryCountry: clean(row[column('Paese di scarico')]),
        deliveryCity: clean(row[column('Città di scarico')]),
        sender: clean(row[column('Mittente')]),
        palletPlaces: clean(row[column('Luoghi pallet')]),
        referenceValid: reference.valid,
      };
    })
    .filter((row) => row.trackingNumber || row.secondaryTrackingNumber || row.orderReferenceRaw);

  const occurrences = new Map();
  for (const row of rows) {
    if (row.referenceValid) {
      occurrences.set(row.orderReference, (occurrences.get(row.orderReference) ?? 0) + 1);
    }
  }

  return rows.map((row) => ({
    ...row,
    duplicateReference: (occurrences.get(row.orderReference) ?? 0) > 1,
    validation: !row.trackingNumber
      ? 'Tracking principale mancante'
      : !row.orderReferenceRaw
        ? 'Riferimento ordine mancante'
        : !row.referenceValid
          ? 'Riferimento PrestaShop non riconosciuto'
          : 'Pronta per la verifica',
  }));
}
