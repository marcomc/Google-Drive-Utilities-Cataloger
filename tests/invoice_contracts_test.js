#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const files = ['Config.gs', 'locales/en.gs', 'locales/it.gs', 'Localization.gs',
  'GeminiModelSelection.gs', 'InvoiceContracts.gs', 'UtilitiesCataloging.gs'];

function runtime() {
  const c = vm.createContext({ console, isFinite });
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), c, { filename: f });
  c.getAutomationConfig_ = () => ({ locale: 'it', canonical_suppliers: ['SUPPLIER ONE', 'SUPPLIER TWO'],
    canonical_supplies: ['Gas', 'Internet', 'Acqua', 'Luce', 'Igiene Ambientale'],
    supplier_aliases: {}, supply_aliases: {}, frequency_overrides: [], address_rules: [], address_missing_type: 'import' });
  return c;
}

const headers = ['Totale costi consumo', 'Totale costi non consumo (escl. IVA)',
  'Quota fissa', 'Trasporto e oneri', 'Accise', 'Ricalcoli', 'IVA'];
const amounts = { selling: 2.48, network_variable: 1.4, consumption_parent: 3.88,
  fixed_selling: 9, network_fixed: 4.07, fixed_parent: 13.07,
  excise: 0.88, regional: 0.15, tax_parent: 4.4, recalculation: 0, excise_recap: 0.88 };

function contract() {
  return { version: 1, supplies: ['Gas'],
    components: Object.keys(amounts).map(id => ({ id, ...(id === 'recalculation' ? { absence_value: 0, absence_statements: ['Recalculations are not printed in the invoice.'] } : {}),
      ...(id === 'excise_recap' ? { reference_only: true } : {}) })),
    checks: [
      { total: 'consumption_parent', parts: ['selling', 'network_variable'] },
      { total: 'fixed_parent', parts: ['fixed_selling', 'network_fixed'] },
      { total: 'tax_parent', parts: ['excise', 'regional', 'field:vat'] },
      { total: 'excise_recap', parts: ['excise'] },
      { total: 'field:cost_non_consumption', parts: ['header:Quota fissa', 'header:Trasporto e oneri', 'header:Accise', 'header:Ricalcoli'] }
    ],
    allocations: [
      { target: 'field:cost_consumption', parts: ['selling'], group: 'canonical', replace_from: ['consumption_parent'] },
      { target: 'field:cost_non_consumption', parts: ['fixed_selling', 'network_fixed', 'network_variable', 'excise', 'regional', 'recalculation'],
        group: 'canonical', replace_from: ['fixed_parent'] },
      { target: 'header:Quota fissa', parts: ['fixed_selling'], group: 'details', replace_from: ['fixed_parent'] },
      { target: 'header:Trasporto e oneri', parts: ['network_variable', 'network_fixed'], group: 'details',
        replace_from: ['network_variable', 'network_fixed'] },
      { target: 'header:Accise', parts: ['excise', 'regional'], group: 'details', replace_from: ['excise'] },
      { target: 'header:Ricalcoli', parts: ['recalculation'], group: 'details' }
    ], defaults: [{ header: 'Ricalcoli', value: 0, aliases: ['Ricalcolo'] }]
  };
}

function policy(supplier, data = contract(), status = 'approvato', supplies) {
  return `--- BEGIN APPROVED SUPPLIER PROFILE: ${supplier} ---\n---\nstato: ${status}\nfornitore: ${supplier}\n` +
    (supplies ? `forniture: ${supplies}\n` : '') + '---\n' +
    '```invoice-contract\n' + JSON.stringify(data) + '\n```\n--- END APPROVED SUPPLIER PROFILE ---';
}

