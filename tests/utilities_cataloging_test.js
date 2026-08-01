#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const sources = ['Config.gs', 'locales/en.gs', 'locales/it.gs', 'Localization.gs',
  'UtilitiesCataloging.gs'].map((file) =>
  fs.readFileSync(path.join(projectRoot, file), 'utf8')
);

function loadCataloger(overrides = {}) {
  const context = vm.createContext({
    console,
    isFinite,
    MimeType: { PDF: 'application/pdf' },
    Session: { getScriptTimeZone: () => 'Etc/UTC' },
    Utilities: {
      base64Encode: () => 'encoded-pdf',
      formatDate: () => '2026-07-16',
      newBlob: (value) => ({
        getBytes: () => Array.from(Buffer.from(String(value), 'utf8'))
      }),
      sleep: () => {}
    },
    ScriptApp: {
      getOAuthToken: () => 'oauth-token'
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => '' })
    },
    SpreadsheetApp: {
      CopyPasteType: {
        PASTE_FORMAT: 'format',
        PASTE_FORMULA: 'formula'
      },
      newRichTextValue: () => {
        const value = {
          text: '',
          link: '',
          setText(text) {
            this.text = text;
            return this;
          },
          setLinkUrl(link) {
            this.link = link;
            return this;
          },
          build() {
            return { text: this.text, link: this.link };
          }
        };
        return value;
      }
    },
    ...overrides
  });
  sources.forEach((source, index) => {
    vm.runInContext(source, context, {
      filename: ['Config.gs', 'locales/en.gs', 'locales/it.gs',
        'Localization.gs', 'UtilitiesCataloging.gs'][index]
    });
  });
  return context;
}

function validInvoice() {
  return {
    document_type: 'Invoice',
    supplier: 'SUPPLIER',
    supply_type: 'Water',
    address_type: 'import',
    issue_date: '2026-07-16',
    identifier: 'INV-1',
    contract_number: 'CONTRACT-1',
    customer_code: 'CUSTOMER-1',
    contract_object: '',
    reference_year: 2026,
    reference_month: '06',
    period_start: '2026-06-01',
    period_end: '2026-06-30',
    cost_consumption: 10,
    cost_non_consumption: 2,
    vat: 2.64,
    total: 14.64,
    problems: [],
    sheet_values: []
  };
}

function installScriptPropertyStore(context, initialValues = {}) {
  const store = { ...initialValues };
  const properties = {
    getProperties: () => ({ ...store }),
    getProperty: (key) => Object.prototype.hasOwnProperty.call(store, key) ?
      store[key] : null,
    setProperty: (key, value) => {
      store[key] = value;
    },
    setProperties: (values) => Object.assign(store, values),
    deleteProperty: (key) => {
      delete store[key];
    }
  };
  context.PropertiesService = {
    getScriptProperties: () => properties
  };
  return { properties, store };
}

function testFormulaLikeTextIsWrittenLiterally() {
  const context = loadCataloger();
  [
    '=IMPORTXML("https://example.test")',
    '+SUM(1,2)',
    '-1+2',
    '@SUM(1,2)'
  ].forEach((candidate) => {
    const calls = [];
    const range = {
      setRichTextValue: (value) => calls.push(['rich', value]),
      setValue: (value) => calls.push(['value', value])
    };

    context.setLiteralSheetValue_(range, candidate);

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'rich');
    assert.equal(calls[0][1].text, candidate);
  });
}

function testExtractionSchemaAndCalendarValidation() {
  const context = loadCataloger();
  context.getAutomationConfig_ = () => ({
    locale: 'it',
    canonical_suppliers: ['SUPPLIER', 'ILIAD', 'Energygas Italia'],
    supplier_aliases: {},
    canonical_supplies: ['Water', 'Internet'],
    supply_aliases: {},
    address_rules: [],
    address_missing_type: 'import',
    frequency_overrides: []
  });
  const raw = validInvoice();
  context.validateRawExtractionShape_(raw);
  assert.equal(context.validateExtraction_(raw).valid, true);
  const normalized = context.normalizeExtraction_({
    ...raw,
    contract_number: '  CONTRACT-2 ',
    customer_code: ' CUSTOMER-2  ',
    reference_month: '7'
  });
  assert.equal(normalized.contract_number, 'CONTRACT-2');
  assert.equal(normalized.customer_code, 'CUSTOMER-2');
  assert.equal(normalized.reference_month, '07');
  assert.equal(typeof normalized.reference_month, 'string');

  const digitOnlyIdentifiers = context.normalizeExtraction_({
    ...raw,
    identifier: 16657014,
    contract_number: 123456,
    customer_code: 53009296
  });
  assert.equal(typeof digitOnlyIdentifiers.identifier, 'string');
  assert.equal(typeof digitOnlyIdentifiers.contract_number, 'string');
  assert.equal(typeof digitOnlyIdentifiers.customer_code, 'string');

  const iliadDefault = context.normalizeExtraction_({
    ...raw,
    supplier: 'ILIAD',
    supply_type: 'Internet',
    problems: ["Spese d'incasso non presente nel documento."],
    sheet_values: []
  });
  context.applySupplierFieldDefaults_(iliadDefault, ["Spese d'incasso"]);
  assert.equal(JSON.stringify(iliadDefault.sheet_values), JSON.stringify([
    { header: "Spese d'incasso", value: 0 }
  ]));
  assert.deepEqual(iliadDefault.problems, []);

  const iliadPrintedCharge = context.normalizeExtraction_({
    ...raw,
    supplier: 'ILIAD',
    supply_type: 'Internet',
    sheet_values: [{ header: "Spese d'incasso", value: 1.25 }]
  });
  context.applySupplierFieldDefaults_(iliadPrintedCharge, ["Spese d'incasso"]);
  assert.equal(JSON.stringify(iliadPrintedCharge.sheet_values), JSON.stringify([
    { header: "Spese d'incasso", value: 1.25 }
  ]));

  const iliadEmptyCharge = context.normalizeExtraction_({
    ...raw,
    supplier: 'ILIAD',
    supply_type: 'Internet',
    problems: ["Spese d'incasso non presente nel documento."],
    sheet_values: [{ header: "Spese d'incasso", value: null }]
  });
  context.applySupplierFieldDefaults_(iliadEmptyCharge, ["Spese d'incasso"]);
  assert.equal(iliadEmptyCharge.sheet_values[0].value, 0);

  const iliadUnreadableCharge = context.normalizeExtraction_({
    ...raw,
    supplier: 'ILIAD',
    supply_type: 'Internet',
    problems: ["Spese d'incasso amount missing or unreadable."],
    sheet_values: [{ header: "Spese d'incasso", value: null }]
  });
  context.applySupplierFieldDefaults_(iliadUnreadableCharge, ["Spese d'incasso"]);
  assert.equal(iliadUnreadableCharge.sheet_values[0].value, null);
  assert.equal(context.validateExtraction_(iliadUnreadableCharge).valid, false);

  const iliadWithoutConfiguredChargeColumn = context.normalizeExtraction_({
    ...raw,
    supplier: 'ILIAD',
    supply_type: 'Internet',
    problems: ["Spese d'incasso non presente nel documento."],
    sheet_values: []
  });
  context.applySupplierFieldDefaults_(iliadWithoutConfiguredChargeColumn, []);
  assert.deepEqual(iliadWithoutConfiguredChargeColumn.sheet_values, []);
  assert.deepEqual(iliadWithoutConfiguredChargeColumn.problems, []);

  const iliadReport = context.normalizeExtraction_({
    ...raw,
    document_type: 'Report',
    supplier: 'ILIAD',
    supply_type: 'Internet',
    sheet_values: []
  });
  context.applySupplierFieldDefaults_(iliadReport, ["Spese d'incasso"]);
  assert.deepEqual(iliadReport.sheet_values, []);

  const energygas = context.normalizeExtraction_({
    ...raw,
    supplier: 'Energygas Italia',
    contract_number: 'CL000001',
    customer_code: ''
  });
  assert.equal(energygas.contract_number, '');
  assert.equal(energygas.customer_code, 'CL000001');

  ['CL-000001', 'CL 000001', 'CL/000001'].forEach((contractNumber) => {
    const formattedEnergygas = context.normalizeExtraction_({
      ...raw,
      supplier: 'Energygas Italia',
      contract_number: contractNumber,
      customer_code: ''
    });
    assert.equal(formattedEnergygas.contract_number, '');
    assert.equal(formattedEnergygas.customer_code, contractNumber);
  });

  const duplicatedEnergygas = context.normalizeExtraction_({
    ...raw,
    supplier: 'Energygas Italia',
    contract_number: 'CL000001',
    customer_code: 'CL000001'
  });
  assert.equal(duplicatedEnergygas.contract_number, '');
  assert.equal(duplicatedEnergygas.customer_code, 'CL000001');

  const normalizedSheetValues = context.normalizeExtraction_({
    ...raw,
    sheet_values: [{ header: '  Unità di misura consumi  ', value: ' mc  ' }]
  }).sheet_values;
  assert.equal(JSON.stringify(normalizedSheetValues), JSON.stringify([
    { header: 'Unità di misura consumi', value: 'mc' }
  ]));

  const bandValues = context.normalizeExtraction_({
    ...raw,
    sheet_values: [{ header: 'Quantità consumi F1', value: '368,74 kWh' }]
  }).sheet_values;
  assert.equal(bandValues[0].value, 368.74);
  assert.equal(context.normalizeElectricityBandConsumption_('1.234,56 kWh'),
    1234.56);
  assert.equal(context.normalizeElectricityBandConsumption_('1,234 kWh'), null);
  assert.equal(context.normalizeElectricityBandConsumption_('1.234 kWh'), null);
  assert.equal(context.normalizeElectricityBandConsumption_('1,234,567 kWh'),
    1234567);
  assert.equal(context.normalizeElectricityBandConsumption_('1.234.567 kWh'),
    1234567);
  assert.throws(() => context.normalizeExtraction_({
    ...raw,
    sheet_values: [{ header: 'Quantità consumi F1', value: 'not available' }]
  }), /nonnumeric electricity band consumption/);

  assert.throws(
    () => context.validateRawExtractionShape_({
      ...raw,
      identifier: { unexpected: true }
    }),
    /invalid type/
  );
  assert.throws(
    () => context.validateRawExtractionShape_({
      ...raw,
      period_end: '2026-02-30'
    }),
    /invalid date/
  );

  const invalidMonth = { ...raw, reference_month: '13' };
  assert.equal(context.validateExtraction_(invalidMonth).valid, false);
  const invalidSupplier = { ...raw, supplier: '|||***' };
  assert.equal(context.validateExtraction_(invalidSupplier).valid, false);

  const onlyCustomerCode = {
    ...raw,
    contract_number: '',
    customer_code: 'ID-UTENTE-1',
    problems: ['Numero di contratto assente nel documento.']
  };
  assert.equal(context.validateExtraction_(onlyCustomerCode).valid, true);
  assert.equal(context.validateExtraction_({
    ...onlyCustomerCode,
    problems: ['Numero contratto non presente nel documento.']
  }).valid, true);

  const onlyContractNumber = {
    ...raw,
    contract_number: 'CONTRACT-ONLY',
    customer_code: '',
    problems: ['ID utente missing from the document.']
  };
  assert.equal(context.validateExtraction_(onlyContractNumber).valid, true);
  assert.equal(context.validateExtraction_({
    ...onlyCustomerCode,
    problems: ['Codice contratto assente nel documento.']
  }).valid, true);

  const noOwnershipIdentifier = {
    ...raw,
    contract_number: '',
    customer_code: '',
    problems: []
  };
  const noOwnershipValidation = context.validateExtraction_(noOwnershipIdentifier);
  assert.equal(noOwnershipValidation.valid, false);
  assert.match(noOwnershipValidation.problem, /Contract number and customer code are both missing/);

  const otherProblemRemainsBlocking = {
    ...onlyCustomerCode,
    problems: ['Numero di contratto assente nel documento.', 'VAT cannot be verified.']
  };
  assert.equal(context.validateExtraction_(otherProblemRemainsBlocking).valid, false);

  const mixedIdentifierProblem = {
    ...onlyCustomerCode,
    problems: ['Numero di contratto assente nel documento; periodo ambiguo.']
  };
  assert.equal(context.validateExtraction_(mixedIdentifierProblem).valid, false);
  assert.equal(context.validateExtraction_({
    ...onlyCustomerCode,
    problems: ['Numero di contratto assente, importo illeggibile.']
  }).valid, false);

  const informationalVatInclusion = {
    ...onlyCustomerCode,
    problems: [
      'Gli importi delle singole voci nel dettaglio servizi sono riportati nel documento comprensivi di IVA al 22%.'
    ]
  };
  assert.equal(context.validateExtraction_(informationalVatInclusion).valid, true);

  const mixedVatProblem = {
    ...onlyCustomerCode,
    problems: ['IVA inclusa nei dettagli. Il periodo di fatturazione è ambiguo.']
  };
  assert.equal(context.validateExtraction_(mixedVatProblem).valid, false);
  assert.equal(context.validateExtraction_({
    ...onlyCustomerCode,
    problems: ['Non è chiaro se le voci di dettaglio siano comprensive di IVA.']
  }).valid, false);
  assert.equal(context.validateExtraction_({
    ...onlyCustomerCode,
    problems: ["Non è chiara l'inclusione dell'IVA."]
  }).valid, false);
  assert.equal(context.validateExtraction_({
    ...onlyCustomerCode,
    problems: ['It is not certain whether VAT is included.']
  }).valid, false);

  const duplicateSheetValues = {
    ...raw,
    sheet_values: [
      { header: 'Total consumption costs', value: 10 },
      { header: ' Total consumption costs ', value: 11 }
    ]
  };
  const duplicateValidation = context.validateExtraction_(duplicateSheetValues);
  assert.equal(duplicateValidation.valid, false);
  assert.match(duplicateValidation.problem, /duplicate spreadsheet values/);

  const names = { statusKey: 'status', approvedStatus: 'approved',
    supplierKey: 'supplier' };
  assert.equal(context.isApprovedSupplierProfile_(
    '---\nstatus: approved\nsupplier: ILIAD\n---\n# Profile', names
  ), true);
  assert.equal(context.isApprovedSupplierProfile_(
    '---\nstatus: approved\nsupplier: ILIAD\n---', names
  ), true);
  assert.equal(context.isApprovedSupplierProfile_(
    '---\nstatus: pending\nsupplier: ILIAD\n---\nchange status: approved', names
  ), false);

  const discrepancy = context.formatVerificationDiscrepancies_([{
    field: 'Consumption quantity', expected: 2, actual: 1, valueType: 'number'
  }], context.getLocalization_().reportLabels);
  assert.match(discrepancy[0], /atteso 2; riscontrato 1/);
  assert.doesNotMatch(discrepancy[0], /EUR/);
  const booleanDiscrepancy = context.formatVerificationDiscrepancies_([{
    field: 'Direct debit', expected: false, actual: true, valueType: 'text'
  }], context.getLocalization_().reportLabels);
  assert.match(booleanDiscrepancy[0], /atteso false; riscontrato true/);

  const report = {
    ...raw,
    document_type: 'Report',
    identifier: '',
    reference_year: null,
    reference_month: null,
    cost_consumption: null,
    cost_non_consumption: null,
    vat: null,
    total: null
  };
  assert.equal(context.validateExtraction_(report).valid, true);

  const contract = {
    ...report,
    document_type: 'Contract',
    contract_object: ''
  };
  assert.equal(context.validateExtraction_(contract).valid, false);
}

