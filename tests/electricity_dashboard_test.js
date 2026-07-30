#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function loadDashboard() {
  const context = vm.createContext({
    Date,
    isNaN,
    Number,
    Math,
    Object,
    String,
    Array,
    Charts: {
      ChartHiddenDimensionStrategy: {
        IGNORE_ROWS: 'IGNORE_ROWS'
      },
      ChartMergeStrategy: {
        MERGE_COLUMNS: 'MERGE_COLUMNS'
      }
    },
    getHeaderAliases_: (key) => ({
      issueDate: ['issue date'],
      year: ['reference year'],
      month: ['reference month']
    })[key] || [],
    getSpreadsheetFormulaArgumentSeparator_: () => ',',
    normalizeHeader_: (value) => String(value).trim().toLowerCase(),
    findHeaderIndex_: (lookup, aliases) => aliases.map((alias) =>
      lookup[String(alias).trim().toLowerCase()]
    ).find(Boolean) || 0
  });
  ['locales/en.gs', 'locales/it.gs', 'Localization.gs',
    'ElectricityDashboard.gs'].forEach((file) => {
    vm.runInContext(
      fs.readFileSync(path.join(projectRoot, file), 'utf8'),
      context,
      { filename: file }
    );
  });
  return context;
}

function loadInstaller() {
  const context = vm.createContext({ Object, String });
  ['locales/en.gs', 'locales/it.gs', 'Localization.gs', 'Installer.gs']
    .forEach((file) => {
      vm.runInContext(
        fs.readFileSync(path.join(projectRoot, file), 'utf8'),
        context,
        { filename: file }
      );
    });
  return context;
}

function testLocalizedDashboardContracts() {
  const context = loadDashboard();
  const english = context.getElectricityDashboardLabels_('en');
  const italian = context.getElectricityDashboardLabels_('it');

  assert.equal(JSON.stringify(english.bandAliases), JSON.stringify([
    ['consumption quantity f1', 'consumption f1 quantity',
      'quantity consumption f1'],
    ['consumption quantity f2', 'consumption f2 quantity',
      'quantity consumption f2'],
    ['consumption quantity f3', 'consumption f3 quantity',
      'quantity consumption f3']
  ]));
  assert.equal(JSON.stringify(italian.bandAliases), JSON.stringify([
    ['quantità consumi f1'],
    ['quantità consumi f2'],
    ['quantità consumi f3']
  ]));
  assert.equal(english.charts.monthlyF2, 'Monthly F2 consumption by year');
  assert.equal(italian.charts.monthlyF3,
    'Confronto mensile consumi F3 per anno');
}

function testElectricityInstallerHeadersStaySupplySpecific() {
  const context = loadInstaller();
  const waterHeaders = context.getInstallerSheetHeaders_('en', false);
  const electricityHeaders = context.getInstallerSheetHeaders_('en', true);
  const italianHeaders = context.getInstallerSheetHeaders_('it', true);

  assert.equal(waterHeaders.includes('Consumption quantity F1'), false);
  assert.equal(electricityHeaders.includes('Consumption quantity F1'), true);
  assert.equal(electricityHeaders.includes('Unit cost F3'), true);
  assert.equal(italianHeaders.includes('Quantità consumi F2'), true);
  assert.equal(italianHeaders.includes('Costo unitario F3'), true);
}

function testDashboardSkipsSheetsWithoutAllRequiredHeaders() {
  const context = loadDashboard();
  context.getHeaderAliases_ = (key) => ({
    issueDate: ['issue date'],
    year: ['reference year'],
    month: ['reference month']
  })[key] || [];
  const labels = context.getElectricityDashboardLabels_('en');
  const complete = {
    'issue date': 1,
    'reference year': 2,
    'reference month': 3,
    'consumption quantity f1': 4,
    'consumption quantity f2': 5,
    'consumption quantity f3': 6
  };
  context.getSheetLayout_ = () => ({ lookup: complete });
  assert.equal(context.hasElectricityDashboardHeaders_({}, labels), true);

  delete complete['consumption quantity f2'];
  assert.equal(context.hasElectricityDashboardHeaders_({}, labels), false);
}

