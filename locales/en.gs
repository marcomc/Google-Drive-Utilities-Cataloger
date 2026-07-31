/**
 * English labels and spreadsheet-header aliases.
 */
function getEnglishLocalization_() {
  return Object.freeze({
    promptLanguage: 'English',
    spreadsheetLocale: 'en_US',
    installerSheetHeaders: Object.freeze([
      'Issue date',
      'Supplier',
      'Invoice number',
      'Contract number',
      'Customer code',
      'Reference year',
      'Reference month',
      'Frequency',
      'Total consumption costs',
      'Total non-consumption costs',
      'VAT',
      'Total cost',
      'Source file'
    ]),
    electricityBandHeaders: Object.freeze([
      'Consumption quantity F1',
      'Unit cost F1',
      'Consumption quantity F2',
      'Unit cost F2',
      'Consumption quantity F3',
      'Unit cost F3'
    ]),
    electricityDashboard: Object.freeze({
      sheet: 'Electricity Statistics',
      dataSheet: 'Electricity Statistics - Data',
      dateHeader: 'Issue date',
      monthHeader: 'Month',
      yearHeader: 'Year',
      months: Object.freeze(['January', 'February', 'March', 'April', 'May',
        'June', 'July', 'August', 'September', 'October', 'November',
        'December']),
      bandHeaders: Object.freeze(['Consumption quantity F1',
        'Consumption quantity F2', 'Consumption quantity F3']),
      bandAliases: Object.freeze([
        Object.freeze(['consumption quantity f1', 'consumption f1 quantity',
          'quantity consumption f1']),
        Object.freeze(['consumption quantity f2', 'consumption f2 quantity',
          'quantity consumption f2']),
        Object.freeze(['consumption quantity f3', 'consumption f3 quantity',
          'quantity consumption f3'])
      ]),
      charts: Object.freeze({
        monthlyBands: 'Monthly consumption by band (F1/F2/F3)',
        monthlyF1: 'Monthly F1 consumption by year',
        monthlyF2: 'Monthly F2 consumption by year',
        monthlyF3: 'Monthly F3 consumption by year',
        annualBands: 'Annual consumption by band'
      })
    }),
    documentLabels: Object.freeze({ Invoice: 'Invoice', Contract: 'Contract', Report: 'Report' }),
    statusLabels: Object.freeze({
      IMPORTED: 'IMPORTED',
      ARCHIVED_WITHOUT_IMPORT: 'ARCHIVED WITHOUT IMPORT',
      DUPLICATE: 'DUPLICATE',
      NEEDS_REVIEW: 'NEEDS REVIEW',
      ERROR: 'ERROR'
    }),
    reportLabels: Object.freeze({
      softwareVersion: 'Software version',
      status: 'STATUS',
      originalFile: 'Original file',
      assignedName: 'Assigned name',
      destination: 'Drive destination',
      supplySupplier: 'Supply / supplier',
      identifier: 'Invoice or contract number',
      period: 'Issue date and period',
      consumption: 'Consumption or contributions',
      consumptionCost: 'Consumption cost',
      nonConsumptionCosts: 'Non-consumption costs',
      vat: 'VAT',
      total: 'Total',
      reconciliation: 'Reconciliation check',
      reconciliationPassed: 'passed',
      failureStage: 'Failure stage',
      extractedData: 'Gemini extracted data',
      persistence: 'Persistence',
      availableNotImported: 'available, not imported',
      rollbackCompleted: 'no import persisted; rollback completed',
      rollbackRequiresManualReview: 'rollback incomplete; manual review required',
      actions: 'Actions taken',
      issue: 'Issue and recommended action',
      notAvailable: 'not available',
      notChanged: 'not changed',
      notIdentified: 'not identified',
      noIssue: 'No issue.',
      notApplicable: 'not applicable',
      failureStages: Object.freeze({
        'extracting-document-data': 'Extracting document data',
        'validating-extracted-data': 'Validating extracted data',
        'validating-target-spreadsheet': 'Validating target spreadsheet',
        'checking-duplicates': 'Checking duplicates',
        'preparing-drive-destination': 'Preparing Drive destination',
        'spreadsheet-write-and-verify': 'Writing and verifying spreadsheet row',
        'renaming-and-moving-pdf': 'Renaming and moving PDF',
        'verifying-imported-row': 'Verifying imported row'
      }),
      emailSubject: '[Utilities] {count} PDF(s) processed'
    }),
    headerAliases: Object.freeze({
      issueDate: ['issue date'],
      supplier: ['supplier'],
      identifier: ['invoice number', 'document number'],
      contractNumber: ['contract number'],
      customerCode: ['customer code', 'customer/client code', 'client code'],
      sourceFile: ['source file'],
      year: ['year', 'reference year'],
      month: ['month', 'reference month'],
      frequency: ['frequency'],
      consumptionCost: ['total consumption costs', 'consumption cost'],
      nonConsumptionCosts: ['total non-consumption costs', 'non-consumption costs'],
      vat: ['vat'],
      total: ['total cost', 'total']
    })
  });
}