function invoice(c, supplier = 'SUPPLIER ONE', values = amounts, data = contract()) {
  const e = { document_type: 'Invoice', supplier, supply_type: 'Gas',
    contract_number: 'CONTRACT-001', customer_code: 'CUSTOMER-001',
    cost_consumption: 2.48, cost_non_consumption: 13.07, vat: 3.37, total: 21.35,
    problems: [], source_components: Object.entries(values).map(([id, amount]) => ({ id, amount,
      source_evidence: id === 'recalculation' ? 'explicit_absence' : 'printed',
      ...(id === 'recalculation' ? { absence_evidence: 'Recalculations are not printed in the invoice.' } : {}) })),
    sheet_values: [{ header: 'Totale costi consumo', value: 2.48 },
      { header: 'Totale costi non consumo (escl. IVA)', value: 13.07 },
      { header: 'Quota fissa', value: 13.07 }, { header: 'Trasporto e oneri', value: 1.4 },
      { header: 'Accise', value: 0.88 }, { header: 'Ricalcoli', value: 0 }, { header: 'IVA', value: 3.37 }] };
  Object.defineProperty(e, 'configured_writable_headers', { value: headers });
  c.bindInvoiceContract_(e, policy(supplier, data));
  return e;
}

function testSupplierRenamingDoesNotChangeExecution() {
  const c = runtime();
  for (const supplier of ['SUPPLIER ONE', 'SUPPLIER TWO', 'A NEW GLOBAL UTILITY']) {
    const e = invoice(c, supplier);
    assert.equal(c.evaluateInvoiceContract_(e, false).valid, false);
    assert.equal(c.evaluateInvoiceContract_(e, true).valid, true);
    assert.equal(c.evaluateInvoiceContract_(e, false).valid, true);
    assert.equal(e.cost_consumption, 2.48);
    assert.equal(e.cost_non_consumption, 15.5);
    assert.equal(e.sheet_values.find(x => x.header === 'Quota fissa').value, 9);
    assert.equal(e.sheet_values.find(x => x.header === 'Trasporto e oneri').value, 5.47);
    assert.equal(e.sheet_values.find(x => x.header === 'Accise').value, 1.03);
    assert.equal(e.vat, 3.37);
    assert.equal(e.total, 21.35);
    const snapshot = c.buildExtractionRepairSnapshot_(e);
    assert.equal(snapshot.source_components.length, Object.keys(amounts).length);
    assert.equal(Object.hasOwn(snapshot, 'invoice_contract_'), false);
  }
}

function testSourceContradictionsRemainBlocking() {
  const c = runtime();
  for (const mutate of [
    e => { delete e.source_components.find(x => x.id === 'recalculation').absence_evidence; },
    e => { e.source_components.find(x => x.id === 'recalculation').absence_evidence = 'Recalculations are unreadable.'; },
    e => { e.source_components.pop(); },
    e => { e.source_components.push(e.source_components[0]); },
    e => { e.source_components[0].id = 'unknown'; },
    e => { e.source_components[0].amount = '2.48'; },
    e => { e.source_components[0].source_evidence = 'explicit_absence'; },
    e => { e.source_components.find(x => x.id === 'tax_parent').amount = 5.43; },
    e => { e.source_components.find(x => x.id === 'excise_recap').amount = 1.76; },
    e => { e.sheet_values.find(x => x.header === 'Accise').value = 2; },
    e => { e.sheet_values.find(x => x.header === 'Accise').value = null; },
    e => { e.sheet_values.find(x => x.header === 'Totale costi consumo').value = 99; },
    e => { e.vat = 4.4; }
  ]) {
    const e = invoice(c); mutate(e); const before = JSON.stringify(e);
    assert.equal(c.evaluateInvoiceContract_(e, true).valid, false);
    assert.equal(JSON.stringify(e), before, 'A failed mapping must leave evidence and values intact');
  }
  const flagged = invoice(c); flagged.problems = ['Source evidence is unreadable.'];
  const before = JSON.stringify(flagged);
  c.evaluateInvoiceContract_(flagged, true);
  assert.equal(JSON.stringify(flagged), before);
}

