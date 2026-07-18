#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const installerSource = fs.readFileSync(
  path.join(projectRoot, 'Installer.gs'),
  'utf8'
);

function loadInstaller(fetchImplementation) {
  const context = vm.createContext({
    ScriptApp: {
      getOAuthToken: () => 'vertex-oauth-token',
      getScriptId: () => 'test-script-id'
    },
    Utilities: {
      base64Decode: (value) => Buffer.from(value, 'base64'),
      newBlob: (value) => ({
        getDataAsString: () => Buffer.from(value).toString('utf8')
      })
    },
    UrlFetchApp: {
      fetch: fetchImplementation
    }
  });

  vm.runInContext(installerSource, context, {
    filename: 'Installer.gs'
  });
  return context;
}

function testSecretManagerBootstrapHandoff() {
  const requests = [];
  const privateOptions = {
    projectId: 'cataloger-project',
    geminiApiKey: 'developer-secret'
  };
  const context = loadInstaller((url, options) => {
    requests.push({ url, options });
    return response(200, {
      payload: {
        data: Buffer.from(JSON.stringify(privateOptions)).toString('base64')
      }
    });
  });

  const result = context.readInstallerBootstrapOptions_({
    bootstrapSecretVersion:
      'projects/cataloger-project/secrets/' +
      'drive-utilities-cataloger-test-script-id/versions/7'
  });

  assert.equal(result.projectId, 'cataloger-project');
  assert.equal(result.geminiApiKey, 'developer-secret');
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://secretmanager.googleapis.com/v1/projects/' +
      'cataloger-project/secrets/' +
      'drive-utilities-cataloger-test-script-id/versions/7:access'
  );
  assert.equal(
    requests[0].options.headers.Authorization,
    'Bearer vertex-oauth-token'
  );
}

function testSecretManagerScopeIsRestricted() {
  const context = loadInstaller(() => {
    throw new Error('fetch must not run');
  });

  assert.throws(
    () => context.readInstallerBootstrapOptions_({
      bootstrapSecretVersion:
        'projects/other-project/secrets/unrelated/versions/1'
    }),
    /does not belong/
  );
}

function testResumedManagedSpreadsheetPlacementIsRepaired() {
  const movedTo = [];
  const context = loadInstaller(() => {
    throw new Error('fetch must not run');
  });
  const spreadsheet = {
    getId: () => 'spreadsheet-id',
    getSheets: () => [{ getLastRow: () => 0 }],
    setSpreadsheetTimeZone: () => {},
    setSpreadsheetLocale: () => {}
  };
  const rootFolder = { getId: () => 'root-folder-id' };
  context.SpreadsheetApp = {
    openById: () => spreadsheet
  };
  context.DriveApp = {
    getFileById: () => ({
      moveTo: (folder) => movedTo.push(folder.getId())
    })
  };
  context.getInstallerLocalization_ = () => ({
    spreadsheetLocale: 'en_US'
  });
  context.initializeInstallerSheets_ = () => {};

  context.ensureInstallerSpreadsheet_(
    rootFolder,
    'spreadsheet-id',
    'Utilities',
    { locale: 'en' },
    'Etc/UTC',
    true
  );
  context.ensureInstallerSpreadsheet_(
    rootFolder,
    'spreadsheet-id',
    'Utilities',
    { locale: 'en' },
    'Etc/UTC',
    false
  );

  assert.deepEqual(movedTo, ['root-folder-id']);
}

function testPopulatedSpreadsheetSettingsAreNotChangedSilently() {
  const context = loadInstaller(() => {
    throw new Error('fetch must not run');
  });
  const spreadsheet = {
    getId: () => 'spreadsheet-id',
    getSheets: () => [{ getLastRow: () => 2 }],
    getSpreadsheetTimeZone: () => 'America/New_York',
    getSpreadsheetLocale: () => 'en_US',
    setSpreadsheetTimeZone: () => {
      throw new Error('must not change populated spreadsheet settings');
    },
    setSpreadsheetLocale: () => {
      throw new Error('must not change populated spreadsheet settings');
    }
  };
  context.SpreadsheetApp = {
    openById: () => spreadsheet
  };
  context.getInstallerLocalization_ = () => ({
    spreadsheetLocale: 'en_US'
  });
  context.initializeInstallerSheets_ = () => {};

  assert.throws(
    () => context.ensureInstallerSpreadsheet_(
      { getId: () => 'root-folder-id' },
      'spreadsheet-id',
      'Utilities',
      { locale: 'en' },
      'Etc/UTC',
      false
    ),
    /time zone must match/
  );
}