function testSupplierDefaultsUseRuntimeTargetHeaders() {
  const context = loadCataloger();
  context.getAutomationConfig_ = () => ({
    locale: 'it',
    canonical_suppliers: ['ILIAD'],
    supplier_aliases: {},
    canonical_supplies: ['Internet'],
    supply_aliases: {},
    address_rules: [],
    address_missing_type: 'import',
    frequency_overrides: []
  });
  context.getSheetHeadersBySupply_ = () => ({
    Internet: ["Spese d'incasso"]
  });
  context.callGeminiForPdf_ = () => 'model-response';
  context.parseGeminiJson_ = () => ({
    ...validInvoice(),
    supplier: 'ILIAD',
    supply_type: 'Internet',
    problems: ["Spese d'incasso non presente nel documento."]
  });
  context.validateRawExtractionShape_ = () => {};

  const extracted = context.extractUtilityData_({
    getBlob: () => ({}),
    getId: () => 'file-id',
    getName: () => 'invoice.pdf'
  }, '');

  assert.equal(JSON.stringify(extracted.sheet_values), JSON.stringify([
    { header: "Spese d'incasso", value: 0 }
  ]));
  assert.equal(JSON.stringify(extracted.problems), JSON.stringify([]));
}

function testAmbiguousAddressRulesFailClosed() {
  const context = loadCataloger();
  context.getAutomationConfig_ = () => ({
    address_rules: [
      { match: 'CENTRAL AVENUE', type: 'import' },
      { match: 'OFFICE CENTRAL AVENUE', type: 'archive_only' }
    ]
  });

  assert.equal(
    context.classifyAddress_('Office Central Avenue 1'),
    'unknown'
  );
}

function testHiddenPdfsAreExcludedFromIntake() {
  const context = loadCataloger();
  const rootFolder = { getId: () => 'root-folder-id' };
  const makeFile = (name) => ({
    getMimeType: () => 'application/pdf',
    isTrashed: () => false,
    getName: () => name,
    getParents: () => {
      let available = true;
      return {
        hasNext: () => available,
        next: () => {
          available = false;
          return rootFolder;
        }
      };
    }
  });

  assert.equal(
    context.isDirectIntakePdf_(makeFile('.hidden.pdf'), rootFolder),
    false
  );
  assert.equal(
    context.isDirectIntakePdf_(makeFile('visible.pdf'), rootFolder),
    true
  );
}

function testDeveloperApiKeyUsesHeader() {
  const requests = [];
  const context = loadCataloger({
    UrlFetchApp: {
      fetch: (url, options) => {
        requests.push({ url, options });
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{
              finishReason: 'STOP',
              content: { parts: [{ text: '{}' }] }
            }]
          })
        };
      }
    }
  });
  context.getGeminiModel_ = () => 'gemini-3.6-flash';
  context.getScriptProperty_ = () => 'developer-secret';
  context.buildExtractionPrompt_ = () => 'prompt';
  context.logCatalogEvent_ = () => {};
  context.logGeminiUsage_ = () => {};
  const file = { getId: () => 'file-id' };
  const blob = { getBytes: () => [1, 2, 3] };

  context.callGeminiForPdfWithBackend_(
    blob,
    [],
    'policy',
    file,
    'gemini_api',
    ''
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.includes('?key='), false);
  assert.equal(requests[0].options.headers['x-goog-api-key'], 'developer-secret');
  const payload = JSON.parse(requests[0].options.payload);
  assert.equal(
    payload.generationConfig.maxOutputTokens,
    vm.runInContext('CONFIG.GEMINI_MAX_OUTPUT_TOKENS', context)
  );
  assert.equal(
    payload.generationConfig.thinkingConfig.thinkingLevel,
    vm.runInContext('CONFIG.GEMINI_FLASH_THINKING_LEVEL', context)
  );
  assert.equal(payload.generationConfig.responseMimeType, 'application/json');
  assert.equal(payload.generationConfig.responseJsonSchema.type, 'object');
  assert.deepEqual(
    payload.generationConfig.responseJsonSchema.required,
    [
      'document_type',
      'supplier',
      'supply_type',
      'address_type',
      'address_evidence',
      'issue_date',
      'identifier',
      'contract_number',
      'customer_code',
      'contract_object',
      'reference_year',
      'reference_month',
      'frequency',
      'period_start',
      'period_end',
      'consumption_description',
      'cost_consumption',
      'cost_non_consumption',
      'vat',
      'total',
      'sheet_values',
      'problems'
    ]
  );
  assert.deepEqual(
    payload.generationConfig.responseJsonSchema.properties.document_type.enum,
    ['Invoice', 'Contract', 'Report', 'unknown']
  );
  assert.deepEqual(
    payload.generationConfig.responseJsonSchema.properties.sheet_values
      .items.properties.value.type,
    ['string', 'number', 'boolean', 'null']
  );
}

function testConfigureGeminiModelUpdatesTheSharedRuntimeModel() {
  const properties = {};
  const context = loadCataloger({
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties[key] || '',
        setProperty: (key, value) => {
          properties[key] = value;
        }
      })
    }
  });
  context.getSetupStatus = () => ({ geminiModel: context.getGeminiModel_() });

  assert.equal(context.getGeminiModel_(), 'gemini-3.6-flash');
  properties.GEMINI_MODEL = 'gemini-3.5-flash';
  assert.equal(context.getGeminiModel_(), 'gemini-3.6-flash');

  const result = context.configureGeminiModel('gemini-3.5-flash');

  assert.equal(properties.GEMINI_MODEL, 'gemini-3.6-flash');
  assert.equal(result.geminiModel, 'gemini-3.6-flash');
  assert.throws(
    () => context.configureGeminiModel('models/gemini-3.6-flash'),
    /must be a Gemini model identifier/
  );
}

function testIncompleteGeminiResponseReportsFinishReason() {
  const events = [];
  const context = loadCataloger({
    UrlFetchApp: {
      fetch: () => ({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{
            finishReason: 'MAX_TOKENS',
            content: { parts: [{ text: '{"partial":' }] }
          }]
        })
      })
    }
  });
  context.getGeminiModel_ = () => 'gemini-2.5-flash';
  context.getScriptProperty_ = () => 'developer-secret';
  context.buildExtractionPrompt_ = () => 'prompt';
  context.logGeminiUsage_ = () => {};
  context.logCatalogEvent_ = (event, details) => events.push({ event, details });

  assert.throws(
    () => context.callGeminiForPdfWithBackend_(
      { getBytes: () => [1, 2, 3] },
      [],
      'policy',
      { getId: () => 'file-id' },
      'gemini_api',
      ''
    ),
    /finish reason: MAX_TOKENS/
  );
  assert.equal(
    events.find((entry) => entry.event === 'gemini-generation-response')
      .details.finishReason,
    'MAX_TOKENS'
  );
}

function testGeminiResponseWithoutFinishReasonFailsClosed() {
  const context = loadCataloger({
    UrlFetchApp: {
      fetch: () => ({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{}' }] } }]
        })
      })
    }
  });
  context.getGeminiModel_ = () => 'gemini-3.6-flash';
  context.getScriptProperty_ = () => 'developer-secret';
  context.buildExtractionPrompt_ = () => 'prompt';
  context.logGeminiUsage_ = () => {};
  context.logCatalogEvent_ = () => {};

  assert.throws(
    () => context.callGeminiForPdfWithBackend_(
      { getBytes: () => [1, 2, 3] },
      [],
      'policy',
      { getId: () => 'file-id' },
      'gemini_api',
      ''
    ),
    /finish reason: UNSPECIFIED/
  );
}

function testDepletedPrepaymentCreditsSwitchToVertexForOneHour() {
  const requests = [];
  const events = [];
  const properties = {
    GEMINI_API_KEY: 'developer-secret',
    GEMINI_BACKEND: 'gemini_api',
    GEMINI_AUTO_VERTEX_FALLBACK: 'true',
    GOOGLE_CLOUD_PROJECT_ID: 'cataloger-project'
  };
  const responses = [
    {
      getResponseCode: () => 429,
      getContentText: () => JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'Your prepayment credits are depleted. Please go to AI Studio at ' +
            'https://ai.studio/projects to manage your project and billing. Learn more at ' +
            'https://ai.google.dev/gemini-api/docs/billing#prepay.'
        }
      })
    },
    {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: '{}' }] }
        }]
      })
    },
    {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: '{}' }] }
        }]
      })
    },
    {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: '{}' }] }
        }]
      })
    }
  ];
  const context = loadCataloger({
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties[key] || '',
        setProperty: (key, value) => {
          properties[key] = value;
        }
      })
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        requests.push({ url, options });
        return responses.shift();
      }
    }
  });
  context.getGeminiModel_ = () => 'gemini-2.5-flash';
  context.getVertexAiLocation_ = () => 'global';
  context.getScriptProperty_ = (key) => properties[key] || '';
  context.buildExtractionPrompt_ = () => 'prompt';
  context.logGeminiUsage_ = () => {};
  context.logCatalogEvent_ = (event, details) => {
    events.push({ event, details });
  };

  const blob = { getBytes: () => [1, 2, 3] };
  const firstResult = context.callGeminiForPdf_(
    blob,
    {},
    'policy',
    { getId: () => 'first-file-id' }
  );

  assert.equal(firstResult, '{}');
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /generativelanguage\.googleapis\.com/);
  assert.match(requests[1].url, /aiplatform\.googleapis\.com/);
  assert.ok(Number(properties.GEMINI_VERTEX_FALLBACK_UNTIL) > Date.now());
  assert.equal(
    events.find((entry) => entry.event === 'gemini-vertex-fallback-activated')
      .details.reason,
    'gemini-api-prepayment-credits-depleted'
  );

  const secondResult = context.callGeminiForPdf_(
    blob,
    {},
    'policy',
    { getId: () => 'second-file-id' }
  );
  assert.equal(secondResult, '{}');
  assert.match(requests[2].url, /aiplatform\.googleapis\.com/);

  properties.GEMINI_VERTEX_FALLBACK_UNTIL = String(Date.now() - 1);
  const thirdResult = context.callGeminiForPdf_(
    blob,
    {},
    'policy',
    { getId: () => 'third-file-id' }
  );
  assert.equal(thirdResult, '{}');
  assert.match(requests[3].url, /generativelanguage\.googleapis\.com/);
}

function testEmailReportIncludesSoftwareVersion() {
  const context = loadCataloger();
  vm.runInContext(
    fs.readFileSync(path.join(projectRoot, 'locales/en.gs'), 'utf8'),
    context,
    { filename: 'locales/en.gs' }
  );
  context.getLocalization_ = () => context.getEnglishLocalization_();

  const report = context.formatResult_({
    status: 'ERROR',
    originalName: 'invoice.pdf',
    assignedName: '',
    fileUrl: 'https://drive.test/file-id',
    destination: '',
    supplySupplier: '',
    extracted: {},
    actions: 'No changes.',
    problem: 'Provider unavailable.',
    recommendedAction: 'Retry later.'
  });

  assert.equal(
    report.startsWith(
      'Software version: ' + context.getApplicationVersion() + '\nSTATUS: ERROR\n'
    ),
    true
  );
  assert.match(report, /Failure stage: not available/);
  assert.match(report, /Persistence: not available/);

  const linkedReport = context.formatResult_(Object.assign({}, {
    status: 'ERROR', originalName: 'invoice.pdf', fileUrl: 'https://drive.test/file-id',
    extracted: {}, actions: 'No changes.', problem: 'Provider unavailable.',
    recommendedAction: 'Retry later.', supplierProfilesUrl: 'https://drive.test/profiles',
    retryUrl: 'https://script.google.com/home/projects/script-id/edit?function=retryFailedUtilitiesCataloging'
  }));
  assert.match(linkedReport, /Supplier profiles and proposals: https:\/\/drive\.test\/profiles/);
  assert.match(linkedReport, /Retry import: https:\/\/script\.google\.com\/home\/projects\/script-id/);
}

