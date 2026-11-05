#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const props = {};
  const labels = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const initial = { chartId: 10, position: { overlayPosition: {
    anchorCell: { sheetId: 20, rowIndex: 3 }, widthPixels: 700, heightPixels: 300 } },
  spec: { title: 'Customized', basicChart: { chartType: 'LINE', headerCount: 1,
    interpolateNulls: true,
    domains: [{ domain: { sourceRange: { sources: [{ sheetId: 20, startRowIndex: 0,
      endRowIndex: 13, startColumnIndex: 0, endColumnIndex: 1 }] } } }],
    series: [{ series: { sourceRange: { sources: [{ sheetId: 20, startRowIndex: 0,
      endRowIndex: 13, startColumnIndex: 1, endColumnIndex: 2 }] } },
    color: { red: 0.4 }, pointStyle: { size: 5 } }] } } };
  const state = { chart: JSON.parse(JSON.stringify(initial)), technical: null,
    writes: 0, lost: false, extraYear: false, differentFormula: false, technicalFormula: false,
    numberFormat: '€0.00', cacheUntilFlush: false, staleNative: false,
    sourceRows: [['2026', '05–08']] };
  const chartSheet = { getSheetId: () => 20, getName: () => 'Stats',
    getMaxRows: () => 100, getMaxColumns: () => 26,
    getCharts: () => [{ getChartId: () => 10, getMergeStrategy: () => 'MERGE_COLUMNS',
      getTransposeRowsAndColumns: () => false, getNumHeaders: () => 1,
      getHiddenDimensionStrategy: () => 'IGNORE_ROWS',
      modify: () => ({ getChartType: () => 'LINE' }) }],
    getRange: (row, column, count) => ({
      getDisplayValues: () => labels.map(label => [label]),
      getFormulas: () => Array.from({ length: 12 }, () => ['=SUM(Source!A:A)']),
      getFormulasR1C1: () => Array.from({ length: 12 }, () =>
        [column === 3 && state.differentFormula ? '=DIFFERENT' : '=SAME']),
      getNumberFormats: () => Array.from({ length: count }, (_, i) =>
        [row === 1 && i === 0 ? 'General' : state.numberFormat]),
      getValues: () => (count === 1 ? [[column === 2 ? 2026 :
        column === 3 && state.extraYear ? 2027 : '']] : count === 13 ? [[2026], ...Array.from({ length: 12 },
        (_, i) => [i === 4 ? 49 : '#N/A'])] :
        Array.from({ length: 12 }, (_, i) => [column === 3 && state.extraYear ?
          (i === 2 ? 25 : '#N/A') : (i === 4 ? 49 : '#N/A')]))
    }) };
  const sourceSheet = { getSheetId: () => 30, getName: () => 'Source',
    getMaxRows: () => 100, getMaxColumns: () => 26, getLastRow: () => state.sourceRows.length + 1,
    getRange: () => ({ getDisplayValues: () => state.sourceRows }) };
  const spreadsheet = { getSheets: () => [chartSheet, sourceSheet].concat(
    state.technical && !(state.cacheUntilFlush && state.staleNative) ? [state.technical] : []) };
  const api = { getProperty: key => props[key] || null,
    setProperty: (key, value) => { props[key] = value; },
    deleteProperty: key => { delete props[key]; }, getProperties: () => ({ ...props }) };
  const blob = value => { const bytes = Buffer.from(value); return {
    getBytes: () => bytes, getDataAsString: () => bytes.toString('utf8') }; };
  let sequence = 0;
  const context = vm.createContext({
    CONFIG: { PROPERTY_KEYS: { MUTATION_JOURNAL_PREFIX: 'MUTATION_' } },
    Charts: { ChartMergeStrategy: { MERGE_COLUMNS: 'MERGE_COLUMNS' } },
    PropertiesService: { getScriptProperties: () => api },
    SpreadsheetApp: { openById: () => spreadsheet, flush: () => { state.staleNative = false; } },
    ScriptApp: { getOAuthToken: () => 'redacted' },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_, value) => Array.from(crypto.createHash('sha256').update(value).digest()),
      newBlob: blob, gzip: data => blob(zlib.gzipSync(data.getBytes())),
      ungzip: data => blob(zlib.gunzipSync(data.getBytes())),
      base64Encode: data => Buffer.from(data).toString('base64'),
      base64Decode: data => Buffer.from(data, 'base64'),
      getUuid: () => (++sequence === 1 ? '1234567a-0000-4000-8000-000000000000' :
        '1234567b-0000-4000-8000-000000000000') },
    getSpreadsheetId_: () => 'workbook', assertCatalogConfiguration_: () => {},
    getAutomationConfig_: () => ({ locale: 'en', sheet_by_supply: { other: 'Source' } }),
    getLocalizationRegistry_: () => ({ en: { electricityDashboard: { months: labels } } }),
    getSheetLayout_: () => ({ headerRow: 1, headers: ['year', 'month'],
      lookup: { year: 1, month: 2 } }), getHeaderAliases_: key => [key],
    findHeaderIndex_: (lookup, aliases) => lookup[aliases[0]] || 0,
    withCatalogLifecycleLock_: (_name, callback) => callback(),
    logCatalogEvent_: () => {}, classifyCatalogErrorForLog_: () => 'test',
    UrlFetchApp: { fetch: (_url, options) => {
      if (options.method !== 'post') {
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({
          sheets: [{ properties: { sheetId: 20 }, charts: [state.chart] }] }) };
      }
      state.writes += 1;
      state.staleNative = true;
      const requests = JSON.parse(options.payload).requests;
      if (requests[0].addSheet) {
        const sheetProps = requests[0].addSheet.properties;
        const marker = requests[1].createDeveloperMetadata.developerMetadata.metadataValue;
        state.technicalValues = Array.from({ length: 145 }, () => Array(26).fill(''));
        state.technicalFormats = Array.from({ length: 145 }, () => Array(26).fill('General'));
        state.technical = { getSheetId: () => sheetProps.sheetId, getName: () => sheetProps.title,
          getMaxRows: () => 145, getMaxColumns: () => 26,
          getDeveloperMetadata: () => [{ getKey: () => 'gduc.period_chart_data',
            getValue: () => marker }], getRange: () => ({
            getValues: () => state.technicalValues, getNumberFormats: () => state.technicalFormats,
            getFormulas: () => Array.from({ length: 145 }, (_, row) =>
              Array.from({ length: 26 }, (_, column) => state.technicalFormula &&
                row === 0 && column === 0 ? '=1' : '')) }) };
      }
      requests.forEach(request => {
        if (request.copyPaste) {
          const { source, destination } = request.copyPaste;
          for (let row = destination.startRowIndex; row < destination.endRowIndex; row += 1) {
            state.technicalFormats[row][destination.startColumnIndex] =
              source.startRowIndex === 0 ? 'General' : state.numberFormat;
          }
        }
        if (request.updateCells) {
          request.updateCells.rows.forEach((row, r) => row.values.forEach((cell, c) => {
            const entry = cell.userEnteredValue;
            state.technicalValues[r][c] = entry ? (entry.numberValue ?? entry.stringValue) : '';
          }));
        }
        if (request.updateChartSpec) { state.chart.spec = request.updateChartSpec.spec; }
      });
      if (state.lost) { throw new Error('simulated lost response'); }
      return { getResponseCode: () => 200, getContentText: () => '{}' };
    } }
  });
  ['PeriodChartData.gs', 'PeriodChartTransactions.gs', 'PeriodChartRuntime.gs',
    'PeriodChartRangesRuntime.gs'].forEach(file => vm.runInContext(fs.readFileSync(
    path.join(__dirname, '..', file), 'utf8'), context, { filename: file }));
  return { state, props, context, initial };
}

