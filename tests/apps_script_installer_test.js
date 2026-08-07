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
  let uuidSequence = 0;
  const context = vm.createContext({
    ScriptApp: {
      getOAuthToken: () => 'vertex-oauth-token',
      getScriptId: () => 'test-script-id'
    },
    Utilities: {
      getUuid: () => {
        uuidSequence += 1;
        return '00000000-0000-4000-8000-' +
          String(uuidSequence).padStart(12, '0');
      },
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

function createSupplierProfileWorkspaceFixture(existingProfileRoot, options = {}) {
  const stored = {};
  const createOperations = [];
  const events = [];
  const descriptionFailures = Object.assign({}, options.descriptionFailures);
  const makeFolder = (id, name) => {
    const folders = [];
    const files = [];
    let description = '';
    const folder = {
      getId: () => id,
      isTrashed: () => false,
      getFoldersByName: (requestedName) => iteratorFor(
        folders.filter((folder) => folder.getName() === requestedName)
      ),
      getFolders: () => iteratorFor(folders),
      getFiles: () => iteratorFor(files),
      getName: () => name,
      getDescription: () => description,
      setDescription: (nextDescription) => {
        if (descriptionFailures[id] > 0) {
          descriptionFailures[id] -= 1;
          events.push(['description-failed', id, nextDescription]);
          throw new Error('simulated folder marker write failure');
        }
        description = nextDescription;
        events.push(['description', id, nextDescription]);
        return folder;
      },
      createFolder: (childName) => {
        const child = makeFolder(id + '/' + childName, childName);
        folders.push(child);
        createOperations.push([id, childName]);
        events.push(['create', id, childName]);
        return child;
      }
    };
    return folder;
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
      setProperty: (key, value) => {
        stored[key] = value;
        if (key === 'SUPPLIER_PROFILE_WORKSPACE_STATE') {
          events.push(['state', JSON.parse(value)]);
        }
      }
    })
  };
  return { context, rootFolder, stored, createOperations, events };
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
    /has no durable installer ownership state/
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

  const token = '00000000-0000-4000-8000-000000000010';
  const plannedState = {
    status: 'planned',
    rootFolderId: 'root-folder-id',
    templateFolderId: 'template-folder-id',
    locale: 'en',
    fileName: 'PROFILE.example.md',
    fileId: '',
    targetContent: fixture.template,
    ownershipToken: token
  };
  const unmarked = createSupplierProfileTemplateFixture(fixture.template,
    plannedState);
  assert.throws(
    () => unmarked.context.ensureInstallerSupplierProfileTemplate_(
      unmarked.rootFolder, 'en'
    ),
    /does not match the installer-owned staging marker/
  );
  assert.deepEqual(unmarked.writes, []);

  const interrupted = createSupplierProfileTemplateFixture(
    fixture.context.getInstallerSupplierProfileTemplateStagingContent_(
      fixture.template, token
    ),
    plannedState
  );
  const adopted = interrupted.context.ensureInstallerSupplierProfileTemplate_(
    interrupted.rootFolder, 'en'
  );
  const recoveredState = JSON.parse(
    interrupted.stored.SUPPLIER_PROFILE_TEMPLATE_STATE
  );
  assert.equal(adopted.getId(), 'template-file-id');
  assert.equal(recoveredState.status, 'managed');
  assert.equal(recoveredState.fileId, 'template-file-id');
  assert.deepEqual(interrupted.writes, [interrupted.template]);
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
  const fixture = createSupplierProfileTemplateFixture(legacy, {
    status: 'managed',
    rootFolderId: 'root-folder-id',
    templateFolderId: 'template-folder-id',
    locale: 'en',
    fileName: 'PROFILE.example.md',
    fileId: 'template-file-id',
    content: legacy
  });

  fixture.context.ensureInstallerSupplierProfileTemplate_(fixture.rootFolder, 'en');

  assert.deepEqual(fixture.writes, [fixture.template]);
  const state = JSON.parse(fixture.stored.SUPPLIER_PROFILE_TEMPLATE_STATE);
  assert.equal(state.status, 'managed');
  assert.equal(state.content, fixture.template);
}

function testSupplierProfileTemplateRejectsStaticContentWithoutOwnershipState() {
  const fixture = createSupplierProfileTemplateFixture([
    '---',
    'managed_by: Google Drive Utilities Cataloger',
    'status: approved',
    'supplier: SUPPLIER NAME',
    '---'
  ].join('\n'));

  assert.throws(
    () => fixture.context.ensureInstallerSupplierProfileTemplate_(
      fixture.rootFolder, 'en'
    ),
    /has no durable installer ownership state/
  );
  assert.deepEqual(fixture.writes, []);
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

function plannedSupplierProfileFolderState(token) {
  return {
    rootFolderId: 'root-folder-id',
    profileRootParentId: 'root-folder-id',
    profileRootName: 'Supplier Profiles',
    profileRootStatus: 'planned',
    profileRootId: '',
    profileRootOwnershipToken: token
  };
}

function createdSupplierProfileFolderState(token, id) {
  const state = plannedSupplierProfileFolderState(token);
  state.profileRootStatus = 'created';
  state.profileRootId = id;
  return state;
}

function testSupplierProfileWorkspaceRejectsUnmanagedFolders() {
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
}

function testSupplierProfileWorkspaceJournalsAndMarksFreshFolders() {
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
  assert.match(state.profileRootOwnershipToken, /^[0-9a-f-]{36}$/i);
  assert.match(state.templateFolderOwnershipToken, /^[0-9a-f-]{36}$/i);
  assert.equal(
    workspace.profileRoot.getDescription(),
    fresh.context.getInstallerSupplierProfileFolderOwnershipMarker_(
      state.profileRootOwnershipToken
    )
  );
  assert.equal(
    workspace.templateFolder.getDescription(),
    fresh.context.getInstallerSupplierProfileFolderOwnershipMarker_(
      state.templateFolderOwnershipToken
    )
  );
  assert.deepEqual(fresh.createOperations, [
    ['root-folder-id', 'Supplier Profiles'],
    ['root-folder-id/Supplier Profiles', '_template']
  ]);
  const rootPlanned = fresh.events.findIndex((event) =>
    event[0] === 'state' && event[1].profileRootStatus === 'planned'
  );
  const rootCreated = fresh.events.findIndex((event) =>
    event[0] === 'create' && event[1] === 'root-folder-id'
  );
  const rootMarked = fresh.events.findIndex((event) =>
    event[0] === 'description' && event[1] === 'root-folder-id/Supplier Profiles'
  );
  const rootCheckpointed = fresh.events.findIndex((event) =>
    event[0] === 'state' && event[1].profileRootStatus === 'created' &&
      event[1].profileRootId === 'root-folder-id/Supplier Profiles'
  );
  const rootManaged = fresh.events.findIndex((event) =>
    event[0] === 'state' && event[1].profileRootStatus === 'managed'
  );
  assert.ok(rootPlanned < rootCreated);
  assert.ok(rootCreated < rootCheckpointed);
  assert.ok(rootCheckpointed < rootMarked);
  assert.ok(rootMarked < rootManaged);
}

function testSupplierProfileWorkspaceRecoversCheckpointedFolderAfterMarkerFailure() {
  const folderId = 'root-folder-id/Supplier Profiles';
  const fixture = createSupplierProfileWorkspaceFixture(false, {
    descriptionFailures: { [folderId]: 1 }
  });
  const properties = fixture.context.PropertiesService.getScriptProperties();

  assert.throws(
    () => fixture.context.ensureInstallerSupplierProfileWorkspace_(
      fixture.rootFolder,
      { folder: 'Supplier Profiles', templateFolder: '_template' },
      properties
    ),
    /simulated folder marker write failure/
  );
  const checkpoint = JSON.parse(fixture.stored.SUPPLIER_PROFILE_WORKSPACE_STATE);
  assert.equal(checkpoint.profileRootStatus, 'created');
  assert.equal(checkpoint.profileRootId, folderId);
  assert.deepEqual(fixture.createOperations, [
    ['root-folder-id', 'Supplier Profiles']
  ]);

  const workspace = fixture.context.ensureInstallerSupplierProfileWorkspace_(
    fixture.rootFolder,
    { folder: 'Supplier Profiles', templateFolder: '_template' },
    properties
  );
  const recovered = JSON.parse(fixture.stored.SUPPLIER_PROFILE_WORKSPACE_STATE);
  assert.equal(workspace.profileRoot.getId(), folderId);
  assert.equal(recovered.profileRootStatus, 'managed');
  assert.equal(recovered.profileRootId, folderId);
  assert.deepEqual(fixture.createOperations, [
    ['root-folder-id', 'Supplier Profiles'],
    [folderId, '_template']
  ]);
}

function testSupplierProfileWorkspacePromotesMarkedCheckpoint() {
  const fixture = createSupplierProfileWorkspaceFixture(false);
  const token = '00000000-0000-4000-8000-000000000014';
  const staged = fixture.rootFolder.createFolder('Supplier Profiles');
  staged.setDescription(
    fixture.context.getInstallerSupplierProfileFolderOwnershipMarker_(token)
  );
  fixture.createOperations.length = 0;
  fixture.events.length = 0;
  const state = createdSupplierProfileFolderState(token, staged.getId());
  fixture.stored.SUPPLIER_PROFILE_WORKSPACE_STATE = JSON.stringify(state);

  const promoted = fixture.context.ensureInstallerManagedSupplierProfileFolder_(
    fixture.rootFolder,
    'Supplier Profiles',
    'profileRoot',
    fixture.context.PropertiesService.getScriptProperties(),
    state
  );
  const recovered = JSON.parse(fixture.stored.SUPPLIER_PROFILE_WORKSPACE_STATE);
  assert.equal(promoted, staged);
  assert.equal(recovered.profileRootStatus, 'managed');
  assert.equal(recovered.profileRootId, staged.getId());
  assert.deepEqual(fixture.createOperations, []);
  assert.deepEqual(fixture.events, [
    ['state', recovered]
  ]);
}

function testSupplierProfileWorkspaceAdoptsOnlyExactPlannedMarker() {
  const fixture = createSupplierProfileWorkspaceFixture(false);
  const token = '00000000-0000-4000-8000-000000000010';
  const state = plannedSupplierProfileFolderState(token);
  const staged = fixture.rootFolder.createFolder('Supplier Profiles');
  staged.setDescription(
    fixture.context.getInstallerSupplierProfileFolderOwnershipMarker_(token)
  );
  fixture.createOperations.length = 0;
  fixture.events.length = 0;
  fixture.stored.SUPPLIER_PROFILE_WORKSPACE_STATE = JSON.stringify(state);

  const adopted = fixture.context.ensureInstallerManagedSupplierProfileFolder_(
    fixture.rootFolder,
    'Supplier Profiles',
    'profileRoot',
    fixture.context.PropertiesService.getScriptProperties(),
    state
  );
  const recovered = JSON.parse(fixture.stored.SUPPLIER_PROFILE_WORKSPACE_STATE);
  assert.equal(adopted, staged);
  assert.equal(recovered.profileRootStatus, 'managed');
  assert.equal(recovered.profileRootId, staged.getId());
  assert.equal(recovered.profileRootOwnershipToken, token);
  assert.deepEqual(fixture.createOperations, []);
}

function testSupplierProfileWorkspaceRejectsUnmarkedOrStalePlans() {
  const token = '00000000-0000-4000-8000-000000000011';
  const unmarked = createSupplierProfileWorkspaceFixture(false);
  const ordinaryFolder = unmarked.rootFolder.createFolder('Supplier Profiles');
  unmarked.createOperations.length = 0;
  const unmarkedState = plannedSupplierProfileFolderState(token);
  unmarked.stored.SUPPLIER_PROFILE_WORKSPACE_STATE = JSON.stringify(unmarkedState);
  assert.throws(
    () => unmarked.context.ensureInstallerManagedSupplierProfileFolder_(
      unmarked.rootFolder,
      'Supplier Profiles',
      'profileRoot',
      unmarked.context.PropertiesService.getScriptProperties(),
      unmarkedState
    ),
    /does not match the installer-owned staging marker/
  );
  assert.equal(ordinaryFolder.getDescription(), '');
  assert.deepEqual(unmarked.createOperations, []);

  const stale = createSupplierProfileWorkspaceFixture(false);
  const staleFolder = stale.rootFolder.createFolder('Supplier Profiles');
  staleFolder.setDescription(
    stale.context.getInstallerSupplierProfileFolderOwnershipMarker_(
      '00000000-0000-4000-8000-000000000012'
    )
  );
  stale.createOperations.length = 0;
  const staleState = plannedSupplierProfileFolderState(token);
  stale.stored.SUPPLIER_PROFILE_WORKSPACE_STATE = JSON.stringify(staleState);
  assert.throws(
    () => stale.context.ensureInstallerManagedSupplierProfileFolder_(
      stale.rootFolder,
      'Supplier Profiles',
      'profileRoot',
      stale.context.PropertiesService.getScriptProperties(),
      staleState
    ),
    /does not match the installer-owned staging marker/
  );
  assert.deepEqual(stale.createOperations, []);

  const legacyPlan = createSupplierProfileWorkspaceFixture(false);
  const legacyState = plannedSupplierProfileFolderState(token);
  delete legacyState.profileRootOwnershipToken;
  legacyPlan.stored.SUPPLIER_PROFILE_WORKSPACE_STATE = JSON.stringify(legacyState);
  assert.throws(
    () => legacyPlan.context.ensureInstallerManagedSupplierProfileFolder_(
      legacyPlan.rootFolder,
      'Supplier Profiles',
      'profileRoot',
      legacyPlan.context.PropertiesService.getScriptProperties(),
      legacyState
    ),
    /planned supplier profile folder state is incomplete/
  );
  assert.deepEqual(legacyPlan.createOperations, []);
}

function testSupplierProfileWorkspaceRejectsMismatchedOrMutatedCheckpoint() {
  const token = '00000000-0000-4000-8000-000000000013';
  const mismatched = createSupplierProfileWorkspaceFixture(false);
  mismatched.rootFolder.createFolder('Supplier Profiles');
  mismatched.createOperations.length = 0;
  const mismatchedState = createdSupplierProfileFolderState(
    token,
    'other-folder-id'
  );
  mismatched.stored.SUPPLIER_PROFILE_WORKSPACE_STATE = JSON.stringify(
    mismatchedState
  );
  assert.throws(
    () => mismatched.context.ensureInstallerManagedSupplierProfileFolder_(
      mismatched.rootFolder,
      'Supplier Profiles',
      'profileRoot',
      mismatched.context.PropertiesService.getScriptProperties(),
      mismatchedState
    ),
    /created supplier profile folder identity does not match/
  );
  assert.deepEqual(mismatched.createOperations, []);

  const foreign = createSupplierProfileWorkspaceFixture(false);
  const foreignFolder = foreign.rootFolder.createFolder('Supplier Profiles');
  foreignFolder.setDescription('user-owned folder');
  foreign.createOperations.length = 0;
  const foreignState = createdSupplierProfileFolderState(
    token,
    foreignFolder.getId()
  );
  foreign.stored.SUPPLIER_PROFILE_WORKSPACE_STATE = JSON.stringify(foreignState);
  assert.throws(
    () => foreign.context.ensureInstallerManagedSupplierProfileFolder_(
      foreign.rootFolder,
      'Supplier Profiles',
      'profileRoot',
      foreign.context.PropertiesService.getScriptProperties(),
      foreignState
    ),
    /does not match the installer-owned staging marker/
  );
  assert.equal(foreignFolder.getDescription(), 'user-owned folder');

  const mutated = createSupplierProfileWorkspaceFixture(false);
  const mutatedFolder = mutated.rootFolder.createFolder('Supplier Profiles');
  mutatedFolder.createFolder('user-content');
  mutated.createOperations.length = 0;
  const mutatedState = createdSupplierProfileFolderState(
    token,
    mutatedFolder.getId()
  );
  mutated.stored.SUPPLIER_PROFILE_WORKSPACE_STATE = JSON.stringify(mutatedState);
  assert.throws(
    () => mutated.context.ensureInstallerManagedSupplierProfileFolder_(
      mutated.rootFolder,
      'Supplier Profiles',
      'profileRoot',
      mutated.context.PropertiesService.getScriptProperties(),
      mutatedState
    ),
    /no longer pristine/
  );
  assert.deepEqual(mutated.createOperations, []);
}

function testSupplierProfileWorkspaceMigratesLegacyManagedWorkspace() {
  const fixture = createSupplierProfileWorkspaceFixture(false);
  const profileRoot = fixture.rootFolder.createFolder('Supplier Profiles');
  const templateFolder = profileRoot.createFolder('_template');
  fixture.createOperations.length = 0;
  fixture.stored.SUPPLIER_PROFILE_TEMPLATE_STATE = JSON.stringify({
    status: 'managed',
    rootFolderId: 'root-folder-id',
    templateFolderId: templateFolder.getId(),
    locale: 'en',
    fileName: 'PROFILE.example.md',
    fileId: 'template-file-id',
    content: 'template'
  });

  const workspace = fixture.context.ensureInstallerSupplierProfileWorkspace_(
    fixture.rootFolder,
    { folder: 'Supplier Profiles', templateFolder: '_template' },
    fixture.context.PropertiesService.getScriptProperties()
  );
  const state = JSON.parse(fixture.stored.SUPPLIER_PROFILE_WORKSPACE_STATE);
  assert.equal(workspace.profileRoot, profileRoot);
  assert.equal(workspace.templateFolder, templateFolder);
  assert.equal(state.profileRootStatus, 'managed');
  assert.equal(state.templateFolderStatus, 'managed');
  assert.equal(state.profileRootOwnershipToken, undefined);
  assert.equal(state.templateFolderOwnershipToken, undefined);
  assert.deepEqual(fixture.createOperations, []);
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

function testServiceIdentityMigrationAddsFieldsAndPreservesCharts() {
  const context = loadInstaller(() => {
    throw new Error('network must not run');
  });
  const cells = [
    ['Issue date', 'Supplier', 'Invoice number', 'Contract number',
      'Customer code', 'Reference year', 'Reference month'],
    ['2026-07-16', 'ENERGYGAS', 'INV-1', 'CON-1', 'CL-1', 2026, '07']
  ];
  const chart = {
    getOptions: () => ({
      get: (key) => ({ title: 'User chart', width: 500, height: 300 })[key]
    })
  };
  const sheet = {
    getName: () => 'Electricity',
    getLastRow: () => cells.length,
    getMaxRows: () => 100,
    getRange: (row, column, rows = 1, columns = 1) => ({
      getDisplayValue: () => String(cells[row - 1][column - 1] || ''),
      setValue: (value) => {
        while (!cells[row - 1]) {
          cells.push([]);
        }
        cells[row - 1][column - 1] = value;
      },
      setValues: (values) => values.forEach((line, rowOffset) =>
        line.forEach((value, columnOffset) => {
          while (!cells[row - 1 + rowOffset]) {
            cells.push([]);
          }
          cells[row - 1 + rowOffset][column - 1 + columnOffset] = value;
        })),
      setFontWeight: () => {},
      setBackground: () => {},
      setNumberFormat: () => {}
    }),
    insertRowsBefore: (row, count) => {
      for (let index = 0; index < count; index += 1) {
        cells.splice(row - 1, 0, Array(20).fill(''));
      }
    },
    insertColumnsBefore: (column, count) => {
      cells.forEach((line) => line.splice(column - 1, 0, ...Array(count).fill('')));
    },
    getCharts: () => [chart],
    setFrozenRows: () => {},
    autoResizeColumns: () => {}
  };
  context.getInstallerLocalization_ = () => ({
    installerSheetHeaders: [
      'Issue date', 'Supplier', 'Invoice number', 'Contract number',
      'Account holder', 'Service address', 'Customer code',
      'Reference year', 'Reference month'
    ],
    headerAliases: {
      issueDate: ['Issue date'], supplier: ['Supplier'],
      identifier: ['Invoice number'], contractNumber: ['Contract number'],
      accountHolder: ['Account holder'], serviceAddress: ['Service address'],
      customerCode: ['Customer code'], sourceFile: ['Source file']
    }
  });
  context.normalizeHeader_ = (value) => String(value).trim().toLowerCase();
  context.findHeaderIndex_ = (lookup, aliases) => {
    for (const alias of aliases) {
      const column = lookup[String(alias).trim().toLowerCase()];
      if (column) {
        return column;
      }
    }
    return 0;
  };
  context.getSheetLayout_ = (_sheet, localizationAliases) => {
    for (let row = 0; row < cells.length; row += 1) {
      const headers = cells[row];
      const lookup = {};
      headers.forEach((header, index) => {
        if (header) {
          lookup[String(header).trim().toLowerCase()] = index + 1;
        }
      });
      if (context.findHeaderIndex_(lookup, localizationAliases.issueDate) &&
        context.findHeaderIndex_(lookup, localizationAliases.supplier)) {
        return { headerRow: row + 1, headers, lookup };
      }
    }
    throw new Error('header row missing');
  };
  context.validateInstallerSheetHeaders_ = () => {};

  context.ensureInstallerServiceIdentityFields_(sheet, 'Electricity', 'en');
  context.ensureInstallerServiceIdentityFields_(sheet, 'Electricity', 'en');

  assert.deepEqual(cells[0].slice(0, 2), [
    'Controllo fornitura', 'Electricity'
  ]);
  assert.deepEqual(cells[1].slice(3, 7), [
    'Contract number', 'Account holder', 'Service address', 'Customer code'
  ]);
  assert.deepEqual(cells[2].slice(3, 7), ['CON-1', '', '', 'CL-1']);
  assert.equal(cells.length, 3);
  assert.equal(sheet.getCharts().length, 1);
  assert.equal(sheet.getCharts()[0].getOptions().get('title'), 'User chart');
}

function testServiceIdentityMigrationPreservesUnownedPreHeaderRow() {
  const context = loadInstaller(() => {
    throw new Error('fetch must not run');
  });
  const cells = [
    ['Customer instruction', '=SUM(1, 2)', 'Leave this row unchanged', '',
      '', 'Laura Fortuna', 'Via Roma 10, Cesena'],
    ['Issue date', 'Supplier', 'Invoice number', 'Contract number',
      'Customer code', 'Account holder', 'Service address'],
    ['2026-07-16', 'ENERGYGAS', 'INV-1', 'CON-1', 'CL-1', '', '']
  ];
  const sheet = {
    getName: () => 'Water',
    getLastRow: () => cells.length,
    getMaxRows: () => 100,
    getRange: (row, column, rows = 1, columns = 1) => ({
      getDisplayValue: () => String(cells[row - 1][column - 1] || ''),
      setValue: (value) => { cells[row - 1][column - 1] = value; },
      setValues: (values) => values.forEach((line, rowOffset) =>
        line.forEach((value, columnOffset) => {
          cells[row - 1 + rowOffset][column - 1 + columnOffset] = value;
        })),
      setFontWeight: () => {}
    }),
    insertRowsBefore: (row, count) => {
      for (let index = 0; index < count; index += 1) {
        cells.splice(row - 1, 0, Array(20).fill(''));
      }
    },
    insertColumnsBefore: () => { throw new Error('headers already exist'); },
    getCharts: () => [],
    setFrozenRows: () => {}
  };
  const localization = {
    installerSheetHeaders: [],
    headerAliases: {
      issueDate: ['Issue date'], supplier: ['Supplier'],
      accountHolder: ['Account holder'], serviceAddress: ['Service address'],
      customerCode: ['Customer code'], contractNumber: ['Contract number']
    }
  };
  context.getInstallerLocalization_ = () => localization;
  context.findHeaderIndex_ = (lookup, aliases) => lookup[aliases[0]] || 0;
  context.getSheetLayout_ = () => {
    const headerIndex = cells.findIndex((row) => row[0] === 'Issue date');
    const lookup = {};
    cells[headerIndex].forEach((header, index) => { lookup[header] = index + 1; });
    return { headerRow: headerIndex + 1, headers: cells[headerIndex], lookup };
  };
  context.validateInstallerSheetHeaders_ = () => {};

  context.ensureInstallerServiceIdentityFields_(sheet, 'Water', 'en');
  context.ensureInstallerServiceIdentityFields_(sheet, 'Water', 'en');

  assert.deepEqual(cells[0].slice(0, 3), [
    'Customer instruction', '=SUM(1, 2)', 'Leave this row unchanged'
  ]);
  assert.deepEqual(cells[1].slice(0, 2), ['Controllo fornitura', 'Water']);
  assert.equal(cells[2][0], 'Issue date');
  assert.equal(cells.length, 4);
}

function testExistingSheetInitializationUsesDeterministicSupply() {
  const context = loadInstaller(() => {
    throw new Error('fetch must not run');
  });
  const migratedSupplies = [];
  const sheet = { getLastRow: () => 1 };
  context.getInstallerSheetHeaders_ = () => [];
  context.ensureInstallerServiceIdentityFields_ = (_sheet, supply) => {
    migratedSupplies.push(supply);
  };
  context.initializeElectricityDashboard_ = () => {};
  const spreadsheet = {
    getSheets: () => [],
    getSheetByName: () => sheet,
    insertSheet: () => { throw new Error('existing sheet must be reused'); }
  };

  context.initializeInstallerSheets_(spreadsheet, {
    canonical_supplies: ['Water', 'Water legacy alias'],
    sheet_by_supply: { Water: 'Water', 'Water legacy alias': 'Water' },
    locale: 'en'
  }, false);

  assert.deepEqual(migratedSupplies, ['Water']);
}

function testServiceIdentityMetadataUsesDetectedColumns() {
  const context = loadInstaller(() => {
    throw new Error('fetch must not run');
  });
  const cells = [
    ['Control', 'Water', 'Existing note', '', '', 'Laura Fortuna',
      'Via Roma 10, Cesena'],
    ['Issue date', 'Supplier', 'Invoice number', 'Contract number',
      'Customer code', 'Account holder', 'Service address']
  ];
  const sheet = {
    getName: () => 'Water',
    getRange: (row, column) => ({
      getDisplayValue: () => String(cells[row - 1][column - 1] || ''),
      setValue: (value) => { cells[row - 1][column - 1] = value; },
      setFontWeight: () => {}
    })
  };
  context.getInstallerLocalization_ = () => ({
    spreadsheetLocale: 'en_US',
    headerAliases: {
      accountHolder: ['Account holder'], serviceAddress: ['Service address']
    }
  });
  context.findHeaderIndex_ = (lookup, aliases) => lookup[aliases[0]] || 0;

  context.writeInstallerServiceIdentityMetadata_(sheet, 'Water', {
    headerRow: 2,
    lookup: { 'Account holder': 6, 'Service address': 7 }
  }, 'en');

  assert.equal(cells[0][5], 'Laura Fortuna');
  assert.equal(cells[0][6], 'Via Roma 10, Cesena');
  assert.equal(cells[0][4], '');
  assert.equal(cells[0][2], 'Account holder / address: edit the control fields');
}

function testNewSupplySheetInitializesServiceIdentityControls() {
  const context = loadInstaller(() => {
    throw new Error('fetch must not run');
  });
  const cells = [];
  const sheet = {
    getLastRow: () => 0,
    getMaxRows: () => 10,
    getRange: (row, column, rows = 1, columns = 1) => ({
      getDisplayValue: () => String((cells[row - 1] || [])[column - 1] || ''),
      setValue: (value) => {
        cells[row - 1] = cells[row - 1] || [];
        cells[row - 1][column - 1] = value;
      },
      setValues: (values) => values.forEach((line, rowOffset) =>
        line.forEach((value, columnOffset) => {
          cells[row - 1 + rowOffset] = cells[row - 1 + rowOffset] || [];
          cells[row - 1 + rowOffset][column - 1 + columnOffset] = value;
        })),
      setFontWeight: () => {},
      setBackground: () => {},
      setNumberFormat: () => {}
    }),
    setFrozenRows: () => {},
    autoResizeColumns: () => {}
  };
  context.getInstallerSheetHeaders_ = () => [
    'Issue date', 'Supplier', 'Invoice number', 'Contract number',
    'Account holder', 'Service address', 'Customer code'
  ];
  context.getInstallerLocalization_ = () => ({
    spreadsheetLocale: 'en_US',
    headerAliases: {
      accountHolder: ['Account holder'], serviceAddress: ['Service address']
    }
  });
  context.normalizeHeader_ = (value) => String(value).toLowerCase();
  context.findHeaderIndex_ = (lookup, aliases) => lookup[aliases[0].toLowerCase()] || 0;
  context.initializeElectricityDashboard_ = () => {};
  const spreadsheet = {
    getSheets: () => [],
    getSheetByName: () => null,
    insertSheet: () => sheet
  };

  context.initializeInstallerSheets_(spreadsheet, {
    canonical_supplies: ['Water', 'Water legacy alias'],
    sheet_by_supply: { Water: 'Shared supply tab', 'Water legacy alias': 'Shared supply tab' },
    locale: 'en'
  }, false);

  assert.equal(cells[0][1], 'Water');
  assert.equal(cells[1][4], 'Account holder');
  assert.equal(cells[1][5], 'Service address');
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
testSupplierProfileTemplateRejectsStaticContentWithoutOwnershipState();
testMissingManagedSupplierProfileTemplateIsNotReplaced();
testSupplierProfileWorkspaceRejectsUnmanagedFolders();
testSupplierProfileWorkspaceJournalsAndMarksFreshFolders();
testSupplierProfileWorkspaceRecoversCheckpointedFolderAfterMarkerFailure();
testSupplierProfileWorkspacePromotesMarkedCheckpoint();
testSupplierProfileWorkspaceAdoptsOnlyExactPlannedMarker();
testSupplierProfileWorkspaceRejectsUnmarkedOrStalePlans();
testSupplierProfileWorkspaceRejectsMismatchedOrMutatedCheckpoint();
testSupplierProfileWorkspaceMigratesLegacyManagedWorkspace();
testSecretManagerScopeIsRestricted();
testResumedManagedSpreadsheetPlacementIsRepaired();
testPopulatedSpreadsheetSettingsAreNotChangedSilently();
testSpreadsheetValidationUsesDetectedHeaderRow();
testServiceIdentityMigrationAddsFieldsAndPreservesCharts();
testServiceIdentityMigrationPreservesUnownedPreHeaderRow();
testExistingSheetInitializationUsesDeterministicSupply();
testServiceIdentityMetadataUsesDetectedColumns();
testNewSupplySheetInitializesServiceIdentityControls();
testGeminiDeveloperApiValidation();
testVertexValidation();
testFallbackValidatesBothBackends();
testCredentialFailureIsRedacted();
testTimeZoneReconfigurationPreservesCredentialsAndTriggers();
testTimeZoneReconfigurationRollsBackRemoteState();
testTimeZoneTransactionLifecycle();

console.log('Apps Script installer tests passed.');
