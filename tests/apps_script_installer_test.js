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

function iteratorFor(items) {
  let index = 0;
  return {
    hasNext: () => index < items.length,
    next: () => items[index++]
  };
}

function createSupplierProfileTemplateFixture(initialContent, initialState) {
  const stored = initialState ? {
    SUPPLIER_PROFILE_TEMPLATE_STATE: JSON.stringify(initialState)
  } : {};
  const writes = [];
  const files = [];
  const template = [
    '---',
    'managed_by: Google Drive Utilities Cataloger',
    'status: approved',
    'supplier: SUPPLIER NAME',
    '---'
  ].join('\n');
  const makeFile = (content) => {
    let fileContent = content;
    return {
      getId: () => 'template-file-id',
      getName: () => 'PROFILE.example.md',
      isTrashed: () => false,
      getBlob: () => ({ getDataAsString: () => fileContent }),
      setContent: (nextContent) => {
        writes.push(nextContent);
        fileContent = nextContent;
      },
      getContent: () => fileContent
    };
  };
  if (initialContent !== undefined) {
    files.push(makeFile(initialContent));
  }
  const templateFolder = {
    getId: () => 'template-folder-id',
    getFilesByName: () => iteratorFor(files),
    createFile: (_name, content) => {
      const file = makeFile(content);
      files.push(file);
      return file;
    }
  };
  const context = loadInstaller(() => {
    throw new Error('network must not run');
  });
  context.CONFIG = { PROPERTY_KEYS: {
    SUPPLIER_PROFILE_WORKSPACE_STATE: 'SUPPLIER_PROFILE_WORKSPACE_STATE',
    SUPPLIER_PROFILE_TEMPLATE_STATE: 'SUPPLIER_PROFILE_TEMPLATE_STATE'
  } };
  context.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => stored[key] || '',
      setProperty: (key, value) => { stored[key] = value; }
    })
  };
  context.MimeType = { PLAIN_TEXT: 'text/plain' };
  context.getSupplierProfileNamesForLocale_ = () => ({
    folder: 'Supplier Profiles', templateFolder: '_template',
    templateFile: 'PROFILE.example.md'
  });
  context.getLocalizedSupplierProfileTemplate_ = () => template;
  context.ensureInstallerSupplierProfileWorkspace_ = () => ({
    profileRoot: { getId: () => 'profile-root-id' },
    templateFolder: templateFolder
  });
  return {
    context,
    rootFolder: { getId: () => 'root-folder-id' },
    files,
    stored,
    template,
    writes
  };
}

function createSupplierProfileWorkspaceFixture(existingProfileRoot) {
  const stored = {};
  const createOperations = [];
  const makeFolder = (id, name) => {
    const folders = [];
    const files = [];
    return {
      getId: () => id,
      isTrashed: () => false,
      getFoldersByName: (requestedName) => iteratorFor(
        folders.filter((folder) => folder.getName() === requestedName)
      ),
      getFolders: () => iteratorFor(folders),
      getFiles: () => iteratorFor(files),
      getName: () => name,
      createFolder: (childName) => {
        const child = makeFolder(id + '/' + childName, childName);
        folders.push(child);
        createOperations.push([id, childName]);
        return child;
      }
    };
  };
  const rootFolder = makeFolder('root-folder-id', 'root');
  if (existingProfileRoot) {
    rootFolder.createFolder('Supplier Profiles');
    createOperations.length = 0;
  }
  const context = loadInstaller(() => {
    throw new Error('network must not run');
  });
  context.CONFIG = { PROPERTY_KEYS: {
    SUPPLIER_PROFILE_WORKSPACE_STATE: 'SUPPLIER_PROFILE_WORKSPACE_STATE',
    SUPPLIER_PROFILE_TEMPLATE_STATE: 'SUPPLIER_PROFILE_TEMPLATE_STATE'
  } };
  context.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => stored[key] || '',
      setProperty: (key, value) => { stored[key] = value; }
    })
  };
  return { context, rootFolder, stored, createOperations };
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