function testProfileTrustAndLanguageAreBounded() {
  const c = runtime();
  const e = invoice(c);
  assert.equal(c.getApprovedInvoiceContract_(policy('ANOTHER SUPPLIER'), e), null);
  assert.equal(c.getApprovedInvoiceContract_(policy(e.supplier, { ...contract(), supplies: ['Internet'] }), e), null);
  assert.throws(() => c.getApprovedInvoiceContract_(policy(e.supplier) + '\n' + policy(e.supplier), e), /More than one/);
  assert.throws(() => c.getApprovedInvoiceContract_(policy(e.supplier, contract(), 'in attesa'), e), /metadata/);
  for (const mutate of [
    x => { x.version = 2; },
    x => { x.script = 'run()'; },
    x => { x.components.push(x.components[0]); },
    x => { x.checks.push({ total: 'selling', parts: ['consumption_parent'] }); },
    x => { x.allocations[0].parts = ['excise_recap']; },
    x => { x.allocations[0].parts = ['consumption_parent']; },
    x => { x.allocations[0].target = 'field:vat'; },
    x => { x.defaults[0].pattern = '.*'; },
    x => { x.allocations.push({ ...x.allocations[2], target: 'header:QUOTA FISSA' }); }
  ]) {
    const data = contract(); mutate(data);
    assert.throws(() => c.parseInvoiceContract_('```invoice-contract\n' + JSON.stringify(data) + '\n```'));
  }
  for (const profileScope of [undefined, '[*]', '[Gas]']) {
    const typo = { ...contract(), supplies: ['Gass'] };
    assert.throws(() => c.getApprovedInvoiceContract_(policy(e.supplier, typo, 'approvato', profileScope), e),
      /scope conflicts/, 'Unknown contract supplies cannot silently disable admission');
  }
  assert.throws(() => c.getApprovedInvoiceContract_(policy(e.supplier, contract(), 'approvato', '[Gass]'), e),
    /scope conflicts/);
  assert.equal(c.getApprovedInvoiceContract_('', { ...e, invoice_contract_: contract() }), null);
  c.bindInvoiceContract_(e, '');
  assert.equal(c.getInvoiceContract_(e), null, 'Model-supplied contract data cannot authorize rules');
}

function testColumnBindingsCannotWriteOutsideTheConfiguredContract() {
  const c = runtime();
  for (const writable of [headers.filter(x => x !== 'Quota fissa'), headers.concat('QUOTA FISSA')]) {
    const original = invoice(c);
    const e = { ...original };
    Object.defineProperty(e, 'configured_writable_headers', { value: writable });
    c.bindInvoiceContract_(e, policy(e.supplier));
    assert.equal(c.evaluateInvoiceContract_(e, true).valid, false);
  }
  for (const header of ['Codice cliente', 'Quantità consumi', 'Costo unitario', 'IVA', 'Costo totale']) {
    const data = contract(); data.allocations[2].target = 'header:' + header;
    assert.throws(() => c.parseInvoiceContract_('```invoice-contract\n' + JSON.stringify(data) + '\n```'));
    const defaults = contract(); defaults.defaults[0].header = header;
    assert.throws(() => c.parseInvoiceContract_('```invoice-contract\n' + JSON.stringify(defaults) + '\n```'));
  }

}

function testReferenceMonthUsesActualPeriodStartForEverySupply() {
  const c = runtime();
  for (const supply_type of ['Internet', 'Igiene Ambientale', 'Acqua', 'Luce', 'Gas', 'ANOTHER SUPPLY']) {
    for (const [period_start, period_end, expectedYear, expectedMonth] of [
      ['2026-10-15', '2026-11-14', 2026, '10'],
      ['2026-05-01', '2026-08-31', 2026, '05'],
      ['2026-07-04', '2026-09-10', 2026, '07'],
      ['2025-09-01', '2025-12-31', 2025, '09'],
      ['2025-12-15', '2026-01-14', 2025, '12'],
      ['2026-09-01', '2026-09-30', 2026, '09']
    ]) {
      const e = { document_type: 'Invoice', supply_type, period_start, period_end,
        issue_date: '2026-10-01', reference_year: 2026, reference_month: '11' };
      c.applyInvoiceReferencePeriod_(e);
      assert.equal(e.reference_year, expectedYear);
      assert.equal(e.reference_month, expectedMonth);
    }
  }
}