function testSpreadsheetValidationUsesDetectedHeaderRow() {
  const context = loadInstaller(() => {
    throw new Error('fetch must not run');
  });
  context.getSheetLayout_ = () => ({
    headerRow: 2,
    headers: [
      'Data di emissione',
      'Fornitore',
      'Numero fattura',
      'File sorgente'
    ]
  });
  context.getInstallerLocalization_ = () => ({
    headerAliases: {
      issueDate: ['data di emissione'],
      supplier: ['fornitore'],
      identifier: ['numero fattura'],
      sourceFile: ['file sorgente']
    }
  });
  context.normalizeHeader_ = (value) => String(value).trim().toLowerCase();
  const sheet = {
    getName: () => 'Acqua',
    getRange: () => {
      throw new Error('validator must use the detected header row');
    }
  };

  context.validateInstallerSheetHeaders_(sheet, 'it');
}

function response(statusCode, body) {
  return {
    getContentText: () => JSON.stringify(body),
    getResponseCode: () => statusCode
  };
}

function testGeminiDeveloperApiValidation() {
  const requests = [];
  const context = loadInstaller((url, options) => {
    requests.push({ url, options });
    return response(200, {
      supportedGenerationMethods: ['generateContent']
    });
  });

  context.validateInstallerGeminiAccess_({
    projectId: 'cataloger-project',
    geminiBackend: 'gemini_api',
    geminiApiKey: 'developer-secret',
    geminiModel: 'gemini-2.5-flash',
    autoVertexFallback: false,
    vertexLocation: 'global'
  });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://generativelanguage.googleapis.com/v1beta/models/' +
      'gemini-2.5-flash'
  );
  assert.equal(
    requests[0].options.headers['x-goog-api-key'],
    'developer-secret'
  );
  assert.equal(requests[0].url.includes('developer-secret'), false);
}

function testVertexValidation() {
  const requests = [];
  const context = loadInstaller((url, options) => {
    requests.push({ url, options });
    return response(200, { totalTokens: 2 });
  });

  context.validateInstallerGeminiAccess_({
    projectId: 'cataloger-project',
    geminiBackend: 'vertex_ai',
    geminiApiKey: '',
    geminiModel: 'gemini-2.5-flash',
    autoVertexFallback: false,
    vertexLocation: 'europe-west1'
  });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://aiplatform.googleapis.com/v1/projects/cataloger-project/' +
      'locations/europe-west1/publishers/google/models/' +
      'gemini-2.5-flash:countTokens'
  );
  assert.equal(
    requests[0].options.headers.Authorization,
    'Bearer vertex-oauth-token'
  );
  const payload = JSON.parse(requests[0].options.payload);
  assert.equal(
    payload.model,
    'projects/cataloger-project/locations/europe-west1/' +
      'publishers/google/models/gemini-2.5-flash'
  );
  assert.equal(payload.contents[0].parts[0].text, 'installation-check');
}

function testFallbackValidatesBothBackends() {
  const requests = [];
  const context = loadInstaller((url) => {
    requests.push(url);
    if (url.includes('generativelanguage.googleapis.com')) {
      return response(200, {
        supportedGenerationMethods: ['generateContent']
      });
    }
    return response(200, { totalTokens: 2 });
  });

  context.validateInstallerGeminiAccess_({
    projectId: 'cataloger-project',
    geminiBackend: 'gemini_api',
    geminiApiKey: 'developer-secret',
    geminiModel: 'gemini-2.5-flash',
    autoVertexFallback: true,
    vertexLocation: 'global'
  });

  assert.equal(requests.length, 2);
  assert.equal(
    requests.some((url) => url.includes('generativelanguage.googleapis.com')),
    true
  );
  assert.equal(
    requests.some((url) => url.endsWith(':countTokens')),
    true
  );
}

function testCredentialFailureIsRedacted() {
  const context = loadInstaller(() => response(403, {
    error: {
      message: 'credential developer-secret was rejected'
    }
  }));

  assert.throws(
    () => context.validateInstallerGeminiAccess_({
      projectId: 'cataloger-project',
      geminiBackend: 'gemini_api',
      geminiApiKey: 'developer-secret',
      geminiModel: 'gemini-2.5-flash',
      autoVertexFallback: false,
      vertexLocation: 'global'
    }),
    (error) => {
      assert.match(error.message, /HTTP 403/);
      assert.equal(error.message.includes('developer-secret'), false);
      assert.equal(error.message.includes('credential'), false);
      return true;
    }
  );
}

