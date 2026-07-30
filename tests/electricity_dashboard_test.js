#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const dashboardCreationProperty =
  'ELECTRICITY_DASHBOARD_CREATION';
const technicalCreationProperty =
  'ELECTRICITY_DASHBOARD_TECHNICAL_CREATION';
const technicalBackupCreationProperty =
  'ELECTRICITY_DASHBOARD_TECHNICAL_BACKUP_CREATION';

function createScriptProperties(initialValues = {}) {
  const values = { ...initialValues };
  const history = [];
  return {
    values,
    history,
    api: {
      getProperty: (key) => values[key] || null,
      setProperty: (key, value) => {
        values[key] = value;
        history.push({ action: 'set', key, value });
      },
      deleteProperty: (key) => {
        delete values[key];
        history.push({ action: 'delete', key });
      }
    }
  };
}

function loadDashboard(scriptProperties = createScriptProperties()) {
  let uuidSequence = 0;
  const context = vm.createContext({
    Date,
    isNaN,
    Number,
    Math,
    Object,
    String,
    Array,
    PropertiesService: {
      getScriptProperties: () => scriptProperties.api
    },
    Utilities: {
      getUuid: () => {
        uuidSequence += 1;
        return `00000000-0000-4000-8000-${String(uuidSequence).padStart(12, '0')}`;
      }
    },
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
  ['Config.gs', 'locales/en.gs', 'locales/it.gs', 'Localization.gs',
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

function createPristineTechnicalSheet(name, sheetId) {
  let currentName = name;
  let parent = null;
  const metadata = [];
  const sheet = {
    getName: () => currentName,
    setName: (value) => {
      currentName = value;
      return sheet;
    },
    getSheetId: () => sheetId,
    getParent: () => parent,
    setParent: (value) => {
      parent = value;
    },
    getDeveloperMetadata: () => metadata.map((item) => ({
      getKey: () => item.key,
      getValue: () => item.value
    })),
    addDeveloperMetadata: (key, value) => {
      metadata.push({ key, value });
      return sheet;
    },
    getMaxRows: () => 1000,
    getMaxColumns: () => 26,
    getLastRow: () => 0,
    getLastColumn: () => 0,
    isSheetHidden: () => false,
    getFrozenRows: () => 0,
    getFrozenColumns: () => 0,
    getCharts: () => [],
    getDrawings: () => [],
    metadata
  };
  return sheet;
}

function createTechnicalSpreadsheet(initialSheets = []) {
  const sheets = initialSheets.slice();
  const insertedNames = [];
  let nextSheetId = 100;
  const spreadsheet = {
    getId: () => 'spreadsheet-1',
    getSheets: () => sheets.slice(),
    getSheetByName: (name) => sheets.find((sheet) =>
      sheet.getName() === name
    ) || null,
    insertSheet: (name) => {
      const sheet = createPristineTechnicalSheet(name, nextSheetId);
      nextSheetId += 1;
      sheet.setParent(spreadsheet);
      sheets.push(sheet);
      insertedNames.push(name);
      return sheet;
    },
    deleteSheet: (sheet) => {
      const index = sheets.indexOf(sheet);
      if (index >= 0) {
        sheets.splice(index, 1);
      }
    },
    insertedNames,
    sheets
  };
  sheets.forEach((sheet) => sheet.setParent(spreadsheet));
  return spreadsheet;
}

function makeBackupSheetOperational(sheet) {
  let rows = 1000;
  let columns = 26;
  let hidden = false;
  const state = { copies: 0 };
  sheet.getMaxRows = () => rows;
  sheet.getMaxColumns = () => columns;
  sheet.isSheetHidden = () => hidden;
  sheet.insertRowsAfter = (_after, count) => {
    rows += count;
  };
  sheet.insertColumnsAfter = (_after, count) => {
    columns += count;
  };
  sheet.getRange = (...args) => ({
    args,
    receiveCopy: () => {
      state.copies += 1;
    }
  });
  sheet.hideSheet = () => {
    hidden = true;
  };
  sheet.backupState = state;
  return sheet;
}

function createTechnicalBackupFixture() {
  const properties = createScriptProperties();
  const context = loadDashboard(properties);
  const labels = context.getElectricityDashboardLabels_('en');
  const technical = createPristineTechnicalSheet(labels.dataSheet, 1);
  const spreadsheet = createTechnicalSpreadsheet([technical]);
  context.markElectricityDashboardTechnicalSheet_(technical);
  technical.getRange = () => ({
    copyTo: (target) => target.receiveCopy()
  });
  const insertSheet = spreadsheet.insertSheet;
  spreadsheet.insertSheet = (name) =>
    makeBackupSheetOperational(insertSheet(name));
  return { properties, context, labels, technical, spreadsheet };
}

function createManagedChartRange(context, technical, key) {
  const block = context.getElectricityChartManagedBlock_(key);
  return {
    getSheet: () => technical,
    getRow: () => block.row,
    getColumn: () => block.column,
    getNumRows: () => block.rows,
    getNumColumns: () => block.columns
  };
}

function createLegacyDashboardSheet(context, labels, technical, sheetId = 2) {
  const dashboard = createPristineTechnicalSheet(labels.sheet, sheetId);
  const charts = Object.keys(labels.charts).map((key) => ({
    getOptions: () => ({
      get: (option) => option === 'title' ? labels.charts[key] : null
    }),
    getRanges: () => [createManagedChartRange(context, technical, key)]
  }));
  dashboard.getCharts = () => charts;
  dashboard.charts = charts;
  return dashboard;
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
  context.createElectricityDashboardSheet_ = () => dashboard;
  context.createElectricityDashboardTechnicalSheet_ = () => technical;
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

function testTechnicalBackupJournalsFreshCreation() {
  const fixture = createTechnicalBackupFixture();
  const { properties, context, technical, spreadsheet } = fixture;
  const insertSheet = spreadsheet.insertSheet;
  spreadsheet.insertSheet = (name) => {
    const planned = JSON.parse(
      properties.values[technicalBackupCreationProperty]
    );
    assert.equal(planned.state, 'planned');
    assert.equal(planned.technicalSheetId, technical.getSheetId());
    const backup = insertSheet(name);
    const addDeveloperMetadata = backup.addDeveloperMetadata;
    backup.addDeveloperMetadata = (key, value) => {
      const created = JSON.parse(
        properties.values[technicalBackupCreationProperty]
      );
      assert.equal(created.state, 'created');
      assert.equal(created.sheetId, backup.getSheetId());
      return addDeveloperMetadata(key, value);
    };
    return backup;
  };
  const copyTo = technical.getRange().copyTo;
  technical.getRange = () => ({
    copyTo: (target) => {
      const created = JSON.parse(
        properties.values[technicalBackupCreationProperty]
      );
      assert.equal(created.state, 'created');
      assert.equal(created.sheetId, spreadsheet.sheets.at(-1).getSheetId());
      assert.equal(context.isElectricityDashboardTechnicalBackup_(
        spreadsheet.sheets.at(-1)
      ), true);
      copyTo(target);
    }
  });

  const backup = context.createElectricityDashboardTechnicalBackup_(
    spreadsheet, technical, null
  );

  assert.match(backup.sheet.getName(),
    /^Electricity dashboard backup pending /);
  assert.equal(backup.sheet.isSheetHidden(), true);
  assert.equal(backup.sheet.backupState.copies, 5);
  assert.equal(JSON.parse(
    properties.values[technicalBackupCreationProperty]
  ).sheetId, backup.sheet.getSheetId());
  assert.deepEqual(properties.history.filter((entry) => entry.action === 'set')
    .map((entry) => JSON.parse(entry.value).state), ['planned', 'created']);

  spreadsheet.deleteSheet(backup.sheet);
  context.clearElectricityDashboardTechnicalBackupCreation_();
  assert.equal(properties.values[technicalBackupCreationProperty], undefined);
}

function testTechnicalBackupRecoversInterruptionBeforeAndAfterInsert() {
  const beforeInsert = createTechnicalBackupFixture();
  const beforeJournal =
    beforeInsert.context.planElectricityDashboardTechnicalBackupCreation_(
      beforeInsert.properties.api, beforeInsert.spreadsheet,
      beforeInsert.technical
    );
  const pending =
    beforeInsert.context.reconcileElectricityDashboardTechnicalBackups_(
      beforeInsert.spreadsheet, beforeInsert.technical
    );
  assert.equal(pending.journal.stagingName, beforeJournal.stagingName);
  assert.ok(beforeInsert.properties.values[technicalBackupCreationProperty]);
  assert.equal(beforeInsert.spreadsheet.sheets.length, 1);

  const afterInsert = createTechnicalBackupFixture();
  const afterJournal =
    afterInsert.context.planElectricityDashboardTechnicalBackupCreation_(
      afterInsert.properties.api, afterInsert.spreadsheet,
      afterInsert.technical
    );
  const staged = afterInsert.spreadsheet.insertSheet(afterJournal.stagingName);
  afterInsert.context.reconcileElectricityDashboardTechnicalBackups_(
    afterInsert.spreadsheet, afterInsert.technical
  );
  assert.equal(afterInsert.spreadsheet.sheets.includes(staged), false);
  assert.equal(
    afterInsert.properties.values[technicalBackupCreationProperty], undefined
  );
  const createdCheckpoint = afterInsert.properties.history.find((entry) =>
    entry.action === 'set' && JSON.parse(entry.value).state === 'created'
  );
  assert.equal(JSON.parse(createdCheckpoint.value).sheetId, staged.getSheetId());
}

function testTechnicalBackupRecoversExactIdBeforeAndAfterMarker() {
  const beforeMarker = createTechnicalBackupFixture();
  const beforeJournal =
    beforeMarker.context.planElectricityDashboardTechnicalBackupCreation_(
      beforeMarker.properties.api, beforeMarker.spreadsheet,
      beforeMarker.technical
    );
  const unmarked = beforeMarker.spreadsheet.insertSheet(
    beforeJournal.stagingName
  );
  beforeJournal.state = 'created';
  beforeJournal.sheetId = unmarked.getSheetId();
  beforeMarker.properties.api.setProperty(technicalBackupCreationProperty,
    JSON.stringify(beforeJournal));
  beforeMarker.context.reconcileElectricityDashboardTechnicalBackups_(
    beforeMarker.spreadsheet, beforeMarker.technical
  );
  assert.equal(beforeMarker.spreadsheet.sheets.includes(unmarked), false);

  const afterMarker = createTechnicalBackupFixture();
  const afterJournal =
    afterMarker.context.planElectricityDashboardTechnicalBackupCreation_(
      afterMarker.properties.api, afterMarker.spreadsheet,
      afterMarker.technical
    );
  const marked = afterMarker.spreadsheet.insertSheet(afterJournal.stagingName);
  afterJournal.state = 'created';
  afterJournal.sheetId = marked.getSheetId();
  afterMarker.properties.api.setProperty(technicalBackupCreationProperty,
    JSON.stringify(afterJournal));
  afterMarker.context.markElectricityDashboardTechnicalBackup_(marked);
  afterMarker.context.reconcileElectricityDashboardTechnicalBackups_(
    afterMarker.spreadsheet, afterMarker.technical
  );
  assert.equal(afterMarker.spreadsheet.sheets.includes(marked), false);
  assert.equal(
    afterMarker.properties.values[technicalBackupCreationProperty], undefined
  );
}

function testTechnicalBackupRecoversDuringExpansionAndCopy() {
  const fixture = createTechnicalBackupFixture();
  const { properties, context, technical, spreadsheet } = fixture;
  const journal = context.planElectricityDashboardTechnicalBackupCreation_(
    properties.api, spreadsheet, technical
  );
  const partial = spreadsheet.insertSheet(journal.stagingName);
  journal.state = 'created';
  journal.sheetId = partial.getSheetId();
  properties.api.setProperty(technicalBackupCreationProperty,
    JSON.stringify(journal));
  context.markElectricityDashboardTechnicalBackup_(partial);
  partial.insertRowsAfter(1000, 9042);
  partial.getLastRow = () => 5000;
  partial.getLastColumn = () => 4;
  partial.hideSheet();

  context.reconcileElectricityDashboardTechnicalBackups_(spreadsheet,
    technical);

  assert.equal(spreadsheet.sheets.includes(partial), false);
  assert.equal(properties.values[technicalBackupCreationProperty], undefined);
}

function testTechnicalBackupCopyFailureCleansUp() {
  const fixture = createTechnicalBackupFixture();
  const { properties, context, technical, spreadsheet } = fixture;
  let copies = 0;
  technical.getRange = () => ({
    copyTo: (target) => {
      copies += 1;
      target.receiveCopy();
      if (copies === 3) {
        throw new Error('copy interrupted');
      }
    }
  });

  assert.throws(() => context.createElectricityDashboardTechnicalBackup_(
    spreadsheet, technical, null
  ), /copy interrupted/);
  assert.equal(spreadsheet.sheets.length, 1);
  assert.equal(properties.values[technicalBackupCreationProperty], undefined);
}

function testTechnicalBackupDeleteFailureRetriesFromExactId() {
  const fixture = createTechnicalBackupFixture();
  const { properties, context, technical, spreadsheet } = fixture;
  const journal = context.planElectricityDashboardTechnicalBackupCreation_(
    properties.api, spreadsheet, technical
  );
  const backup = spreadsheet.insertSheet(journal.stagingName);
  journal.state = 'created';
  journal.sheetId = backup.getSheetId();
  properties.api.setProperty(technicalBackupCreationProperty,
    JSON.stringify(journal));
  const deleteSheet = spreadsheet.deleteSheet;
  spreadsheet.deleteSheet = () => {
    throw new Error('delete unavailable');
  };

  assert.throws(() => context.reconcileElectricityDashboardTechnicalBackups_(
    spreadsheet, technical
  ), /delete unavailable/);
  assert.equal(spreadsheet.sheets.includes(backup), true);
  assert.ok(properties.values[technicalBackupCreationProperty]);

  spreadsheet.deleteSheet = deleteSheet;
  context.reconcileElectricityDashboardTechnicalBackups_(spreadsheet,
    technical);
  assert.equal(spreadsheet.sheets.includes(backup), false);
  assert.equal(properties.values[technicalBackupCreationProperty], undefined);
}

function testTechnicalBackupFailsClosedForUnsafeRecordsAndCandidates() {
  const stale = createTechnicalBackupFixture();
  const staleJournal =
    stale.context.planElectricityDashboardTechnicalBackupCreation_(
      stale.properties.api, stale.spreadsheet, stale.technical
    );
  staleJournal.plannedAt = Date.now() - 25 * 60 * 60 * 1000;
  stale.properties.api.setProperty(technicalBackupCreationProperty,
    JSON.stringify(staleJournal));
  assert.throws(() =>
    stale.context.reconcileElectricityDashboardTechnicalBackups_(
      stale.spreadsheet, stale.technical
    ), /creation record is stale/);
  assert.ok(stale.properties.values[technicalBackupCreationProperty]);

  const malformed = createTechnicalBackupFixture();
  malformed.properties.api.setProperty(technicalBackupCreationProperty,
    '{not-json');
  assert.throws(() =>
    malformed.context.reconcileElectricityDashboardTechnicalBackups_(
      malformed.spreadsheet, malformed.technical
    ), /creation record is malformed/);

  const mismatch = createTechnicalBackupFixture();
  const mismatchJournal =
    mismatch.context.planElectricityDashboardTechnicalBackupCreation_(
      mismatch.properties.api, mismatch.spreadsheet, mismatch.technical
    );
  mismatchJournal.spreadsheetId = 'another-spreadsheet';
  mismatch.properties.api.setProperty(technicalBackupCreationProperty,
    JSON.stringify(mismatchJournal));
  assert.throws(() =>
    mismatch.context.reconcileElectricityDashboardTechnicalBackups_(
      mismatch.spreadsheet, mismatch.technical
    ), /does not match this spreadsheet and technical sheet/);

  const technicalMismatch = createTechnicalBackupFixture();
  const technicalMismatchJournal =
    technicalMismatch.context.planElectricityDashboardTechnicalBackupCreation_(
      technicalMismatch.properties.api, technicalMismatch.spreadsheet,
      technicalMismatch.technical
    );
  technicalMismatchJournal.technicalSheetId = 999;
  technicalMismatchJournal.existingSheetIds.push(999);
  technicalMismatch.properties.api.setProperty(
    technicalBackupCreationProperty,
    JSON.stringify(technicalMismatchJournal)
  );
  assert.throws(() =>
    technicalMismatch.context.reconcileElectricityDashboardTechnicalBackups_(
      technicalMismatch.spreadsheet, technicalMismatch.technical
    ), /does not match this spreadsheet and technical sheet/);

  const preExisting = createTechnicalBackupFixture();
  const preExistingJournal =
    preExisting.context.planElectricityDashboardTechnicalBackupCreation_(
      preExisting.properties.api, preExisting.spreadsheet,
      preExisting.technical
    );
  const userNamed = preExisting.spreadsheet.insertSheet(
    preExistingJournal.stagingName
  );
  preExistingJournal.existingSheetIds.push(userNamed.getSheetId());
  preExisting.properties.api.setProperty(technicalBackupCreationProperty,
    JSON.stringify(preExistingJournal));
  assert.throws(() =>
    preExisting.context.reconcileElectricityDashboardTechnicalBackups_(
      preExisting.spreadsheet, preExisting.technical
    ), /does not match the created sheet/);
  assert.equal(preExisting.spreadsheet.sheets.includes(userNamed), true);

  const modified = createTechnicalBackupFixture();
  const modifiedJournal =
    modified.context.planElectricityDashboardTechnicalBackupCreation_(
      modified.properties.api, modified.spreadsheet, modified.technical
    );
  const modifiedCandidate = modified.spreadsheet.insertSheet(
    modifiedJournal.stagingName
  );
  modifiedCandidate.addDeveloperMetadata('user.metadata', 'keep');
  assert.throws(() =>
    modified.context.reconcileElectricityDashboardTechnicalBackups_(
      modified.spreadsheet, modified.technical
    ), /does not identify a safe created sheet/);
  assert.equal(modified.spreadsheet.sheets.includes(modifiedCandidate), true);

  const createdMismatch = createTechnicalBackupFixture();
  const createdJournal =
    createdMismatch.context.planElectricityDashboardTechnicalBackupCreation_(
      createdMismatch.properties.api, createdMismatch.spreadsheet,
      createdMismatch.technical
    );
  const renamed = createdMismatch.spreadsheet.insertSheet(
    createdJournal.stagingName
  );
  createdJournal.state = 'created';
  createdJournal.sheetId = renamed.getSheetId();
  createdMismatch.properties.api.setProperty(technicalBackupCreationProperty,
    JSON.stringify(createdJournal));
  renamed.setName('User-owned backup');
  assert.throws(() =>
    createdMismatch.context.reconcileElectricityDashboardTechnicalBackups_(
      createdMismatch.spreadsheet, createdMismatch.technical
    ), /does not match the created sheet/);
  assert.equal(createdMismatch.spreadsheet.sheets.includes(renamed), true);
}

function testDashboardCreationJournalsFreshSuccess() {
  const properties = createScriptProperties({
    [technicalCreationProperty]: 'technical-journal',
    [technicalBackupCreationProperty]: 'backup-journal'
  });
  const context = loadDashboard(properties);
  const labels = context.getElectricityDashboardLabels_('en');
  const spreadsheet = createTechnicalSpreadsheet();
  const insertSheet = spreadsheet.insertSheet;
  spreadsheet.insertSheet = (name) => {
    const created = insertSheet(name);
    const addDeveloperMetadata = created.addDeveloperMetadata;
    created.addDeveloperMetadata = (key, value) => {
      const checkpoint = JSON.parse(
        properties.values[dashboardCreationProperty]
      );
      assert.equal(checkpoint.state, 'created');
      assert.equal(checkpoint.sheetId, created.getSheetId());
      return addDeveloperMetadata(key, value);
    };
    return created;
  };
  const deleteProperty = properties.api.deleteProperty;
  properties.api.deleteProperty = (key) => {
    if (key === dashboardCreationProperty) {
      const target = spreadsheet.getSheetByName(labels.sheet);
      assert.ok(target);
      assert.equal(context.isElectricityDashboardSheetMarked_(target), true);
    }
    deleteProperty(key);
  };

  const dashboard = context.createElectricityDashboardSheet_(spreadsheet,
    labels, null);

  assert.equal(dashboard.getName(), labels.sheet);
  assert.deepEqual(dashboard.metadata, [{
    key: 'gduc.electricity_dashboard',
    value: 'v1'
  }]);
  assert.equal(properties.values[dashboardCreationProperty], undefined);
  assert.equal(properties.values[technicalCreationProperty],
    'technical-journal');
  assert.equal(properties.values[technicalBackupCreationProperty],
    'backup-journal');
  assert.equal(context.isElectricityDashboardTechnicalBackup_(dashboard), false);
  assert.match(spreadsheet.insertedNames[0],
    /^Electricity dashboard pending /);
  const checkpoints = properties.history.filter((entry) =>
    entry.action === 'set' && entry.key === dashboardCreationProperty
  ).map((entry) => JSON.parse(entry.value).state);
  assert.deepEqual(checkpoints, ['planned', 'created']);
}

function testDashboardCreationRecoversBeforeAndAfterInsert() {
  const beforeProperties = createScriptProperties();
  const beforeContext = loadDashboard(beforeProperties);
  const beforeLabels = beforeContext.getElectricityDashboardLabels_('en');
  const beforeSpreadsheet = createTechnicalSpreadsheet();
  const beforeJournal = beforeContext.planElectricityDashboardCreation_(
    beforeProperties.api, beforeSpreadsheet, beforeLabels);

  const pending = beforeContext.reconcileElectricityDashboardCreation_(
    beforeSpreadsheet, beforeLabels);

  assert.equal(pending.sheet, null);
  assert.equal(pending.journal.stagingName, beforeJournal.stagingName);
  const created = beforeContext.createElectricityDashboardSheet_(
    beforeSpreadsheet, beforeLabels, pending.journal);
  assert.equal(created.getName(), beforeLabels.sheet);
  assert.equal(beforeProperties.values[dashboardCreationProperty], undefined);
  assert.deepEqual(beforeSpreadsheet.insertedNames, [
    beforeJournal.stagingName
  ]);

  const afterProperties = createScriptProperties();
  const afterContext = loadDashboard(afterProperties);
  const afterLabels = afterContext.getElectricityDashboardLabels_('en');
  const afterSpreadsheet = createTechnicalSpreadsheet();
  const afterJournal = afterContext.planElectricityDashboardCreation_(
    afterProperties.api, afterSpreadsheet, afterLabels);
  const staged = afterSpreadsheet.insertSheet(afterJournal.stagingName);

  const recovered = afterContext.reconcileElectricityDashboardCreation_(
    afterSpreadsheet, afterLabels);

  assert.equal(recovered.sheet, staged);
  assert.equal(staged.getName(), afterLabels.sheet);
  assert.equal(afterContext.isElectricityDashboardSheetMarked_(staged), true);
  assert.equal(afterProperties.values[dashboardCreationProperty], undefined);
  const exactIdCheckpoint = afterProperties.history.find((entry) =>
    entry.action === 'set' && entry.key === dashboardCreationProperty &&
    JSON.parse(entry.value).state === 'created'
  );
  assert.equal(JSON.parse(exactIdCheckpoint.value).sheetId, staged.getSheetId());
}

function testDashboardCreationRecoversExactIdAndPreservesAdjustments() {
  const properties = createScriptProperties();
  const context = loadDashboard(properties);
  const labels = context.getElectricityDashboardLabels_('en');
  const spreadsheet = createTechnicalSpreadsheet();
  const journal = context.planElectricityDashboardCreation_(properties.api,
    spreadsheet, labels);
  const staged = spreadsheet.insertSheet(journal.stagingName);
  const adjustedChart = { adjusted: true };
  staged.addDeveloperMetadata('user.layout', 'keep');
  staged.getLastRow = () => 12;
  staged.getCharts = () => [adjustedChart];
  journal.state = 'created';
  journal.sheetId = staged.getSheetId();
  properties.api.setProperty(dashboardCreationProperty, JSON.stringify(journal));

  const recovered = context.reconcileElectricityDashboardCreation_(spreadsheet,
    labels);

  assert.equal(recovered.sheet, staged);
  assert.equal(staged.getName(), labels.sheet);
  assert.equal(staged.getCharts()[0], adjustedChart);
  assert.deepEqual(staged.metadata, [{
    key: 'user.layout',
    value: 'keep'
  }, {
    key: 'gduc.electricity_dashboard',
    value: 'v1'
  }]);
  assert.equal(properties.values[dashboardCreationProperty], undefined);
}

function testDashboardCreationRecoversAfterMarkerBeforeRenameOrCleanup() {
  const stagedProperties = createScriptProperties();
  const stagedContext = loadDashboard(stagedProperties);
  const stagedLabels = stagedContext.getElectricityDashboardLabels_('en');
  const stagedSpreadsheet = createTechnicalSpreadsheet();
  const stagedJournal = stagedContext.planElectricityDashboardCreation_(
    stagedProperties.api, stagedSpreadsheet, stagedLabels);
  const staged = stagedSpreadsheet.insertSheet(stagedJournal.stagingName);
  stagedJournal.state = 'created';
  stagedJournal.sheetId = staged.getSheetId();
  stagedProperties.api.setProperty(dashboardCreationProperty,
    JSON.stringify(stagedJournal));
  stagedContext.markElectricityDashboardSheet_(staged);

  stagedContext.reconcileElectricityDashboardCreation_(stagedSpreadsheet,
    stagedLabels);

  assert.equal(staged.getName(), stagedLabels.sheet);
  assert.equal(staged.metadata.filter((item) =>
    item.key === 'gduc.electricity_dashboard'
  ).length, 1);
  assert.equal(stagedProperties.values[dashboardCreationProperty], undefined);

  const renamedProperties = createScriptProperties();
  const renamedContext = loadDashboard(renamedProperties);
  const renamedLabels = renamedContext.getElectricityDashboardLabels_('en');
  const renamedSpreadsheet = createTechnicalSpreadsheet();
  const renamedJournal = renamedContext.planElectricityDashboardCreation_(
    renamedProperties.api, renamedSpreadsheet, renamedLabels);
  const renamed = renamedSpreadsheet.insertSheet(renamedJournal.stagingName);
  renamedJournal.state = 'created';
  renamedJournal.sheetId = renamed.getSheetId();
  renamedProperties.api.setProperty(dashboardCreationProperty,
    JSON.stringify(renamedJournal));
  renamedContext.markElectricityDashboardSheet_(renamed);
  renamed.setName(renamedLabels.sheet);

  renamedContext.reconcileElectricityDashboardCreation_(renamedSpreadsheet,
    renamedLabels);

  assert.equal(renamedProperties.values[dashboardCreationProperty], undefined);
  assert.equal(renamedContext.isElectricityDashboardSheetMarked_(renamed), true);
}

function testDashboardCreationFailsClosedForUnsafeRecordsAndTargets() {
  const malformedProperties = createScriptProperties({
    [dashboardCreationProperty]: '{not-json'
  });
  const malformedContext = loadDashboard(malformedProperties);
  const malformedLabels =
    malformedContext.getElectricityDashboardLabels_('en');
  assert.throws(() =>
    malformedContext.reconcileElectricityDashboardCreation_(
      createTechnicalSpreadsheet(), malformedLabels
    ), /creation record is malformed/);

  const staleProperties = createScriptProperties();
  const staleContext = loadDashboard(staleProperties);
  const staleLabels = staleContext.getElectricityDashboardLabels_('en');
  const staleSpreadsheet = createTechnicalSpreadsheet();
  const staleJournal = staleContext.planElectricityDashboardCreation_(
    staleProperties.api, staleSpreadsheet, staleLabels);
  staleJournal.plannedAt = Date.now() - 25 * 60 * 60 * 1000;
  staleProperties.api.setProperty(dashboardCreationProperty,
    JSON.stringify(staleJournal));
  assert.throws(() =>
    staleContext.reconcileElectricityDashboardCreation_(staleSpreadsheet,
      staleLabels), /creation record is stale/);

  const mismatchProperties = createScriptProperties();
  const mismatchContext = loadDashboard(mismatchProperties);
  const mismatchLabels = mismatchContext.getElectricityDashboardLabels_('en');
  const mismatchSpreadsheet = createTechnicalSpreadsheet();
  const mismatchJournal = mismatchContext.planElectricityDashboardCreation_(
    mismatchProperties.api, mismatchSpreadsheet, mismatchLabels);
  const mismatched = mismatchSpreadsheet.insertSheet(
    mismatchJournal.stagingName);
  mismatchJournal.state = 'created';
  mismatchJournal.sheetId = mismatched.getSheetId();
  mismatchProperties.api.setProperty(dashboardCreationProperty,
    JSON.stringify(mismatchJournal));
  mismatched.setName('User-renamed sheet');
  assert.throws(() =>
    mismatchContext.reconcileElectricityDashboardCreation_(
      mismatchSpreadsheet, mismatchLabels
    ), /does not match the created sheet/);

  const modifiedProperties = createScriptProperties();
  const modifiedContext = loadDashboard(modifiedProperties);
  const modifiedLabels = modifiedContext.getElectricityDashboardLabels_('en');
  const modifiedSpreadsheet = createTechnicalSpreadsheet();
  const modifiedJournal = modifiedContext.planElectricityDashboardCreation_(
    modifiedProperties.api, modifiedSpreadsheet, modifiedLabels);
  const modified = modifiedSpreadsheet.insertSheet(modifiedJournal.stagingName);
  modified.addDeveloperMetadata('user.layout', 'not-pristine');
  assert.throws(() =>
    modifiedContext.reconcileElectricityDashboardCreation_(
      modifiedSpreadsheet, modifiedLabels
    ), /does not identify a safe created sheet/);
  assert.deepEqual(modified.metadata, [{
    key: 'user.layout',
    value: 'not-pristine'
  }]);

  const userProperties = createScriptProperties();
  const userContext = loadDashboard(userProperties);
  const userLabels = userContext.getElectricityDashboardLabels_('en');
  const source = createPristineTechnicalSheet('Electricity', 1);
  const userDashboard = createPristineTechnicalSheet(userLabels.sheet, 2);
  const userSpreadsheet = createTechnicalSpreadsheet([source, userDashboard]);
  userContext.validateElectricityDashboardSource_ = () => true;
  assert.throws(() => userContext.initializeElectricityDashboard_(
    userSpreadsheet, {
      locale: 'en',
      sheet_by_supply: { electricity: 'Electricity' }
    }
  ), /unmanaged electricity dashboard sheet/);
  assert.deepEqual(userDashboard.metadata, []);
  assert.deepEqual(userProperties.history, []);
  assert.deepEqual(userSpreadsheet.insertedNames, []);
}

function testDashboardLegacyOwnershipMigrationIsExact() {
  const context = loadDashboard();
  const labels = context.getElectricityDashboardLabels_('en');
  const technical = createPristineTechnicalSheet(labels.dataSheet, 1);
  context.markElectricityDashboardTechnicalSheet_(technical);
  const legacy = createLegacyDashboardSheet(context, labels, technical);

  context.ensureElectricityDashboardSheetOwnership_(legacy, technical, labels);

  assert.equal(context.isElectricityDashboardSheetMarked_(legacy), true);

  const nearLegacy = createLegacyDashboardSheet(context, labels, technical, 3);
  nearLegacy.charts.push(nearLegacy.charts[0]);
  assert.throws(() => context.ensureElectricityDashboardSheetOwnership_(
    nearLegacy, technical, labels
  ), /unmanaged electricity dashboard sheet/);
  assert.deepEqual(nearLegacy.metadata, []);

  const wrongRange = createLegacyDashboardSheet(context, labels, technical, 4);
  wrongRange.charts[0].getRanges = () => [
    createManagedChartRange(context, technical, 'monthlyF1')
  ];
  assert.throws(() => context.ensureElectricityDashboardSheetOwnership_(
    wrongRange, technical, labels
  ), /unmanaged electricity dashboard sheet/);
  assert.deepEqual(wrongRange.metadata, []);
}

function testDashboardOwnershipMetadataConflictsFailClosed() {
  const context = loadDashboard();
  const labels = context.getElectricityDashboardLabels_('en');
  const technical = createPristineTechnicalSheet(labels.dataSheet, 1);
  context.markElectricityDashboardTechnicalSheet_(technical);

  const wrong = createLegacyDashboardSheet(context, labels, technical, 2);
  wrong.addDeveloperMetadata('gduc.electricity_dashboard', 'wrong');
  assert.throws(() => context.ensureElectricityDashboardSheetOwnership_(
    wrong, technical, labels
  ), /ownership metadata is conflicting or malformed/);
  assert.deepEqual(wrong.metadata, [{
    key: 'gduc.electricity_dashboard',
    value: 'wrong'
  }]);

  const duplicate = createLegacyDashboardSheet(context, labels, technical, 3);
  duplicate.addDeveloperMetadata('gduc.electricity_dashboard', 'v1');
  duplicate.addDeveloperMetadata('gduc.electricity_dashboard', 'v1');
  assert.throws(() => context.markElectricityDashboardSheet_(duplicate),
    /ownership metadata is conflicting or malformed/);
  assert.equal(duplicate.metadata.length, 2);

  const technicalOwned =
    createLegacyDashboardSheet(context, labels, technical, 5);
  technicalOwned.addDeveloperMetadata(
    'gduc.electricity_dashboard_technical', 'v1');
  assert.throws(() => context.ensureElectricityDashboardSheetOwnership_(
    technicalOwned, technical, labels
  ), /ownership metadata is conflicting or malformed/);
  assert.equal(technicalOwned.metadata.length, 1);
}

function testDashboardDownstreamFailureCleansUpAndDeleteFailureRetries() {
  const successfulCleanupProperties = createScriptProperties();
  const successfulCleanupContext = loadDashboard(successfulCleanupProperties);
  const successfulLabels =
    successfulCleanupContext.getElectricityDashboardLabels_('en');
  const successfulSource =
    createPristineTechnicalSheet('Electricity', 1);
  const successfulSpreadsheet =
    createTechnicalSpreadsheet([successfulSource]);
  const successfulTechnical = { hideSheet: () => {} };
  successfulCleanupContext.validateElectricityDashboardSource_ = () => true;
  successfulCleanupContext.assertElectricityDashboardTechnicalSheet_ = () => {};
  successfulCleanupContext.reconcileElectricityDashboardTechnicalBackups_ =
    () => ({ journal: null });
  successfulCleanupContext.assertElectricityDashboardCapacity_ = () => {};
  successfulCleanupContext.createElectricityDashboardTechnicalSheet_ =
    () => successfulTechnical;
  successfulCleanupContext.markElectricityDashboardTechnicalSheet_ = () => {};
  successfulCleanupContext.captureElectricityChartLayouts_ = () => ({});
  successfulCleanupContext.writeElectricityDashboardData_ = () => {
    throw new Error('downstream initialization failed');
  };

  assert.throws(() =>
    successfulCleanupContext.initializeElectricityDashboard_(
      successfulSpreadsheet, {
        locale: 'en',
        sheet_by_supply: { electricity: 'Electricity' }
      }
    ), /downstream initialization failed/);
  assert.equal(successfulSpreadsheet.getSheetByName(successfulLabels.sheet),
    null);
  assert.equal(
    successfulCleanupProperties.values[dashboardCreationProperty],
    undefined
  );

  const retryProperties = createScriptProperties();
  const retryContext = loadDashboard(retryProperties);
  const retryLabels = retryContext.getElectricityDashboardLabels_('en');
  const retrySource = createPristineTechnicalSheet('Electricity', 1);
  const retrySpreadsheet = createTechnicalSpreadsheet([retrySource]);
  const originalDeleteSheet = retrySpreadsheet.deleteSheet;
  let rejectDashboardDelete = true;
  retrySpreadsheet.deleteSheet = (sheet) => {
    if (rejectDashboardDelete && typeof sheet.getName === 'function' &&
      sheet.getName() === retryLabels.sheet) {
      throw new Error('dashboard delete failed');
    }
    originalDeleteSheet(sheet);
  };
  const retryTechnical = { hideSheet: () => {} };
  retryContext.validateElectricityDashboardSource_ = () => true;
  retryContext.assertElectricityDashboardTechnicalSheet_ = () => {};
  retryContext.reconcileElectricityDashboardTechnicalBackups_ =
    () => ({ journal: null });
  retryContext.assertElectricityDashboardCapacity_ = () => {};
  retryContext.createElectricityDashboardTechnicalSheet_ =
    () => retryTechnical;
  retryContext.markElectricityDashboardTechnicalSheet_ = () => {};
  retryContext.captureElectricityChartLayouts_ = () => ({});
  retryContext.writeElectricityDashboardData_ = () => {
    throw new Error('first initialization failed');
  };

  assert.throws(() => retryContext.initializeElectricityDashboard_(
    retrySpreadsheet, {
      locale: 'en',
      sheet_by_supply: { electricity: 'Electricity' }
    }
  ), /first initialization failed.*Dashboard sheet cleanup also failed: dashboard delete failed/);
  const retained = retrySpreadsheet.getSheetByName(retryLabels.sheet);
  assert.ok(retained);
  assert.equal(retryContext.isElectricityDashboardSheetMarked_(retained), true);

  rejectDashboardDelete = false;
  retryContext.writeElectricityDashboardData_ = () => ({});
  retryContext.refreshElectricityDashboardCharts_ = () => {};
  retryContext.initializeElectricityDashboard_(retrySpreadsheet, {
    locale: 'en',
    sheet_by_supply: { electricity: 'Electricity' }
  });

  assert.equal(retrySpreadsheet.getSheetByName(retryLabels.sheet), retained);
  assert.equal(retrySpreadsheet.insertedNames.filter((name) =>
    name.indexOf('Electricity dashboard pending ') === 0
  ).length, 1);
}

function testDashboardCapacityDoesNotDoubleCountRecoveredSheet() {
  const context = loadDashboard();
  const largeSheet = {
    getMaxRows: () => 9060,
    getMaxColumns: () => 1000
  };
  const recoveredDashboard = {
    getMaxRows: () => 1000,
    getMaxColumns: () => 26
  };
  const spreadsheet = {
    getSheets: () => [largeSheet, recoveredDashboard]
  };

  assert.doesNotThrow(() => context.assertElectricityDashboardCapacity_(
    spreadsheet, recoveredDashboard, null));
  assert.throws(() => context.assertElectricityDashboardCapacity_(
    spreadsheet, null, null), /cell limit/);
}

function testTechnicalCreationJournalsNormalFreshCreation() {
  const properties = createScriptProperties();
  const context = loadDashboard(properties);
  const labels = context.getElectricityDashboardLabels_('en');
  const spreadsheet = createTechnicalSpreadsheet();
  const insertSheet = spreadsheet.insertSheet;
  spreadsheet.insertSheet = (name) => {
    const created = insertSheet(name);
    const addDeveloperMetadata = created.addDeveloperMetadata;
    created.addDeveloperMetadata = (key, value) => {
      const checkpoint = JSON.parse(
        properties.values[technicalCreationProperty]
      );
      assert.equal(checkpoint.state, 'created');
      assert.equal(checkpoint.sheetId, created.getSheetId());
      return addDeveloperMetadata(key, value);
    };
    return created;
  };
  const deleteProperty = properties.api.deleteProperty;
  properties.api.deleteProperty = (key) => {
    const target = spreadsheet.getSheetByName(labels.dataSheet);
    assert.ok(target);
    assert.equal(target.metadata.some((item) =>
      item.key === 'gduc.electricity_dashboard_technical' &&
      item.value === 'v1'
    ), true);
    deleteProperty(key);
  };

  const sheet = context.createElectricityDashboardTechnicalSheet_(spreadsheet,
    labels, null);

  assert.equal(sheet.getName(), labels.dataSheet);
  assert.deepEqual(sheet.metadata, [{
    key: 'gduc.electricity_dashboard_technical',
    value: 'v1'
  }]);
  assert.equal(properties.values[technicalCreationProperty], undefined);
  assert.match(spreadsheet.insertedNames[0],
    /^Electricity dashboard technical pending /);
  const checkpoints = properties.history.filter((entry) =>
    entry.action === 'set'
  ).map((entry) => JSON.parse(entry.value).state);
  assert.deepEqual(checkpoints, ['planned', 'created']);
  assert.equal(properties.history.at(-1).action, 'delete');
}

function testInitializationReconcilesCreationBeforeOwnershipPreflight() {
  const properties = createScriptProperties();
  const context = loadDashboard(properties);
  const labels = context.getElectricityDashboardLabels_('en');
  const source = createPristineTechnicalSheet('Electricity', 1);
  const spreadsheet = createTechnicalSpreadsheet([source]);
  const journal = context.planElectricityDashboardTechnicalCreation_(
    properties.api, spreadsheet, labels);
  const staged = spreadsheet.insertSheet(journal.stagingName);
  context.validateElectricityDashboardSource_ = () => true;
  context.assertElectricityDashboardTechnicalSheet_ = (technical) => {
    assert.equal(technical, staged);
    assert.equal(technical.getName(), labels.dataSheet);
    assert.equal(technical.metadata.some((item) =>
      item.key === 'gduc.electricity_dashboard_technical' &&
      item.value === 'v1'
    ), true);
    throw new Error('stop after ownership preflight');
  };

  assert.throws(() => context.initializeElectricityDashboard_(spreadsheet, {
    locale: 'en',
    sheet_by_supply: { electricity: 'Electricity' }
  }), /stop after ownership preflight/);
}

function testTechnicalCreationRecoversInterruptionBeforeInsert() {
  const properties = createScriptProperties();
  const context = loadDashboard(properties);
  const labels = context.getElectricityDashboardLabels_('en');
  const spreadsheet = createTechnicalSpreadsheet();
  const journal = context.planElectricityDashboardTechnicalCreation_(
    properties.api, spreadsheet, labels);

  const recovery = context.reconcileElectricityDashboardTechnicalCreation_(
    spreadsheet, labels);

  assert.equal(recovery.sheet, null);
  assert.equal(recovery.recovered, false);
  assert.equal(recovery.journal.stagingName, journal.stagingName);
  const sheet = context.createElectricityDashboardTechnicalSheet_(spreadsheet,
    labels, recovery.journal);
  assert.equal(sheet.getName(), labels.dataSheet);
  assert.equal(properties.values[technicalCreationProperty], undefined);
  assert.deepEqual(spreadsheet.insertedNames, [journal.stagingName]);
}

function testTechnicalCreationRecoversInsertBeforeExactIdCheckpoint() {
  const properties = createScriptProperties();
  const context = loadDashboard(properties);
  const labels = context.getElectricityDashboardLabels_('en');
  const spreadsheet = createTechnicalSpreadsheet();
  const journal = context.planElectricityDashboardTechnicalCreation_(
    properties.api, spreadsheet, labels);
  const staged = spreadsheet.insertSheet(journal.stagingName);

  const recovery = context.reconcileElectricityDashboardTechnicalCreation_(
    spreadsheet, labels);

  assert.equal(recovery.sheet, staged);
  assert.equal(recovery.recovered, true);
  assert.equal(staged.getName(), labels.dataSheet);
  assert.equal(properties.values[technicalCreationProperty], undefined);
  const createdCheckpoint = properties.history.find((entry) =>
    entry.action === 'set' && JSON.parse(entry.value).state === 'created'
  );
  assert.equal(JSON.parse(createdCheckpoint.value).sheetId, staged.getSheetId());
}

function testTechnicalCreationRecoversExactIdCheckpointBeforeMetadata() {
  const properties = createScriptProperties();
  const context = loadDashboard(properties);
  const labels = context.getElectricityDashboardLabels_('en');
  const spreadsheet = createTechnicalSpreadsheet();
  const journal = context.planElectricityDashboardTechnicalCreation_(
    properties.api, spreadsheet, labels);
  const staged = spreadsheet.insertSheet(journal.stagingName);
  journal.state = 'created';
  journal.sheetId = staged.getSheetId();
  properties.api.setProperty(technicalCreationProperty,
    JSON.stringify(journal));

  const recovery = context.reconcileElectricityDashboardTechnicalCreation_(
    spreadsheet, labels);

  assert.equal(recovery.sheet, staged);
  assert.equal(staged.getName(), labels.dataSheet);
  assert.deepEqual(staged.metadata, [{
    key: 'gduc.electricity_dashboard_technical',
    value: 'v1'
  }]);
  assert.equal(properties.values[technicalCreationProperty], undefined);
}

function testTechnicalCreationFailsClosedForUnsafeRecords() {
  const labelsFor = (context) =>
    context.getElectricityDashboardLabels_('en');

  const staleProperties = createScriptProperties();
  const staleContext = loadDashboard(staleProperties);
  const staleSpreadsheet = createTechnicalSpreadsheet();
  const staleJournal = staleContext.planElectricityDashboardTechnicalCreation_(
    staleProperties.api, staleSpreadsheet, labelsFor(staleContext));
  staleJournal.plannedAt = Date.now() - 25 * 60 * 60 * 1000;
  staleProperties.api.setProperty(technicalCreationProperty,
    JSON.stringify(staleJournal));
  assert.throws(() =>
    staleContext.reconcileElectricityDashboardTechnicalCreation_(
      staleSpreadsheet, labelsFor(staleContext)
    ), /creation record is stale/);
  assert.ok(staleProperties.values[technicalCreationProperty]);

  const mismatchProperties = createScriptProperties();
  const mismatchContext = loadDashboard(mismatchProperties);
  const mismatchSpreadsheet = createTechnicalSpreadsheet();
  const mismatchJournal =
    mismatchContext.planElectricityDashboardTechnicalCreation_(
      mismatchProperties.api, mismatchSpreadsheet, labelsFor(mismatchContext));
  mismatchJournal.spreadsheetId = 'another-spreadsheet';
  mismatchProperties.api.setProperty(technicalCreationProperty,
    JSON.stringify(mismatchJournal));
  assert.throws(() =>
    mismatchContext.reconcileElectricityDashboardTechnicalCreation_(
      mismatchSpreadsheet, labelsFor(mismatchContext)
    ), /does not match this spreadsheet/);

  const malformedProperties = createScriptProperties({
    [technicalCreationProperty]: '{not-json'
  });
  const malformedContext = loadDashboard(malformedProperties);
  assert.throws(() =>
    malformedContext.reconcileElectricityDashboardTechnicalCreation_(
      createTechnicalSpreadsheet(), labelsFor(malformedContext)
    ), /creation record is malformed/);
}

function testTechnicalCreationNeverAdoptsUserOrModifiedSheets() {
  const userProperties = createScriptProperties();
  const userContext = loadDashboard(userProperties);
  const userLabels = userContext.getElectricityDashboardLabels_('en');
  const userSpreadsheet = createTechnicalSpreadsheet();
  userContext.planElectricityDashboardTechnicalCreation_(
    userProperties.api, userSpreadsheet, userLabels);
  const userSheet = userSpreadsheet.insertSheet(userLabels.dataSheet);
  assert.throws(() =>
    userContext.reconcileElectricityDashboardTechnicalCreation_(
      userSpreadsheet, userLabels
    ), /does not match the target sheet/);
  assert.deepEqual(userSheet.metadata, []);

  const modifiedProperties = createScriptProperties();
  const modifiedContext = loadDashboard(modifiedProperties);
  const modifiedLabels = modifiedContext.getElectricityDashboardLabels_('en');
  const modifiedSpreadsheet = createTechnicalSpreadsheet();
  const modifiedJournal =
    modifiedContext.planElectricityDashboardTechnicalCreation_(
      modifiedProperties.api, modifiedSpreadsheet, modifiedLabels);
  const modifiedSheet = modifiedSpreadsheet.insertSheet(
    modifiedJournal.stagingName);
  modifiedSheet.addDeveloperMetadata('user.metadata', 'keep');
  assert.throws(() =>
    modifiedContext.reconcileElectricityDashboardTechnicalCreation_(
      modifiedSpreadsheet, modifiedLabels
    ), /does not identify a pristine created sheet/);
  assert.equal(modifiedSpreadsheet.sheets.includes(modifiedSheet), true);
  assert.deepEqual(modifiedSheet.metadata, [{
    key: 'user.metadata',
    value: 'keep'
  }]);
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
  }, {}, technical, true), /temporary backup exceeds/);
}

function testRecoveredTechnicalCapacitySkipsUnusedBackup() {
  const context = loadDashboard();
  const grid = context.getElectricityDashboardTechnicalGrid_();
  const technical = {
    getMaxRows: () => 1000,
    getMaxColumns: () => 26
  };
  const other = {
    getMaxRows: () => 1,
    getMaxColumns: () => 10000000 - grid.rows * grid.columns - 100
  };
  const spreadsheet = {
    getSheets: () => [other, technical]
  };

  assert.doesNotThrow(() => context.assertElectricityDashboardCapacity_(
    spreadsheet, {}, technical, false));
  assert.throws(() => context.assertElectricityDashboardCapacity_(
    spreadsheet, {}, technical, true), /temporary backup exceeds/);
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
  context.createElectricityDashboardSheet_ = () => dashboard;
  context.createElectricityDashboardTechnicalSheet_ = () => technical;
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
testTechnicalBackupJournalsFreshCreation();
testTechnicalBackupRecoversInterruptionBeforeAndAfterInsert();
testTechnicalBackupRecoversExactIdBeforeAndAfterMarker();
testTechnicalBackupRecoversDuringExpansionAndCopy();
testTechnicalBackupCopyFailureCleansUp();
testTechnicalBackupDeleteFailureRetriesFromExactId();
testTechnicalBackupFailsClosedForUnsafeRecordsAndCandidates();
testDashboardCreationJournalsFreshSuccess();
testDashboardCreationRecoversBeforeAndAfterInsert();
testDashboardCreationRecoversExactIdAndPreservesAdjustments();
testDashboardCreationRecoversAfterMarkerBeforeRenameOrCleanup();
testDashboardCreationFailsClosedForUnsafeRecordsAndTargets();
testDashboardLegacyOwnershipMigrationIsExact();
testDashboardOwnershipMetadataConflictsFailClosed();
testDashboardDownstreamFailureCleansUpAndDeleteFailureRetries();
testDashboardCapacityDoesNotDoubleCountRecoveredSheet();
testTechnicalCreationJournalsNormalFreshCreation();
testInitializationReconcilesCreationBeforeOwnershipPreflight();
testTechnicalCreationRecoversInterruptionBeforeInsert();
testTechnicalCreationRecoversInsertBeforeExactIdCheckpoint();
testTechnicalCreationRecoversExactIdCheckpointBeforeMetadata();
testTechnicalCreationFailsClosedForUnsafeRecords();
testTechnicalCreationNeverAdoptsUserOrModifiedSheets();
testTechnicalFormulaRangesUseReservedCapacity();
testDashboardCapacityIncludesTemporaryBackup();
testRecoveredTechnicalCapacitySkipsUnusedBackup();
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
