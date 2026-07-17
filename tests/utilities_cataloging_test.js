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
  const raw = validInvoice();
  context.validateRawExtractionShape_(raw);
  assert.equal(context.validateExtraction_(raw).valid, true);

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
            candidates: [{ content: { parts: [{ text: '{}' }] } }]
          })
        };
      }
    }
  });
  context.getGeminiModel_ = () => 'gemini-2.5-flash';
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
        candidates: [{ content: { parts: [{ text: '{}' }] } }]
      })
    },
    {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{}' }] } }]
      })
    },
    {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{}' }] } }]
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
        candidates: [{ content: { parts: [{ text: '{}' }] } }]
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
        candidates: [{ content: { parts: [{ text: '{}' }] } }]
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
    return {
      deletedRows,
      refreshedRows,
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

  const markerLostAfterJournal = scenario({
    stage: 'sheet-marker-written',
    sheetName: 'Water',
    sheetRow: 2,
    sheetRowCreated: true
  }, []);
  assert.throws(markerLostAfterJournal.result, /source marker is missing/);

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

function testFormulaAndStyleCopySources() {
  const calls = [];
  const context = loadCataloger();
  const sheet = {
    getLastRow: () => 6,
    getRange: (row) => ({
      copyTo: (_target, pasteType) => calls.push([row, pasteType])
    })
  };
  const layout = { headerRow: 1, headers: ['A', 'B'] };

  context.copyRowStyleAndFormulas_(sheet, 4, layout);
  context.copyRowStyleAndFormulas_(sheet, 2, layout);

  assert.deepEqual(calls, [
    [3, 'format'],
    [3, 'formula'],
    [3, 'format'],
    [3, 'formula']
  ]);
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

testFormulaLikeTextIsWrittenLiterally();
testExtractionSchemaAndCalendarValidation();
testAmbiguousAddressRulesFailClosed();
testHiddenPdfsAreExcludedFromIntake();
testDeveloperApiKeyUsesHeader();
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
testFormulaAndStyleCopySources();
testPendingReportOutboxRetriesAndRepairsMalformedEntries();
testPendingReportOutboxFlushesBeforeItsStorageBudget();
testLockAndLogContracts();
testProcessingLeaseAndDocumentStatus();

console.log('Utilities cataloging tests passed.');