function testFutureModelVersionsDoNotRequireReleaseLists() {
  const c = runtime();
  for (const version of ['3.99', '4', '40.12.7']) {
    const lite = `gemini-${version}-flash-lite`, flash = `gemini-${version}-flash`;
    assert.equal(c.isStableGeminiModelIdForTier_(lite, 'flash-lite'), true);
    assert.equal(c.isStableGeminiModelIdForTier_(flash, 'flash'), true);
    assert.equal(c.getGeminiReasoningConfig_(lite, 'gemini_api').thinking_level, 'low');
    assert.equal(c.getGeminiReasoningConfig_(flash, 'gemini_api').thinking_level, 'medium');
    assert.equal(c.getGeminiReasoningConfig_(lite, 'vertex_ai').thinkingConfig.thinkingLevel, 'LOW');
    assert.equal(c.getGeminiReasoningConfig_(flash, 'vertex_ai').thinkingConfig.thinkingLevel, 'MEDIUM');
  }
  c.getGeminiModel_ = () => 'gemini-40.12.7-flash-lite';
  assert.deepEqual(Array.from(c.getGeminiDeveloperModelCandidatesPinned_()), ['gemini-40.12.7-flash-lite']);
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8'), /oenergy|energygas|iliad/i, f);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'Config.gs'), 'utf8'), /mediumLevelModels|gemini25Models|GEMINI_DEVELOPER_FALLBACK_MODELS/);
}

function iterator(values) {
  let index = 0;
  return { hasNext: () => index < values.length, next: () => values[index++] };
}

function profileFolder(text, name) {
  return { isTrashed: () => false, getName: () => name,
    getFilesByName: () => iterator([{ isTrashed: () => false,
      getSize: () => Buffer.byteLength(text), getBlob: () => ({ getDataAsString: () => text }) }]) };
}

function testSameSupplierMayHaveDisjointSupplyProfiles() {
  const c = runtime();
  c.Utilities = { newBlob: text => ({ getBytes: () => Array.from(Buffer.from(text)) }) };
  const gas = policy('SUPPLIER ONE', contract(), 'approvato', '[Gas]')
    .replace(/^--- BEGIN[^\n]*\n/, '').replace(/\n--- END[^\n]*$/, '');
  const internet = policy('SUPPLIER ONE', { ...contract(), supplies: ['Internet'] }, 'approvato', '[Internet]')
    .replace(/^--- BEGIN[^\n]*\n/, '').replace(/\n--- END[^\n]*$/, '');
  const read = texts => c.readApprovedProfilesFromRoot_({
    getFolders: () => iterator(texts.map((t, i) => profileFolder(t, 'PROFILE-' + i)))
  }, c.getSupplierProfileNames_());
  const trusted = read([gas, internet]);
  assert.ok(c.getApprovedInvoiceContract_(trusted, { document_type: 'Invoice', supplier: 'SUPPLIER ONE', supply_type: 'Gas' }));
  assert.ok(c.getApprovedInvoiceContract_(trusted, { document_type: 'Invoice', supplier: 'SUPPLIER ONE', supply_type: 'Internet' }));
  for (const pair of [[gas, gas], [internet, internet]]) assert.throws(() => read(pair), /same supplier and supply/);
  const wildcard = '---\nstato: approvato\nfornitore: SUPPLIER ONE\n---\nReading guide';
  for (const pair of [[wildcard, gas], [gas, wildcard]]) assert.throws(() => read(pair), /same supplier and supply/);
  assert.throws(() => read([gas.replace('forniture: [Gas]', 'forniture: [Internet]')]), /scope conflicts/);
  assert.throws(() => read([gas.replace('forniture: [Gas]', 'forniture: Gas')]), /bounded list/);
}

