#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const sources = ['Config.gs', 'UtilitiesCataloging.gs'].map((file) =>
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
      filename: index === 0 ? 'Config.gs' : 'UtilitiesCataloging.gs'
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
    canonical_suppliers: ['SUPPLIER'],
    supplier_aliases: {},
    canonical_supplies: ['Water'],
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
  assert.match(prompt, /"customer_code": "printed customer\/client\/account code or null"/);
  assert.match(prompt, /Never substitute one for the other/);
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
  assert.match(firstResults[0].problem, /Drive file is unavailable/);
  assert.equal(queuedResults.length, 1);
  assert.equal(secondResults.length, 0);
  assert.ok(store[`${alertPrefix}${fileId}`]);
  assert.ok(store[`${journalPrefix}${fileId}`]);
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
    headers: ['Issue date', 'Source file', 'Calculated value'],
    lookup: {
      'issue date': 1,
      'source file': 2,
      'calculated value': 3
    }
  };
  const sheet = {
    getLastRow: () => 3,
    getParent: () => ({ getSpreadsheetLocale: () => 'en_US' }),
    getRange: (row, column, _rows, width) => {
      if (column === 1 && width === 3) {
        return { getFormulas: () => [['', '=HYPERLINK("url","text")', '=A3*2']] };
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

  assert.equal(writes.some((entry) => entry[1] === 3), false);
  assert.equal(writes.some((entry) => entry[1] === 1), true);
  assert.equal(writes.some((entry) => entry[1] === 2 && entry[2] === 'formula'),
    true);
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

  assert.throws(
    () => context.verifyImportedRow_(
      sheet,
      3,
      {
        headerRow: 1,
        headers: ['Cost total', 'Source file'],
        lookup: { 'cost total': 1, 'source file': 2 }
      },
      { getUrl: () => 'https://drive.test/file-id' },
      extracted
    ),
    /formula total verification failed/
  );
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
testAmbiguousAddressRulesFailClosed();
testHiddenPdfsAreExcludedFromIntake();
testDeveloperApiKeyUsesHeader();
testConfigureGeminiModelUpdatesTheSharedRuntimeModel();
testIncompleteGeminiResponseReportsFinishReason();
testGeminiResponseWithoutFinishReasonFailsClosed();
testDepletedPrepaymentCreditsSwitchToVertexForOneHour();
testEmailReportIncludesSoftwareVersion();
testGenericRateLimitStaysOnDeveloperApi();
testVertexRateLimitRetriesWithoutReclassifyingProviderQuota();
testStructuredFileLogsContainOnlyOpaqueId();
testReportFieldsCannotInjectExtraLines();
testPromptKeepsHeadersScopedBySupply();
testHeadersAreCollectedPerSupply();
testDuplicateNormalizedSheetHeadersAreRejected();
testMutationRecoveryStages();
testMutationRecoveryReportsUnavailableFileOnce();
testTargetMutationJournalRecoveryLeavesUnrelatedJournalUntouched();
testFormulaAndStyleCopySources();
testExistingFormulaCellsAreNotOverwrittenDuringReimport();
testMissingRowFormulaDoesNotUnprotectTemplateColumn();
testSourceHyperlinkFormulaIsPreserved();
testExistingInvoicePayloadRestoresAndRepositions();
testCorrectedInvoiceMovesImmediatelyBeforeNewerInvoice();
testCorrectedInvoiceAppendsWithoutBlankRow();
testInsertedInvoiceRollsBackWhenDashboardRefreshFails();
testDashboardRollbackForcesRegeneration();
testRowDeletionIsJournaledBeforeDashboardRollback();
testMutationJournalPayloadUsesSeparateChunks();
testBuildSpreadsheetHyperlinkFormulaEscapesValues();
testDrivePathLabelIsRelativeToConfiguredRoot();
testSpreadsheetFormulaArgumentSeparatorFollowsLocale();
testReferenceMonthVerificationAcceptsSheetNumericCoercion();
testFormulaTotalMustReconcileWithExtraction();
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