function testDashboardValidationPreventsPartialArtifacts() {
  const context = loadDashboard();
  const labels = context.getElectricityDashboardLabels_('en');
  context.getHeaderAliases_ = (key) => ({
    issueDate: ['issue date'],
    year: ['reference year'],
    month: ['reference month']
  })[key] || [];
  const lookup = {
    'issue date': 1,
    'reference year': 2,
    'reference month': 3,
    'consumption quantity f1': 4,
    'consumption quantity f2': 5,
    'consumption quantity f3': 6
  };
  const source = { getLastRow: () => 10002 };
  const inserted = [];
  context.getSheetLayout_ = () => ({ headerRow: 1, lookup });
  const spreadsheet = {
    getSheetByName: (name) => name === 'Electricity' ? source : null,
    insertSheet: (name) => inserted.push(name)
  };
  const config = { locale: 'en', sheet_by_supply: { electricity: 'Electricity' } };

  source.getLastRow = () => 2;
  context.getElectricityDashboardYears_ = () => [2026];
  assert.throws(() => context.initializeElectricityDashboard_({
    getSheetByName: (name) => name === 'Electricity' || name === labels.sheet ?
      source : null
  }, config), /dashboard sheet name matches a source sheet/);

  source.getLastRow = () => 10002;
  assert.throws(() => context.initializeElectricityDashboard_(spreadsheet, config),
    /supports up to 10000 source rows/);
  assert.deepEqual(inserted, []);

  source.getLastRow = () => 2;
  context.getElectricityDashboardYears_ = () => Array(26).fill(2026);
  assert.throws(() => context.initializeElectricityDashboard_(spreadsheet, config),
    /supports up to 25 years/);
  assert.deepEqual(inserted, []);
  context.getElectricityDashboardYears_ = () => [2026];
  assert.equal(context.validateElectricityDashboardSource_(source, labels), true);

  delete lookup['consumption quantity f2'];
  assert.throws(() => context.initializeElectricityDashboard_({
    getSheetByName: (name) => name === 'Electricity' ? source : {}
  }, config), /source headers are missing or invalid/);
  lookup['consumption quantity f2'] = 5;

  const fullSheet = {
    getMaxRows: () => 100000,
    getMaxColumns: () => 100
  };
  const capacityInserted = [];
  assert.throws(() => context.initializeElectricityDashboard_({
    getSheetByName: (name) => name === 'Electricity' ? source : null,
    getSheets: () => [fullSheet],
    insertSheet: (name) => capacityInserted.push(name)
  }, config), /cell limit/);
  assert.deepEqual(capacityInserted, []);
}

function testDashboardCreationAttemptsBothCleanupsAfterFailure() {
  const context = loadDashboard();
  const labels = context.getElectricityDashboardLabels_('en');
  const source = {};
  const dashboard = {};
  const technical = {};
  const deleted = [];
  const spreadsheet = {
    getSheetByName: (name) => name === 'Electricity' ? source : null,
    getSheets: () => [],
    insertSheet: (name) => name === labels.sheet ? dashboard : technical,
    deleteSheet: (sheet) => {
      deleted.push(sheet);
      if (sheet === technical) {
        throw new Error('technical delete failed');
      }
    }
  };
  const config = { locale: 'en', sheet_by_supply: { electricity: 'Electricity' } };
  context.validateElectricityDashboardSource_ = () => true;
  context.assertElectricityDashboardTechnicalSheet_ = () => {};
  context.assertElectricityDashboardCapacity_ = () => {};
  context.markElectricityDashboardTechnicalSheet_ = () => {};
  context.captureElectricityChartLayouts_ = () => ({});
  context.writeElectricityDashboardData_ = () => {
    throw new Error('write failed');
  };

  assert.throws(() => context.initializeElectricityDashboard_(spreadsheet, config),
    /write failed.*Technical sheet cleanup also failed: technical delete failed/);
  assert.deepEqual(deleted, [technical, dashboard]);
}

function testTechnicalSheetCannotAliasAnyConfiguredSource() {
  const context = loadDashboard();
  const labels = context.getElectricityDashboardLabels_('en');
  const electricity = {};
  const water = {};
  const spreadsheet = {
    getSheetByName: (name) => {
      if (name === 'Electricity') {
        return electricity;
      }
      return name === labels.dataSheet ? water : null;
    }
  };
  context.validateElectricityDashboardSource_ = () => true;
  assert.throws(() => context.initializeElectricityDashboard_(spreadsheet, {
    locale: 'en',
    sheet_by_supply: { electricity: 'Electricity', water: labels.dataSheet }
  }), /technical sheet name matches a source sheet/);
}