function testBootstrapInitializesSpreadsheetUnderLifecycleLock() {
  const context = loadInstaller(() => {
    throw new Error('network must not run');
  });
  const operations = [];
  const properties = {
    getProperty: () => '',
    setProperties: () => {},
    deleteProperty: () => {}
  };
  const spreadsheet = {
    getId: () => 'spreadsheet-id',
    getUrl: () => 'https://sheets.test/spreadsheet-id'
  };
  context.CONFIG = { PROPERTY_KEYS: {
    ROOT_FOLDER_ID: 'ROOT_FOLDER_ID',
    SPREADSHEET_ID: 'SPREADSHEET_ID',
    GEMINI_API_KEY: 'GEMINI_API_KEY',
    GEMINI_VERTEX_FALLBACK_UNTIL: 'GEMINI_VERTEX_FALLBACK_UNTIL'
  } };
  context.PropertiesService = { getScriptProperties: () => properties };
  context.DriveApp = { getFolderById: () => ({ getUrl: () => 'https://drive.test' }) };
  context.readInstallerBootstrapOptions_ = () => ({});
  context.validateInstallerOptions_ = () => ({
    rootFolderId: 'root-folder-id', spreadsheetId: '', spreadsheetTitle: 'Utilities',
    automationConfig: {}, timeZone: 'Etc/UTC', agentsPolicy: 'policy',
    geminiBackend: 'gemini_api', geminiModel: 'gemini', autoVertexFallback: false,
    vertexLocation: 'global', notificationRecipient: 'owner@example.com',
    projectId: 'project-id', geminiApiKey: ''
  });
  context.validateInstallerGeminiAccess_ = () => {};
  context.ensureInstallerPolicyFile_ = () => ({ getUrl: () => 'https://drive.test/policy' });
  context.ensureInstallerSupplierProfileTemplate_ = () => {};
  context.ensureInstallerSpreadsheet_ = () => {
    operations.push('spreadsheet');
    return spreadsheet;
  };
  context.ensureInstallerDestinationFolders_ = () => {};
  context.assertCatalogConfiguration_ = () => {};
  context.provisionDriveEventTransportUnlocked_ = () => ({ pubSubConfigured: false });
  context.installAutomationTriggersUnlocked_ = () => ({
    geminiBackend: 'gemini_api', geminiAutoVertexFallbackEnabled: false
  });
  context.withCatalogLifecycleLock_ = (operation, callback) => {
    operations.push(operation);
    return callback();
  };

  context.bootstrapCatalogerInstallation({});

  assert.deepEqual(operations, [
    'installation-supplier-profile-initialization',
    'installation-spreadsheet-initialization',
    'spreadsheet',
    'installation-bootstrap'
  ]);
}

function testSupplierProfileTemplatePreservesManualContent() {
  const fixture = createSupplierProfileTemplateFixture('# Operator-maintained template');

  assert.throws(
    () => fixture.context.ensureInstallerSupplierProfileTemplate_(
      fixture.rootFolder, 'en'
    ),
    /not installer-managed or pristine/
  );
  assert.deepEqual(fixture.writes, []);
  assert.equal(fixture.files[0].getContent(), '# Operator-maintained template');
}

function testSupplierProfileTemplateCreationAndRecoveryAreJournaled() {
  const fixture = createSupplierProfileTemplateFixture();
  const created = fixture.context.ensureInstallerSupplierProfileTemplate_(
    fixture.rootFolder, 'en'
  );
  const managedState = JSON.parse(fixture.stored.SUPPLIER_PROFILE_TEMPLATE_STATE);
  assert.equal(created.getId(), 'template-file-id');
  assert.equal(managedState.status, 'managed');
  assert.equal(managedState.fileId, 'template-file-id');
  assert.equal(managedState.content, fixture.template);

  created.setContent('# Operator-maintained template');
  assert.throws(
    () => fixture.context.ensureInstallerSupplierProfileTemplate_(
      fixture.rootFolder, 'en'
    ),
    /was modified/
  );
  assert.equal(created.getContent(), '# Operator-maintained template');

  const interrupted = createSupplierProfileTemplateFixture(fixture.template, {
    status: 'planned',
    rootFolderId: 'root-folder-id',
    templateFolderId: 'template-folder-id',
    locale: 'en',
    fileName: 'PROFILE.example.md',
    fileId: '',
    targetContent: fixture.template
  });
  const adopted = interrupted.context.ensureInstallerSupplierProfileTemplate_(
    interrupted.rootFolder, 'en'
  );
  const recoveredState = JSON.parse(
    interrupted.stored.SUPPLIER_PROFILE_TEMPLATE_STATE
  );
  assert.equal(adopted.getId(), 'template-file-id');
  assert.equal(recoveredState.status, 'managed');
  assert.equal(recoveredState.fileId, 'template-file-id');
  assert.deepEqual(interrupted.writes, []);
}