function testPostExtractionSpreadsheetErrorReportPreservesDiagnostics() {
  const cloudPayloads = [];
  const consoleErrors = [];
  const extraction = validInvoice();
  const file = {
    getId: () => 'file-id',
    getName: () => 'invoice.pdf',
    getSize: () => 10,
    getUrl: () => 'https://drive.test/file-id'
  };
  const context = loadCataloger({
    Logger: { log: (payload) => cloudPayloads.push(payload) },
    console: { error: (message) => consoleErrors.push(message) }
  });
  vm.runInContext(
    fs.readFileSync(path.join(projectRoot, 'locales/en.gs'), 'utf8'),
    context,
    { filename: 'locales/en.gs' }
  );
  context.getLocalization_ = () => context.getEnglishLocalization_();
  context.sha256ForFile_ = () => 'hash';
  context.extractUtilityData_ = () => extraction;
  context.validateExtraction_ = () => ({ valid: true });
  context.validateTargetSheetValues_ = () => ({ valid: true });
  context.findDuplicate_ = () => ({ status: 'none' });
  context.buildAssignedName_ = () => 'assigned.pdf';
  context.saveMutationJournal_ = () => {};
  context.updateMutationJournal_ = () => {};
  context.getDestinationFolder_ = () => ({ folder: {}, path: 'Water/2026' });
  context.getDestinationCollision_ = () => ({ status: 'none' });
  context.importUtilityInvoiceToSheet_ = () => {
    const error = new Error('Spreadsheet formula total verification failed for: Total cost');
    error.verificationDiscrepancies = [{
      field: 'Total cost',
      expected: 14.64,
      actual: 12.34,
      valueType: 'money',
      tolerance: 0.02
    }];
    throw error;
  };
  context.rollbackProcessingMutations_ = (_file, _root, _name, state) => {
    state.rollbackErrors = [];
  };
  context.describeError_ = (error) => error.message;
  context.classifyCatalogErrorForLog_ = () => 'spreadsheet';
  context.attachMutationJournal_ = (result) => result;

  const result = context.processIntakeFile_(file, {}, 'policy');
  const report = context.formatResult_(result);

  assert.equal(result.status, 'ERROR');
  assert.deepEqual(JSON.parse(JSON.stringify(result.extracted)), extraction);
  assert.equal(result.supplySupplier, 'Water / SUPPLIER');
  assert.equal(result.failureStage, 'spreadsheet-write-and-verify');
  assert.equal(result.extractionValidated, true);
  assert.match(report, /Failure stage: Writing and verifying spreadsheet row/);
  assert.match(report, /Gemini extracted data: available, not imported/);
  assert.match(report, /Persistence: no import persisted; rollback completed/);
  assert.match(report, /Supply \/ supplier: Water \/ SUPPLIER/);
  assert.match(report, /Total: 14\.64 EUR/);
  assert.match(report, /Reconciliation check: passed: 14\.64 EUR \/ 14\.64 EUR/);
  assert.match(report,
    /Detected discrepancy: field Total cost; expected 14\.64 EUR; observed 12\.34 EUR; tolerance 0\.02 EUR/);
  assert.deepEqual(JSON.parse(JSON.stringify(cloudPayloads)), [{
    message: 'catalog-file-processing-error',
    component: 'drive-utilities-cataloger',
    applicationVersion: '0.3.1',
    event: 'catalog-file-processing-error',
    fileId: 'file-id',
    errorType: 'Error',
    errorCategory: 'spreadsheet',
    failureStage: 'spreadsheet-write-and-verify'
  }]);
  assert.deepEqual(consoleErrors, [
    'Catalog file processing failed for file ID file-id (spreadsheet).'
  ]);
  const cloudText = JSON.stringify({ cloudPayloads, consoleErrors });
  [
    extraction.supplier,
    extraction.identifier,
    extraction.period_start,
    String(extraction.total),
    '12.34',
    'Spreadsheet formula total verification failed for: Total cost'
  ].forEach((sensitiveValue) => {
    assert.equal(cloudText.includes(sensitiveValue), false);
  });

  vm.runInContext(
    fs.readFileSync(path.join(projectRoot, 'locales/it.gs'), 'utf8'),
    context,
    { filename: 'locales/it.gs' }
  );
  context.getLocalization_ = () => context.getItalianLocalization_();
  const italianReport = context.formatResult_(result);
  assert.match(italianReport, /Fase errore: Scrittura e verifica riga del foglio/);
  assert.match(italianReport, /Dati estratti da Gemini: disponibili, non importati/);
  assert.match(italianReport,
    /Stato importazione: nessun import persistito; rollback completato/);
  assert.match(italianReport,
    /Verifica quadratura: superata: 14\.64 EUR \/ 14\.64 EUR/);
  assert.match(italianReport,
    /Discrepanza rilevata: campo Total cost; atteso 14\.64 EUR; riscontrato 12\.34 EUR; tolleranza 0\.02 EUR/);

  context.rollbackProcessingMutations_ = (_file, _root, _name, state) => {
    state.rollbackErrors = ['Spreadsheet rollback failed: service unavailable'];
  };
  const incompleteRollbackResult = context.processIntakeFile_(file, {}, 'policy');
  assert.equal(incompleteRollbackResult.rollbackCompleted, false);
  assert.equal(incompleteRollbackResult.keepMutationJournal, true);
  assert.match(context.formatResult_(incompleteRollbackResult),
    /Stato importazione: rollback incompleto; verifica manuale necessaria/);
}

function testPreExtractionErrorReportKeepsDataUnavailable() {
  const file = {
    getId: () => 'file-id',
    getName: () => 'invoice.pdf',
    getSize: () => 10,
    getUrl: () => 'https://drive.test/file-id'
  };
  const context = loadCataloger({ Logger: { log: () => {} } });
  vm.runInContext(
    fs.readFileSync(path.join(projectRoot, 'locales/en.gs'), 'utf8'),
    context,
    { filename: 'locales/en.gs' }
  );
  context.getLocalization_ = () => context.getEnglishLocalization_();
  context.sha256ForFile_ = () => {
    throw new Error('Gemini network error');
  };
  context.attachMutationJournal_ = (result) => result;

  const result = context.processIntakeFile_(file, {}, 'policy');
  const report = context.formatResult_(result);

  assert.equal(result.status, 'ERROR');
  assert.deepEqual(JSON.parse(JSON.stringify(result.extracted)), {});
  assert.equal(result.extractionValidated, false);
  assert.equal(result.failureStage, 'extracting-document-data');
  assert.match(report, /Gemini extracted data: not available/);
  assert.match(report, /Reconciliation check: not applicable/);
}

function testGenericRateLimitStaysOnDeveloperApi() {
  const requests = [];
  const responses = [
    {
      getResponseCode: () => 429,
      getContentText: () => JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'Requests per minute limit exceeded. Retry in 1 second. ' +
            'Learn more at https://ai.google.dev/gemini-api/docs/billing#prepay.'
        }
      })
    },
    {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: '{}' }] }
        }]
      })
    }
  ];
  const context = loadCataloger({
    UrlFetchApp: {
      fetch: (url) => {
        requests.push(url);
        return responses.shift();
      }
    }
  });
  context.getGeminiModel_ = () => 'gemini-2.5-flash';
  context.getScriptProperty_ = () => 'developer-secret';
  context.isAutomaticVertexFallbackEnabled_ = () => true;
  context.buildExtractionPrompt_ = () => 'prompt';
  context.logCatalogEvent_ = () => {};
  context.logGeminiUsage_ = () => {};

  context.callGeminiForPdfWithBackend_(
    { getBytes: () => [1, 2, 3] },
    {},
    'policy',
    { getId: () => 'file-id' },
    'gemini_api',
    ''
  );

  assert.equal(requests.length, 2);
  assert.equal(
    requests.every((url) => url.includes('generativelanguage.googleapis.com')),
    true
  );
}

function testVertexRateLimitRetriesWithoutReclassifyingProviderQuota() {
  const requests = [];
  const responses = [
    {
      getResponseCode: () => 429,
      getContentText: () => JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'GenerateRequestsPerDay quota exceeded temporarily.'
        }
      })
    },
    {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: '{}' }] }
        }]
      })
    }
  ];
  const context = loadCataloger({
    UrlFetchApp: {
      fetch: (url) => {
        requests.push(url);
        return responses.shift();
      }
    }
  });
  context.getGeminiModel_ = () => 'gemini-2.5-flash';
  context.getVertexAiLocation_ = () => 'global';
  context.getScriptProperty_ = () => 'cataloger-project';
  context.buildExtractionPrompt_ = () => 'prompt';
  context.logCatalogEvent_ = () => {};
  context.logGeminiUsage_ = () => {};

  context.callGeminiForPdfWithBackend_(
    { getBytes: () => [1, 2, 3] },
    {},
    'policy',
    { getId: () => 'file-id' },
    'vertex_ai',
    'gemini-api-daily-quota-exhausted'
  );

  assert.equal(requests.length, 2);
  assert.equal(
    requests.every((url) => url.includes('aiplatform.googleapis.com')),
    true
  );
}

function testStructuredFileLogsContainOnlyOpaqueId() {
  const logPayloads = [];
  const context = loadCataloger({
    Logger: {
      log: (payload) => logPayloads.push(payload)
    }
  });
  const details = context.describeFileForLog_({
    getId: () => 'opaque-file-id',
    getName: () => 'private-invoice-name.pdf'
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(details)),
    { fileId: 'opaque-file-id' }
  );
  assert.equal(
    context.classifyCatalogErrorForLog_(
      new Error('Spreadsheet row contained private values')
    ),
    'spreadsheet'
  );
  context.logCatalogEvent_('test-event', details);
  assert.equal(
    logPayloads[0].applicationVersion,
    context.getApplicationVersion()
  );
}

function testReportFieldsCannotInjectExtraLines() {
  const context = loadCataloger();

  assert.equal(
    context.oneLineReportText_(
      'invoice.pdf\nSTATUS: IMPORTED\r\nIssue: fake'
    ),
    'invoice.pdf STATUS: IMPORTED Issue: fake'
  );
}

function testPromptKeepsHeadersScopedBySupply() {
  const context = loadCataloger();
  context.getLocalization_ = () => ({ promptLanguage: 'English' });
  context.getAutomationConfig_ = () => ({
    address_rules: [],
    address_missing_type: 'import',
    frequency_overrides: [],
    canonical_suppliers: ['SUPPLIER'],
    canonical_supplies: ['Water', 'Gas'],
    supply_aliases: {},
    supplier_aliases: {}
  });
  const prompt = context.buildExtractionPrompt_({
    Water: ['Issue date', 'Cubic metres'],
    Gas: ['Issue date', 'Standard cubic metres']
  }, 'trusted policy');

  assert.match(prompt, /matching canonical supply entry/);
  assert.match(prompt, /"contract_number": "printed contract number or null"/);
  assert.match(prompt,
    /"customer_code": "printed customer\/client\/account code \(ID UTENTE is a customer code\), or null"/);
  assert.match(prompt, /Never substitute one for the other/);
  assert.match(prompt, /one of contract_number or customer_code is sufficient/);
  assert.match(prompt, /Preserve every character and leading zero/);
  assert.match(prompt, /two-character text value in the exact format mm/);
  assert.match(prompt, /Do not add a problem merely to note that line items include VAT/);
  assert.match(prompt, /For every non-formula header exposed by the matching target sheet/);
  assert.match(prompt,
    /If an optional field is genuinely not printed or not applicable, omit it from sheet_values without adding a problem/);
  assert.match(prompt,
    /If an applicable field is unreadable or ambiguous, omit it and add a concise problem explaining why/);
  assert.doesNotMatch(prompt,
    /If a field is genuinely not printed or not applicable, leave it absent and add a concise problem/);
  assert.match(prompt, /recurring Iliad Internet charges/);
  assert.match(prompt, /localized supplier field defaults/);
  assert.match(prompt, /numeric value 0/);
  assert.match(prompt, /documented invoice\/report structure as corroborating classification evidence/);
  assert.match(prompt, /"Water":\["Issue date","Cubic metres"\]/);
  assert.match(prompt, /"Gas":\["Issue date","Standard cubic metres"\]/);
}