function testWorkspaceSelectionOnlyBindsExplicitExistingResources() {
  const c = runtime();
  let writes = 0, driveReads = 0;
  const properties = {};
  const locks = [];
  c.assertCatalogConfiguration_ = () => {};
  c.getRootFolderId_ = () => 'root-id';
  c.getScriptProperty_ = key => properties[key] || '';
  c.PropertiesService = { getScriptProperties: () => ({
    getProperty: key => properties[key] || '',
    setProperty: (key, value) => { writes += 1; properties[key] = value; }
  }) };
  c.withCatalogLifecycleLock_ = (_source, fn) => { locks.push('lifecycle'); return fn(); };
  c.withCatalogProcessingLock_ = (_source, fn) => { locks.push('processing'); return fn(); };
  const folder = (id, name, children) => ({ getId: () => id, getName: () => name,
    isTrashed: () => false, getFoldersByName: n => iterator(children.filter(x => x.getName() === n)),
    getFolders: () => iterator([]), createFolder: () => { throw new Error('Creation is outside this operation'); } });
  const template = folder('template-id', '_modello', []);
  const profiles = folder('profiles-id', 'Profili fornitori', [template]);
  const rootFolder = folder('root-id', 'Installation-specific intake', [profiles]);
  c.DriveApp = { getFolderById: id => { driveReads += 1; assert.equal(id, 'root-id'); return rootFolder; } };
  const selected = { rootFolderId: 'root-id', profileRootId: 'profiles-id', templateFolderId: 'template-id' };
  assert.throws(() => c.configureApprovedProfileWorkspace({ ...selected, rootFolderId: 'another-installation' }), /installed/);
  assert.equal(driveReads, 0);
  assert.throws(() => c.configureApprovedProfileWorkspace({ ...selected, templateFolderId: 'wrong-id' }), /identity/);
  assert.equal(writes, 0);
  assert.equal(c.configureApprovedProfileWorkspace(selected).configured, true);
  assert.deepEqual(locks.slice(-2), ['lifecycle', 'processing']);
  assert.equal(writes, 1);
  assert.equal(c.configureApprovedProfileWorkspace(selected).changed, false);
  assert.equal(writes, 1, 'An acknowledged configuration is reconciled without repeating the write');
  const saved = JSON.parse(properties.SUPPLIER_PROFILE_WORKSPACE_STATE);
  assert.equal(saved.profileRootId, 'profiles-id');
  properties.SUPPLIER_PROFILE_WORKSPACE_STATE = JSON.stringify({ ...saved, profileRootId: 'different-root' });
  assert.throws(() => c.configureApprovedProfileWorkspace(selected), /different resource/);
  assert.equal(writes, 1);
}

