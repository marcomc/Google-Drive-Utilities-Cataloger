#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const properties = {};
  const original = { chartId: 12, position: { overlayPosition: {
    anchorCell: { sheetId: 44, rowIndex: 7 }, widthPixels: 800, heightPixels: 400 } },
  spec: { title: 'Custom title', backgroundColor: { red: 0.5 }, basicChart: {
    chartType: 'LINE', interpolateNulls: true,
    domains: [{ domain: { sourceRange: { sources: [{ sheetId: 44 }] } } }],
    series: [{ series: { sourceRange: { sources: [{ sheetId: 44 }] } },
      color: { red: 1 }, pointStyle: { shape: 'DIAMOND', size: 0 } },
    { series: { sourceRange: { sources: [{ sheetId: 44 }] } },
      pointStyle: { size: 8 } }] } } };
  const state = { chart: JSON.parse(JSON.stringify(original)), writes: 0, reads: 0,
    changeAtRead: 0, transpose: false, merge: 'MERGE_COLUMNS', hidden: 'IGNORE_ROWS',
    changeNativeAfterWrite: false, lost: false };
  const propertyApi = {
    getProperty: key => properties[key] || null,
    setProperty: (key, value) => { properties[key] = value; },
    deleteProperty: key => { delete properties[key]; }
  };
  const blob = (value, contentType) => { const bytes = Buffer.from(value); return {
    getBytes: () => bytes, getDataAsString: () => bytes.toString('utf8'),
    getContentType: () => contentType }; };
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => propertyApi },
    Charts: { ChartMergeStrategy: { MERGE_COLUMNS: 'MERGE_COLUMNS' } },
    SpreadsheetApp: { flush: () => {}, openById: () => ({ getSheets: () => [{ getSheetId: () => 44,
      getCharts: () => [{ getChartId: () => 12, getMergeStrategy: () => state.merge,
        getTransposeRowsAndColumns: () => state.transpose, getNumHeaders: () => 1,
        getHiddenDimensionStrategy: () => state.hidden,
        modify: () => ({ getChartType: () => 'LINE' }) }] }] }) },
    ScriptApp: { getOAuthToken: () => 'redacted' },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_, data) => Array.from(crypto.createHash('sha256').update(data).digest()),
      newBlob: blob, gzip: data => blob(zlib.gzipSync(data.getBytes())),
      ungzip: data => {
        assert.equal(data.getContentType(), 'application/x-gzip');
        return blob(zlib.gunzipSync(data.getBytes()));
      },
      base64Encode: data => Buffer.from(data).toString('base64'),
      base64Decode: data => Buffer.from(data, 'base64'), getUuid: () => 'uuid' },
    UrlFetchApp: { fetch: (url, options) => {
      assert.ok(url.includes('/spreadsheets/workbook'));
      if (options.method === 'post') {
        state.writes += 1;
        const request = JSON.parse(options.payload).requests[0].updateChartSpec;
        assert.equal(request.chartId, state.chart.chartId);
        state.chart.spec = request.spec;
        if (state.changeNativeAfterWrite) { state.hidden = 'IGNORE_COLUMNS'; }
        if (state.lost) { throw new Error('simulated lost response'); }
        return { getResponseCode: () => 200, getContentText: () => '{}' };
      }
      state.reads += 1;
      if (state.reads === state.changeAtRead) { state.chart.spec.title = 'Owner edit'; }
      const body = { sheets: [{ properties: { sheetId: 44 }, charts: [state.chart] }] };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) };
    } },
    getSpreadsheetId_: () => 'workbook', assertCatalogConfiguration_: () => {},
    withCatalogLifecycleLock_: (_name, fn) => fn(),
    logCatalogEvent_: () => {}, classifyCatalogErrorForLog_: () => 'test'
  });
  ['PeriodChartTransactions.gs', 'PeriodChartRuntime.gs'].forEach(file => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context,
      { filename: file });
  });
  return { state, original, properties, context };
}

