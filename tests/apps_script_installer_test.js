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

testSecretManagerBootstrapHandoff();
testSecretManagerScopeIsRestricted();
testResumedManagedSpreadsheetPlacementIsRepaired();
testPopulatedSpreadsheetSettingsAreNotChangedSilently();
testGeminiDeveloperApiValidation();
testVertexValidation();
testFallbackValidatesBothBackends();
testCredentialFailureIsRedacted();

console.log('Apps Script installer tests passed.');