function testExtractionCallerUsesTrustedContractAndUniversalPeriod() {
  for (const supplier of ['SUPPLIER ONE', 'SUPPLIER TWO']) {
    for (const supply of ['Gas', 'Acqua', 'Internet', 'Igiene Ambientale', 'Luce']) {
    const c = runtime();
    const profileContract = contract();
    profileContract.supplies = [supply];
    profileContract.products = [{ quantity_header: 'Quantità consumi', rate_header: 'Costo unitario', total: 'selling' }];
    const writableHeaders = headers.concat(['Quantità consumi', 'Costo unitario']);
    const trustedPolicy = policy(supplier, profileContract);
    c.logCatalogEvent_ = () => {};
    c.classifyAddress_ = () => 'import';
    c.getSheetHeadersBySupply_ = () => ({ [supply]: writableHeaders });
    c.getConfiguredSecondaryInvoiceHeaders_ = () => [];
    c.getConfiguredInvoiceFrequency_ = () => '';
    c.getHistoricalInvoiceFrequencyEvidence_ = () => ({ state: 'empty', frequency: '' });
    c.validateServiceIdentityForInvoice_ = () => ({ valid: true });
    c.validateTargetSheetValues_ = () => ({ valid: true });
    c.buildInvoiceRepairSupplyContext_ = () => ({ state: 'available', previousInvoices: [] });
    c.isAutomaticGeminiModelSelectionEnabled_ = () => false;
    const raw = Object.fromEntries(c.buildExtractionResponseSchema_().required.map(key => [key, null]));
    Object.assign(raw, JSON.parse(JSON.stringify(invoice(c, supplier))), {
      supply_type: supply, address_type: 'import', address_evidence: 'Verified service address', account_holder: 'Test Owner',
      identifier: 'INV-001', issue_date: '2026-10-01', billing_cycle_kind: 'ordinary',
      frequency: null, frequency_source_evidence: null, reference_year: 2026, reference_month: '08',
      period_start: '2026-05-01', period_end: '2026-08-31',
      contract_number: '',
      problem_details: [{ code: 'missing', fields: ['Ricalcoli'], message: 'Ricalcoli non presente nel documento.' },
        { code: 'missing', fields: ['contract_number'], message: 'Numero contratto non presente.' }],
      problems: ['Ricalcoli non presente nel documento.', 'Numero contratto non presente.']
    });
    raw.sheet_values.push({ header: 'Quantità consumi', value: 5 }, { header: 'Costo unitario', value: 0.496 });
    let calls = 0;
    const repairs = [];
    c.callGeminiForPdf_ = (_blob, _headers, trusted, _file, repair) => {
      assert.equal(trusted, trustedPolicy);
      repairs.push(repair);
      const response = JSON.parse(JSON.stringify(raw));
      if (++calls === 1) response.source_components.find(x => x.id === 'selling').amount = 3;
      if (calls === 2) response.sheet_values.find(x => x.header === 'Costo unitario').value = 0.776;
      if (calls === 3) {
        response.sheet_values.find(x => x.header === 'Costo unitario').value = '0,496';
        response.sheet_values.find(x => x.header === 'Quantità consumi').value = '5';
      }
      return JSON.stringify(response);
    };
    const file = { getBlob: () => ({}), getId: () => 'file-id', getName: () => 'invoice.pdf' };
    const result = c.extractUtilityDataWithRepair_(file, trustedPolicy, Date.now() + 120000);
    assert.equal(result.validation.valid, true, JSON.stringify(result.validation));
    assert.equal(calls, 3);
    assert.ok(repairs[2].feedback.issues[0].fields.includes('Costo unitario'));
    assert.equal(repairs[1].feedback.issues[0].code, 'invoice_cost_reconciliation_mismatch');
    assert.equal(result.extracted.reference_month, '05');
    assert.equal(result.extracted.cost_non_consumption, 15.5);
    assert.equal(result.extracted.vat, 3.37);
    assert.equal(result.extracted.total, 21.35);
    assert.ok(c.getInvoiceContract_(result.extracted));
    c.callGeminiForPdf_ = () => JSON.stringify(raw);
    const immediate = c.extractUtilityDataWithRepair_(file, trustedPolicy, Date.now() + 120000);
    assert.equal(immediate.validation.valid, true);
    assert.equal(immediate.aiCallCount, 1, 'Non-blocking absence must not consume extra model calls');
    assert.equal(immediate.extracted.cost_non_consumption, 15.5);
    assert.ok(immediate.extracted.problems.includes('Numero contratto non presente.'));
    const cadence = JSON.parse(JSON.stringify(raw)); cadence.period_end = '2026-09-30';
    c.callGeminiForPdf_ = () => JSON.stringify(cadence);
    const review = c.extractUtilityDataWithRepair_(file, trustedPolicy, Date.now() + 120000);
    assert.equal(review.validation.valid, true);
    assert.equal(review.aiCallCount, 3);
    assert.equal(review.extracted.cost_non_consumption, 15.5);
    assert.equal(review.extracted.review_issues.length, 1);
    assert.equal(review.extracted.review_issues[0].fields[0], 'frequency');
    assert.equal(result.extracted.sheet_values.find(x => x.header === 'Costo unitario').value, 0.496);
    assert.equal(result.extracted.sheet_values.find(x => x.header === 'Quantità consumi').value, 5);
    for (const [header, value] of [['Costo unitario', 'unreadable'], ['Quantità consumi', '1.234']]) {
      const invalid = JSON.parse(JSON.stringify(raw));
      invalid.sheet_values.find(x => x.header === header).value = value;
      c.callGeminiForPdf_ = () => JSON.stringify(invalid);
      assert.throws(() => c.extractUtilityDataWithRepair_(file, trustedPolicy, Date.now() + 120000), /nonnumeric/);
    }
    assert.equal(c.validateExtractedUtilityDataForImport_({ ...result.extracted,
      period_start: null }).valid, false, 'Missing actual billed period cannot be a cadence-only warning');
    assert.equal(c.validateExtractedUtilityDataForImport_({ ...result.extracted,
      period_end: null }).valid, false, 'Missing period end cannot safely render a billed range');
    }
  }
}