function testDashboardInitializationReconcilesInterruptedBackups() {
  const context = loadDashboard();
  const labels = context.getElectricityDashboardLabels_('en');
  const source = {};
  const technical = {};
  const backup = {
    getName: () => 'Electricity dashboard backup 1234567890123',
    getDeveloperMetadata: () => [{
      getKey: () => 'gduc.electricity_dashboard_backup',
      getValue: () => 'v1'
    }]
  };
  const userNamedSheet = {
    getName: () => 'Electricity dashboard backup 9876543210987',
    getDeveloperMetadata: () => []
  };
  const deleted = [];
  const spreadsheet = {
    getSheetByName: (name) => name === 'Electricity' ? source :
      name === labels.dataSheet ? technical : null,
    getSheets: () => [backup, userNamedSheet],
    deleteSheet: (sheet) => deleted.push(sheet)
  };
  context.validateElectricityDashboardSource_ = () => true;
  context.assertElectricityDashboardTechnicalSheet_ = () => {};
  context.assertElectricityDashboardCapacity_ = () => {
    assert.deepEqual(deleted, [backup]);
    throw new Error('stop after preflight');
  };
  assert.throws(() => context.initializeElectricityDashboard_(spreadsheet, {
    locale: 'en', sheet_by_supply: { electricity: 'Electricity' }
  }), /stop after preflight/);
}

function testTechnicalFormulaRangesUseReservedCapacity() {
  const context = loadDashboard();
  const source = {
    sheet: "'Electricity'!",
    date: 'A',
    year: 'F',
    month: 'G',
    firstDataRow: 2,
    lastRow: 10002,
    separator: ','
  };

  assert.equal(
    context.electricitySourceColumnFormula_(source, 'N'),
    '=ARRAYFORMULA(IF(\'Electricity\'!$N$2:$N$10002="","",\'Electricity\'!$N$2:$N$10002))'
  );
  assert.equal(
    context.electricitySumFormula_(source, 'N', 2026, 4),
    '=SUMPRODUCT((IFERROR(IF((VALUE(\'Electricity\'!$F$2:$F$10002)>=1900)*(VALUE(\'Electricity\'!$F$2:$F$10002)<=9999),VALUE(\'Electricity\'!$F$2:$F$10002),YEAR(\'Electricity\'!$A$2:$A$10002)),YEAR(\'Electricity\'!$A$2:$A$10002))=2026)*(IFERROR(IF((VALUE(\'Electricity\'!$G$2:$G$10002)>=1)*(VALUE(\'Electricity\'!$G$2:$G$10002)<=12),VALUE(\'Electricity\'!$G$2:$G$10002),MONTH(\'Electricity\'!$A$2:$A$10002)),MONTH(\'Electricity\'!$A$2:$A$10002))=4)*\'Electricity\'!$N$2:$N$10002)'
  );
  assert.equal(
    context.electricityAnnualFormula_(source, 'N', 2026),
    '=SUMPRODUCT((IFERROR(IF((VALUE(\'Electricity\'!$F$2:$F$10002)>=1900)*(VALUE(\'Electricity\'!$F$2:$F$10002)<=9999),VALUE(\'Electricity\'!$F$2:$F$10002),YEAR(\'Electricity\'!$A$2:$A$10002)),YEAR(\'Electricity\'!$A$2:$A$10002))=2026)*\'Electricity\'!$N$2:$N$10002)'
  );
  assert.equal(context.columnLetter_(90), 'CL');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.getElectricityDashboardTechnicalGrid_())),
    {
      rows: 10001,
      columns: 90,
      monthlyStarts: [6, 33, 60],
      blockWidth: 26,
      annualStart: 87
    }
  );
}

function testDashboardCapacityIncludesTemporaryBackup() {
  const context = loadDashboard();
  const grid = context.getElectricityDashboardTechnicalGrid_();
  const technical = {
    getMaxRows: () => 1000,
    getMaxColumns: () => grid.columns
  };
  const other = {
    getMaxRows: () => 1,
    getMaxColumns: () => 10000000 - grid.rows * grid.columns
  };
  assert.throws(() => context.assertElectricityDashboardCapacity_({
    getSheets: () => [other, technical]
  }, {}, technical), /temporary backup exceeds/);
}