function testTimeZoneReconfigurationPreservesCredentialsAndTriggers() {
  const context = loadInstaller(() => {
    throw new Error('Secret Manager and Gemini must not be called');
  });
  const stored = {
    SPREADSHEET_ID: 'spreadsheet-id',
    AUTOMATION_CONFIG_JSON: JSON.stringify({
      locale: 'en',
      time_zone: 'Europe/Rome'
    }),
    TIME_ZONE_RECONFIGURATION: JSON.stringify({
      transactionId: 'transaction-1',
      previousTimeZone: 'Europe/Rome',
      targetTimeZone: 'Pacific/Auckland'
    }),
    GEMINI_BACKEND: 'gemini_api',
    GEMINI_API_KEY: 'persisted-key'
  };
  const triggerHandlers = [
    'runDailyUtilitiesCataloging',
    'processDriveEventQueue',
    'renewDriveEventSubscription'
  ];
  let spreadsheetTimeZone = 'Europe/Rome';
  context.CONFIG = {
    PROPERTY_KEYS: {
      SPREADSHEET_ID: 'SPREADSHEET_ID',
      AUTOMATION_CONFIG_JSON: 'AUTOMATION_CONFIG_JSON',
      TIME_ZONE_RECONFIGURATION: 'TIME_ZONE_RECONFIGURATION'
    }
  };
  context.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => stored[key] || '',
      setProperty: (key, value) => {
        stored[key] = value;
      }
    })
  };
  context.SpreadsheetApp = {
    openById: (spreadsheetId) => {
      assert.equal(spreadsheetId, 'spreadsheet-id');
      return {
        getSpreadsheetTimeZone: () => spreadsheetTimeZone,
        setSpreadsheetTimeZone: (timeZone) => {
          spreadsheetTimeZone = timeZone;
        }
      };
    }
  };
  context.ScriptApp.getProjectTriggers = () => triggerHandlers.map(
    (handler) => ({ getHandlerFunction: () => handler })
  );
  context.isValidIanaTimeZone_ = (timeZone) =>
    timeZone === 'Pacific/Auckland';
  context.validateAutomationConfig_ = (config) => {
    assert.equal(config.time_zone, 'Pacific/Auckland');
  };
  context.assertCatalogConfiguration_ = () => {};
  context.withCatalogLifecycleLock_ = (_label, callback) => callback();

  const result = context.reconfigureCatalogerTimeZone({
    timeZone: 'Pacific/Auckland',
    transactionId: 'transaction-1'
  });

  assert.equal(result.configured, true);
  assert.equal(spreadsheetTimeZone, 'Pacific/Auckland');
  assert.equal(
    JSON.parse(stored.AUTOMATION_CONFIG_JSON).time_zone,
    'Pacific/Auckland'
  );
  assert.equal(stored.GEMINI_BACKEND, 'gemini_api');
  assert.equal(stored.GEMINI_API_KEY, 'persisted-key');
  assert.deepEqual(
    context.ScriptApp.getProjectTriggers().map(
      (trigger) => trigger.getHandlerFunction()
    ),
    triggerHandlers
  );
}