function testSupplierProfileTemplateAdoptsOnlyPristineLegacyContent() {
  const template = [
    '---',
    'managed_by: Google Drive Utilities Cataloger',
    'status: approved',
    'supplier: SUPPLIER NAME',
    '---'
  ].join('\n');
  const legacy = template.replace(
    '\nmanaged_by: Google Drive Utilities Cataloger\n', '\n'
  );
  const fixture = createSupplierProfileTemplateFixture(legacy);

  fixture.context.ensureInstallerSupplierProfileTemplate_(fixture.rootFolder, 'en');

  assert.deepEqual(fixture.writes, [fixture.template]);
  const state = JSON.parse(fixture.stored.SUPPLIER_PROFILE_TEMPLATE_STATE);
  assert.equal(state.status, 'managed');
  assert.equal(state.content, fixture.template);
}

function testMissingManagedSupplierProfileTemplateIsNotReplaced() {
  const template = [
    '---',
    'managed_by: Google Drive Utilities Cataloger',
    'status: approved',
    'supplier: SUPPLIER NAME',
    '---'
  ].join('\n');
  const fixture = createSupplierProfileTemplateFixture(undefined, {
    status: 'managed',
    rootFolderId: 'root-folder-id',
    templateFolderId: 'template-folder-id',
    locale: 'en',
    fileName: 'PROFILE.example.md',
    fileId: 'template-file-id',
    content: template
  });

  assert.throws(
    () => fixture.context.ensureInstallerSupplierProfileTemplate_(
      fixture.rootFolder, 'en'
    ),
    /missing or was moved/
  );
  assert.deepEqual(fixture.writes, []);
}

function testSupplierProfileWorkspaceRejectsUnmanagedFoldersAndJournalsCreation() {
  const unmanaged = createSupplierProfileWorkspaceFixture(true);
  assert.throws(
    () => unmanaged.context.ensureInstallerSupplierProfileWorkspace_(
      unmanaged.rootFolder,
      { folder: 'Supplier Profiles', templateFolder: '_template' },
      unmanaged.context.PropertiesService.getScriptProperties()
    ),
    /not installer-managed/
  );
  assert.deepEqual(unmanaged.createOperations, []);

  const fresh = createSupplierProfileWorkspaceFixture(false);
  const workspace = fresh.context.ensureInstallerSupplierProfileWorkspace_(
    fresh.rootFolder,
    { folder: 'Supplier Profiles', templateFolder: '_template' },
    fresh.context.PropertiesService.getScriptProperties()
  );
  const state = JSON.parse(fresh.stored.SUPPLIER_PROFILE_WORKSPACE_STATE);
  assert.equal(workspace.profileRoot.getId(), 'root-folder-id/Supplier Profiles');
  assert.equal(
    workspace.templateFolder.getId(),
    'root-folder-id/Supplier Profiles/_template'
  );
  assert.equal(state.profileRootStatus, 'managed');
  assert.equal(state.templateFolderStatus, 'managed');
  assert.deepEqual(fresh.createOperations, [
    ['root-folder-id', 'Supplier Profiles'],
    ['root-folder-id/Supplier Profiles', '_template']
  ]);
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
  const localization = {
    headerAliases: {
      issueDate: ['data di emissione'],
      supplier: ['fornitore'],
      identifier: ['numero fattura'],
      sourceFile: ['file sorgente']
    }
  };
  context.getSheetLayout_ = (_sheet, headerAliases) => {
    assert.equal(headerAliases, localization.headerAliases);
    return {
      headerRow: 2,
      headers: [
        'Data di emissione',
        'Fornitore',
        'Numero fattura',
        'File sorgente'
      ]
    };
  };
  context.getInstallerLocalization_ = () => localization;
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
      locale: 'en'
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
  assert.equal(
    JSON.parse(stored.AUTOMATION_CONFIG_JSON).time_zone,
    'Europe/Rome'
  );
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
testBootstrapInitializesSpreadsheetUnderLifecycleLock();
testSupplierProfileTemplatePreservesManualContent();
testSupplierProfileTemplateCreationAndRecoveryAreJournaled();
testSupplierProfileTemplateAdoptsOnlyPristineLegacyContent();
testMissingManagedSupplierProfileTemplateIsNotReplaced();
testSupplierProfileWorkspaceRejectsUnmanagedFoldersAndJournalsCreation();
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