function testTechnicalRangesUseTheReservedGrid() {
  const context = loadDashboard();
  const labels = context.getElectricityDashboardLabels_('en');
  context.getHeaderAliases_ = (key) => ({
    issueDate: ['issue date'],
    year: ['reference year'],
    month: ['reference month']
  })[key] || [];
  const lookup = {
    'issue date': 1,
    'reference year': 2,
    'reference month': 3,
    'consumption quantity f1': 4,
    'consumption quantity f2': 5,
    'consumption quantity f3': 6
  };
  const requestedRanges = [];
  const technical = {
    getMaxRows: () => 10001,
    getMaxColumns: () => 90,
    getRange: (...args) => {
      requestedRanges.push(args);
      return {
        clearContent: () => {},
        setValues: () => {},
        setFormula: () => {},
        setNumberFormat: () => {},
        setFormulas: () => {}
      };
    }
  };
  const electricity = {
    getName: () => 'Electricity',
    getLastRow: () => 2
  };
  context.getSheetLayout_ = () => ({ headerRow: 1, lookup });
  context.getElectricityDashboardYears_ = () => [2026];
  context.writeElectricityMonthlyBandsData_ = () => {};
  context.writeElectricityBandComparisonData_ = () => {};
  context.writeElectricityAnnualData_ = () => {};
  const ranges = context.writeElectricityDashboardData_(technical, electricity,
    labels);
  assert.deepEqual(
    JSON.parse(JSON.stringify(requestedRanges.at(-1))), [1, 87, 26, 4]
  );
  assert.ok(ranges.annualBands);
}

function testYearDiscoveryUsesReferenceYearThenIssueDate() {
  const context = loadDashboard();
  const sheet = {
    getLastRow: () => 4,
    getRange: () => ({
      getValues: () => [
        [new Date('2024-05-01'), 2024],
        [new Date('2026-01-01'), '2026'],
        [new Date('2025-01-01'), 'not-a-year']
      ]
    })
  };

  assert.equal(
    JSON.stringify(context.getElectricityDashboardYears_(sheet, 2, 1, 1)),
    JSON.stringify([2024, 2025, 2026])
  );
}

function testTechnicalGridExpansionAndLayoutPreservation() {
  const context = loadDashboard();
  const calls = [];
  const technical = {
    getMaxRows: () => 10,
    getMaxColumns: () => 5,
    getSheetId: () => 42,
    insertRowsAfter: (start, count) => calls.push(['rows', start, count]),
    insertColumnsAfter: (start, count) => calls.push(['columns', start, count])
  };
  context.ensureElectricityDashboardGrid_(technical, 20, 12);
  assert.deepEqual(calls, [['rows', 10, 10], ['columns', 5, 7]]);

  const labels = context.getElectricityDashboardLabels_('en');
  const options = {
    get: (key) => ({
      title: labels.charts.monthlyF1,
      width: 811,
      height: 377,
      fontSize: 17,
      colors: ['#123456'],
      legend: { position: 'bottom' },
      series: { 0: { lineWidth: 4, pointSize: 7 } }
    })[key]
  };
  const chartTechnical = {
    getSheetId: () => 42,
    getMaxRows: () => 10001,
    getMaxColumns: () => 90
  };
  const range = {
    getA1Notation: () => 'F1:AE13',
    getSheet: () => chartTechnical,
    getRow: () => 1,
    getColumn: () => 6,
    getNumRows: () => 13,
    getNumColumns: () => 26
  };
  const wrongRange = {
    getA1Notation: () => 'AF1:AI26',
    getSheet: () => chartTechnical,
    getRow: () => 1,
    getColumn: () => 32,
    getNumRows: () => 26,
    getNumColumns: () => 4
  };
  const layouts = context.captureElectricityChartLayouts_({
    getCharts: () => [{
      getOptions: () => options,
      getRanges: () => [range, wrongRange],
      getContainerInfo: () => ({
        getAnchorRow: () => 17,
        getAnchorColumn: () => 9,
        getOffsetX: () => 12,
        getOffsetY: () => 14
      })
    }]
  }, chartTechnical, labels);
  assert.equal(layouts.monthlyF1.row, 17);
  assert.equal(layouts.monthlyF1.width, 811);
  assert.equal(JSON.stringify(layouts.monthlyF1.sourceRanges),
    JSON.stringify(['F1:AE13']));
  assert.equal(JSON.stringify(layouts.monthlyF1.options.colors),
    JSON.stringify(['#123456']));
  assert.equal(JSON.stringify(layouts.monthlyF1.options.legend),
    JSON.stringify({ position: 'bottom' }));
  assert.equal(layouts.monthlyF1.options.fontSize, 17);
  assert.equal(JSON.stringify(layouts.monthlyF1.options.series),
    JSON.stringify({ 0: { lineWidth: 4, pointSize: 7 } }));

  const addedRanges = [];
  const unexpectedBuilderStateCalls = [];
  const builder = {
    addRange: (range) => {
      addedRanges.push(range.a1);
      return builder;
    },
    setHiddenDimensionStrategy: (value) => {
      unexpectedBuilderStateCalls.push(['hidden', value]);
      return builder;
    },
    setMergeStrategy: (value) => {
      unexpectedBuilderStateCalls.push(['merge', value]);
      return builder;
    },
    setNumHeaders: (value) => {
      unexpectedBuilderStateCalls.push(['headers', value]);
      return builder;
    },
    setPosition: () => builder,
    setOption: () => builder,
    build: () => ({})
  };
  context.insertElectricityChart_({
    newChart: () => ({ asColumnChart: () => builder }),
    insertChart: () => {}
  }, {
    getRange: (a1) => ({ a1 })
  }, { a1: 'A1:D10001' }, layouts.monthlyF1, labels.charts.monthlyF1,
  'column');
  assert.deepEqual(addedRanges, ['F1:AE13']);
  assert.deepEqual(unexpectedBuilderStateCalls, []);
}

