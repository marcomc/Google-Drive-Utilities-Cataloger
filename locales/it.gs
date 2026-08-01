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
    documentTypeAliases: Object.freeze({
      invoice: 'Invoice', fattura: 'Invoice', contract: 'Contract',
      contratto: 'Contract', report: 'Report'
    }),
    subscriberIdentifierProblemPatterns: Object.freeze([
      '\\b(?:assente|mancante|non\\s+presente|missing|absent|not\\s+present)\\b',
      '(?:numero\\s+(?:di\\s+)?contratto|codice\\s+(?:di\\s+)?contratto|contract(?:\\s+number)?|id\\s*utente|user\\s*id|(?:customer|client|account)\\s*(?:code|id)|(?:codice|numero)\\s+(?:cliente|utente))'
    ]),
    supplierFieldDefaults: Object.freeze([
      Object.freeze({
        supplier: 'ILIAD',
        supply_type: 'Internet',
        header: "Spese d'incasso",
        value: 0,
        fieldPattern: "\\b(?:spese?\\s+d['’]?incasso|spese?\\s+di\\s+incasso)\\b",
        explicitAbsencePattern: "\\b(?:non\\s+presente|non\\s+stampat[oa]e?|assente)\\b"
      })
    ]),
    supplierProfiles: Object.freeze({
      folder: 'Profili fornitori', pendingFolder: 'In attesa di approvazione',
      templateFolder: '_modello', profileFile: 'PROFILO.md',
      templateFile: 'PROFILO.example.md', statusKey: 'stato', approvedStatus: 'approvato',
      supplierKey: 'fornitore'
    }),
    supplierProfileTemplate: Object.freeze([
      '---', 'managed_by: Google Drive Utilities Cataloger', 'stato: approvato', 'fornitore: NOME FORNITORE',
      'forniture: [fornitura]', 'verificato_il: YYYY-MM-DD', '---', '',
      '# Profilo fornitore: NOME FORNITORE', '', '## Fonti', '',
      '- Sito ufficiale: <https://example.invalid/>',
      '- Istruzioni di lettura: versione/data, origine, URL e data di verifica.', '',
      '## Struttura del documento', '',
      '- Fattura: sezioni visive stabili, evidenze obbligatorie e varianti note.',
      '- Report: sezioni visive stabili, evidenze obbligatorie e varianti note.',
      '- Storico versioni: descrivere modifiche e intervallo/data di validità.', '',
      '## Navigazione', '',
      '- Classificare da evidenze stampate e struttura insieme, mai dal solo nome file.',
      '- Dopo la classificazione, seguire nell ordine le sezioni documentate e riconciliare il totale.',
      '- Una struttura non corrispondente richiede revisione o proposta pendente, mai invenzione di dati.', '',
      '## Manutenzione', '',
      '- Inserire un profilo rivisto in `In attesa di approvazione`; non sovrascrivere automaticamente il profilo approvato.', ''
    ]),
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
      extractedSnapshot: 'Snapshot estrazione',
      persistence: 'Stato importazione',
      availableNotImported: 'disponibili, non importati',
      rollbackCompleted: 'nessun import persistito; rollback completato',
      rollbackRequiresManualReview: 'rollback incompleto; verifica manuale necessaria',
      discrepancyDetails: 'Discrepanza rilevata',
      discrepancyField: 'campo',
      expectedValue: 'atteso',
      observedValue: 'riscontrato',
      tolerance: 'tolleranza',
      actions: 'Azioni eseguite',
      issue: 'Problema e azione consigliata',
      supplierProfiles: 'Profili fornitori e proposte',
      retryImport: 'Rilancia importazione',
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
      customerCode: ['codice cliente', 'numero cliente', 'codice cliente/utente', 'id utente'],
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