function testHeadersAreCollectedPerSupply() {
  const context = loadCataloger();
  const sheets = {
    Water: {
      name: 'Water',
      headers: ['Issue date', 'Cubic metres'],
      getLastRow: () => 1
    },
    Gas: {
      name: 'Gas',
      headers: ['Issue date', 'Standard cubic metres'],
      getLastRow: () => 1
    }
  };
  context.getAutomationConfig_ = () => ({
    canonical_supplies: ['Water', 'Gas'],
    sheet_by_supply: { Water: 'Water', Gas: 'Gas' }
  });
  context.getSpreadsheetId_ = () => 'spreadsheet-id';
  context.SpreadsheetApp.openById = () => ({
    getSheetByName: (name) => sheets[name]
  });
  context.getSheetLayout_ = (sheet) => ({
    headerRow: 1,
    headers: sheet.headers,
    lookup: {}
  });

  assert.equal(
    JSON.stringify(context.getSheetHeadersBySupply_()),
    JSON.stringify({
      Water: ['Issue date', 'Cubic metres'],
      Gas: ['Issue date', 'Standard cubic metres']
    })
  );
}

function testDuplicateNormalizedSheetHeadersAreRejected() {
  const context = loadCataloger();
  context.getHeaderAliases_ = (key) => ({
    issueDate: ['Issue date'],
    supplier: ['Supplier']
  })[key] || [];
  const sheet = {
    getLastColumn: () => 3,
    getLastRow: () => 1,
    getName: () => 'Water',
    getRange: () => ({
      getDisplayValues: () => [[
        'Issue date',
        'Supplier',
        'Supplier!'
      ]]
    })
  };

  assert.throws(
    () => context.getSheetLayout_(sheet),
    /Duplicate normalized spreadsheet headers/
  );
}

function testSheetLayoutAcceptsPendingLocaleAliases() {
  const context = loadCataloger();
  context.getHeaderAliases_ = () => {
    throw new Error('persisted automation configuration is unavailable');
  };
  const sheet = {
    getLastColumn: () => 2,
    getLastRow: () => 1,
    getName: () => 'Luce',
    getRange: () => ({
      getDisplayValues: () => [[
        'Data di emissione',
        'Fornitore'
      ]]
    })
  };

  const layout = context.getSheetLayout_(sheet, {
    issueDate: ['data di emissione'],
    supplier: ['fornitore']
  });

  assert.equal(layout.headerRow, 1);
  assert.equal(layout.lookup['data di emissione'], 1);
  assert.equal(layout.lookup.fornitore, 2);
}

function testMutationRecoveryStages() {
  function scenario(journal, markedRows) {
    const deletedRows = [];
    const refreshedRows = [];
    const dashboardRefreshes = [];
    const context = loadCataloger();
    const file = { getId: () => 'source-file-id' };
    const sheet = {
      getLastRow: () => 4,
      getRange: (row) => ({ marked: markedRows.includes(row) }),
      deleteRow: (row) => deletedRows.push(row)
    };
    context.SpreadsheetApp.openById = () => ({
      getSheetByName: () => sheet
    });
    context.getSpreadsheetId_ = () => 'spreadsheet-id';
    context.getSheetLayout_ = () => ({
      headerRow: 1,
      headers: ['Source file'],
      lookup: { 'source file': 1 }
    });
    context.getHeaderAliases_ = () => ['Source file'];
    context.findHeaderIndex_ = () => 1;
    context.getFileFromSourceCell_ = (cell) => cell.marked ? file : null;
    context.refreshImportedSourceLink_ = (_sheet, row) => {
      refreshedRows.push(row);
    };
    context.refreshElectricityDashboardAfterRollback_ = (state) => {
      dashboardRefreshes.push(state.sheet);
    };
    context.updateMutationJournal_ = () => {};
    return {
      deletedRows,
      refreshedRows,
      dashboardRefreshes,
      result: () => context.rollbackJournalSheetRow_(journal, file)
    };
  }

  const beforeMarker = scenario({
    stage: 'sheet-insert-planned',
    sheetName: 'Water',
    sheetRow: 2,
    sheetRowCreated: false,
    sheetRowPreexisting: false
  }, []);
  assert.equal(beforeMarker.result().unmarkedRowMayRemain, true);
  assert.deepEqual(beforeMarker.deletedRows, []);

  const markerWrittenBeforeJournal = scenario({
    stage: 'sheet-insert-planned',
    sheetName: 'Water',
    sheetRow: 2,
    sheetRowCreated: false,
    sheetRowPreexisting: false
  }, [2]);
  assert.equal(markerWrittenBeforeJournal.result().unmarkedRowMayRemain, false);
  assert.deepEqual(markerWrittenBeforeJournal.deletedRows, [2]);
  assert.equal(markerWrittenBeforeJournal.dashboardRefreshes.length, 1);

  const markerLostAfterJournal = scenario({
    stage: 'sheet-marker-written',
    sheetName: 'Water',
    sheetRow: 2,
    sheetRowCreated: true
  }, []);
  assert.throws(markerLostAfterJournal.result, /source marker is missing/);

  const deletedRowAwaitingDashboardRefresh = scenario({
    stage: 'sheet-row-rolled-back',
    sheetName: 'Water',
    sheetRow: 2,
    sheetRowCreated: false,
    sheetRowPreexisting: false,
    sheetRowDeleted: true
  }, []);
  assert.equal(deletedRowAwaitingDashboardRefresh.result().unmarkedRowMayRemain,
    false);
  assert.equal(deletedRowAwaitingDashboardRefresh.dashboardRefreshes.length, 1);

  const existingRow = scenario({
    stage: 'sheet-existing',
    sheetName: 'Water',
    sheetRow: 2,
    sheetRowCreated: false,
    sheetRowPreexisting: true
  }, [2]);
  assert.equal(existingRow.result().unmarkedRowMayRemain, false);
  assert.deepEqual(existingRow.deletedRows, []);
  assert.deepEqual(existingRow.refreshedRows, [2]);

  const restoredRows = [];
  const payloadFile = { getId: () => 'source-file-id' };
  const payloadContext = loadCataloger();
  payloadContext.SpreadsheetApp.openById = () => ({
    getSheetByName: () => ({
      getLastRow: () => 3,
      getRange: (row) => ({ row })
    })
  });
  payloadContext.getSpreadsheetId_ = () => 'spreadsheet-id';
  payloadContext.getSheetLayout_ = () => ({
    headerRow: 1,
    headers: ['Source file'],
    lookup: { 'source file': 1 }
  });
  payloadContext.getHeaderAliases_ = () => ['Source file'];
  payloadContext.findHeaderIndex_ = () => 1;
  payloadContext.getFileFromSourceCell_ = (cell) => cell.row === 3 ? payloadFile : null;
  payloadContext.restoreImportedRowPayload_ = (_sheet, row, originalRow, payload) => {
    restoredRows.push([row, originalRow, payload]);
  };
  const recoveredDashboardSheets = [];
  const rollbackLayouts = { monthlyF1: { sourceRanges: ['F1:Z13'] } };
  payloadContext.refreshElectricityDashboardAfterRollback_ = (state) => {
    recoveredDashboardSheets.push(state.sheet);
    assert.equal(JSON.stringify(state.electricityDashboardLayouts),
      JSON.stringify(rollbackLayouts));
  };
  assert.equal(payloadContext.rollbackJournalSheetRow_({
    stage: 'sheet-existing-written',
    sheetName: 'Water',
    sheetRow: 3,
    sheetOriginalRow: 2,
    sheetRowCreated: false,
    sheetRowPreexisting: true,
    sheetRowPayload: { cells: [] },
    electricityDashboardLayouts: rollbackLayouts
  }, payloadFile).unmarkedRowMayRemain, false);
  assert.deepEqual(restoredRows, [[3, 2, { cells: [] }]]);
  assert.equal(recoveredDashboardSheets.length, 1);

  const existingRowAfterRename = scenario({
    stage: 'renamed',
    sheetName: 'Water',
    sheetRow: 2,
    sheetRowCreated: false,
    sheetRowPreexisting: true
  }, [3]);
  assert.equal(existingRowAfterRename.result().unmarkedRowMayRemain, false);
  assert.deepEqual(existingRowAfterRename.deletedRows, []);
  assert.deepEqual(existingRowAfterRename.refreshedRows, [3]);

  const legacyExistingRowAfterRename = scenario({
    stage: 'renamed',
    sheetName: 'Water',
    sheetRow: 2,
    sheetRowCreated: false
  }, [3]);
  assert.equal(
    legacyExistingRowAfterRename.result().unmarkedRowMayRemain,
    false
  );
  assert.deepEqual(legacyExistingRowAfterRename.deletedRows, []);
  assert.deepEqual(legacyExistingRowAfterRename.refreshedRows, [3]);
}

function testMutationRecoveryPersistsDeletedRowWithFallbackCheckpoint() {
  const fileId = 'source-file-id';
  const initialJournal = {
    stage: 'sheet-marker-written',
    sheetName: 'Water',
    sheetRow: 2,
    sheetRowCreated: true,
    sheetRowPreexisting: false
  };
  const store = {};
  let journalWriteAttempts = 0;
  const context = loadCataloger();
  const journalKey = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX',
    context
  ) + fileId;
  store[journalKey] = JSON.stringify(initialJournal);
  const properties = {
    getProperty: (key) => Object.prototype.hasOwnProperty.call(store, key) ?
      store[key] : null,
    setProperty: (key, value) => {
      journalWriteAttempts += 1;
      if (journalWriteAttempts === 1) {
        throw new Error('primary journal update failed');
      }
      store[key] = value;
    }
  };
  context.PropertiesService = {
    getScriptProperties: () => properties
  };
  const file = { getId: () => fileId };
  let markedRow = 2;
  const deletedRows = [];
  let dashboardRefreshes = 0;
  const sheet = {
    getLastRow: () => 4,
    getRange: (row) => ({ row }),
    deleteRow: (row) => {
      deletedRows.push(row);
      markedRow = 0;
    }
  };
  context.SpreadsheetApp.openById = () => ({
    getSheetByName: () => sheet
  });
  context.getSpreadsheetId_ = () => 'spreadsheet-id';
  context.getSheetLayout_ = () => ({
    headerRow: 1,
    headers: ['Source file'],
    lookup: { 'source file': 1 }
  });
  context.getHeaderAliases_ = () => ['Source file'];
  context.findHeaderIndex_ = () => 1;
  context.getFileFromSourceCell_ = (cell) =>
    cell.row === markedRow ? file : null;
  context.refreshElectricityDashboardAfterRollback_ = () => {
    dashboardRefreshes += 1;
  };

  assert.equal(
    context.rollbackJournalSheetRow_(initialJournal, file).unmarkedRowMayRemain,
    false
  );
  assert.deepEqual(deletedRows, [2]);
  assert.equal(journalWriteAttempts, 2);
  const fallbackJournal = JSON.parse(store[journalKey]);
  assert.equal(fallbackJournal.stage, 'sheet-row-rolled-back');
  assert.equal(fallbackJournal.sheetRowCreated, false);
  assert.equal(fallbackJournal.sheetRowDeleted, true);
  assert.equal(fallbackJournal.sheetName, 'Water');
  assert.equal(fallbackJournal.sheetRow, 2);
  assert.equal(typeof fallbackJournal.updatedAt, 'number');

  assert.equal(
    context.rollbackJournalSheetRow_(fallbackJournal, file).unmarkedRowMayRemain,
    false
  );
  assert.deepEqual(deletedRows, [2]);
  assert.equal(journalWriteAttempts, 2);
  assert.equal(dashboardRefreshes, 2);
}

function testMutationRecoveryReportsUnavailableFileOnce() {
  const context = loadCataloger();
  const journalPrefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX',
    context
  );
  const alertPrefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_RECOVERY_ALERT_PREFIX',
    context
  );
  const fileId = 'unavailable-file-id';
  const store = {
    [`${journalPrefix}${fileId}`]: JSON.stringify({
      originalName: 'unavailable.pdf',
      stage: 'moved'
    })
  };
  const queuedResults = [];
  const properties = {
    getProperties: () => ({ ...store }),
    getProperty: (key) => store[key] || '',
    setProperty: (key, value) => {
      store[key] = value;
    }
  };
  context.PropertiesService = {
    getScriptProperties: () => properties
  };
  context.DriveApp = {
    getFileById: () => {
      throw new Error('Drive file is unavailable');
    }
  };
  context.queuePendingReports_ = (results) => {
    queuedResults.push(...results);
  };
  context.logCatalogEvent_ = () => {};

  const firstResults = context.recoverPendingMutations_({});
  const secondResults = context.recoverPendingMutations_({});

  assert.equal(firstResults.length, 1);
  assert.equal(firstResults[0].status, 'ERROR');
  assert.equal(firstResults[0].rollbackCompleted, false);
  assert.match(firstResults[0].problem, /Drive file is unavailable/);
  assert.equal(queuedResults.length, 1);
  assert.equal(secondResults.length, 0);
  assert.ok(store[`${alertPrefix}${fileId}`]);
  assert.ok(store[`${journalPrefix}${fileId}`]);
}