function testTechnicalOwnershipAndCapacityPreflight() {
  const context = loadDashboard();
  const labels = context.getElectricityDashboardLabels_('en');
  const source = { getName: () => 'Electricity' };
  const unmanaged = {
    getName: () => labels.dataSheet,
    getDeveloperMetadata: () => [],
    isSheetHidden: () => false
  };
  assert.throws(() => context.assertElectricityDashboardTechnicalSheet_(
    unmanaged, source, labels), /unmanaged electricity dashboard technical sheet/);
  assert.throws(() => context.assertElectricityDashboardTechnicalSheet_(
    source, source, labels), /matches the source sheet/);

  const fullSheet = {
    getMaxRows: () => 100000,
    getMaxColumns: () => 100
  };
  assert.throws(() => context.assertElectricityDashboardCapacity_(
    { getSheets: () => [fullSheet] }, null, null), /cell limit/);
}

function testDashboardRefreshRebuildsEveryElectricityImport() {
  const context = loadDashboard();
  const technical = {
    getRange: () => ({ getValues: () => [[2025, 2026].concat(Array(23).fill(''))] })
  };
  assert.equal(context.hasElectricityDashboardYear_(technical, 2026), true);
  assert.equal(context.hasElectricityDashboardYear_(technical, 2027), false);
  assert.equal(context.electricityDashboardImportedYear_({ reference_year: '2027' }),
    2027);
  assert.equal(context.electricityDashboardImportedYear_({ issue_date: '2028-01-03' }),
    2028);

  const labels = context.getElectricityDashboardLabels_('en');
  const importedSheet = { getName: () => 'Electricity' };
  const spreadsheet = {
    getSheetByName: (name) => name === labels.dataSheet ? technical : null
  };
  const config = { locale: 'en', sheet_by_supply: { electricity: 'Electricity' } };
  let refreshes = 0;
  context.isManagedElectricityDashboardTechnicalSheet_ = () => true;
  context.validateElectricityDashboardSource_ = () => true;
  const options = [];
  context.initializeElectricityDashboard_ = (_spreadsheet, _config, value) => {
    refreshes += 1;
    options.push(value);
  };
  context.refreshElectricityDashboardAfterInvoiceImport_(spreadsheet, config,
    importedSheet, { reference_year: 2027 });
  context.refreshElectricityDashboardAfterInvoiceImport_(spreadsheet, config,
    importedSheet, { reference_year: 2026 });
  assert.equal(refreshes, 2);
  assert.equal(options[0].extendManagedRanges, true);
  assert.equal(options[1].extendManagedRanges, true);
}

function testDashboardRefreshValidatesEveryImportAndPropagatesFailures() {
  const context = loadDashboard();
  const labels = context.getElectricityDashboardLabels_('en');
  const importedSheet = { getName: () => 'Electricity' };
  const technical = { getRange: () => ({ getValues: () => [[2026]] }) };
  const spreadsheet = { getSheetByName: () => technical };
  const config = { locale: 'en', sheet_by_supply: { electricity: 'Electricity' } };
  assert.throws(() => context.refreshElectricityDashboardAfterInvoiceImport_({
    getSheetByName: (name) => name === labels.sheet ? {} : null
  }, config, importedSheet, { reference_year: 2026 }),
  /technical sheet is missing/);
  assert.doesNotThrow(() => context.refreshElectricityDashboardAfterInvoiceImport_({
    getSheetByName: () => null
  }, config, importedSheet, { reference_year: 2026 }));
  context.isManagedElectricityDashboardTechnicalSheet_ = () => false;
  assert.throws(() => context.refreshElectricityDashboardAfterInvoiceImport_({
    getSheetByName: () => ({})
  }, config, importedSheet, { reference_year: 2026 }),
  /technical sheet is unmanaged/);
  context.isManagedElectricityDashboardTechnicalSheet_ = () => true;
  context.validateElectricityDashboardSource_ = () => {
    throw new Error('source capacity exceeded');
  };
  assert.throws(() => context.refreshElectricityDashboardAfterInvoiceImport_(
    spreadsheet, config, importedSheet, { reference_year: 2026 }
  ), /source capacity exceeded/);

  context.validateElectricityDashboardSource_ = () => false;
  assert.throws(() => context.refreshElectricityDashboardAfterInvoiceImport_(
    spreadsheet, config, importedSheet, { reference_year: 2026 }
  ), /source headers are missing or invalid/);

  let logged = 0;
  context.validateElectricityDashboardSource_ = () => true;
  context.hasElectricityDashboardYear_ = () => false;
  context.initializeElectricityDashboard_ = () => {
    throw new Error('year capacity exceeded');
  };
  context.logCatalogEvent_ = () => { logged += 1; };
  context.classifyCatalogErrorForLog_ = () => 'validation';
  assert.throws(() => context.refreshElectricityDashboardAfterInvoiceImport_(
    spreadsheet, config, importedSheet, { reference_year: 2027 }
  ), /year capacity exceeded/);
  assert.equal(logged, 1);
  assert.equal(labels.dataSheet, 'Electricity Statistics - Data');
}