function testTimeZoneReconfigurationRollsBackRemoteState() {
  const context = loadInstaller(() => {
    throw new Error('network must not run');
  });
  const originalConfig = JSON.stringify({
    locale: 'en',
    time_zone: 'Europe/Rome'
  });
  const stored = {
    SPREADSHEET_ID: 'spreadsheet-id',
    AUTOMATION_CONFIG_JSON: originalConfig,
    TIME_ZONE_RECONFIGURATION: JSON.stringify({
      transactionId: 'transaction-1',
      previousTimeZone: 'Europe/Rome',
      targetTimeZone: 'Pacific/Auckland'
    })
  };
  let spreadsheetTimeZone = 'Europe/Rome';
  let validationCalls = 0;
  context.CONFIG = {
    PROPERTY_KEYS: {
      SPREADSHEET_ID: 'SPREADSHEET_ID',
      AUTOMATION_CONFIG_JSON: 'AUTOMATION_CONFIG_JSON',
      TIME_ZONE_RECONFIGURATION: 'TIME_ZONE_RECONFIGURATION'
    }
  };
  context.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => stored[key] || '',
      setProperty: (key, value) => {
        stored[key] = value;
      }
    })
  };
  context.SpreadsheetApp = {
    openById: () => ({
      getSpreadsheetTimeZone: () => spreadsheetTimeZone,
      setSpreadsheetTimeZone: (timeZone) => {
        spreadsheetTimeZone = timeZone;
      }
    })
  };
  context.isValidIanaTimeZone_ = () => true;
  context.validateAutomationConfig_ = () => {};
  context.assertCatalogConfiguration_ = () => {
    validationCalls += 1;
    throw new Error('post-update validation failed');
  };
  context.withCatalogLifecycleLock_ = (_label, callback) => callback();

  assert.throws(
    () => context.reconfigureCatalogerTimeZone({
      timeZone: 'Pacific/Auckland',
      transactionId: 'transaction-1'
    }),
    /post-update validation failed/
  );
  assert.equal(validationCalls, 1);
  assert.equal(spreadsheetTimeZone, 'Europe/Rome');
  assert.equal(stored.AUTOMATION_CONFIG_JSON, originalConfig);
}

function testTimeZoneTransactionLifecycle() {
  const context = loadInstaller(() => {
    throw new Error('network must not run');
  });
  const stored = {
    SPREADSHEET_ID: 'spreadsheet-id',
    AUTOMATION_CONFIG_JSON: JSON.stringify({
      locale: 'en',
      time_zone: 'Europe/Rome'
    })
  };
  let spreadsheetTimeZone = 'Europe/Rome';
  context.CONFIG = {
    PROPERTY_KEYS: {
      SPREADSHEET_ID: 'SPREADSHEET_ID',
      AUTOMATION_CONFIG_JSON: 'AUTOMATION_CONFIG_JSON',
      TIME_ZONE_RECONFIGURATION: 'TIME_ZONE_RECONFIGURATION'
    }
  };
  context.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => stored[key] || '',
      setProperty: (key, value) => { stored[key] = value; },
      deleteProperty: (key) => { delete stored[key]; }
    })
  };
  context.SpreadsheetApp = {
    openById: () => ({
      getSpreadsheetTimeZone: () => spreadsheetTimeZone,
      setSpreadsheetTimeZone: (timeZone) => {
        spreadsheetTimeZone = timeZone;
      }
    })
  };
  context.Utilities = { getUuid: () => 'transaction-1' };
  context.isValidIanaTimeZone_ = () => true;
  context.validateAutomationConfig_ = () => {};
  context.withCatalogLifecycleLock_ = (_label, callback) => callback();

  const first = context.beginCatalogerTimeZoneReconfiguration({
    timeZone: 'Pacific/Auckland'
  });
  const resumed = context.beginCatalogerTimeZoneReconfiguration({
    timeZone: 'Pacific/Auckland'
  });
  assert.equal(first.transactionId, 'transaction-1');
  assert.equal(first.previousTimeZone, 'Europe/Rome');
  assert.equal(resumed.transactionId, first.transactionId);
  assert.throws(
    () => context.beginCatalogerTimeZoneReconfiguration({
      timeZone: 'Asia/Tokyo'
    }),
    /Another time-zone reconfiguration is pending/
  );

  const finished = context.finishCatalogerTimeZoneReconfiguration({
    transactionId: 'transaction-1',
    expectedTimeZone: 'Europe/Rome'
  });
  assert.equal(finished.completed, true);
  assert.equal(stored.TIME_ZONE_RECONFIGURATION, undefined);

  spreadsheetTimeZone = 'Pacific/Auckland';
  assert.throws(
    () => context.beginCatalogerTimeZoneReconfiguration({
      timeZone: 'Asia/Tokyo'
    }),
    /time zones diverge/
  );
}

testSecretManagerBootstrapHandoff();
testSecretManagerScopeIsRestricted();
testResumedManagedSpreadsheetPlacementIsRepaired();
testPopulatedSpreadsheetSettingsAreNotChangedSilently();
testSpreadsheetValidationUsesDetectedHeaderRow();
testGeminiDeveloperApiValidation();
testVertexValidation();
testFallbackValidatesBothBackends();
testCredentialFailureIsRedacted();
testTimeZoneReconfigurationPreservesCredentialsAndTriggers();
testTimeZoneReconfigurationRollsBackRemoteState();
testTimeZoneTransactionLifecycle();

console.log('Apps Script installer tests passed.');