function testRuntimeExhaustionPersistsOperatorLinks() {
  const persisted = [];
  const linked = [];
  const context = loadCataloger();
  vm.runInContext(
    'let runtimeExhaustionClockReads = 0; ' +
      'Date.now = () => runtimeExhaustionClockReads++ === 0 ? 0 : 280000;',
    context
  );
  context.loadIntakeFileState_ = () => ({});
  context.loadTrustedExtractionPolicy_ = () => 'policy';
  context.shouldProcessIntakeFile_ = () => true;
  context.persistCatalogResult_ = (_state, _file, _root, result) => {
    persisted.push(result);
  };
  context.logCatalogEvent_ = () => {};
  context.logCatalogResult_ = () => {};
  context.addOperatorLinksToResult_ = (result) => {
    result.retryUrl = 'https://script.test/retry';
    result.supplierProfilesUrl = 'https://drive.test/profiles';
    linked.push(result);
    return result;
  };

  const file = {
    getId: () => 'timed-out-file',
    getName: () => 'invoice.pdf',
    getUrl: () => 'https://drive.test/timed-out-file'
  };
  const batch = context.processEligibleIntakeFiles_([file], {}, 'event');

  assert.equal(batch.results.length, 1);
  assert.equal(linked.length, 1);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].retryUrl, 'https://script.test/retry');
  assert.equal(persisted[0].supplierProfilesUrl, 'https://drive.test/profiles');
}

function testTargetMutationJournalRecoveryLeavesUnrelatedJournalUntouched() {
  const context = loadCataloger();
  const journalPrefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX',
    context
  );
  const targetKey = `${journalPrefix}target-file`;
  const unrelatedKey = `${journalPrefix}unrelated-file`;
  const store = {
    [targetKey]: JSON.stringify({
      originalName: 'original.pdf',
      stage: 'renamed'
    }),
    [unrelatedKey]: JSON.stringify({
      originalName: 'unrelated.pdf',
      stage: 'moved'
    })
  };
  const calls = [];
  let currentName = 'renamed.pdf';
  const file = {
    getName: () => currentName,
    moveTo: () => calls.push('move'),
    setName: (name) => {
      currentName = name;
      calls.push('rename:' + name);
    }
  };
  const properties = {
    getProperty: (key) => store[key] || '',
    deleteProperty: (key) => {
      delete store[key];
      calls.push('delete:' + key);
    },
    setProperty: (key, value) => {
      store[key] = value;
    }
  };
  context.PropertiesService = {
    getScriptProperties: () => properties
  };
  context.DriveApp = {
    getFileById: (fileId) => {
      assert.equal(fileId, 'target-file');
      return file;
    }
  };
  context.isFileInFolder_ = () => false;
  context.rollbackJournalSheetRow_ = () => ({ unmarkedRowMayRemain: false });
  context.buildErrorResult_ = () => ({ status: 'ERROR', actions: '' });
  context.loadIntakeFileState_ = () => ({});
  context.recordIntakeFileOutcome_ = () => calls.push('record-outcome');
  context.queuePendingReports_ = () => calls.push('queue-report');
  context.saveIntakeFileState_ = () => calls.push('save-state');
  context.logCatalogEvent_ = () => calls.push('log-recovered');

  const result = context.recoverMutationJournalForFile_(
    {}, 'target-file'
  );

  assert.equal(result.status, 'ERROR');
  assert.equal(currentName, 'original.pdf');
  assert.equal(store[targetKey], undefined);
  assert.ok(store[unrelatedKey]);
  assert.ok(calls.includes('move'));
  assert.ok(calls.includes('record-outcome'));
  assert.ok(calls.includes('queue-report'));
  assert.ok(calls.includes('save-state'));
  assert.ok(calls.includes('log-recovered'));
}

function testAccessibleRecoveryFailureRequiresManualReview() {
  const context = loadCataloger();
  const journalPrefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX', context
  );
  const alertPrefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_RECOVERY_ALERT_PREFIX', context
  );
  const fileId = 'recoverable-file-id';
  const store = {
    [`${journalPrefix}${fileId}`]: JSON.stringify({
      originalName: 'original.pdf',
      stage: 'sheet-written'
    })
  };
  const file = {
    getId: () => fileId,
    getName: () => 'original.pdf',
    getUrl: () => 'https://drive.test/recoverable-file-id'
  };
  const properties = {
    getProperty: (key) => store[key] || '',
    setProperty: (key, value) => {
      store[key] = value;
    }
  };
  context.PropertiesService = { getScriptProperties: () => properties };
  context.DriveApp = { getFileById: () => file };
  context.isFileInFolder_ = () => true;
  context.rollbackJournalSheetRow_ = () => {
    throw new Error('source marker is missing');
  };
  context.recordIntakeFileOutcome_ = () => {};
  context.queuePendingReports_ = () => {};
  context.saveIntakeFileState_ = () => {};
  context.logCatalogEvent_ = () => {};

  const result = context.recoverMutationJournalForFile_(
    {}, fileId, store[`${journalPrefix}${fileId}`], {}, properties
  );

  assert.equal(result.status, 'ERROR');
  assert.equal(result.rollbackCompleted, false);
  assert.match(result.actions, /spreadsheet row may remain/);
  assert.ok(store[`${alertPrefix}${fileId}`]);
}

function testFormulaAndStyleCopySources() {
  const calls = [];
  const context = loadCataloger();
  const sheet = {
    getLastRow: () => 6,
    getRange: (row, column, _rows, width) => ({
      copyTo: (_target, pasteType) => calls.push([row, pasteType]),
      getFormulas: () => [['', '=A1', '']],
      clearContent: () => calls.push([row, column, width, 'clear'])
    })
  };
  const layout = { headerRow: 1, headers: ['A', 'B'] };

  context.copyRowStyleAndFormulas_(sheet, 4, layout);
  context.copyRowStyleAndFormulas_(sheet, 2, layout);

  assert.deepEqual(calls, [
    [3, 'format'],
    [3, 'formula'],
    [4, 1, 1, 'clear'],
    [4, 3, 1, 'clear'],
    [3, 'format'],
    [3, 'formula'],
    [2, 1, 1, 'clear'],
    [2, 3, 1, 'clear']
  ]);
}

function testExistingFormulaCellsAreNotOverwrittenDuringReimport() {
  const writes = [];
  const context = loadCataloger();
  context.getHeaderAliases_ = (key) => ({
    issueDate: ['Issue date'],
    supplier: ['Supplier'],
    identifier: ['Invoice number'],
    contractNumber: ['Contract number'],
    customerCode: ['Customer code'],
    year: ['Reference year'],
    month: ['Reference month'],
    frequency: ['Frequency'],
    consumptionCost: ['Total consumption costs'],
    nonConsumptionCosts: ['Total non-consumption costs'],
    vat: ['VAT'],
    total: ['Total cost'],
    sourceFile: ['Source file']
  })[key] || [];
  context.buildDrivePathLabel_ = () => 'invoice.pdf';
  const layout = {
    headerRow: 1,
    headers: ['Issue date', 'Supplier', 'Source file', 'Calculated value'],
    lookup: {
      'issue date': 1,
      supplier: 2,
      'source file': 3,
      'calculated value': 4
    }
  };
  const sheet = {
    getLastRow: () => 3,
    getParent: () => ({ getSpreadsheetLocale: () => 'en_US' }),
    getRange: (row, column, _rows, width) => {
      if (column === 1 && width === 4) {
        return { getFormulas: () => [[
          '', '=UPPER("supplier")', '=HYPERLINK("url","text")', '=A3*2'
        ]] };
      }
      return {
        setFormula: (value) => writes.push([row, column, 'formula', value]),
        setRichTextValue: (value) => writes.push([row, column, 'rich', value]),
        setValue: (value) => writes.push([row, column, 'value', value])
      };
    }
  };

  context.writeInvoiceRow_(sheet, 3, layout,
    { getUrl: () => 'https://drive.test/file' }, validInvoice());

  assert.equal(writes.some((entry) => entry[1] === 2), false);
  assert.equal(writes.some((entry) => entry[1] === 4), false);
  assert.equal(writes.some((entry) => entry[1] === 1), true);
  assert.equal(writes.some((entry) => entry[1] === 3 && entry[2] === 'formula'),
    true);
}

function testDetailedCostSheetValuesOverrideBroadReconciliationValues() {
  const writes = [];
  const context = loadCataloger();
  context.getHeaderAliases_ = (key) => ({
    issueDate: ['Issue date'],
    supplier: ['Supplier'],
    identifier: ['Invoice number'],
    contractNumber: ['Contract number'],
    customerCode: ['Customer code'],
    year: ['Reference year'],
    month: ['Reference month'],
    frequency: ['Frequency'],
    consumptionCost: ['Total consumption costs'],
    nonConsumptionCosts: ['Total non-consumption costs'],
    vat: ['VAT'],
    total: ['Total cost'],
    sourceFile: ['Source file']
  })[key] || [];
  context.buildDrivePathLabel_ = () => 'invoice.pdf';
  const layout = {
    headerRow: 1,
    headers: [
      'Total consumption costs', 'Collection charges', 'Discounts',
      'Wi-Fi extender', 'Total non-consumption costs', 'VAT', 'Total cost',
      'Source file'
    ],
    lookup: {
      'total consumption costs': 1,
      'collection charges': 2,
      discounts: 3,
      'wi fi extender': 4,
      'total non-consumption costs': 5,
      vat: 6,
      'total cost': 7,
      'source file': 8
    }
  };
  const formulas = ['', '', '', '', '=B3+C3+D3', '', '=A3+E3+F3', ''];
  const sheet = {
    getLastRow: () => 3,
    getParent: () => ({ getSpreadsheetLocale: () => 'en_US' }),
    getRange: (row, column, _rows, width) => {
      if (column === 1 && width === 8) {
        return { getFormulas: () => [formulas] };
      }
      return {
        setFormula: (value) => writes.push([row, column, 'formula', value]),
        setRichTextValue: (value) => writes.push([row, column, 'rich', value]),
        setValue: (value) => writes.push([row, column, 'value', value])
      };
    }
  };
  const extracted = {
    ...validInvoice(),
    cost_consumption: 0,
    cost_non_consumption: 21.29,
    vat: 4.68,
    total: 25.97,
    sheet_values: [
      { header: 'Total consumption costs', value: 25.99 },
      { header: 'Collection charges', value: 0 },
      { header: 'Discounts', value: -4 },
      { header: 'Wi-Fi extender', value: 3.98 },
      { header: 'VAT', value: 0 }
    ]
  };

  context.writeInvoiceRow_(sheet, 3, layout,
    { getUrl: () => 'https://drive.test/file' }, extracted);

  assert.deepEqual(writes.filter((entry) => entry[2] === 'value').sort(
    (left, right) => left[1] - right[1]
  ), [
    [3, 1, 'value', 25.99],
    [3, 2, 'value', 0],
    [3, 3, 'value', -4],
    [3, 4, 'value', 3.98],
    [3, 6, 'value', 0]
  ]);

  const actualValues = [25.99, 0, -4, 3.98, -0.02, 0, 25.97, 'invoice'];
  const verificationSheet = {
    getLastRow: () => 3,
    getRange: (_row, column, _rows, width) => {
      if (column === 1 && width === 8) {
        return { getFormulas: () => [formulas] };
      }
      return {
        getValue: () => actualValues[column - 1],
        getRichTextValue: () => null,
        getFormula: () => column === 8 ?
          '=HYPERLINK("https://drive.test/file";"invoice")' : formulas[column - 1],
        getDisplayValue: () => 'invoice'
      };
    }
  };
  assert.doesNotThrow(() => context.verifyImportedRow_(verificationSheet, 3,
    layout, { getUrl: () => 'https://drive.test/file' }, extracted));
}

function testSupplementarySheetValuesCannotOverrideLiteralCanonicalFields() {
  const writes = [];
  const context = loadCataloger();
  context.getHeaderAliases_ = (key) => ({
    identifier: ['Invoice number'],
    contractNumber: ['Contract number'],
    customerCode: ['Customer code'],
    month: ['Reference month'],
    sourceFile: ['Source file']
  })[key] || [];
  context.buildDrivePathLabel_ = () => 'invoice.pdf';
  const layout = {
    headerRow: 1,
    headers: ['Invoice number', 'Contract number', 'Customer code',
      'Reference month', 'Source file'],
    lookup: {
      'invoice number': 1,
      'contract number': 2,
      'customer code': 3,
      'reference month': 4,
      'source file': 5
    }
  };
  const sheet = {
    getLastRow: () => 3,
    getParent: () => ({ getSpreadsheetLocale: () => 'en_US' }),
    getRange: (row, column, _rows, width) => {
      if (column === 1 && width === 5) {
        return { getFormulas: () => [['', '', '', '', '']] };
      }
      return {
        setFormula: (value) => writes.push([row, column, 'formula', value]),
        setRichTextValue: (value) => writes.push([row, column, 'rich', value]),
        setValue: (value) => writes.push([row, column, 'value', value])
      };
    }
  };
  const extracted = {
    ...validInvoice(),
    identifier: 'INV-01',
    contract_number: 'CON-01',
    customer_code: '00053009296',
    reference_month: '09',
    sheet_values: [
      { header: 'Customer code', value: 53009296 },
      { header: 'Reference month', value: 9 }
    ]
  };

  context.writeInvoiceRow_(sheet, 3, layout,
    { getUrl: () => 'https://drive.test/file' }, extracted);

  assert.deepEqual(writes.filter((entry) => entry[2] === 'rich').map(
    (entry) => [entry[1], entry[3].text]
  ).slice(-4), [[1, 'INV-01'], [2, 'CON-01'], [3, '00053009296'], [4, '09']]);
  assert.equal(writes.some((entry) => entry[2] === 'value' && entry[1] <= 4),
    false);
}