function testCustomizedChartBuilderStateSurvivesRefresh() {
  const context = loadDashboard();
  const labels = context.getElectricityDashboardLabels_('en');
  const chartTechnical = { getSheetId: () => 42 };
  const chartRange = (a1, column, columns) => ({
    getA1Notation: () => a1,
    getSheet: () => chartTechnical,
    getRow: () => 1,
    getColumn: () => column,
    getNumRows: () => 13,
    getNumColumns: () => columns
  });
  const options = {
    get: (key) => ({
      title: labels.charts.monthlyF1,
      width: 811,
      height: 377,
      legend: { position: 'bottom' }
    })[key]
  };
  let modifyCalls = 0;
  const original = {
    getOptions: () => options,
    getRanges: () => [
      chartRange('F1:F13', 6, 1),
      chartRange('G1:I13', 7, 3)
    ],
    getContainerInfo: () => ({
      getAnchorRow: () => 17,
      getAnchorColumn: () => 9,
      getOffsetX: () => 12,
      getOffsetY: () => 14
    }),
    getHiddenDimensionStrategy: () => 'IGNORE_COLUMNS',
    getMergeStrategy: () => 'MERGE_ROWS',
    getNumHeaders: () => 2,
    getTransposeRowsAndColumns: () => true,
    modify: () => {
      modifyCalls += 1;
      return { getChartType: () => 'AREA' };
    }
  };
  const inserted = [];
  const removed = [];
  const dashboard = {
    getCharts: () => [original],
    newChart: () => {
      const state = { options: {}, ranges: [] };
      const builder = {
        addRange: (range) => {
          state.ranges.push(range.a1);
          return builder;
        },
        setChartType: (chartType) => {
          state.chartType = chartType;
          return builder;
        },
        setHiddenDimensionStrategy: (strategy) => {
          state.hiddenDimensionStrategy = strategy;
          return builder;
        },
        setMergeStrategy: (strategy) => {
          state.mergeStrategy = strategy;
          return builder;
        },
        setNumHeaders: (headers) => {
          state.numHeaders = headers;
          return builder;
        },
        setPosition: (...position) => {
          state.position = position;
          return builder;
        },
        setOption: (key, value) => {
          state.options[key] = value;
          return builder;
        },
        setTransposeRowsAndColumns: (transpose) => {
          state.transposeRowsAndColumns = transpose;
          return builder;
        },
        build: () => ({ state })
      };
      return {
        asLineChart: () => {
          state.chartType = 'LINE';
          return builder;
        },
        asColumnChart: () => {
          state.chartType = 'COLUMN';
          return builder;
        }
      };
    },
    insertChart: (chart) => inserted.push(chart),
    removeChart: (chart) => removed.push(chart)
  };
  const technical = {
    getSheetId: () => 42,
    getRange: (a1) => ({ a1 })
  };
  context.getElectricityChartDataDimension_ = () => 4;

  context.refreshElectricityDashboardCharts_(dashboard, technical, {
    monthlyBands: { a1: 'A1:D10001' },
    monthlyF1: { a1: 'F1:AE13' },
    monthlyF2: { a1: 'AG1:BJ13' },
    monthlyF3: { a1: 'BK1:CK13' },
    annualBands: { a1: 'CI1:CL26' }
  }, labels, false);

  assert.equal(modifyCalls, 1);
  assert.equal(typeof original.getChartType, 'undefined');
  assert.deepEqual(removed, [original]);
  const refreshed = inserted.find((chart) =>
    chart.state.options.title === labels.charts.monthlyF1
  );
  assert.ok(refreshed);
  assert.equal(refreshed.state.chartType, 'AREA');
  assert.equal(refreshed.state.hiddenDimensionStrategy, 'IGNORE_COLUMNS');
  assert.equal(refreshed.state.mergeStrategy, 'MERGE_ROWS');
  assert.equal(refreshed.state.numHeaders, 2);
  assert.equal(refreshed.state.transposeRowsAndColumns, true);
  assert.deepEqual(refreshed.state.ranges, ['F1:F13', 'G1:I13']);
  assert.deepEqual(refreshed.state.position, [17, 9, 12, 14]);
}

