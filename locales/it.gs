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
    electricityBandHeaders: Object.freeze([
      'Quantità consumi F1',
      'Costo unitario F1',
      'Quantità consumi F2',
      'Costo unitario F2',
      'Quantità consumi F3',
      'Costo unitario F3'
    ]),
    electricityDashboard: Object.freeze({
      sheet: 'Statistiche Luce',
      dataSheet: 'Statistiche Luce - Dati',
      dateHeader: 'Data di emissione',
      monthHeader: 'Mese',
      yearHeader: 'Anno',
      months: Object.freeze(['gennaio', 'febbraio', 'marzo', 'aprile',
        'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre',
        'novembre', 'dicembre']),
      bandHeaders: Object.freeze(['Quantità consumi F1',
        'Quantità consumi F2', 'Quantità consumi F3']),
      bandAliases: Object.freeze([
        Object.freeze(['quantità consumi f1']),
        Object.freeze(['quantità consumi f2']),
        Object.freeze(['quantità consumi f3'])
      ]),
      charts: Object.freeze({
        monthlyBands: 'Consumi mensili per fascia (F1/F2/F3)',
        monthlyF1: 'Confronto mensile consumi F1 per anno',
        monthlyF2: 'Confronto mensile consumi F2 per anno',
        monthlyF3: 'Confronto mensile consumi F3 per anno',
        annualBands: 'Consumo annuale per fascia'
      })
    }),
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
      reconciliationPassed: 'superata',
      failureStage: 'Fase errore',
      extractedData: 'Dati estratti da Gemini',
      persistence: 'Stato importazione',
      availableNotImported: 'disponibili, non importati',
      rollbackCompleted: 'nessun import persistito; rollback completato',
      rollbackRequiresManualReview: 'rollback incompleto; verifica manuale necessaria',
      actions: 'Azioni eseguite',
      issue: 'Problema e azione consigliata',
      notAvailable: 'non disponibile',
      notChanged: 'non modificato',
      notIdentified: 'non identificato',
      noIssue: 'Nessun problema.',
      notApplicable: 'non applicabile',
      failureStages: Object.freeze({
        'extracting-document-data': 'Estrazione dati documento',
        'validating-extracted-data': 'Validazione dati estratti',
        'validating-target-spreadsheet': 'Validazione foglio di destinazione',
        'checking-duplicates': 'Controllo duplicati',
        'preparing-drive-destination': 'Preparazione destinazione Drive',
        'spreadsheet-write-and-verify': 'Scrittura e verifica riga del foglio',
        'renaming-and-moving-pdf': 'Rinomina e spostamento PDF',
        'verifying-imported-row': 'Verifica riga importata'
      }),
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