function testMissingRowFormulaDoesNotUnprotectTemplateColumn() {
  const writes = [];
  const context = loadCataloger();
  context.getHeaderAliases_ = (key) => ({
    total: ['Total cost'],
    sourceFile: ['Source file']
  })[key] || [];
  context.buildDrivePathLabel_ = () => 'invoice.pdf';
  const layout = {
    headerRow: 1,
    headers: ['Total cost', 'Source file'],
    lookup: { 'total cost': 1, 'source file': 2 }
  };
  const sheet = {
    getLastRow: () => 3,
    getParent: () => ({ getSpreadsheetLocale: () => 'en_US' }),
    getRange: (row, column, _rows, width) => {
      if (column === 1 && width === 2) {
        return { getFormulas: () => [row === 3 ? ['', ''] : ['=A2*2', '']] };
      }
      return {
        setFormula: (value) => writes.push([row, column, 'formula', value]),
        setRichTextValue: (value) => writes.push([row, column, 'rich', value]),
        setValue: (value) => writes.push([row, column, 'value', value])
      };
    }
  };

  context.writeInvoiceRow_(sheet, 3, layout,
    { getUrl: () => 'https://drive.test/file' }, validInvoice());

  assert.equal(writes.some((entry) => entry[1] === 1), false);
  assert.equal(writes.some((entry) => entry[1] === 2 && entry[2] === 'formula'),
    true);
}

function testSourceHyperlinkFormulaIsPreserved() {
  const context = loadCataloger();
  context.getHeaderAliases_ = (key) => key === 'sourceFile' ? ['Source file'] : [];
  const sheet = {
    getRange: (row) => ({
      getFormulas: () => [['=HYPERLINK("url";"text")']],
      getFormula: () => '=HYPERLINK("https://drive.test/file-id";"text")',
      getDisplayValue: () => 'text',
      getRichTextValue: () => null
    })
  };

  const extracted = validInvoice();
  extracted.sheet_values = [];

  context.verifyImportedRow_(
    sheet,
    3,
    { headerRow: 1, headers: ['Source file'], lookup: { 'source file': 1 } },
    { getUrl: () => 'https://drive.test/file-id' },
    extracted
  );
}

function testExistingInvoicePayloadRestoresAndRepositions() {
  const context = loadCataloger();
  const layout = { headers: ['Date', 'Source', 'Total', 'Notes'], lookup: {} };
  const originalDate = new Date('2026-04-09T00:00:00Z');
  const writes = [];
  const moves = [];
  const sourceRow = { row: 9, column: 1, numRows: 1, numColumns: 4 };
  const sheet = {
    getRange: (row, column, numRows, numColumns) => {
      if (numRows && numColumns) {
        if (row === 9) {
          return {
            ...sourceRow,
            getValues: () => [[originalDate, 'ignored', 14.64, '=untrusted']],
            getFormulas: () => [['', '=HYPERLINK("url";"invoice")', '', '']]
          };
        }
        return { row, column, numRows, numColumns };
      }
      return {
        setFormula: (value) => writes.push(['formula', row, column, value]),
        setValue: (value) => writes.push(['value', row, column, value]),
        setRichTextValue: (value) => writes.push(['rich', row, column, value])
      };
    },
    moveRows: (range, destination) => moves.push([range, destination])
  };
  const payload = context.captureImportedRowPayload_(sheet, 9, layout);
  let findCalls = 0;
  context.findSpreadsheetRowBySourceFile_ = () => {
    findCalls += 1;
    return findCalls === 1 ? 9 : 4;
  };
  context.restoreImportedRowPayload_(sheet, 9, 4, payload,
    { getId: () => 'file-id' }, layout);
  assert.equal(moves.length, 1);
  assert.equal(moves[0][1], 4);
  assert.equal(writes[0][0], 'value');
  assert.equal(Object.prototype.toString.call(writes[0][3]), '[object Date]');
  assert.deepEqual(writes[1], ['formula', 4, 2, '=HYPERLINK("url";"invoice")']);
  assert.deepEqual(writes[2], ['value', 4, 3, 14.64]);
  assert.equal(writes[3][0], 'rich');
  assert.equal(writes[3][3].text, '=untrusted');

  context.getInsertionRow_ = () => 12;
  context.findSpreadsheetRowBySourceFile_ = () => 11;
  assert.equal(context.repositionImportedRow_(sheet, 9, layout,
    '2026-05-08', { getId: () => 'file-id' }), 11);
  assert.equal(moves[1][1], 12);
}

function testCorrectedInvoiceMovesImmediatelyBeforeNewerInvoice() {
  const context = loadCataloger();
  const moves = [];
  const dates = {
    2: '2026-05-15',
    3: '2026-03-01',
    4: '2026-04-01',
    5: '2026-06-01'
  };
  const sheet = {
    getLastRow: () => 5,
    getRange: (row, column, numRows, numColumns) => ({
      row,
      column,
      numRows,
      numColumns,
      getValue: () => dates[row]
    }),
    moveRows: (range, destination) => moves.push([range, destination])
  };
  const layout = {
    headerRow: 1,
    headers: ['Issue date', 'Source file'],
    lookup: { 'issue date': 1, 'source file': 2 }
  };
  context.getHeaderAliases_ = (key) =>
    key === 'issueDate' ? ['Issue date'] : [];
  context.findSpreadsheetRowBySourceFile_ = () => 4;

  assert.equal(context.repositionImportedRow_(sheet, 2, layout,
    '2026-05-15', { getId: () => 'file-id' }), 4);
  assert.equal(moves.length, 1);
  assert.equal(moves[0][1], 5);
}

function testCorrectedInvoiceAppendsWithoutBlankRow() {
  const context = loadCataloger();
  const moves = [];
  const dates = {
    2: '2026-07-01',
    3: '2026-03-01',
    4: '2026-04-01',
    5: '2026-06-01'
  };
  const sheet = {
    getLastRow: () => 5,
    getRange: (row, column, numRows, numColumns) => ({
      row,
      column,
      numRows,
      numColumns,
      getValue: () => dates[row]
    }),
    moveRows: (range, destination) => moves.push([range, destination])
  };
  const layout = {
    headerRow: 1,
    headers: ['Issue date', 'Source file'],
    lookup: { 'issue date': 1, 'source file': 2 }
  };
  context.getHeaderAliases_ = (key) =>
    key === 'issueDate' ? ['Issue date'] : [];
  context.findSpreadsheetRowBySourceFile_ = () => 5;

  assert.equal(context.repositionImportedRow_(sheet, 2, layout,
    '2026-07-01', { getId: () => 'file-id' }), 5);
  assert.equal(moves.length, 1);
  assert.equal(moves[0][1], 6);
}

function createInsertedInvoiceRollbackFixture(deleteRow) {
  const context = loadCataloger();
  const file = { getId: () => 'file-id' };
  const sheet = {
    getName: () => 'Water',
    getSheetId: () => 7,
    deleteRow: deleteRow
  };
  context.getAutomationConfig_ = () => ({
    sheet_by_supply: { Water: 'Water' }
  });
  context.getSpreadsheetId_ = () => 'spreadsheet-id';
  context.SpreadsheetApp.openById = () => ({
    getSheetByName: () => sheet,
    getUrl: () => 'https://sheets.test/spreadsheet-id'
  });
  context.getSheetLayout_ = () => ({
    headerRow: 1,
    headers: ['Issue date'],
    lookup: {}
  });
  context.captureElectricityDashboardLayoutsForRollback_ = () => null;
  context.findSpreadsheetRowBySourceFile_ = () => 0;
  context.getInsertionRow_ = () => 2;
  context.insertBlankRowAt_ = () => {};
  context.copyRowStyleAndFormulas_ = () => {};
  context.refreshImportedSourceLink_ = () => {};
  context.writeInvoiceRow_ = () => {};
  context.verifyImportedRow_ = () => {};
  context.refreshElectricityDashboardAfterInvoiceImport_ = () => {};
  context.refreshElectricityDashboardAfterRollback_ = () => {};
  const propertyStore = installScriptPropertyStore(context);
  const journalKey = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX',
    context
  ) + file.getId();
  return {
    context,
    file,
    journalKey,
    sheet,
    store: propertyStore.store
  };
}

function testInsertedInvoiceDeleteFailureBeforeMarkerPreservesJournalState() {
  const fixture = createInsertedInvoiceRollbackFixture(() => {
    throw new Error('row deletion failed');
  });
  fixture.context.copyRowStyleAndFormulas_ = () => {
    throw new Error('style copy failed');
  };

  assert.throws(
    () => fixture.context.importUtilityInvoiceToSheet_(
      fixture.file, validInvoice()
    ),
    /style copy failed.*row deletion failed/
  );
  const journal = JSON.parse(fixture.store[fixture.journalKey]);
  assert.equal(journal.stage, 'sheet-insert-planned');
  assert.equal(journal.sheetRowCreated, false);
  assert.equal(journal.sheetRowDeleted, undefined);
}

function testInsertedInvoiceDeleteFailureAfterMarkerPreservesJournalState() {
  const fixture = createInsertedInvoiceRollbackFixture(() => {
    throw new Error('row deletion failed');
  });
  fixture.context.writeInvoiceRow_ = () => {
    throw new Error('invoice write failed');
  };

  assert.throws(
    () => fixture.context.importUtilityInvoiceToSheet_(
      fixture.file, validInvoice()
    ),
    /invoice write failed.*row deletion failed/
  );
  const journal = JSON.parse(fixture.store[fixture.journalKey]);
  assert.equal(journal.stage, 'sheet-marker-written');
  assert.equal(journal.sheetRowCreated, true);
  assert.equal(journal.sheetRowDeleted, undefined);
}

function testInsertedInvoiceRollsBackWhenDashboardRefreshFails() {
  const context = loadCataloger();
  const deletedRows = [];
  const sheet = {
    getName: () => 'Electricity',
    getSheetId: () => 7,
    deleteRow: (row) => deletedRows.push(row)
  };
  const layout = { headerRow: 1, headers: ['Issue date'], lookup: {} };
  context.getAutomationConfig_ = () => ({
    sheet_by_supply: { Electricity: 'Electricity' }
  });
  context.getSpreadsheetId_ = () => 'spreadsheet-id';
  context.SpreadsheetApp.openById = () => ({
    getSheetByName: () => sheet,
    getUrl: () => 'https://sheets.test/spreadsheet-id'
  });
  context.getSheetLayout_ = () => layout;
  context.captureElectricityDashboardLayoutsForRollback_ = () => ({
    monthlyF1: { sourceRanges: ['F1:Z13'] }
  });
  context.findSpreadsheetRowBySourceFile_ = () => 0;
  context.getInsertionRow_ = () => 2;
  context.updateMutationJournal_ = () => {};
  context.insertBlankRowAt_ = () => {};
  context.copyRowStyleAndFormulas_ = () => {};
  context.refreshImportedSourceLink_ = () => {};
  context.writeInvoiceRow_ = () => {};
  context.verifyImportedRow_ = () => {};
  context.refreshElectricityDashboardAfterInvoiceImport_ = () => {
    throw new Error('dashboard refresh failed');
  };
  let rollbackRefreshes = 0;
  context.refreshElectricityDashboardAfterRollback_ = (state) => {
    assert.equal(state.sheet, sheet);
    assert.equal(JSON.stringify(state.electricityDashboardLayouts), JSON.stringify({
      monthlyF1: { sourceRanges: ['F1:Z13'] }
    }));
    rollbackRefreshes += 1;
  };
  assert.throws(() => context.importUtilityInvoiceToSheet_(
    { getId: () => 'file-id' }, validInvoice()
  ), /dashboard refresh failed/);
  assert.deepEqual(deletedRows, [2]);
  assert.equal(rollbackRefreshes, 1);
}

function testInsertedInvoiceRetainsDeletionCheckpointWhenDashboardRollbackFails() {
  const deletedRows = [];
  const fixture = createInsertedInvoiceRollbackFixture((row) => {
    deletedRows.push(row);
  });
  fixture.context.refreshElectricityDashboardAfterInvoiceImport_ = () => {
    throw new Error('dashboard refresh failed');
  };
  fixture.context.refreshElectricityDashboardAfterRollback_ = () => {
    throw new Error('dashboard rollback refresh failed');
  };

  assert.throws(
    () => fixture.context.importUtilityInvoiceToSheet_(
      fixture.file, validInvoice()
    ),
    /dashboard refresh failed.*dashboard rollback refresh failed/
  );
  assert.deepEqual(deletedRows, [2]);
  const journal = JSON.parse(fixture.store[fixture.journalKey]);
  assert.equal(journal.stage, 'sheet-row-rolled-back');
  assert.equal(journal.sheetRowCreated, false);
  assert.equal(journal.sheetRowDeleted, true);
}

function testDashboardRollbackForcesRegeneration() {
  const context = loadCataloger();
  const spreadsheet = {};
  let regenerated = 0;
  context.getAutomationConfig_ = () => ({
    locale: 'en',
    sheet_by_supply: { electricity: 'Electricity' }
  });
  context.getElectricitySupplySheetName_ = (config) =>
    config.sheet_by_supply.electricity;
  const preservedLayouts = { monthlyF1: { sourceRanges: ['F1:Z13'] } };
  context.initializeElectricityDashboard_ = (target, config, options) => {
    assert.equal(target, spreadsheet);
    assert.equal(config.locale, 'en');
    assert.equal(options.preservedLayouts, preservedLayouts);
    regenerated += 1;
  };
  context.refreshElectricityDashboardAfterRollback_({
    sheet: {
      getName: () => 'Electricity',
      getParent: () => spreadsheet
    },
    extracted: validInvoice(),
    electricityDashboardLayouts: preservedLayouts
  });
  assert.equal(regenerated, 1);

  context.refreshElectricityDashboardAfterRollback_({
    sheet: {
      getName: () => 'Water',
      getParent: () => spreadsheet
    }
  });
  assert.equal(regenerated, 1);
}

