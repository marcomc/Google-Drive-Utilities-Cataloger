#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'PeriodChartTransactions.gs'),
  'utf8'), context);

function fixture() {
  const state = { journal: null, registration: null, fingerprint: 'old', calls: 0 };
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const store = {
    readJournal: () => state.journal && copy(state.journal),
    saveJournal: (value) => { state.journal = copy(value); },
    saveRegistration: (value) => { state.registration = copy(value); },
    clearJournal: () => { state.journal = null; }
  };
  const sheets = {
    readFingerprint: () => state.fingerprint,
    applyBatch: () => { state.calls += 1; state.fingerprint = 'new'; }
  };
  const transaction = { version: 1, transactionId: 'transaction', spreadsheetId: 'sheet',
    before: 'old', after: 'new', registration: { chartId: 42 }, requests: [{ update: 1 }] };
  return { state, store, sheets, transaction };
}

{
  const f = fixture();
  assert.equal(context.commitPeriodChartTransaction_(f.store, f.sheets, f.transaction).state,
    'committed');
  assert.equal(f.state.calls, 1);
  assert.equal(f.state.registration.chartId, 42);
  assert.equal(f.state.journal, null);
}
{
  const f = fixture();
  f.sheets.applyBatch = () => { f.state.calls += 1; f.state.fingerprint = 'new';
    throw new Error('response lost'); };
  assert.throws(() => context.commitPeriodChartTransaction_(f.store, f.sheets, f.transaction));
  assert.equal(context.reconcilePeriodChartTransaction_(f.store, f.sheets).state, 'committed');
  assert.equal(f.state.calls, 1);
}
{
  const f = fixture();
  f.sheets.applyBatch = () => { f.state.calls += 1; throw new Error('unknown result'); };
  assert.throws(() => context.commitPeriodChartTransaction_(f.store, f.sheets, f.transaction));
  assert.equal(context.reconcilePeriodChartTransaction_(f.store, f.sheets).state, 'uncertain');
  assert.equal(f.state.calls, 1);
  assert.ok(f.state.journal);
}
{
  const f = fixture();
  const save = f.store.saveRegistration;
  f.store.saveRegistration = () => { throw new Error('local write failed'); };
  assert.throws(() => context.commitPeriodChartTransaction_(f.store, f.sheets, f.transaction));
  f.store.saveRegistration = save;
  assert.equal(context.reconcilePeriodChartTransaction_(f.store, f.sheets).state, 'committed');
  assert.equal(f.state.calls, 1);
}
{
  const f = fixture();
  f.sheets.applyBatch = () => { f.state.calls += 1; f.state.fingerprint = 'user edit'; };
  assert.throws(() => context.commitPeriodChartTransaction_(f.store, f.sheets, f.transaction));
  assert.throws(() => context.reconcilePeriodChartTransaction_(f.store, f.sheets));
  assert.ok(f.state.journal);
}
{
  const f = fixture();
  const save = f.store.saveJournal;
  let writes = 0;
  f.store.saveJournal = (journal) => {
    writes += 1;
    if (writes === 2) { throw new Error('journal update failed'); }
    save(journal);
  };
  assert.throws(() => context.commitPeriodChartTransaction_(f.store, f.sheets, f.transaction));
  assert.equal(context.reconcilePeriodChartTransaction_(f.store, f.sheets).state, 'prepared');
  assert.equal(f.state.calls, 0);
  f.state.fingerprint = 'new';
  assert.throws(() => context.reconcilePeriodChartTransaction_(f.store, f.sheets));
  assert.equal(f.state.registration, null);
}
{
  const f = fixture();
  f.state.fingerprint = 'different chart';
  assert.throws(() => context.commitPeriodChartTransaction_(f.store, f.sheets, f.transaction));
  assert.equal(f.state.calls, 0);
  assert.equal(f.state.journal, null);
}
console.log('Period chart transaction recovery tests passed.');