function testJournalOnlyChartRangesUseDefaultsWhenDashboardIsRecreated() {
  const context = loadDashboard();
  const labels = context.getElectricityDashboardLabels_('en');
  const electricity = {};
  const inserted = [];
  const dashboard = {
    getCharts: () => [],
    newChart: () => {
      const state = { ranges: [], options: {} };
      const builder = {
        addRange: (range) => {
          state.ranges.push(range.a1);
          return builder;
        },
        setHiddenDimensionStrategy: (strategy) => {
          state.hiddenDimensionStrategy = strategy;
          return builder;
        },
        setMergeStrategy: (strategy) => {
          state.mergeStrategy = strategy;
          return builder;
        },
        setNumHeaders: (headers) => {
          state.numHeaders = headers;
          return builder;
        },
        setPosition: (...position) => {
          state.position = position;
          return builder;
        },
        setOption: (key, value) => {
          state.options[key] = value;
          return builder;
        },
        setTransposeRowsAndColumns: (transpose) => {
          state.transposeRowsAndColumns = transpose;
          return builder;
        },
        build: () => ({ state })
      };
      return {
        asLineChart: () => {
          state.chartType = 'LINE';
          return builder;
        },
        asColumnChart: () => {
          state.chartType = 'COLUMN';
          return builder;
        }
      };
    },
    insertChart: (chart) => inserted.push(chart),
    removeChart: () => {}
  };
  const technical = {
    getRange: (a1) => ({ a1 }),
    hideSheet: () => {}
  };
  const spreadsheet = {
    getSheetByName: (name) => name === 'Electricity' ? electricity : null,
    insertSheet: (name) => name === labels.sheet ? dashboard : technical
  };
  const chartRanges = {
    monthlyBands: { a1: 'A1:D10001' },
    monthlyF1: { a1: 'F1:AE13' },
    monthlyF2: { a1: 'AG1:BJ13' },
    monthlyF3: { a1: 'BK1:CK13' },
    annualBands: { a1: 'CI1:CL26' }
  };
  context.validateElectricityDashboardSource_ = () => true;
  context.assertElectricityDashboardTechnicalSheet_ = () => {};
  context.reconcileElectricityDashboardTechnicalBackups_ = () => {};
  context.assertElectricityDashboardCapacity_ = () => {};
  context.markElectricityDashboardTechnicalSheet_ = () => {};
  context.writeElectricityDashboardData_ = () => chartRanges;
  context.shouldExtendElectricityChartRange_ = (
    _preserved, _sourceRange, _technical, key
  ) => {
    assert.equal(key, 'monthlyF1');
    return false;
  };

  context.initializeElectricityDashboard_(spreadsheet, {
    locale: 'en',
    sheet_by_supply: { electricity: 'Electricity' }
  }, {
    preservedLayouts: {
      monthlyF1: { sourceRanges: ['F1:Z13'] }
    },
    extendManagedRanges: true
  });

  assert.equal(inserted.length, 5);
  const monthlyF1 = inserted.find((chart) =>
    chart.state.options.title === labels.charts.monthlyF1
  );
  assert.ok(monthlyF1);
  assert.deepEqual(monthlyF1.state.ranges, ['F1:Z13']);
  assert.deepEqual(monthlyF1.state.position, [8, 18, 0, 0]);
  assert.equal(monthlyF1.state.options.width, 700);
  assert.equal(monthlyF1.state.options.height, 360);
  assert.equal(JSON.stringify(monthlyF1.state.options.legend),
    JSON.stringify({ position: 'right' }));
  assert.equal(monthlyF1.state.chartType, 'COLUMN');
  assert.equal(monthlyF1.state.hiddenDimensionStrategy, 'IGNORE_ROWS');
  assert.equal(monthlyF1.state.mergeStrategy, 'MERGE_COLUMNS');
  assert.equal(monthlyF1.state.numHeaders, 1);
  assert.equal(monthlyF1.state.transposeRowsAndColumns, false);
}