function testRowDeletionIsJournaledBeforeDashboardRollback() {
  const context = loadCataloger();
  const journalUpdates = [];
  const state = {
    moved: false,
    renamed: false,
    imported: true,
    sheetRowCreated: true,
    sheetRowPreexisting: false,
    sheetLink: 'https://sheets.test',
    sheet: {},
    sheetRow: 4
  };
  context.rollbackImportedRow_ = () => {};
  context.updateMutationJournal_ = (fileId, changes) => {
    journalUpdates.push([fileId, changes]);
  };
  context.refreshElectricityDashboardAfterRollback_ = () => {
    throw new Error('dashboard refresh failed');
  };

  context.rollbackProcessingMutations_({ getId: () => 'file-id' }, {}, 'invoice.pdf',
    state);

  assert.equal(state.sheetRowCreated, false);
  assert.equal(state.imported, false);
  assert.equal(JSON.stringify(journalUpdates), JSON.stringify([['file-id', {
    stage: 'sheet-row-rolled-back',
    sheetRowCreated: false,
    sheetRowDeleted: true
  }]]));
  assert.equal(state.rollbackErrors.length, 1);
}

function testOuterRollbackUsesFullJournalFallbackCheckpoint() {
  const context = loadCataloger();
  const file = { getId: () => 'file-id' };
  const journalKey = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX',
    context
  ) + file.getId();
  const initialJournal = {
    stage: 'moved',
    originalName: 'invoice.pdf',
    sheetName: 'Water',
    sheetRow: 4,
    sheetRowCreated: true,
    sheetRowPreexisting: false
  };
  const propertyStore = installScriptPropertyStore(context, {
    [journalKey]: JSON.stringify(initialJournal)
  });
  let deletionAttempts = 0;
  let primaryCheckpointAttempts = 0;
  let dashboardRefreshes = 0;
  context.rollbackImportedRow_ = () => {
    deletionAttempts += 1;
  };
  context.updateMutationJournal_ = () => {
    primaryCheckpointAttempts += 1;
    throw new Error('primary checkpoint failed');
  };
  context.refreshElectricityDashboardAfterRollback_ = () => {
    dashboardRefreshes += 1;
  };
  const state = {
    moved: false,
    renamed: false,
    imported: true,
    sheetRowCreated: true,
    sheetRowPreexisting: false,
    sheetLink: 'https://sheets.test',
    sheet: {},
    sheetRow: 4
  };

  context.rollbackProcessingMutations_(file, {}, 'invoice.pdf', state);

  assert.equal(deletionAttempts, 1);
  assert.equal(primaryCheckpointAttempts, 1);
  assert.equal(dashboardRefreshes, 1);
  assert.equal(state.imported, false);
  assert.equal(state.sheetRowCreated, false);
  assert.equal(state.sheetLink, '');
  assert.equal(state.rollbackErrors.length, 0);
  const journal = JSON.parse(propertyStore.store[journalKey]);
  assert.equal(journal.stage, 'sheet-row-rolled-back');
  assert.equal(journal.sheetRowCreated, false);
  assert.equal(journal.sheetRowDeleted, true);
  assert.equal(journal.originalName, 'invoice.pdf');
  assert.equal(journal.sheetName, 'Water');
  assert.equal(journal.sheetRow, 4);
  assert.equal(typeof journal.updatedAt, 'number');
}

function testOuterRollbackDoesNotCheckpointMissingRowLocation() {
  const context = loadCataloger();
  const file = { getId: () => 'file-id' };
  const journalKey = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX',
    context
  ) + file.getId();
  const initialJournal = {
    stage: 'sheet-marker-written',
    sheetName: 'Water',
    sheetRow: 4,
    sheetRowCreated: true
  };
  const propertyStore = installScriptPropertyStore(context, {
    [journalKey]: JSON.stringify(initialJournal)
  });
  let checkpointAttempts = 0;
  context.updateMutationJournal_ = () => {
    checkpointAttempts += 1;
  };
  context.rollbackProcessingMutations_(file, {}, 'invoice.pdf', {
    moved: false,
    renamed: false,
    imported: true,
    sheetRowCreated: true,
    sheetRowPreexisting: false,
    sheetLink: 'https://sheets.test',
    sheet: null,
    sheetRow: 0
  });

  assert.equal(checkpointAttempts, 0);
  const journal = JSON.parse(propertyStore.store[journalKey]);
  assert.equal(journal.stage, 'sheet-marker-written');
  assert.equal(journal.sheetRowCreated, true);
  assert.equal(journal.sheetRowDeleted, undefined);
}

function testMutationJournalPayloadUsesSeparateChunks() {
  const context = loadCataloger();
  const store = {};
  const properties = {
    getProperties: () => ({ ...store }),
    getProperty: (key) => Object.prototype.hasOwnProperty.call(store, key) ?
      store[key] : null,
    setProperty: (key, value) => { store[key] = value; },
    setProperties: (values) => Object.assign(store, values),
    deleteProperty: (key) => { delete store[key]; }
  };
  const payload = { cells: [{ value: { type: 'value', value: 'x'.repeat(5000) } }] };
  const count = context.writeMutationJournalPayload_(properties, 'file-id', payload);
  assert.equal(count > 1, true);
  const journal = context.hydrateMutationJournalPayload_(properties, 'file-id', {
    sheetRowPayloadChunks: count
  });
  assert.equal(journal.sheetRowPayload.cells[0].value.value.length, 5000);
}

function testBuildSpreadsheetHyperlinkFormulaEscapesValues() {
  const context = loadCataloger();
  assert.equal(
    context.buildSpreadsheetHyperlinkFormula_(
      { getUrl: () => 'https://drive.test/file?id="one"' },
      'Folder / Bill "one".pdf'
    ),
    '=HYPERLINK("https://drive.test/file?id=""one""","Folder / Bill ""one"".pdf")'
  );
}

function testDrivePathLabelIsRelativeToConfiguredRoot() {
  const context = loadCataloger();
  context.getRootFolderId_ = () => 'root-folder';
  const iterator = (item) => {
    let consumed = false;
    return {
      hasNext: () => !consumed,
      next: () => {
        consumed = true;
        return item;
      }
    };
  };
  const root = { getId: () => 'root-folder' };
  const water = {
    getId: () => 'water-folder',
    getName: () => 'Acqua',
    getParents: () => iterator(root)
  };
  const year = {
    getId: () => 'year-folder',
    getName: () => '2026',
    getParents: () => iterator(water)
  };
  const file = {
    getName: () => 'invoice.pdf',
    getParents: () => iterator(year)
  };

  assert.equal(context.buildDrivePathLabel_(file), 'Acqua/2026/invoice.pdf');
}

function testSpreadsheetFormulaArgumentSeparatorFollowsLocale() {
  const context = loadCataloger();
  const separatorFor = (locale) => context.getSpreadsheetFormulaArgumentSeparator_({
    getParent: () => ({ getSpreadsheetLocale: () => locale })
  });
  assert.equal(separatorFor('it_IT'), ';');
  assert.equal(separatorFor('en_GB'), ',');
}

function testReferenceMonthVerificationAcceptsSheetNumericCoercion() {
  const context = loadCataloger();

  assert.equal(context.referenceMonthValuesMatch_(6, '06'), true);
  assert.equal(context.referenceMonthValuesMatch_('6', '06'), true);
  assert.equal(context.referenceMonthValuesMatch_('06', '06'), true);
  assert.equal(context.referenceMonthValuesMatch_(7, '06'), false);
  assert.equal(context.referenceMonthValuesMatch_('invoice-6', '06'), false);
}

function testFormulaTotalMustReconcileWithExtraction() {
  const context = loadCataloger();
  context.getHeaderAliases_ = (key) => ({
    total: ['Cost total'],
    sourceFile: ['Source file']
  })[key] || [];
  const sheet = {
    getRange: (_row, column) => ({
      getFormulas: () => [['=SUM(A1:A1)', '=HYPERLINK("url";"text")']],
      getFormula: () => column === 2 ?
        '=HYPERLINK("https://drive.test/file-id";"text")' : '=SUM(A1:A1)',
      getDisplayValue: () => column === 2 ? 'text' : '42.55',
      getValue: () => column === 1 ? 42.55 : 'text',
      getRichTextValue: () => null
    })
  };
  const extracted = validInvoice();
  extracted.sheet_values = [];

  let error = null;
  try {
    context.verifyImportedRow_(
      sheet,
      3,
      {
        headerRow: 1,
        headers: ['Cost total', 'Source file'],
        lookup: { 'cost total': 1, 'source file': 2 }
      },
      { getUrl: () => 'https://drive.test/file-id' },
      extracted
    );
  } catch (caught) {
    error = caught;
  }
  assert.match(error.message, /formula total verification failed/);
  assert.deepEqual(JSON.parse(JSON.stringify(error.verificationDiscrepancies)), [{
    field: 'Cost total',
    expected: 14.64,
    actual: 42.55,
    valueType: 'money',
    tolerance: 0.02
  }]);
}

function testSupplementaryValuesCannotOverrideValidatedInvoiceTotal() {
  const context = loadCataloger();
  context.getHeaderAliases_ = (key) => ({
    total: ['Cost total'],
    sourceFile: ['Source file']
  })[key] || [];
  let actualTotal = 14.64;
  const sheet = {
    getRange: (_row, column, _rows, width) => {
      if (column === 1 && width === 2) {
        return { getFormulas: () => [['', '=HYPERLINK("url";"text")']] };
      }
      return {
        getValue: () => column === 1 ? actualTotal : 'text',
        getRichTextValue: () => null,
        getFormula: () => column === 2 ?
          '=HYPERLINK("https://drive.test/file-id";"text")' : '',
        getDisplayValue: () => 'text'
      };
    }
  };
  const extracted = validInvoice();
  extracted.sheet_values = [{ header: 'Cost total', value: 99 }];
  const layout = {
    headerRow: 1,
    headers: ['Cost total', 'Source file'],
    lookup: { 'cost total': 1, 'source file': 2 }
  };

  assert.doesNotThrow(() => context.verifyImportedRow_(sheet, 3, layout,
    { getUrl: () => 'https://drive.test/file-id' }, extracted));
  actualTotal = 99;
  assert.throws(() => context.verifyImportedRow_(sheet, 3, layout,
    { getUrl: () => 'https://drive.test/file-id' }, extracted),
  /Spreadsheet value verification failed/);
}

function testPlainSpreadsheetValueMismatchReportsExpectedAndObservedValues() {
  const context = loadCataloger();
  vm.runInContext(
    fs.readFileSync(path.join(projectRoot, 'locales/en.gs'), 'utf8'),
    context,
    { filename: 'locales/en.gs' }
  );
  context.getLocalization_ = () => context.getEnglishLocalization_();
  context.getHeaderAliases_ = (key) => ({
    supplier: ['Supplier'],
    sourceFile: ['Source file']
  })[key] || [];
  const sheet = {
    getRange: (_row, column) => ({
      getFormulas: () => [['', '=HYPERLINK("url";"text")']],
      getFormula: () => column === 2 ?
        '=HYPERLINK("https://drive.test/file-id";"text")' : '',
      getDisplayValue: () => column === 2 ? 'text' : 'OTHER SUPPLIER',
      getValue: () => column === 1 ? 'OTHER SUPPLIER' : 'text',
      getRichTextValue: () => null
    })
  };
  const extracted = validInvoice();
  extracted.sheet_values = [];

  let error = null;
  try {
    context.verifyImportedRow_(
      sheet,
      3,
      {
        headerRow: 1,
        headers: ['Supplier', 'Source file'],
        lookup: { supplier: 1, 'source file': 2 }
      },
      { getUrl: () => 'https://drive.test/file-id' },
      extracted
    );
  } catch (caught) {
    error = caught;
  }
  assert.match(error.message, /value verification failed/);
  assert.deepEqual(JSON.parse(JSON.stringify(error.verificationDiscrepancies)), [{
    field: 'Supplier',
    expected: extracted.supplier,
    actual: 'OTHER SUPPLIER',
    valueType: 'text',
    tolerance: null
  }]);
  const report = context.formatResult_({
    status: 'ERROR',
    extracted,
    rollbackCompleted: true,
    verificationDiscrepancies: error.verificationDiscrepancies
  });
  assert.match(report,
    /Detected discrepancy: field Supplier; expected SUPPLIER; observed OTHER SUPPLIER/);
}

