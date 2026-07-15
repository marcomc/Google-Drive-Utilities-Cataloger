/**
 * English labels and spreadsheet-header aliases.
 */
function getEnglishLocalization_() {
  return Object.freeze({
    promptLanguage: 'English',
    documentLabels: Object.freeze({ Invoice: 'Invoice', Contract: 'Contract', Report: 'Report' }),
    statusLabels: Object.freeze({
      IMPORTED: 'IMPORTED',
      ARCHIVED_WITHOUT_IMPORT: 'ARCHIVED WITHOUT IMPORT',
      DUPLICATE: 'DUPLICATE',
      NEEDS_REVIEW: 'NEEDS REVIEW',
      ERROR: 'ERROR'
    }),
    reportLabels: Object.freeze({
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
      actions: 'Actions taken',
      issue: 'Issue and recommended action',
      notAvailable: 'not available',
      notChanged: 'not changed',
      notIdentified: 'not identified',
      noIssue: 'No issue.',
      notApplicable: 'not applicable',
      emailSubject: '[Utilities] {count} PDF(s) processed'
    }),
    headerAliases: Object.freeze({
      issueDate: ['issue date'],
      supplier: ['supplier'],
      identifier: ['invoice number', 'document number'],
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