function testManagedChartsSurviveReplacementFailure() {
  const context = loadDashboard();
  const labels = context.getElectricityDashboardLabels_('en');
  let builds = 0;
  const inserted = [];
  const removed = [];
  const original = {
    kind: 'original',
    getOptions: () => ({ get: (key) => key === 'title' ?
      labels.charts.monthlyBands : null })
  };
  const dashboard = {
    getCharts: () => [original],
    newChart: () => {
      const builder = {
        addRange: () => builder,
        setNumHeaders: () => builder,
        setPosition: () => builder,
        setOption: () => builder,
        build: () => {
          builds += 1;
          return { kind: 'replacement-' + builds };
        }
      };
      return { asLineChart: () => builder, asColumnChart: () => builder };
    },
    insertChart: (chart) => {
      if (chart.kind === 'replacement-2') {
        throw new Error('transient chart failure');
      }
      inserted.push(chart);
    },
    removeChart: (chart) => removed.push(chart)
  };
  context.captureElectricityChartLayouts_ = () => ({});
  assert.throws(() => context.refreshElectricityDashboardCharts_(dashboard,
    { getRange: () => ({}) }, {
      monthlyBands: {}, monthlyF1: {}, monthlyF2: {}, monthlyF3: {}, annualBands: {}
    }, labels), /transient chart failure/);
  assert.equal(inserted.length, 1);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].kind, 'replacement-1');
}

function testPreservedChartRangesExtendOnlyFromTheirManagedOrigin() {
  const context = loadDashboard();
  const sheet = {
    getSheetId: () => 42,
    getRange: () => ({ getValues: () => [['Month', 2024, 2025, 2026, 2027]] })
  };
  const canonical = {
    getSheet: () => sheet,
    getRow: () => 1,
    getColumn: () => 6,
    getNumRows: () => 13,
    getNumColumns: () => 26
  };
  const currentBoundary = {
    getSheet: () => sheet,
    getRow: () => 1,
    getColumn: () => 6,
    getNumRows: () => 13,
    getNumColumns: () => 4
  };
  const intentionallyShortened = {
    getSheet: () => sheet,
    getRow: () => 1,
    getColumn: () => 6,
    getNumRows: () => 13,
    getNumColumns: () => 3
  };
  const shifted = {
    getSheet: () => sheet,
    getRow: () => 1,
    getColumn: () => 7,
    getNumRows: () => 13,
    getNumColumns: () => 4
  };
  const splitSeries = {
    getSheet: () => sheet,
    getRow: () => 1,
    getColumn: () => 7,
    getNumRows: () => 13,
    getNumColumns: () => 3
  };
  assert.equal(context.shouldExtendElectricityChartRange_(currentBoundary,
    canonical, sheet, 'monthlyF1', 4), true);
  assert.equal(context.shouldExtendElectricityChartRange_(intentionallyShortened,
    canonical, sheet, 'monthlyF1', 4), false);
  assert.equal(context.shouldExtendElectricityChartRange_(shifted, canonical,
    sheet, 'monthlyF1', 4), false);
  assert.equal(context.shouldExtendElectricityChartRange_(splitSeries,
    canonical, sheet, 'monthlyF1', 4), true);
}

testLocalizedDashboardContracts();
testElectricityInstallerHeadersStaySupplySpecific();
testDashboardSkipsSheetsWithoutAllRequiredHeaders();
testDashboardValidationPreventsPartialArtifacts();
testDashboardCreationAttemptsBothCleanupsAfterFailure();
testTechnicalSheetCannotAliasAnyConfiguredSource();
testDashboardInitializationReconcilesInterruptedBackups();
testTechnicalFormulaRangesUseReservedCapacity();
testDashboardCapacityIncludesTemporaryBackup();
testTechnicalRangesUseTheReservedGrid();
testYearDiscoveryUsesReferenceYearThenIssueDate();
testTechnicalGridExpansionAndLayoutPreservation();
testTechnicalOwnershipAndCapacityPreflight();
testDashboardRefreshRebuildsEveryElectricityImport();
testDashboardRefreshValidatesEveryImportAndPropagatesFailures();
testCustomizedChartBuilderStateSurvivesRefresh();
testJournalOnlyChartRangesUseDefaultsWhenDashboardIsRecreated();
testManagedChartsSurviveReplacementFailure();
testPreservedChartRangesExtendOnlyFromTheirManagedOrigin();
console.log('electricity dashboard tests passed');
