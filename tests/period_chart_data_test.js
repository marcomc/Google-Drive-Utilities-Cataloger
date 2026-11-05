#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'PeriodChartData.gs'),
  'utf8'), context);
const parse = (year, value) => JSON.parse(JSON.stringify(
  context.parsePeriodChartRange_(year, value)));
const build = (year, values, periods) => Array.from(
  context.buildPeriodChartSeries_(year, values, periods));

assert.deepEqual(parse(2026, '05–08'), { start: 5, endExclusive: 9, isRange: true });
assert.deepEqual(parse(2025, '09–12'), { start: 9, endExclusive: 13, isRange: true });
assert.deepEqual(parse(2025, '11/2025–02/2026'),
  { start: 11, endExclusive: 15, isRange: true });
assert.deepEqual(parse(2024, '12/2024–12/2025'),
  { start: 12, endExclusive: 25, isRange: true });
for (const invalid of ['13–14', '10–02', '11/2024–02/2026', '05/2025–06',
  '01/2025–12/2035']) {
  assert.throws(() => parse(2025, invalid));
}
const months = Array(12).fill(null);
months[4] = 49;
const result = build(2026, months, ['05–08']);
assert.equal(result[8], 49);
assert.equal(months[8], null);
const crossYear = Array(12).fill(null);
crossYear[10] = 20;
assert.equal(build(2025, crossYear, ['11/2025–02/2026'])[14], 20);
const december = Array(12).fill(null);
december[11] = 16;
assert.equal(build(2024, december, ['12/2024–12/2025'])[24], 16);
const newer = Array(12).fill(null);
newer[4] = 40;
newer[6] = 50;
assert.equal(build(2026, newer, ['05–08', '07–09'])[8], null);
assert.equal(build(2026, newer, ['05–08', '07–09'])[9], 50);
const absentLaterMetric = Array(12).fill(null);
absentLaterMetric[4] = 40;
assert.throws(() => build(2026, absentLaterMetric, ['05–08', '07–09']));
assert.throws(() => build(2026, months, ['05–08', '05–09']));
assert.throws(() => build(2026, months, ['05', '05–08']));
const historicalOverlap = Array(12).fill(null);
historicalOverlap[0] = 12;
historicalOverlap[4] = 20;
historicalOverlap[6] = 30;
const waterSeries = build(2026, historicalOverlap, ['01', '01–05', '05–07', '07–09']);
assert.equal(waterSeries[0], 12);
assert.equal(waterSeries[9], 30);
assert.deepEqual(build(2026, Array(12).fill(null), ['05–08']), Array(12).fill(null));
const labels = Array.from({ length: 12 }, (_, i) => `month ${i + 1}`);
const table = JSON.parse(JSON.stringify(context.buildPeriodChartTable_(labels, [
  { year: 2025, values: crossYear, periods: ['11/2025–02/2026'] },
  { year: 2026, values: months, periods: ['05–08'] }
])));
assert.deepEqual(table[0], ['', 2025, 2026]);
assert.deepEqual(table[9], ['month 9', null, 49]);
assert.deepEqual(table[15], ['month 3 (+1)', 20, null]);
assert.throws(() => context.buildPeriodChartTable_(['January'], []));
const chart = { title: 'Customized', basicChart: { chartType: 'LINE',
  interpolateNulls: true, series: [{ pointStyle: { shape: 'DIAMOND', size: 0 },
    color: { red: 0.5 } }, { targetAxis: 'RIGHT_AXIS' }] } };
const updated = JSON.parse(JSON.stringify(context.addPeriodChartReferencePoints_(chart, 5)));
assert.equal(updated.basicChart.series[0].pointStyle.size, 5);
assert.equal(updated.basicChart.series[0].pointStyle.shape, 'DIAMOND');
assert.equal(updated.basicChart.series[1].pointStyle.size, 5);
assert.equal(chart.basicChart.series[0].pointStyle.size, 0);
updated.basicChart.series[0].pointStyle.size = 0;
delete updated.basicChart.series[1].pointStyle;
assert.deepEqual(updated, chart);
assert.throws(() => context.addPeriodChartReferencePoints_({ basicChart: {
  chartType: 'COLUMN', series: [] } }, 5));
const existing = { chartId: 42, position: { overlayPosition: { widthPixels: 800 } },
  spec: { title: 'Custom', basicChart: { chartType: 'LINE', interpolateNulls: true,
    domains: [{ domain: { sourceRange: { sources: [{ sheetId: 10 }] },
      aggregateType: 'NONE' } }],
    series: [{ series: { sourceRange: { sources: [{ sheetId: 10 }] } },
      color: { red: 1 }, pointStyle: { size: 3 } }] } } };
const original = JSON.stringify(existing);
const plan = JSON.parse(JSON.stringify(context.preparePeriodChartUpdate_(existing,
  { sheetId: 20, startRowIndex: 5, startColumnIndex: 2, rowCount: 14 }, 5)));
assert.equal(plan.updateChartSpec.chartId, 42);
assert.equal(plan.updateChartSpec.spec.title, 'Custom');
assert.equal(plan.updateChartSpec.spec.basicChart.interpolateNulls, true);
assert.equal(plan.updateChartSpec.spec.basicChart.domains[0].domain.aggregateType, 'NONE');
assert.equal(plan.updateChartSpec.spec.basicChart.series[0].color.red, 1);
assert.equal(plan.updateChartSpec.spec.basicChart.series[0].pointStyle.size, 5);
assert.deepEqual(plan.updateChartSpec.spec.basicChart.series[0].series.sourceRange.sources[0],
  { sheetId: 20, startRowIndex: 5, endRowIndex: 19, startColumnIndex: 3, endColumnIndex: 4 });
assert.equal(JSON.stringify(existing), original);
assert.throws(() => context.preparePeriodChartUpdate_(existing,
  { sheetId: 20, startRowIndex: -1, startColumnIndex: 2, rowCount: 14 }, 5));
const batch = JSON.parse(JSON.stringify(context.preparePeriodChartBatch_(existing,
  { sheetId: 20, startRowIndex: 5, startColumnIndex: 2,
    rowCapacity: 20, columnCapacity: 2 }, labels,
  [{ year: 2026, values: months, periods: ['05–08'] }], 5)));
assert.equal(batch.length, 2);
assert.equal(batch[0].updateCells.fields, 'userEnteredValue');
assert.equal(batch[0].updateCells.rows[9].values[1].userEnteredValue.numberValue, 49);
assert.equal(batch[1].updateChartSpec.chartId, 42);
assert.equal(batch[1].updateChartSpec.spec.basicChart.series[0].color.red, 1);
assert.throws(() => context.preparePeriodChartBatch_(existing,
  { sheetId: 20, startRowIndex: 5, startColumnIndex: 2,
    rowCapacity: 12, columnCapacity: 2 }, labels,
  [{ year: 2026, values: months, periods: ['05–08'] }], 5));
assert.throws(() => build(2026, Array(12).fill('ambiguous'), ['05–08']));
const zeroValues = Array(12).fill('#N/A');
zeroValues[4] = 0;
assert.equal(build(2026, zeroValues, ['05–08'])[8], 0);
assert.equal(build(2026, zeroValues, ['05–08'])[7], null);
assert.throws(() => context.preparePeriodChartBatch_(existing,
  { sheetId: 20, startRowIndex: 5, startColumnIndex: 2,
    rowCapacity: 20, columnCapacity: 2 }, labels,
  [{ year: 2026, values: months, periods: ['05–08'] },
    { year: 2025, values: crossYear, periods: ['11/2025–02/2026'] }], 5));
console.log('Period chart data tests passed.');