function testProductChecksRequireTypedConfiguredIndependentInputs() {
  const c = runtime();
  const data = contract();
  data.products = [{ quantity_header: 'Quantità consumi', rate_header: 'Costo unitario', total: 'selling' }];
  function candidate() {
    const e = { ...invoice(c) };
    Object.defineProperty(e, 'configured_writable_headers', { value: headers.concat(['Quantità consumi', 'Costo unitario']) });
    e.sheet_values = e.sheet_values.concat([{ header: 'Quantità consumi', value: 5 }, { header: 'Costo unitario', value: 0.496 }]);
    c.bindInvoiceContract_(e, policy(e.supplier, data));
    return e;
  }
  const valid = candidate();
  assert.equal(c.evaluateInvoiceContract_(valid, true).valid, true);
  for (const mutate of [
    e => { e.sheet_values.find(x => x.header === 'Costo unitario').value = 0.776; },
    e => { e.sheet_values.find(x => x.header === 'Costo unitario').value = null; },
    e => { e.sheet_values.find(x => x.header === 'Quantità consumi').value = '5'; },
    e => { e.sheet_values.find(x => x.header === 'Quantità consumi').value = -5; },
    e => { e.sheet_values.push({ header: 'COSTO UNITARIO', value: 0.496 }); },
    e => { e.sheet_values = e.sheet_values.filter(x => x.header !== 'Costo unitario'); }
  ]) {
    const e = candidate(); mutate(e);
    assert.equal(c.evaluateInvoiceContract_(e, true).valid, false);
    assert.equal(e.cost_non_consumption, 13.07, 'No partial mapping after product rejection');
    assert.equal(e.vat, 3.37); assert.equal(e.total, 21.35);
  }
  for (const bad of [
    { quantity_header: 'Codice cliente', rate_header: 'Costo unitario', total: 'selling' },
    { quantity_header: 'Quantità consumi', rate_header: 'IVA', total: 'selling' },
    { quantity_header: 'Quantità consumi', rate_header: 'Costo unitario', total: 'unknown' },
    { quantity_header: 'Quantità consumi', rate_header: 'Costo unitario', total: 'selling', expression: 'q*r' }
  ]) assert.throws(() => c.parseInvoiceContract_('```invoice-contract\n' + JSON.stringify({ ...data, products: [bad] }) + '\n```'));
}

function testValidatedMappingRetainsNonBlockingDiagnostics() {
  const c = runtime();
  for (const [problem, missing] of [
    ['Numero contratto non presente.', 'contract_number'],
    ['Codice cliente non presente.', 'customer_code'],
    ['Gli importi sono riportati comprensivi di IVA.', ''],
    ['Billing frequency could not be established from the billed period or prior invoices.', '']
  ]) {
    const e = invoice(c); e[missing] = ''; e.problems = [problem];
    assert.equal(c.evaluateInvoiceContract_(e, true).valid, true);
    assert.equal(e.cost_non_consumption, 15.5, 'Optional identifier absence must not suppress a valid mapping');
    assert.deepEqual(e.problems, [problem], 'Keep the original diagnostic for downstream classification');
  }
  for (const problem of ['Quota fissa ambigua.', 'Numero contratto illeggibile.',
    'Numero contratto non presente. La quota fissa è in conflitto.', 'Unclassified extraction problem.']) {
    const e = invoice(c); e.contract_number = ''; e.problems = [problem];
    c.evaluateInvoiceContract_(e, true);
    assert.equal(e.cost_non_consumption, 13.07, 'Conflicting diagnostics retain the original snapshot');
    assert.equal(c.validateInvoiceCostEvidence_(e).valid, false);
    assert.equal(e.sheet_values.find(x => x.header === 'Quota fissa').value, 13.07);
    assert.deepEqual(e.problems, [problem]);
  }
}

