/**
 * Italian labels and spreadsheet-header aliases.
 */
function getItalianLocalization_() {
  return Object.freeze({
    promptLanguage: 'Italian',
    spreadsheetLocale: 'it_IT',
    installerSheetHeaders: Object.freeze([
      'Data di emissione',
      'Fornitore',
      'Numero fattura',
      'Numero contratto',
      'Codice cliente',
      'Anno di riferimento',
      'Mese di riferimento',
      'Frequenza',
      'Totale costi consumo',
      'Totale costi non consumo',
      'IVA',
      'Costo totale',
      'File sorgente'
    ]),
    documentLabels: Object.freeze({ Invoice: 'Fattura', Contract: 'Contratto', Report: 'Report' }),
    statusLabels: Object.freeze({
      IMPORTED: 'IMPORTATO',
      ARCHIVED_WITHOUT_IMPORT: 'ARCHIVIATO SENZA IMPORTAZIONE',
      DUPLICATE: 'DUPLICATO',
      NEEDS_REVIEW: 'DA VERIFICARE',
      ERROR: 'ERRORE'
    }),
    reportLabels: Object.freeze({
      softwareVersion: 'Versione software',
      status: 'ESITO',
      originalFile: 'File originale',
      assignedName: 'Nome assegnato',
      destination: 'Destinazione Drive',
      supplySupplier: 'Fornitura / fornitore',
      identifier: 'Numero fattura o contratto',
      period: 'Data di emissione e periodo',
      consumption: 'Consumi o conferimenti',
      consumptionCost: 'Costo consumi',
      nonConsumptionCosts: 'Costi non consumo',
      vat: 'IVA',
      total: 'Totale',
      reconciliation: 'Verifica quadratura',
      actions: 'Azioni eseguite',
      issue: 'Problema e azione consigliata',
      notAvailable: 'non disponibile',
      notChanged: 'non modificato',
      notIdentified: 'non identificato',
      noIssue: 'Nessun problema.',
      notApplicable: 'non applicabile',
      emailSubject: '[Utenze] {count} PDF elaborato/i'
    }),
    headerAliases: Object.freeze({
      issueDate: ['data di emissione'],
      supplier: ['fornitore'],
      identifier: ['numero fattura', 'n fattura', 'numero documento'],
      contractNumber: ['numero contratto', 'codice contratto'],
      customerCode: ['codice cliente', 'numero cliente', 'codice cliente/utente'],
      sourceFile: ['file sorgente'],
      year: ['anno', 'anno riferimento', 'anno di riferimento'],
      month: [
        'numero mese di riferimento',
        'mese',
        'mese riferimento',
        'mese di riferimento'
      ],
      frequency: ['frequenza'],
      consumptionCost: ['totale costi consumo', 'costo consumi', 'costi consumo'],
      nonConsumptionCosts: ['totale costi non consumo', 'costi non consumo'],
      vat: ['iva'],
      total: ['costo totale', 'totale']
    })
  });
}