{
  const f = fixture();
  assert.equal(f.context.periodChartFormulaReferencesSheet_('=SUM(Source!A:A)', 'Source'), true);
  assert.equal(f.context.periodChartFormulaReferencesSheet_("=SUM('Other Source'!A:A)",
    'Other Source'), true);
  assert.equal(f.context.periodChartFormulaReferencesSheet_('=SUM(OtherSource!A:A)', 'Source'), false);
  assert.equal(f.context.periodChartFormulaReferencesSheet_('=SUM(ÉSource!A:A)', 'Source'), false);
  assert.equal(f.context.periodChartFormulaReferencesSheet_("=SUM('Other''Source'!A:A)",
    'Source'), false);
  assert.equal(f.context.periodChartFormulaReferencesSheet_('=IF(A1="Source!",1,0)', 'Source'), false);
}
{
  const f = fixture();
  f.state.cacheUntilFlush = true;
  const result = f.context.adoptCatalogerPeriodChart({ sheetId: 20, chartId: 10, sourceSheetId: 30 });
  assert.equal(result.adopted, true);
  assert.equal(f.state.writes, 1);
  assert.deepEqual(f.state.chart.position, f.initial.position);
  assert.equal(f.state.chart.spec.title, 'Customized');
  assert.equal(f.state.chart.spec.basicChart.series[0].color.red, 0.4);
  assert.equal(f.state.technical.getRange().getValues()[9][1], 49);
  assert.equal(f.state.technicalFormats[1][1], '€0.00');
  assert.equal(f.state.technicalFormats[13][1], '€0.00');
  assert.deepEqual(f.state.sourceRows, [['2026', '05–08']]);
  assert.ok(f.props.PERIOD_CHART_RANGE_V1_10);
  f.state.sourceRows = [['2026', '05/2026–02/2027']];
  const registration = JSON.parse(f.props.PERIOD_CHART_RANGE_V1_10);
  assert.equal(f.context.refreshRegisteredPeriodChart_(registration).state, 'committed');
  assert.equal(f.state.technicalValues[15][1], 49);
  assert.equal(f.state.chart.spec.basicChart.domains[0].domain.sourceRange.sources[0].endRowIndex, 16);
  assert.equal(f.state.chart.spec.title, 'Customized');
  assert.equal(f.state.writes, 2);
}
{
  const f = fixture();
  f.state.lost = true;
  assert.throws(() => f.context.adoptCatalogerPeriodChart({ sheetId: 20, chartId: 10, sourceSheetId: 30 }));
  assert.ok(f.props.PERIOD_CHART_POINT_JOURNAL_V1);
  f.state.lost = false;
  assert.equal(f.context.recoverPendingPeriodChartPoints_().state, 'committed');
  assert.equal(f.state.writes, 1);
  assert.ok(f.props.PERIOD_CHART_RANGE_V1_10);
}
{
  const f = fixture();
  f.context.adoptCatalogerPeriodChart({ sheetId: 20, chartId: 10, sourceSheetId: 30 });
  f.state.chart.spec.basicChart.series[0].pointStyle.size = 0;
  assert.equal(f.context.adoptCatalogerChartPoints({ sheetId: 20, chartIds: [10] }).adopted.length, 1);
  assert.equal(f.state.chart.spec.basicChart.series[0].pointStyle.size, 5);
  f.state.sourceRows = [['2026', '05/2026–02/2027']];
  const registration = JSON.parse(f.props.PERIOD_CHART_RANGE_V1_10);
  assert.equal(f.context.refreshRegisteredPeriodChart_(registration).state, 'committed');
  assert.equal(f.state.chart.spec.basicChart.series[0].pointStyle.size, 5);
  assert.ok(f.props.PERIOD_CHART_POINT_V1_10);
}
{
  const f = fixture();
  f.context.adoptCatalogerPeriodChart({ sheetId: 20, chartId: 10, sourceSheetId: 30 });
  f.state.numberFormat = '$0.000';
  const registration = JSON.parse(f.props.PERIOD_CHART_RANGE_V1_10);
  assert.equal(f.context.refreshRegisteredPeriodChart_(registration).state, 'committed');
  assert.equal(f.state.technicalFormats[1][1], '$0.000');
  assert.equal(f.state.chart.spec.title, 'Customized');
}
{
  const f = fixture();
  f.context.adoptCatalogerPeriodChart({ sheetId: 20, chartId: 10, sourceSheetId: 30 });
  const registration = JSON.parse(f.props.PERIOD_CHART_RANGE_V1_10);
  f.state.sourceRows = [['2026', '05/2026–02/2027']];
  f.state.lost = true;
  assert.throws(() => f.context.refreshRegisteredPeriodChart_(registration));
  assert.equal(f.context.recoverPendingPeriodChartPoints_().state, 'committed');
  assert.equal(f.state.writes, 2);
  assert.equal(f.state.technicalValues[15][1], 49);
}
{
  const f = fixture();
  assert.throws(() => f.context.adoptCatalogerPeriodChart({ sheetId: 20, chartId: 10, sourceSheetId: 99 }));
  assert.equal(f.state.writes, 0);
}
{
  const f = fixture();
  f.context.adoptCatalogerPeriodChart({ sheetId: 20, chartId: 10, sourceSheetId: 30 });
  const registration = JSON.parse(f.props.PERIOD_CHART_RANGE_V1_10);
  f.state.chart.spec.title = 'Owner adjusted';
  f.state.chart.spec.basicChart.domains[0].domain.sourceRange.sources[0].endRowIndex = 10;
  f.state.sourceRows = [['2026', '05/2026–02/2027']];
  assert.equal(f.context.refreshRegisteredPeriodChart_(registration).state, 'committed');
  assert.equal(f.state.chart.spec.title, 'Owner adjusted');
  assert.equal(f.state.chart.spec.basicChart.domains[0].domain.sourceRange.sources[0].endRowIndex, 10);
}
{
  const f = fixture();
  f.context.adoptCatalogerPeriodChart({ sheetId: 20, chartId: 10, sourceSheetId: 30 });
  const registration = JSON.parse(f.props.PERIOD_CHART_RANGE_V1_10);
  f.state.technical.getDeveloperMetadata = () => [];
  assert.throws(() => f.context.refreshRegisteredPeriodChart_(registration));
  assert.equal(f.state.writes, 1);
}
{
  const f = fixture();
  f.context.adoptCatalogerPeriodChart({ sheetId: 20, chartId: 10, sourceSheetId: 30 });
  const registration = JSON.parse(f.props.PERIOD_CHART_RANGE_V1_10);
  f.state.technicalFormula = true;
  assert.throws(() => f.context.refreshRegisteredPeriodChart_(registration));
  assert.equal(f.state.writes, 1);
}
{
  const f = fixture();
  f.context.adoptCatalogerPeriodChart({ sheetId: 20, chartId: 10, sourceSheetId: 30 });
  const registration = JSON.parse(f.props.PERIOD_CHART_RANGE_V1_10);
  f.context.getAutomationConfig_ = () => ({ locale: 'en', sheet_by_supply: {
    other: 'Source', another: f.state.technical.getName() } });
  assert.throws(() => f.context.refreshRegisteredPeriodChart_(registration));
  assert.equal(f.state.writes, 1);
}
{
  const f = fixture();
  f.context.adoptCatalogerPeriodChart({ sheetId: 20, chartId: 10, sourceSheetId: 30 });
  f.context.queuePeriodChartRefreshForSource_({ getSheetId: () => 30 });
  f.props.MUTATION_pending = '{}';
  assert.equal(f.context.recoverPendingPeriodChartRefresh_().state, 'deferred-source-recovery');
  assert.ok(f.props.PERIOD_CHART_REFRESH_PENDING_V1);
  delete f.props.MUTATION_pending;
  f.state.sourceRows = [['2027', '01']];
  const importResult = f.context.refreshPeriodChartsAfterInvoiceImport_(
    { getSheetId: () => 30 }, { warning: '' });
  assert.match(importResult.warning, /Period chart refresh was deferred/);
  assert.equal(f.state.writes, 1);
  assert.equal(f.context.recoverPendingPeriodChartRefresh_().state, 'failed');
  assert.ok(f.props.PERIOD_CHART_REFRESH_PENDING_V1);
  assert.equal(f.state.writes, 1);
  f.state.sourceRows = [['2026', '05–08']];
  assert.equal(f.context.recoverPendingPeriodChartRefresh_().state, 'refreshed');
  assert.equal(f.props.PERIOD_CHART_REFRESH_PENDING_V1, undefined);
}
{
  const f = fixture();
  f.context.adoptCatalogerPeriodChart({ sheetId: 20, chartId: 10, sourceSheetId: 30 });
  f.state.extraYear = true;
  f.state.sourceRows = [['2026', '05–08'], ['2027', '03–06']];
  const previous = JSON.parse(f.props.PERIOD_CHART_RANGE_V1_10);
  assert.equal(f.context.refreshRegisteredPeriodChart_(previous).state, 'committed');
  const updated = JSON.parse(f.props.PERIOD_CHART_RANGE_V1_10);
  assert.equal(updated.bindings.length, 2);
  assert.equal(updated.bindings[1].year, 2027);
  assert.equal(f.state.chart.spec.basicChart.series.length, 2);
  assert.equal(f.state.chart.spec.basicChart.series[0].color.red, 0.4);
  assert.equal(f.state.technicalValues[7][2], 25);
  assert.equal(f.state.writes, 2);
}
{
  const f = fixture();
  f.context.adoptCatalogerPeriodChart({ sheetId: 20, chartId: 10, sourceSheetId: 30 });
  f.state.sourceRows = [['2026', '05/2026–02/2027']];
  assert.equal(f.context.recoverPendingPeriodChartRefresh_().state, 'idle');
  assert.equal(f.context.recoverPendingPeriodChartRefresh_(true).state, 'refreshed');
  assert.equal(f.state.technicalValues[15][1], 49);
  assert.equal(f.props.PERIOD_CHART_REFRESH_PENDING_V1, undefined);
}
{
  const f = fixture();
  f.context.adoptCatalogerPeriodChart({ sheetId: 20, chartId: 10, sourceSheetId: 30 });
  f.state.extraYear = true;
  f.state.sourceRows = [['2026', '05–08'], ['2027', '03–06']];
  f.state.lost = true;
  const previous = JSON.parse(f.props.PERIOD_CHART_RANGE_V1_10);
  assert.throws(() => f.context.refreshRegisteredPeriodChart_(previous));
  f.state.lost = false;
  assert.equal(f.context.recoverPendingPeriodChartPoints_().state, 'committed');
  assert.equal(JSON.parse(f.props.PERIOD_CHART_RANGE_V1_10).bindings.length, 2);
  assert.equal(f.state.writes, 2);
}
{
  const f = fixture();
  f.context.adoptCatalogerPeriodChart({ sheetId: 20, chartId: 10, sourceSheetId: 30 });
  f.state.extraYear = true;
  f.state.differentFormula = true;
  f.state.sourceRows = [['2026', '05–08'], ['2027', '03–06']];
  const previous = JSON.parse(f.props.PERIOD_CHART_RANGE_V1_10);
  assert.throws(() => f.context.refreshRegisteredPeriodChart_(previous));
  assert.equal(f.state.writes, 1);
}
// A corrected short period must not detach the automatic range boundary from
// the table, including when registration recovery follows the shrinking write.
for (const interruptedShrink of [false, true]) {
  const f = fixture();
  f.state.sourceRows = [['2026', '05/2026–02/2027']];
  f.context.adoptCatalogerPeriodChart({ sheetId: 20, chartId: 10, sourceSheetId: 30 });
  const registration = JSON.parse(f.props.PERIOD_CHART_RANGE_V1_10);
  const ranges = () => [f.state.chart.spec.basicChart.domains[0].domain,
    f.state.chart.spec.basicChart.series[0].series].map(item => item.sourceRange.sources[0]);
  assert.deepEqual(ranges().map(range => range.endRowIndex), [16, 16]);
  f.state.sourceRows = [['2026', '05–08']];
  f.state.lost = interruptedShrink;
  if (interruptedShrink) {
    assert.throws(() => f.context.refreshRegisteredPeriodChart_(registration));
    f.state.lost = false;
    assert.equal(f.context.recoverPendingPeriodChartPoints_().state, 'committed');
  } else {
    assert.equal(f.context.refreshRegisteredPeriodChart_(registration).state, 'committed');
  }
  assert.deepEqual(ranges().map(range => range.endRowIndex), [13, 13]);
  assert.equal(f.state.technicalValues[15][1], '');
  f.state.sourceRows = [['2026', '05/2026–12/2027']];
  assert.equal(f.context.refreshRegisteredPeriodChart_(registration).state, 'committed');
  assert.deepEqual(ranges().map(range => range.endRowIndex), [26, 26]);
  assert.equal(f.state.technicalValues[25][1], 49);
  assert.deepEqual(f.state.chart.position, f.initial.position);
  assert.equal(f.state.chart.spec.basicChart.series[0].color.red, 0.4);
}
// Custom ends stay intact. Custom starts and columns also stay intact when the
// end matches the automatic boundary or the start lies beyond the shorter table.
for (const customization of [ { endRowIndex: 15 }, { startRowIndex: 14 },
  { startColumnIndex: 1, endColumnIndex: 2 } ]) {
  const f = fixture();
  f.state.sourceRows = [['2026', '05/2026–02/2027']];
  f.context.adoptCatalogerPeriodChart({ sheetId: 20, chartId: 10, sourceSheetId: 30 });
  const registration = JSON.parse(f.props.PERIOD_CHART_RANGE_V1_10);
  const range = f.state.chart.spec.basicChart.domains[0].domain.sourceRange.sources[0];
  Object.assign(range, customization);
  const originalRange = JSON.parse(JSON.stringify(range));
  for (const period of ['05–08', '05/2026–12/2027']) {
    f.state.sourceRows = [['2026', period]];
    assert.equal(f.context.refreshRegisteredPeriodChart_(registration).state, 'committed');
    assert.deepEqual(f.state.chart.spec.basicChart.domains[0].domain.sourceRange.sources[0],
      originalRange);
  }
}
console.log('Period chart range runtime integration tests passed.');