function testEnergygasSourceComponentsDriveExclusiveAllocation() {
  const c = runtime();
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/energygas-electricity-contract.json'), 'utf8'));
  // Synthetic amounts preserve the printed-parent and duplicate-charge cases.
  const values = { consumption_parent: 52, selling_consumption: 40,
    network_consumption: 12, fixed_parent: 10, fixed_selling: 8,
    fixed_network: 2, power_network: 4, excise: 5, television: 6,
    transport_separate: 0, system_separate: 0, recalculations: 0 };
  const absence = { transport_separate: 'Trasporto separato non presente: incluso negli importi rete e oneri.',
    system_separate: 'Oneri separati non presenti: ASOS e ARIM sono compresi negli importi rete e oneri.',
    recalculations: 'Ricalcoli non presenti nel documento.' };
  const e = { document_type: 'Invoice', supplier: 'Energygas Italia', supply_type: 'Luce',
    contract_number: '', customer_code: 'CL123', cost_consumption: 40,
    cost_non_consumption: 37, vat: 7, total: 84, problems: [], sheet_values: [],
    source_components: Object.entries(values).map(([id, amount]) => ({ id, amount,
      source_evidence: absence[id] ? 'explicit_absence' : 'printed',
      ...(absence[id] ? { absence_evidence: absence[id] } : {}) })) };
  Object.defineProperty(e, 'configured_writable_headers', { value: fixture.detail_headers });
  c.bindInvoiceContract_(e, policy('Energygas Italia', fixture.contract));
  c.applyApprovedProfileFieldDefaults_(e, fixture.detail_headers);
  assert.deepEqual(e.problems, [], 'Contract-allocated fields must not receive conflicting default diagnostics');
  assert.equal(c.evaluateInvoiceContract_(e, true).valid, true);
  const mapped = Object.fromEntries(e.sheet_values.map(x => [x.header, x.value]));
  assert.deepEqual(mapped, { 'Altri costi materia energia': 8,
    'Trasporto e gestione contatore': 0, 'Oneri di sistema': 0, 'Accise': 5,
    'Canone TV': 6, 'Ricalcoli': 0, 'Rete e oneri non scorporabili': 18 });
  assert.equal(c.evaluateInvoiceContract_(e, false).valid, true);
  const duplicated = JSON.parse(JSON.stringify(e));
  duplicated.sheet_values.find(x => x.header === 'Oneri di sistema').value = 6.5;
  Object.defineProperty(duplicated, 'configured_writable_headers', { value: fixture.detail_headers });
  c.bindInvoiceContract_(duplicated, policy('Energygas Italia', fixture.contract));
  const duplicateResult = c.evaluateInvoiceContract_(duplicated, true);
  assert.equal(duplicateResult.valid, false, 'A contradictory charge cannot be silently replaced');
  assert.equal(duplicateResult.code, 'invoice_cost_reconciliation_mismatch');
  const missingColumn = JSON.parse(JSON.stringify(e));
  Object.defineProperty(missingColumn, 'configured_writable_headers', {
    value: fixture.detail_headers.filter(header => header !== 'Rete e oneri non scorporabili')
  });
  c.bindInvoiceContract_(missingColumn, policy('Energygas Italia', fixture.contract));
  assert.equal(c.evaluateInvoiceContract_(missingColumn, true).valid, false,
    'A missing cost column must not disable reconciliation');
  for (const change of [
    x => { x.source_components.find(v => v.id === 'system_separate').absence_evidence = 'Unreadable'; },
    x => { x.source_components = x.source_components.filter(v => v.id !== 'power_network'); },
    x => { x.source_components.find(v => v.id === 'fixed_parent').amount += 1; },
    x => { x.source_components.find(v => v.id === 'fixed_parent').amount = 14; },
    x => { x.sheet_values.find(v => v.header === 'Rete e oneri non scorporabili').value = 99; }
  ]) {
    const invalid = JSON.parse(JSON.stringify(e));
    change(invalid);
    Object.defineProperty(invalid, 'configured_writable_headers', { value: fixture.detail_headers });
    c.bindInvoiceContract_(invalid, policy('Energygas Italia', fixture.contract));
    const before = JSON.stringify(invalid);
    assert.equal(c.evaluateInvoiceContract_(invalid, true).valid, false);
    assert.equal(JSON.stringify(invalid), before, 'Rejected evidence must not mutate the extraction');
  }
  const inconsistent = JSON.parse(JSON.stringify(e));
  inconsistent.source_components.find(x => x.id === 'network_consumption').amount += 1;
  Object.defineProperty(inconsistent, 'configured_writable_headers', { value: fixture.detail_headers });
  c.bindInvoiceContract_(inconsistent, policy('Energygas Italia', fixture.contract));
  assert.equal(c.evaluateInvoiceContract_(inconsistent, true).valid, false);
}

testEnergygasSourceComponentsDriveExclusiveAllocation();
testSupplierRenamingDoesNotChangeExecution();
testSourceContradictionsRemainBlocking();
testProfileTrustAndLanguageAreBounded();
testColumnBindingsCannotWriteOutsideTheConfiguredContract();
testReferenceMonthUsesActualPeriodStartForEverySupply();
testFutureModelVersionsDoNotRequireReleaseLists();
testSameSupplierMayHaveDisjointSupplyProfiles();
testWorkspaceSelectionOnlyBindsExplicitExistingResources();
testExtractionCallerUsesTrustedContractAndUniversalPeriod();
testProductChecksRequireTypedConfiguredIndependentInputs();
testValidatedMappingRetainsNonBlockingDiagnostics();
console.log('Generic invoice contracts and model-family tests passed.');
