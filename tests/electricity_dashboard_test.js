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
    '=SUMIFS(\'Electricity\'!$N$2:$N$10002,\'Electricity\'!$F$2:$F$10002,2026,\'Electricity\'!$G$2:$G$10002,4)'
  );
  assert.equal(
    context.electricityAnnualFormula_(source, 'N', 2026),
    '=SUMIF(\'Electricity\'!$F$2:$F$10002,2026,\'Electricity\'!$N$2:$N$10002)'
  );
  assert.equal(context.columnLetter_(90), 'CL');
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
      colors: ['#123456'],
      legend: { position: 'bottom' }
    })[key]
  };
  const layouts = context.captureElectricityChartLayouts_({
    getCharts: () => [{
      getOptions: () => options,
      getRanges: () => [{ getA1Notation: () => 'F1:AE13' }],
      getContainerInfo: () => ({
        getAnchorRow: () => 17,
        getAnchorColumn: () => 9,
        getOffsetX: () => 12,
        getOffsetY: () => 14
      })
    }]
  }, labels);
  assert.equal(layouts.monthlyF1.row, 17);
  assert.equal(layouts.monthlyF1.width, 811);
  assert.equal(JSON.stringify(layouts.monthlyF1.sourceRanges),
    JSON.stringify(['F1:AE13']));
  assert.equal(JSON.stringify(layouts.monthlyF1.options.colors),
    JSON.stringify(['#123456']));
  assert.equal(JSON.stringify(layouts.monthlyF1.options.legend),
    JSON.stringify({ position: 'bottom' }));
}

testLocalizedDashboardContracts();
testElectricityInstallerHeadersStaySupplySpecific();
testTechnicalFormulaRangesUseReservedCapacity();
testYearDiscoveryUsesReferenceYearThenIssueDate();
testTechnicalGridExpansionAndLayoutPreservation();
console.log('electricity dashboard tests passed');