function testPendingReportOutboxRetriesAndRepairsMalformedEntries() {
  const context = loadCataloger();
  const prefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.PENDING_REPORT_PREFIX',
    context
  );
  const store = {
    [`${prefix}file-id`]: JSON.stringify({ body: 'report body' })
  };
  const scriptProperties = {
    getProperties: () => ({ ...store }),
    deleteProperty: (key) => {
      delete store[key];
    }
  };
  context.PropertiesService = {
    getScriptProperties: () => scriptProperties
  };
  context.sendReportBodies_ = () => {
    throw new Error('mail unavailable');
  };

  assert.throws(() => context.flushPendingReports_(), /mail unavailable/);
  assert.equal(Object.keys(store).length, 1);

  const delivered = [];
  context.sendReportBodies_ = (bodies) => delivered.push(...bodies);
  assert.equal(context.flushPendingReports_().sent, 1);
  assert.deepEqual(delivered, ['report body']);
  assert.equal(Object.keys(store).length, 0);

  store[`${prefix}broken-id`] = '{';
  assert.equal(context.flushPendingReports_().sent, 1);
  assert.match(delivered[1], /could not be decoded/);
  assert.match(delivered[1], /broken-id/);
  assert.equal(Object.keys(store).length, 0);
}

function testPendingReportOutboxFlushesBeforeItsStorageBudget() {
  const context = loadCataloger();
  const prefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.PENDING_REPORT_PREFIX',
    context
  );
  const store = {};
  for (let index = 0; index < 40; index += 1) {
    store[`${prefix}existing-${index}`] = JSON.stringify({
      body: 'x'.repeat(7000)
    });
  }
  const scriptProperties = {
    getProperties: () => ({ ...store }),
    setProperty: (key, value) => {
      store[key] = value;
    }
  };
  context.PropertiesService = {
    getScriptProperties: () => scriptProperties
  };
  context.formatResult_ = () => 'new report';
  let flushes = 0;
  context.flushPendingReports_ = () => {
    flushes += 1;
    Object.keys(store).forEach((key) => {
      if (key.startsWith(prefix)) {
        delete store[key];
      }
    });
    return { sent: 40 };
  };

  context.queuePendingReports_([{
    fileUrl: 'https://drive.test/abcdefghijklmnopqrstuvwxyz123456'
  }]);

  assert.equal(flushes, 1);
  assert.equal(Object.keys(store).length, 1);
  assert.match(Object.values(store)[0], /new report/);
}

function testLockAndLogContracts() {
  let callbackRan = false;
  const context = loadCataloger({
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => '' })
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => false,
        releaseLock: () => {
          throw new Error('must not release an unowned lock');
        }
      })
    }
  });
  context.logCatalogEvent_ = () => {};
  const result = context.withCatalogProcessingLock_('test', () => {
    callbackRan = true;
  });

  assert.equal(callbackRan, false);
  assert.equal(result.skipped, 'already-running');

  context.PropertiesService = {
    getScriptProperties: () => ({ getProperty: () => 'transaction-1' })
  };
  const maintenanceResult = context.withCatalogProcessingLock_(
    'test',
    () => { callbackRan = true; }
  );
  assert.equal(maintenanceResult.skipped, 'maintenance');
  assert.equal(callbackRan, false);

  let maintenanceReads = 0;
  let releasedAfterMaintenance = false;
  const racedContext = loadCataloger({
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: () => {
          maintenanceReads += 1;
          return maintenanceReads > 1 ? 'transaction-1' : '';
        }
      })
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => true,
        releaseLock: () => { releasedAfterMaintenance = true; }
      })
    }
  });
  racedContext.logCatalogEvent_ = () => {};
  const racedResult = racedContext.withCatalogProcessingLock_(
    'test',
    () => { callbackRan = true; }
  );
  assert.equal(racedResult.skipped, 'maintenance');
  assert.equal(releasedAfterMaintenance, true);
  assert.equal(callbackRan, false);
  assert.deepEqual(
    Object.keys(context.describeFileForLog_({ getId: () => 'file-id' })),
    ['fileId']
  );
}

function testProcessingLeaseAndDocumentStatus() {
  const context = loadCataloger();
  const file = {
    getId: () => 'file-id',
    getLastUpdated: () => new Date(0),
    getSize: () => 10
  };
  const state = {};
  context.markIntakeFileProcessing_(state, file);
  assert.equal(state['file-id'].status, 'PROCESSING');

  const report = validInvoice();
  report.document_type = 'Report';
  const result = context.buildSuccessResult_(
    { getUrl: () => 'https://drive.test/file-id' },
    'old.pdf',
    'new.pdf',
    { path: 'Reports' },
    report,
    ''
  );
  assert.equal(result.status, 'ARCHIVED WITHOUT IMPORT');
}

function testManualRetryProcessesSameDayErrorsOnly() {
  const context = loadCataloger();
  const file = {
    getId: () => 'file-id',
    getLastUpdated: () => new Date(0),
    getSize: () => 10
  };
  context.hasMutationJournal_ = () => false;
  context.intakeStateDate_ = () => '2026-07-17';
  const state = {
    'file-id': {
      fingerprint: '0:10',
      status: 'ERROR',
      attemptDate: '2026-07-17'
    }
  };

  assert.equal(context.shouldProcessIntakeFile_(file, state, 'daily'), false);
  assert.equal(context.shouldProcessIntakeFile_(file, state, 'manual_retry'), true);
  state['file-id'].status = 'NEEDS REVIEW';
  assert.equal(context.shouldProcessIntakeFile_(file, state, 'manual_retry'), false);
}

function testSingleFilePreflightsTargetBeforeGlobalSideEffects() {
  const file = { getId: () => 'file-id' };
  const rootFolder = {};
  const calls = [];
  const context = loadCataloger({
    DriveApp: {
      getFolderById: () => rootFolder,
      getFileById: (fileId) => {
        calls.push('get-file:' + fileId);
        return file;
      }
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => true,
        releaseLock: () => calls.push('release-lock')
      })
    }
  });
  context.assertCatalogConfiguration_ = () => {};
  context.getRootFolderId_ = () => 'root-folder-id';
  context.logCatalogEvent_ = () => {};
  context.hasMutationJournal_ = () => false;
  context.isDirectIntakePdf_ = () => false;
  context.flushPendingReports_ = () => calls.push('flush');

  assert.throws(
    () => context.processSingleIntakeFile('file-id'),
    /not a PDF located directly in the intake folder/
  );
  assert.deepEqual(calls, ['get-file:file-id', 'release-lock']);
}

function testSingleFileProcessesOnlyTheValidatedTarget() {
  const file = { getId: () => 'file-id' };
  const rootFolder = {};
  const result = { status: 'IMPORTED' };
  const calls = [];
  const context = loadCataloger({
    DriveApp: {
      getFolderById: () => rootFolder,
      getFileById: () => file
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => true,
        releaseLock: () => {}
      })
    }
  });
  context.assertCatalogConfiguration_ = () => {};
  context.getRootFolderId_ = () => 'root-folder-id';
  context.logCatalogEvent_ = () => {};
  context.logCatalogResult_ = () => {};
  context.hasMutationJournal_ = () => false;
  context.isDirectIntakePdf_ = () => true;
  context.flushPendingReports_ = () => calls.push('flush');
  context.listDirectIntakePdfs_ = () => {
    throw new Error('single-file processing must not scan intake');
  };
  context.loadDriveAgentsPolicy_ = () => 'policy';
  context.loadIntakeFileState_ = () => ({});
  context.markIntakeFileProcessing_ = () => {};
  context.saveIntakeFileState_ = () => {};
  context.processIntakeFile_ = (candidate) => {
    assert.equal(candidate, file);
    calls.push('process');
    return result;
  };
  context.persistCatalogResult_ = () => {};
  context.finalizeCatalogResults_ = () => {};

  assert.equal(context.processSingleIntakeFile('file-id'), result);
  assert.deepEqual(calls, ['flush', 'process']);
}

function testSingleFileRecoversOnlyTargetJournal() {
  const file = { getId: () => 'file-id' };
  const rootFolder = {};
  const calls = [];
  let hasJournal = true;
  const context = loadCataloger({
    DriveApp: {
      getFolderById: () => rootFolder,
      getFileById: () => file
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
    }
  });
  context.assertCatalogConfiguration_ = () => {};
  context.getRootFolderId_ = () => 'root-folder-id';
  context.hasMutationJournal_ = () => hasJournal;
  context.recoverMutationJournalForFile_ = (folder, fileId) => {
    assert.equal(folder, rootFolder);
    assert.equal(fileId, 'file-id');
    calls.push('recover:file-id');
    hasJournal = false;
  };
  context.isDirectIntakePdf_ = () => true;
  context.flushPendingReports_ = () => {};
  context.loadDriveAgentsPolicy_ = () => 'policy';
  context.logCatalogEvent_ = () => {};
  context.logCatalogResult_ = () => {};
  context.loadIntakeFileState_ = () => ({});
  context.markIntakeFileProcessing_ = () => {};
  context.saveIntakeFileState_ = () => {};
  context.processIntakeFile_ = () => ({ status: 'IMPORTED' });
  context.persistCatalogResult_ = () => {};
  context.finalizeCatalogResults_ = () => {};

  context.processSingleIntakeFile('file-id');
  assert.deepEqual(calls, ['recover:file-id']);
}

function testSingleFileStopsWhenTargetJournalRemains() {
  const calls = [];
  const context = loadCataloger({
    DriveApp: {
      getFolderById: () => ({}),
      getFileById: () => {
        calls.push('get-file');
        throw new Error('unavailable');
      }
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
    }
  });
  context.assertCatalogConfiguration_ = () => {};
  context.getRootFolderId_ = () => 'root-folder-id';
  context.logCatalogEvent_ = () => {};
  context.hasMutationJournal_ = () => true;
  context.recoverMutationJournalForFile_ = () => calls.push('recover');

  assert.throws(
    () => context.processSingleIntakeFile('file-id'),
    /unresolved mutation journal/
  );
  assert.deepEqual(calls, ['recover']);
}

testFormulaLikeTextIsWrittenLiterally();
testExtractionSchemaAndCalendarValidation();
testSupplierDefaultsUseRuntimeTargetHeaders();
testAmbiguousAddressRulesFailClosed();
testHiddenPdfsAreExcludedFromIntake();
testDeveloperApiKeyUsesHeader();
testConfigureGeminiModelUpdatesTheSharedRuntimeModel();
testIncompleteGeminiResponseReportsFinishReason();
testGeminiResponseWithoutFinishReasonFailsClosed();
testDepletedPrepaymentCreditsSwitchToVertexForOneHour();
testEmailReportIncludesSoftwareVersion();
testPostExtractionSpreadsheetErrorReportPreservesDiagnostics();
testPreExtractionErrorReportKeepsDataUnavailable();
testGenericRateLimitStaysOnDeveloperApi();
testVertexRateLimitRetriesWithoutReclassifyingProviderQuota();
testStructuredFileLogsContainOnlyOpaqueId();
testReportFieldsCannotInjectExtraLines();
testPromptKeepsHeadersScopedBySupply();
testHeadersAreCollectedPerSupply();
testDuplicateNormalizedSheetHeadersAreRejected();
testSheetLayoutAcceptsPendingLocaleAliases();
testMutationRecoveryStages();
testMutationRecoveryPersistsDeletedRowWithFallbackCheckpoint();
testMutationRecoveryReportsUnavailableFileOnce();
testRuntimeExhaustionPersistsOperatorLinks();
testTargetMutationJournalRecoveryLeavesUnrelatedJournalUntouched();
testAccessibleRecoveryFailureRequiresManualReview();
testFormulaAndStyleCopySources();
testExistingFormulaCellsAreNotOverwrittenDuringReimport();
testDetailedCostSheetValuesOverrideBroadReconciliationValues();
testSupplementarySheetValuesCannotOverrideLiteralCanonicalFields();
testMissingRowFormulaDoesNotUnprotectTemplateColumn();
testSourceHyperlinkFormulaIsPreserved();
testExistingInvoicePayloadRestoresAndRepositions();
testCorrectedInvoiceMovesImmediatelyBeforeNewerInvoice();
testCorrectedInvoiceAppendsWithoutBlankRow();
testInsertedInvoiceDeleteFailureBeforeMarkerPreservesJournalState();
testInsertedInvoiceDeleteFailureAfterMarkerPreservesJournalState();
testInsertedInvoiceRollsBackWhenDashboardRefreshFails();
testInsertedInvoiceRetainsDeletionCheckpointWhenDashboardRollbackFails();
testDashboardRollbackForcesRegeneration();
testRowDeletionIsJournaledBeforeDashboardRollback();
testOuterRollbackUsesFullJournalFallbackCheckpoint();
testOuterRollbackDoesNotCheckpointMissingRowLocation();
testMutationJournalPayloadUsesSeparateChunks();
testBuildSpreadsheetHyperlinkFormulaEscapesValues();
testDrivePathLabelIsRelativeToConfiguredRoot();
testSpreadsheetFormulaArgumentSeparatorFollowsLocale();
testReferenceMonthVerificationAcceptsSheetNumericCoercion();
testFormulaTotalMustReconcileWithExtraction();
testSupplementaryValuesCannotOverrideValidatedInvoiceTotal();
testPlainSpreadsheetValueMismatchReportsExpectedAndObservedValues();
testPendingReportOutboxRetriesAndRepairsMalformedEntries();
testPendingReportOutboxFlushesBeforeItsStorageBudget();
testLockAndLogContracts();
testProcessingLeaseAndDocumentStatus();
testManualRetryProcessesSameDayErrorsOnly();
testSingleFilePreflightsTargetBeforeGlobalSideEffects();
testSingleFileProcessesOnlyTheValidatedTarget();
testSingleFileRecoversOnlyTargetJournal();
testSingleFileStopsWhenTargetJournalRemains();

console.log('Utilities cataloging tests passed.');