{
  const f = fixture();
  assert.deepEqual(Array.from(f.context.adoptCatalogerChartPoints(
    { sheetId: 44, chartIds: [12] }).adopted), [12]);
  assert.equal(f.state.writes, 1);
  assert.equal(f.state.chart.spec.basicChart.series[0].pointStyle.size, 5);
  assert.equal(f.state.chart.spec.basicChart.series[0].pointStyle.shape, 'DIAMOND');
  assert.equal(f.state.chart.spec.basicChart.series[1].pointStyle.size, 8);
  assert.deepEqual(f.state.chart.position, f.original.position);
  assert.equal(f.state.chart.spec.title, f.original.spec.title);
  assert.deepEqual(f.state.chart.spec.basicChart.domains, f.original.spec.basicChart.domains);
  assert.ok(f.properties.PERIOD_CHART_POINT_V1_12);
  f.context.adoptCatalogerChartPoints({ sheetId: 44, chartIds: [12] });
  assert.equal(f.state.writes, 1);
}
{
  const f = fixture();
  f.state.lost = true;
  assert.throws(() => f.context.adoptCatalogerChartPoints({ sheetId: 44, chartIds: [12] }));
  assert.ok(f.properties.PERIOD_CHART_POINT_JOURNAL_V1);
  f.state.lost = false;
  assert.equal(f.context.recoverPendingPeriodChartPoints_().state, 'committed');
  assert.equal(f.state.writes, 1);
  assert.ok(f.properties.PERIOD_CHART_POINT_V1_12);
  assert.equal(f.properties.PERIOD_CHART_POINT_JOURNAL_V1, undefined);
}
{
  const f = fixture();
  assert.throws(() => f.context.adoptCatalogerChartPoints({ sheetId: 44, chartIds: [12, 13] }));
  assert.equal(f.state.writes, 0);
  assert.equal(Object.keys(f.properties).length, 0);
}
{
  const f = fixture();
  f.state.changeAtRead = 3;
  assert.throws(() => f.context.adoptCatalogerChartPoints({ sheetId: 44, chartIds: [12] }));
  assert.equal(f.state.writes, 0);
  assert.equal(f.state.chart.spec.title, 'Owner edit');
  assert.ok(f.properties.PERIOD_CHART_POINT_JOURNAL_V1);
}
{
  const f = fixture();
  f.state.transpose = true;
  assert.throws(() => f.context.adoptCatalogerChartPoints({ sheetId: 44, chartIds: [12] }));
  assert.equal(f.state.writes, 0);
  assert.equal(Object.keys(f.properties).length, 0);
}
{
  const f = fixture();
  f.state.changeNativeAfterWrite = true;
  assert.throws(() => f.context.adoptCatalogerChartPoints({ sheetId: 44, chartIds: [12] }));
  assert.equal(f.state.writes, 1);
  assert.ok(f.properties.PERIOD_CHART_POINT_JOURNAL_V1);
  assert.throws(() => f.context.recoverPendingPeriodChartPoints_());
  assert.equal(f.state.writes, 1);
}
{
  const f = fixture();
  f.state.chart.spec.subtitle = 'repeatable text '.repeat(900);
  f.state.lost = true;
  assert.throws(() => f.context.adoptCatalogerChartPoints({ sheetId: 44, chartIds: [12] }));
  assert.ok(f.properties.PERIOD_CHART_POINT_JOURNAL_V1.startsWith('gz:'));
  f.state.lost = false;
  assert.equal(f.context.recoverPendingPeriodChartPoints_().state, 'committed');
  assert.equal(f.state.writes, 1);
}
{
  const f = fixture();
  f.state.chart.spec.subtitle = crypto.randomBytes(12000).toString('base64');
  assert.throws(() => f.context.adoptCatalogerChartPoints({ sheetId: 44, chartIds: [12] }));
  assert.equal(f.state.writes, 0);
}
{
  const f = fixture();
  f.properties.PERIOD_CHART_POINT_JOURNAL_V1 = 'gz:not-valid-gzip';
  assert.throws(() => f.context.recoverPendingPeriodChartPoints_());
  assert.equal(f.properties.PERIOD_CHART_POINT_JOURNAL_V1, 'gz:not-valid-gzip');
  assert.equal(f.state.writes, 0);
}
function uncertainFixture() {
  const f = fixture();
  const registration = { spreadsheetId: 'installed', sheetId: 44, chartId: 12 };
  // Obtain the fixture installation identity through the same public dependency.
  registration.spreadsheetId = f.context.getSpreadsheetId_();
  const before = f.context.periodChartFingerprint_(f.context.readPeriodChart_(registration));
  f.properties.PERIOD_CHART_POINT_JOURNAL_V1 = JSON.stringify({ version: 1,
    transactionId: 'terminated-request', spreadsheetId: registration.spreadsheetId,
    before, after: 'different', registration, phase: 'sent', requests: [{}] });
  return f;
}
{
  const f = uncertainFixture();
  const info = f.context.recoverCatalogerCharts();
  assert.equal(info.state, 'uncertain');
  for (const options of [ {}, { action: 'abandon', transactionId: 'other', before: info.before,
    confirmation: 'NO_WRITE_IN_FLIGHT' }, { action: 'abandon',
    transactionId: info.transactionId, before: info.before } ]) {
    assert.throws(() => f.context.recoverCatalogerCharts(options));
    assert.ok(f.properties.PERIOD_CHART_POINT_JOURNAL_V1);
  }
  const result = f.context.recoverCatalogerCharts({ action: 'abandon',
    transactionId: info.transactionId, before: info.before, confirmation: 'NO_WRITE_IN_FLIGHT' });
  assert.equal(result.state, 'abandoned');
  assert.equal(f.state.writes, 0);
  assert.equal(f.properties.PERIOD_CHART_POINT_JOURNAL_V1, undefined);
  assert.equal(JSON.parse(f.properties.PERIOD_CHART_LAST_RESOLUTION_V1).transactionId,
    info.transactionId);
  assert.equal(f.context.recoverCatalogerCharts().state, 'idle');
  f.context.adoptCatalogerChartPoints({ sheetId: 44, chartIds: [12] });
  assert.equal(f.state.writes, 1);
}
{
  const f = uncertainFixture();
  const info = f.context.recoverCatalogerCharts();
  f.state.chart.spec.title = 'Later owner edit';
  assert.throws(() => f.context.recoverCatalogerCharts({ action: 'abandon',
    transactionId: info.transactionId, before: info.before, confirmation: 'NO_WRITE_IN_FLIGHT' }));
  assert.ok(f.properties.PERIOD_CHART_POINT_JOURNAL_V1);
  assert.equal(f.state.writes, 0);
}
console.log('Period chart runtime integration tests passed.');
