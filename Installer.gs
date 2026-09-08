const INSTALLER_BOOTSTRAP_SECRET_PREFIX =
  'drive-utilities-cataloger-';

/**
 * Complete the owner-authorized installation after the CLI has created and
 * linked the Apps Script and Cloud projects.
 *
 * This function is exposed only through the owner-only API executable. It
 * never returns or logs credentials.
 */
function bootstrapCatalogerInstallation(options) {
  const validated = validateInstallerOptions_(
    readInstallerBootstrapOptions_(options)
  );
  validateInstallerGeminiAccess_(validated);
  const properties = PropertiesService.getScriptProperties();
  const priorRootFolderId = properties.getProperty(
    CONFIG.PROPERTY_KEYS.ROOT_FOLDER_ID
  );
  const resumableSpreadsheetId = !validated.spreadsheetId &&
    priorRootFolderId === validated.rootFolderId ?
    properties.getProperty(CONFIG.PROPERTY_KEYS.SPREADSHEET_ID) : '';
  const rootFolder = DriveApp.getFolderById(validated.rootFolderId);
  const policyFile = ensureInstallerPolicyFile_(rootFolder, validated.agentsPolicy);
  withCatalogLifecycleLock_('installation-supplier-profile-initialization',
    function () {
      return ensureInstallerSupplierProfileTemplate_(
        rootFolder, validated.automationConfig.locale || 'en'
      );
    });
  const spreadsheet = withCatalogLifecycleLock_(
    'installation-spreadsheet-initialization', function () {
      return ensureInstallerSpreadsheet_(
        rootFolder,
        validated.spreadsheetId || resumableSpreadsheetId,
        validated.spreadsheetTitle,
        validated.automationConfig,
        validated.timeZone,
        !validated.spreadsheetId
      );
    }
  );
  ensureInstallerDestinationFolders_(rootFolder, validated.automationConfig);

  const propertyValues = {
    GEMINI_BACKEND: validated.geminiBackend,
    GEMINI_MODEL: validated.geminiModel,
    GEMINI_AUTO_VERTEX_FALLBACK: String(validated.autoVertexFallback),
    VERTEX_AI_LOCATION: validated.vertexLocation,
    NOTIFICATION_RECIPIENT: validated.notificationRecipient,
    ROOT_FOLDER_ID: validated.rootFolderId,
    SPREADSHEET_ID: spreadsheet.getId(),
    AUTOMATION_CONFIG_JSON: JSON.stringify(validated.automationConfig),
    GOOGLE_CLOUD_PROJECT_ID: validated.projectId,
    INSTALLER_COMPLETED_AT: new Date().toISOString()
  };
  if (validated.geminiApiKey) {
    propertyValues.GEMINI_API_KEY = validated.geminiApiKey;
  } else {
    properties.deleteProperty(CONFIG.PROPERTY_KEYS.GEMINI_API_KEY);
  }
  properties.setProperties(propertyValues, false);
  properties.deleteProperty(CONFIG.PROPERTY_KEYS.GEMINI_VERTEX_FALLBACK_UNTIL);

  // Reuse the runtime validators before creating any event transport.
  assertCatalogConfiguration_();
  const lifecycleStatus = withCatalogLifecycleLock_('installation-bootstrap', function () {
    return {
      transport: provisionDriveEventTransportUnlocked_(),
      triggers: installAutomationTriggersUnlocked_()
    };
  });
  const transportStatus = lifecycleStatus.transport;
  const triggerStatus = lifecycleStatus.triggers;

  return {
    installed: true,
    projectId: validated.projectId,
    rootFolderUrl: rootFolder.getUrl(),
    policyFileUrl: policyFile.getUrl(),
    spreadsheetId: spreadsheet.getId(),
    spreadsheetUrl: spreadsheet.getUrl(),
    geminiBackend: triggerStatus.geminiBackend,
    geminiAutoVertexFallbackEnabled:
      triggerStatus.geminiAutoVertexFallbackEnabled,
    pubSubConfigured: transportStatus.pubSubConfigured,
    workspaceEventSubscription: transportStatus.workspaceEventSubscription,
    workspaceEventExpiresAt: transportStatus.workspaceEventExpiresAt
  };
}

/**
 * Add the supply-identity fields to every configured supply tab. This is an
 * owner-controlled migration for existing installations; it is idempotent
 * and refreshes the managed electricity dashboard after the source tab
 * changes.
 */
function migrateCatalogerServiceIdentityFields() {
  assertCatalogConfiguration_();
  return withCatalogLifecycleLock_('service-identity-sheet-migration', function () {
    const automationConfig = getAutomationConfig_();
    const spreadsheet = SpreadsheetApp.openById(getSpreadsheetId_());
    const seenSheets = Object.create(null);
    const migrated = [];
    automationConfig.canonical_supplies.forEach(function (supply) {
      const sheetName = automationConfig.sheet_by_supply[supply];
      if (seenSheets[sheetName]) {
        return;
      }
      const sheet = spreadsheet.getSheetByName(sheetName);
      if (!sheet) {
        throw new Error('Configured spreadsheet tab is missing: ' + sheetName);
      }
      ensureInstallerServiceIdentityFields_(sheet, supply,
        automationConfig.locale || 'en');
      migrated.push({
        supply: supply,
        sheet: sheetName,
        identityConfigured: hasInstallerServiceIdentityControls_(sheet)
      });
      seenSheets[sheetName] = true;
    });
    initializeElectricityDashboard_(spreadsheet, automationConfig);
    return { migrated: true, sheets: migrated };
  });
}

/**
 * Normalize imported reference years and months as literal text. This keeps
 * chart category labels stable for existing rows and is safe to rerun.
 */
function migrateCatalogerReferencePeriodText() {
  assertCatalogConfiguration_();
  return withCatalogLifecycleLock_('reference-period-text-migration', function () {
    const automationConfig = getAutomationConfig_();
    const spreadsheet = SpreadsheetApp.openById(getSpreadsheetId_());
    const properties = PropertiesService.getScriptProperties();
    const key = CONFIG.PROPERTY_KEYS.REFERENCE_PERIOD_MIGRATION;
    const seenSheets = Object.create(null);
    // Resolve every target before recovering or starting any row mutation.
    const targets = automationConfig.canonical_supplies.map(function (supply) {
      const sheetName = automationConfig.sheet_by_supply[supply];
      const sheet = spreadsheet.getSheetByName(sheetName);
      if (!sheet) {
        throw new Error('Configured spreadsheet tab is missing: ' + sheetName);
      }
      const sheetId = sheet.getSheetId();
      if (seenSheets[sheetId]) {
        return null;
      }
      seenSheets[sheetId] = true;
      const layout = getSheetLayout_(sheet);
      const columns = ['issueDate', 'supplier', 'year', 'month'].map(function (field) {
        return findHeaderIndex_(layout.lookup, getHeaderAliases_(field));
      });
      if (columns.some(function (column) { return !column; }) ||
        new Set(columns).size !== columns.length) {
        throw new Error('Reference period migration requires distinct issue date, supplier, year, and month headers.');
      }
      return { supply: supply, sheet: sheet, layout: layout, columns: columns, changedRows: 0 };
    }).filter(Boolean);
    const pending = properties.getProperty(key);
    if (pending !== null && pending !== '') {
      const journal = parseReferencePeriodMigration_(pending);
      const target = targets.filter(function (candidate) {
        return candidate.sheet.getSheetId() === journal.sheetId;
      })[0];
      if (!target || journal.spreadsheetId !== spreadsheet.getId() ||
        journal.sheetName !== target.sheet.getName()) {
        throw new Error('Reference period migration target changed; checkpoint retained.');
      }
      resumeReferencePeriodRow_(target, journal, properties, key);
      target.changedRows += 1;
    }
    targets.forEach(function (target) {
      const sheet = target.sheet;
      const layout = target.layout;
      const lastRow = sheet.getLastRow();
      for (let row = layout.headerRow + 1; row <= lastRow; row += 1) {
        const state = readReferencePeriodRow_(sheet, row, layout.headers.length);
        if (!state.values[target.columns[0] - 1] && !state.values[target.columns[1] - 1]) {
          continue;
        }
        const fields = [4, 2].map(function (width, index) {
          const column = target.columns[index + 2];
          const value = state.values[column - 1];
          const expected = normalizeReferencePeriodText_(value, width);
          const format = state.formats[column - 1];
          if (!expected || state.formulas[column - 1] ||
            typeof value === 'string' && value === expected && format === '@') {
            return null;
          }
          return { column: column, width: width, prior: serializeImportedCellValue_(value),
            priorFormat: format, expected: expected, stage: 'planned' };
        }).filter(Boolean);
        if (!fields.length) {
          continue;
        }
        const journal = { version: 1, spreadsheetId: spreadsheet.getId(), sheetId: sheet.getSheetId(),
          sheetName: sheet.getName(), headerRow: layout.headerRow, row: row,
          contextHash: referencePeriodRowContextHash_(layout, state, fields), fields: fields };
        saveReferencePeriodMigration_(properties, key, journal);
        resumeReferencePeriodRow_(target, journal, properties, key);
        target.changedRows += 1;
      }
    });
    return { migrated: true, sheets: targets.map(function (target) {
      return { supply: target.supply, sheet: target.sheet.getName(), changedRows: target.changedRows };
    }) };
  });
}

function readReferencePeriodRow_(sheet, row, width) {
  const range = sheet.getRange(row, 1, 1, width);
  return { values: range.getValues()[0], formulas: range.getFormulas()[0],
    formats: range.getNumberFormats()[0] };
}

function referencePeriodRowContextHash_(layout, state, fields) {
  const columns = fields.map(function (field) { return field.column; });
  const context = state.values.map(function (value, index) {
    if (columns.indexOf(index + 1) >= 0) {
      return null;
    }
    // Formula results may recalculate when period cells change; the formula
    // rather than a volatile computed value, identifies that cell. Unrelated
    // formatting is presentation state that this migration never overwrites.
    return { value: state.formulas[index] ? null : serializeImportedCellValue_(value),
      formula: state.formulas[index] };
  });
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify([layout.headerRow, layout.headers, context]), Utilities.Charset.UTF_8)
    .map(function (byte) { return ('0' + (byte & 255).toString(16)).slice(-2); }).join('');
}

function saveReferencePeriodMigration_(properties, key, journal) {
  const serialized = JSON.stringify(journal);
  // Leave headroom beneath the per-property quota, including UTF-8 text.
  if (referencePeriodMigrationBytes_(journal, serialized) > 8000) {
    throw new Error('Reference period migration checkpoint exceeds its size limit.');
  }
  properties.setProperty(key, serialized);
}

function referencePeriodMigrationBytes_(journal, serialized) {
  // Reserve the longest stage spelling before the first format write too.
  return Utilities.newBlob(serialized).getBytes().length + journal.fields.reduce(function (bytes, field) {
    return bytes + 'formatted'.length - field.stage.length;
  }, 0);
}

function parseReferencePeriodMigration_(raw) {
  if (typeof raw !== 'string' || Utilities.newBlob(raw).getBytes().length > 8000) {
    throw new Error('Invalid reference period migration checkpoint; retained for inspection.');
  }
  let journal;
  try { journal = JSON.parse(raw); } catch (error) {
    throw new Error('Invalid reference period migration checkpoint; retained for inspection.');
  }
  const exactKeys = function (value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
  };
  if (!exactKeys(journal, ['version', 'spreadsheetId', 'sheetId', 'sheetName', 'headerRow',
    'row', 'contextHash', 'fields']) || journal.version !== 1 ||
    typeof journal.spreadsheetId !== 'string' || !journal.spreadsheetId ||
    typeof journal.sheetName !== 'string' || !journal.sheetName ||
    !Number.isInteger(journal.sheetId) || journal.sheetId < 0 ||
    !Number.isInteger(journal.headerRow) || journal.headerRow < 1 ||
    !Number.isInteger(journal.row) || journal.row <= journal.headerRow ||
    typeof journal.contextHash !== 'string' || !/^[a-f0-9]{64}$/.test(journal.contextHash) ||
    !Array.isArray(journal.fields) || journal.fields.length < 1 || journal.fields.length > 2 ||
    journal.fields.some(function (field, index) {
      if (!exactKeys(field, ['column', 'width', 'prior', 'priorFormat', 'expected', 'stage']) ||
        !Number.isInteger(field.column) || field.column < 1 || [4, 2].indexOf(field.width) < 0 ||
        !exactKeys(field.prior, ['type', 'value']) ||
        typeof field.priorFormat !== 'string' || typeof field.expected !== 'string' || !field.expected ||
        ['planned', 'formatted', 'written'].indexOf(field.stage) < 0 ||
        journal.fields.slice(0, index).some(function (previous) {
          return previous.column === field.column || previous.width === field.width;
        })) {
        return true;
      }
      const prior = field.prior;
      const validValue = prior.type === 'date' ? typeof prior.value === 'number' &&
        Number.isFinite(new Date(prior.value).getTime()) :
        prior.type === 'value' && (typeof prior.value === 'string' || typeof prior.value === 'boolean' ||
          typeof prior.value === 'number' && Number.isFinite(prior.value) || prior.value === null);
      return !validValue || field.expected !== normalizeReferencePeriodText_(
        deserializeImportedCellValue_(prior), field.width);
    })) {
    throw new Error('Invalid reference period migration checkpoint; retained for inspection.');
  }
  if (referencePeriodMigrationBytes_(journal, raw) > 8000) {
    throw new Error('Reference period migration checkpoint exceeds its size limit.');
  }
  return journal;
}

function resumeReferencePeriodRow_(target, journal, properties, key) {
  const verify = function () {
    const layout = getSheetLayout_(target.sheet);
    if (target.sheet.getSheetId() !== journal.sheetId || target.sheet.getName() !== journal.sheetName ||
      layout.headerRow !== journal.headerRow || journal.row > target.sheet.getLastRow() ||
      journal.fields.some(function (field) {
        return field.column !== findHeaderIndex_(layout.lookup,
          getHeaderAliases_(field.width === 4 ? 'year' : 'month'));
      })) {
      throw new Error('Reference period migration row or layout changed; checkpoint retained.');
    }
    const state = readReferencePeriodRow_(target.sheet, journal.row, layout.headers.length);
    if (referencePeriodRowContextHash_(layout, state, journal.fields) !== journal.contextHash) {
      throw new Error('Reference period migration row contents changed; checkpoint retained.');
    }
    journal.fields.forEach(function (field) {
      const index = field.column - 1;
      const prior = JSON.stringify(serializeImportedCellValue_(state.values[index])) === JSON.stringify(field.prior);
      const expected = state.values[index] === field.expected && state.formats[index] === '@';
      const formatted = prior && state.formats[index] === '@';
      const original = prior && state.formats[index] === field.priorFormat;
      if (state.formulas[index] || !(expected || field.stage !== 'written' && formatted ||
        field.stage === 'planned' && original)) {
        throw new Error('Reference period migration cell changed; checkpoint retained.');
      }
    });
    return state;
  };
  verify();
  journal.fields.forEach(function (field) {
    let state = verify();
    const index = field.column - 1;
    if (state.values[index] !== field.expected || state.formats[index] !== '@') {
      const cell = target.sheet.getRange(journal.row, field.column);
      if (state.formats[index] !== '@') {
        cell.setNumberFormat('@');
      }
      field.stage = 'formatted';
      saveReferencePeriodMigration_(properties, key, journal);
      state = verify();
      if (state.values[index] !== field.expected) {
        setLiteralSheetValue_(cell, field.expected);
      }
    }
    field.stage = 'written';
    saveReferencePeriodMigration_(properties, key, journal);
    verify();
  });
  properties.deleteProperty(key);
}

function normalizeReferencePeriodText_(value, width) {
  if (value === null || value === undefined) {
    return '';
  }
  const text = String(value).trim();
  if (!text) {
    return '';
  }
  return width === 2 && /^\d{1,2}$/.test(text) ? text.padStart(2, '0') : text;
}

/**
 * Reconfigure only the installed time zone without reading the deleted
 * installer handoff or changing triggers and event transport.
 */
function beginCatalogerTimeZoneReconfiguration(options) {
  return withCatalogLifecycleLock_('begin-time-zone-reconfiguration', function () {
    return beginCatalogerTimeZoneReconfigurationUnlocked_(options);
  });
}

function beginCatalogerTimeZoneReconfigurationUnlocked_(options) {
  const validated = validateInstallerTimeZoneReconfiguration_(options, false);
  const properties = PropertiesService.getScriptProperties();
  const transactionKey = CONFIG.PROPERTY_KEYS.TIME_ZONE_RECONFIGURATION;
  const existingTransaction = properties.getProperty(transactionKey);
  if (existingTransaction) {
    const existing = JSON.parse(existingTransaction);
    if (existing.targetTimeZone !== validated.timeZone) {
      throw new Error('Another time-zone reconfiguration is pending.');
    }
    return existing;
  }
  const spreadsheetId = properties.getProperty(
    CONFIG.PROPERTY_KEYS.SPREADSHEET_ID
  );
  const previousConfig = properties.getProperty(
    CONFIG.PROPERTY_KEYS.AUTOMATION_CONFIG_JSON
  );
  if (!spreadsheetId || !previousConfig) {
    throw new Error('A completed cataloger installation is required.');
  }
  let automationConfig;
  try {
    automationConfig = JSON.parse(previousConfig);
  } catch (error) {
    throw new Error('Installed automation configuration is invalid JSON.');
  }
  const legacyConfigNeedsTimeZone = !Object.prototype.hasOwnProperty.call(
    automationConfig,
    'time_zone'
  );
  validateAutomationConfig_(automationConfig, {
    allowLegacyMissingTimeZone: true
  });
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const previousTimeZone = spreadsheet.getSpreadsheetTimeZone();
  if (legacyConfigNeedsTimeZone) {
    automationConfig.time_zone = previousTimeZone;
    validateAutomationConfig_(automationConfig);
    properties.setProperty(
      CONFIG.PROPERTY_KEYS.AUTOMATION_CONFIG_JSON,
      JSON.stringify(automationConfig)
    );
  } else if (automationConfig.time_zone !== previousTimeZone) {
    throw new Error(
      'Installed spreadsheet and automation configuration time zones diverge.'
    );
  }
  const transaction = {
    transactionId: Utilities.getUuid(),
    previousTimeZone: previousTimeZone,
    targetTimeZone: validated.timeZone
  };
  properties.setProperty(transactionKey, JSON.stringify(transaction));
  return transaction;
}

function reconfigureCatalogerTimeZone(options) {
  return withCatalogLifecycleLock_('apply-time-zone-reconfiguration', function () {
    return reconfigureCatalogerTimeZoneUnlocked_(options);
  });
}

function reconfigureCatalogerTimeZoneUnlocked_(options) {
  const validated = validateInstallerTimeZoneReconfiguration_(options, true);
  const properties = PropertiesService.getScriptProperties();
  const transaction = loadTimeZoneReconfiguration_(
    properties,
    validated.transactionId
  );
  if (transaction.targetTimeZone !== validated.timeZone) {
    throw new Error('Time-zone reconfiguration target does not match.');
  }
  applyCatalogerTimeZone_(properties, validated.timeZone);
  return {
    configured: true,
    timeZone: validated.timeZone,
    transactionId: validated.transactionId,
    automaticProcessingPreserved: true
  };
}

function rollbackCatalogerTimeZoneReconfiguration(options) {
  return withCatalogLifecycleLock_('rollback-time-zone-reconfiguration', function () {
    return rollbackCatalogerTimeZoneReconfigurationUnlocked_(options);
  });
}

function rollbackCatalogerTimeZoneReconfigurationUnlocked_(options) {
  const validated = validateInstallerTimeZoneTransaction_(options);
  const properties = PropertiesService.getScriptProperties();
  const transaction = loadTimeZoneReconfiguration_(
    properties,
    validated.transactionId
  );
  applyCatalogerTimeZone_(properties, transaction.previousTimeZone);
  return {
    configured: true,
    timeZone: transaction.previousTimeZone,
    transactionId: validated.transactionId
  };
}

function finishCatalogerTimeZoneReconfiguration(options) {
  return withCatalogLifecycleLock_('finish-time-zone-reconfiguration', function () {
    return finishCatalogerTimeZoneReconfigurationUnlocked_(options);
  });
}

function finishCatalogerTimeZoneReconfigurationUnlocked_(options) {
  const validated = validateInstallerTimeZoneTransaction_(options);
  const properties = PropertiesService.getScriptProperties();
  const transaction = loadTimeZoneReconfiguration_(
    properties,
    validated.transactionId
  );
  const expectedTimeZone = String(options.expectedTimeZone || '').trim();
  if (
    expectedTimeZone !== transaction.targetTimeZone &&
    expectedTimeZone !== transaction.previousTimeZone
  ) {
    throw new Error('Time-zone completion value does not match the transaction.');
  }
  assertInstalledTimeZone_(properties, expectedTimeZone);
  properties.deleteProperty(CONFIG.PROPERTY_KEYS.TIME_ZONE_RECONFIGURATION);
  return { completed: true, timeZone: expectedTimeZone };
}

function applyCatalogerTimeZone_(properties, timeZone) {
  const spreadsheetId = properties.getProperty(
    CONFIG.PROPERTY_KEYS.SPREADSHEET_ID
  );
  const previousConfig = properties.getProperty(
    CONFIG.PROPERTY_KEYS.AUTOMATION_CONFIG_JSON
  );
  const automationConfig = JSON.parse(previousConfig);
  automationConfig.time_zone = timeZone;
  validateAutomationConfig_(automationConfig);
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const previousTimeZone = spreadsheet.getSpreadsheetTimeZone();

  try {
    spreadsheet.setSpreadsheetTimeZone(timeZone);
    properties.setProperty(
      CONFIG.PROPERTY_KEYS.AUTOMATION_CONFIG_JSON,
      JSON.stringify(automationConfig)
    );
    assertCatalogConfiguration_();
    if (spreadsheet.getSpreadsheetTimeZone() !== timeZone) {
      throw new Error('Spreadsheet did not retain the configured time zone.');
    }
  } catch (error) {
    let rollbackError = null;
    try {
      spreadsheet.setSpreadsheetTimeZone(previousTimeZone);
      properties.setProperty(
        CONFIG.PROPERTY_KEYS.AUTOMATION_CONFIG_JSON,
        previousConfig
      );
    } catch (restoreError) {
      rollbackError = restoreError;
    }
    if (rollbackError) {
      throw new Error(
        'Time-zone reconfiguration failed and rollback was incomplete: ' +
        rollbackError.message
      );
    }
    throw error;
  }

}

function assertInstalledTimeZone_(properties, expectedTimeZone) {
  const automationConfig = JSON.parse(properties.getProperty(
    CONFIG.PROPERTY_KEYS.AUTOMATION_CONFIG_JSON
  ));
  const spreadsheet = SpreadsheetApp.openById(properties.getProperty(
    CONFIG.PROPERTY_KEYS.SPREADSHEET_ID
  ));
  if (
    automationConfig.time_zone !== expectedTimeZone ||
    spreadsheet.getSpreadsheetTimeZone() !== expectedTimeZone
  ) {
    throw new Error('Installed time-zone state did not converge.');
  }
}

function loadTimeZoneReconfiguration_(properties, transactionId) {
  const serialized = properties.getProperty(
    CONFIG.PROPERTY_KEYS.TIME_ZONE_RECONFIGURATION
  );
  if (!serialized) {
    throw new Error('No time-zone reconfiguration is pending.');
  }
  const transaction = JSON.parse(serialized);
  if (transaction.transactionId !== transactionId) {
    throw new Error('Time-zone reconfiguration transaction does not match.');
  }
  return transaction;
}

function validateInstallerTimeZoneReconfiguration_(options, requireTransaction) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Time-zone reconfiguration options must be an object.');
  }
  const timeZone = String(options.timeZone || '').trim();
  if (!isValidIanaTimeZone_(timeZone)) {
    throw new Error(
      'Time-zone reconfiguration requires a valid IANA time zone.'
    );
  }
  const validated = { timeZone: timeZone };
  if (requireTransaction) {
    validated.transactionId = validateInstallerTimeZoneTransaction_(
      options
    ).transactionId;
  }
  return validated;
}

function validateInstallerTimeZoneTransaction_(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Time-zone transaction options must be an object.');
  }
  const transactionId = String(options.transactionId || '').trim();
  if (!transactionId) {
    throw new Error('Time-zone reconfiguration transaction is required.');
  }
  return { transactionId: transactionId };
}

/**
 * Verify the installed resources without processing intake PDFs.
 */
function validateCatalogerInstallation() {
  assertCatalogConfiguration_();
  const rootFolder = DriveApp.getFolderById(getRootFolderId_());
  loadTrustedExtractionPolicy_(rootFolder);
  validateInstallerConfiguredSheets_();
  getSheetHeadersBySupply_();

  const triggerStatus = getAutomationTriggerStatus_();
  const setup = getSetupStatus();
  let workspaceEventActive = false;
  let workspaceEventError = '';
  try {
    validateDriveEventTopology_();
    workspaceEventActive = true;
  } catch (error) {
    workspaceEventError = error.message;
  }

  return {
    installed: setup.rootFolderConfigured &&
      setup.spreadsheetConfigured &&
      setup.automationConfigConfigured &&
      setup.cloudProjectConfigured &&
      setup.pubSubConfigured &&
      workspaceEventActive &&
      triggerStatus.missingTriggerHandlers.length === 0 &&
      triggerStatus.duplicateTriggerHandlers.length === 0,
    missingTriggerHandlers: triggerStatus.missingTriggerHandlers,
    duplicateTriggerHandlers: triggerStatus.duplicateTriggerHandlers,
    triggerCounts: triggerStatus.triggerCounts,
    workspaceEventActive: workspaceEventActive,
    workspaceEventError: workspaceEventError,
    geminiBackend: setup.geminiBackend,
    geminiApiKeyConfigured: setup.geminiApiKeyConfigured,
    pubSubConfigured: setup.pubSubConfigured
  };
}

/**
 * Validate the configured Gemini model against every enabled backend without
 * exposing the stored API key or performing a document-generation request.
 * This is owner-controlled operational validation for model migrations.
 */
function validateConfiguredGeminiAccess() {
  const backend = getGeminiBackend_();
  const autoVertexFallback = isAutomaticVertexFallbackEnabled_();
  const model = getGeminiModel_();
  const options = {
    projectId: getScriptProperty_(CONFIG.PROPERTY_KEYS.GOOGLE_CLOUD_PROJECT_ID),
    geminiBackend: backend,
    geminiApiKey: getScriptProperty_(CONFIG.PROPERTY_KEYS.GEMINI_API_KEY),
    geminiModel: model,
    autoVertexFallback: autoVertexFallback,
    vertexLocation: getVertexAiLocation_()
  };
  const geminiApi = validateConfiguredGeminiBackend_(
    'gemini_api', backend === 'gemini_api', options);
  const vertexAi = validateConfiguredGeminiBackend_(
    'vertex_ai', backend === 'vertex_ai' || autoVertexFallback, options);
  return {
    applicationVersion: CONFIG.APP_VERSION,
    geminiBackend: backend,
    geminiModel: model,
    ready: (!geminiApi.enabled || geminiApi.available) &&
      (!vertexAi.enabled || vertexAi.available),
    geminiApiValidated: geminiApi.metadataValidated,
    geminiApiGenerationValidated: geminiApi.generationValidated,
    vertexAiValidated: vertexAi.metadataValidated,
    vertexAiGenerationValidated: vertexAi.generationValidated,
    backends: {
      gemini_api: geminiApi,
      vertex_ai: vertexAi
    }
  };
}

function validateConfiguredGeminiBackend_(backend, enabled, options) {
  const result = {
    enabled: enabled,
    metadataValidated: false,
    generationValidated: false,
    available: false
  };
  if (!enabled) {
    return result;
  }
  try {
    if (backend === 'gemini_api') {
      validateInstallerGeminiDeveloperApi_(options);
    } else {
      validateInstallerVertexAi_(options);
    }
    result.metadataValidated = true;
  } catch (error) {
    return addConfiguredGeminiFailure_(result, 'metadata', error);
  }
  try {
    if (backend === 'gemini_api') {
      validateConfiguredGeminiDeveloperGeneration_(options);
    } else {
      validateConfiguredVertexGeneration_(options);
    }
    result.generationValidated = true;
    result.available = true;
    return result;
  } catch (error) {
    return addConfiguredGeminiFailure_(result, 'generation', error);
  }
}

function addConfiguredGeminiFailure_(result, stage, error) {
  result.failureStage = stage;
  const statusMatch = String(error && error.message || error).match(/HTTP ([0-9]{3})/);
  if (statusMatch) {
    result.httpStatus = Number(statusMatch[1]);
  }
  result.reason = error && error.geminiHighDemand === true ?
    'high-demand' : 'validation-failed';
  return result;
}

function validateConfiguredGeminiDeveloperGeneration_(options) {
  const response = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': options.geminiApiKey },
      payload: JSON.stringify({
        model: options.geminiModel,
        input: 'Reply with exactly OK.',
        generation_config: {
          max_output_tokens: 256,
          thinking_level: 'low'
        },
        store: false
      }),
      muteHttpExceptions: true
    });
  validateConfiguredGenerationResponse_(response, 'Gemini Developer API', true);
}

function validateConfiguredVertexGeneration_(options) {
  const endpoint = 'https://aiplatform.googleapis.com/v1/projects/' +
    encodeURIComponent(options.projectId) +
    '/locations/' + encodeURIComponent(options.vertexLocation) +
    '/publishers/google/models/' + encodeURIComponent(options.geminiModel) +
    ':generateContent';
  const response = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly OK.' }] }],
      generationConfig: {
        maxOutputTokens: 256,
        thinkingConfig: { thinkingBudget: 128 }
      }
    }),
    muteHttpExceptions: true
  });
  validateConfiguredGenerationResponse_(response, 'Vertex AI', false);
}

function validateConfiguredGenerationResponse_(response, provider, interactions) {
  const statusCode = response.getResponseCode();
  if (statusCode !== 200) {
    const failure = new Error(provider +
      ' generation readiness validation failed (HTTP ' + statusCode + ').');
    failure.geminiHighDemand = interactions && statusCode === 500 &&
      isConfiguredGeminiHighDemandResponse_(response);
    throw failure;
  }
  let body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error(provider +
      ' generation readiness validation returned invalid JSON.');
  }
  const completed = interactions ?
    body.status === 'completed' && Array.isArray(body.steps) &&
      body.steps.some(function (step) {
        return step && step.type === 'model_output';
      }) :
    Array.isArray(body.candidates) && body.candidates.some(function (candidate) {
      return candidate && candidate.finishReason === 'STOP';
    });
  if (!completed) {
    throw new Error(provider +
      ' generation readiness validation did not complete successfully.');
  }
}

function isConfiguredGeminiHighDemandResponse_(response) {
  try {
    const body = JSON.parse(response.getContentText());
    return Boolean(body && body.error && typeof body.error.message === 'string' &&
      /\bcurrently\s+experiencing\s+high\s+demand\b/i.test(body.error.message));
  } catch (error) {
    return false;
  }
}

function validateInstallerOptions_(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Installer options must be an object.');
  }

  const requiredText = [
    'projectId',
    'rootFolderId',
    'spreadsheetTitle',
    'notificationRecipient',
    'geminiBackend',
    'geminiModel',
    'vertexLocation',
    'agentsPolicy',
    'timeZone'
  ];
  requiredText.forEach(function (key) {
    if (!String(options[key] || '').trim()) {
      throw new Error('Installer option is required: ' + key);
    }
  });

  if (['gemini_api', 'vertex_ai'].indexOf(options.geminiBackend) < 0) {
    throw new Error('Installer geminiBackend must be gemini_api or vertex_ai.');
  }
  if (options.geminiBackend === 'gemini_api' &&
    !String(options.geminiApiKey || '').trim()) {
    throw new Error('Installer Gemini API credential is required for gemini_api.');
  }
  if (!options.automationConfig ||
    typeof options.automationConfig !== 'object' ||
    Array.isArray(options.automationConfig)) {
    throw new Error('Installer automationConfig must be an object.');
  }

  const config = options.automationConfig;
  validateAutomationConfig_(config);
  if (config.time_zone !== String(options.timeZone).trim()) {
    throw new Error(
      'Installer timeZone must match automationConfig.time_zone.'
    );
  }
  ['canonical_supplies', 'canonical_suppliers', 'address_rules'].forEach(
    function (key) {
      if (!Array.isArray(config[key])) {
        throw new Error('Installer automationConfig requires the ' + key + ' array.');
      }
    }
  );
  ['supply_aliases', 'supplier_aliases', 'destination_templates',
    'sheet_by_supply'].forEach(function (key) {
    if (!config[key] || typeof config[key] !== 'object' ||
      Array.isArray(config[key])) {
      throw new Error('Installer automationConfig requires the ' + key + ' object.');
    }
  });
  if (getSupportedLocales_().indexOf(config.locale || 'en') < 0) {
    throw new Error(
      'Installer automationConfig locale must be one of: ' +
        getSupportedLocales_().join(', ') + '.'
    );
  }

  return {
    projectId: String(options.projectId).trim(),
    rootFolderId: String(options.rootFolderId).trim(),
    spreadsheetId: String(options.spreadsheetId || '').trim(),
    spreadsheetTitle: String(options.spreadsheetTitle).trim(),
    notificationRecipient: String(options.notificationRecipient).trim(),
    geminiBackend: options.geminiBackend,
    geminiApiKey: String(options.geminiApiKey || '').trim(),
    geminiModel: normalizeGeminiModel_(options.geminiModel),
    autoVertexFallback: options.autoVertexFallback === true,
    vertexLocation: String(options.vertexLocation).trim(),
    automationConfig: config,
    agentsPolicy: String(options.agentsPolicy),
    timeZone: String(options.timeZone).trim()
  };
}

function readInstallerBootstrapOptions_(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
    !String(options.bootstrapSecretVersion || '').trim()) {
    throw new Error('Installer bootstrapSecretVersion is required.');
  }
  const secretVersion = String(options.bootstrapSecretVersion).trim();
  const secretId = INSTALLER_BOOTSTRAP_SECRET_PREFIX +
    ScriptApp.getScriptId();
  const match = secretVersion.match(
    /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/secrets\/([^/]+)\/versions\/([0-9]+)$/
  );
  if (!match || match[2] !== secretId) {
    throw new Error(
      'Installer bootstrap secret does not belong to this Apps Script project.'
    );
  }

  const response = UrlFetchApp.fetch(
    'https://secretmanager.googleapis.com/v1/' +
      secretVersion + ':access',
    {
      method: 'get',
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken()
      },
      muteHttpExceptions: true
    }
  );
  const statusCode = response.getResponseCode();
  if (statusCode !== 200) {
    throw new Error(
      'Could not access the temporary installer bootstrap data (HTTP ' +
      statusCode + ').'
    );
  }

  let secretResponse;
  try {
    secretResponse = JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error('Secret Manager returned an invalid response.');
  }
  const encodedPayload = secretResponse.payload &&
    secretResponse.payload.data;
  if (!encodedPayload) {
    throw new Error('The temporary installer bootstrap data is empty.');
  }
  let privateOptions;
  try {
    privateOptions = JSON.parse(Utilities.newBlob(
      Utilities.base64Decode(encodedPayload)
    ).getDataAsString());
  } catch (error) {
    throw new Error('The temporary installer bootstrap data is invalid.');
  }
  if (!privateOptions || typeof privateOptions !== 'object' ||
    Array.isArray(privateOptions) || privateOptions.projectId !== match[1]) {
    throw new Error(
      'Installer bootstrap data does not match the selected Cloud project.'
    );
  }
  return privateOptions;
}

/**
 * Rotate only the Gemini Developer API credential from a private handoff.
 *
 * This owner-only maintenance entrypoint deliberately preserves the existing
 * installation, transport, triggers, and Vertex fallback configuration.
 * The secret version contains the cataloger's Cloud project identity so the
 * existing installation handoff ownership checks remain in force.
 */
function rotateGeminiDeveloperApiKeyFromSecret(options) {
  return withCatalogLifecycleLock_('gemini-api-key-rotation', function () {
    const properties = PropertiesService.getScriptProperties();
    const installedProject = properties.getProperty(
      CONFIG.PROPERTY_KEYS.GOOGLE_CLOUD_PROJECT_ID);
    if (!installedProject) {
      throw new Error('Configure the installation Cloud project before key rotation.');
    }
    const privateOptions = readInstallerBootstrapOptions_(options);
    if (privateOptions.projectId !== installedProject) {
      throw new Error('Credential handoff does not match the installed Cloud project.');
    }
    const apiKey = String(privateOptions.geminiApiKey || '').trim();
    const apiProjectId = String(privateOptions.geminiApiProjectId || '').trim();
    if (!apiKey) {
      throw new Error('Gemini Developer API key is missing from the handoff.');
    }
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(apiProjectId)) {
      throw new Error('Gemini API project identity is invalid.');
    }
    validateInstallerGeminiDeveloperApi_({
      geminiApiKey: apiKey,
      geminiModel: getGeminiModel_()
    });
    properties.setProperty(CONFIG.PROPERTY_KEYS.GEMINI_API_KEY, apiKey);
    return Object.assign(getSetupStatus(), {
      geminiApiProjectId: apiProjectId
    });
  });
}

function validateInstallerGeminiAccess_(options) {
  if (options.geminiBackend === 'gemini_api') {
    validateInstallerGeminiDeveloperApi_(options);
  }
  if (options.geminiBackend === 'vertex_ai' || options.autoVertexFallback) {
    validateInstallerVertexAi_(options);
  }
}

function validateInstallerGeminiDeveloperApi_(options) {
  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(options.geminiModel);
  const response = UrlFetchApp.fetch(endpoint, {
    method: 'get',
    headers: {
      'x-goog-api-key': options.geminiApiKey
    },
    muteHttpExceptions: true
  });
  const statusCode = response.getResponseCode();
  if (statusCode !== 200) {
    throw new Error(
      'Gemini Developer API key or model validation failed (HTTP ' +
      statusCode + ').'
    );
  }

  let model;
  try {
    model = JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error('Gemini Developer API returned invalid model metadata.');
  }
  if (!Array.isArray(model.supportedGenerationMethods) ||
    model.supportedGenerationMethods.indexOf('generateContent') < 0) {
    throw new Error(
      'The selected Gemini Developer API model does not support generateContent.'
    );
  }
}

function validateInstallerVertexAi_(options) {
  const modelResource = 'projects/' + options.projectId +
    '/locations/' + options.vertexLocation +
    '/publishers/google/models/' + options.geminiModel;
  const endpoint = 'https://aiplatform.googleapis.com/v1/projects/' +
    encodeURIComponent(options.projectId) +
    '/locations/' + encodeURIComponent(options.vertexLocation) +
    '/publishers/google/models/' + encodeURIComponent(options.geminiModel) +
    ':countTokens';
  const response = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken()
    },
    payload: JSON.stringify({
      model: modelResource,
      contents: [{
        role: 'user',
        parts: [{ text: 'installation-check' }]
      }]
    }),
    muteHttpExceptions: true
  });
  const statusCode = response.getResponseCode();
  if (statusCode !== 200) {
    throw new Error(
      'Vertex AI project, location, or model validation failed (HTTP ' +
      statusCode + ').'
    );
  }

  let tokenCount;
  try {
    tokenCount = JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error('Vertex AI returned invalid token-count metadata.');
  }
  if (!isFinite(Number(tokenCount.totalTokens)) ||
    Number(tokenCount.totalTokens) <= 0) {
    throw new Error('Vertex AI did not return a valid token count.');
  }
}

function ensureInstallerPolicyFile_(rootFolder, policyText) {
  const files = rootFolder.getFilesByName(CONFIG.DRIVE_AGENTS_FILE_NAME);
  const matches = [];
  while (files.hasNext()) {
    const file = files.next();
    if (!file.isTrashed()) {
      matches.push(file);
    }
  }
  if (matches.length > 1) {
    throw new Error('The intake folder contains multiple AGENTS.md files.');
  }
  if (matches.length === 1) {
    const existing = matches[0];
    if (existing.getSize() > CONFIG.MAX_AGENTS_FILE_BYTES) {
      throw new Error('The existing intake AGENTS.md exceeds the size limit.');
    }
    const policy = existing.getBlob().getDataAsString('UTF-8').trim();
    if (!policy || policy.indexOf('\u0000') >= 0) {
      throw new Error('The existing intake AGENTS.md is empty or unreadable.');
    }
    return existing;
  }
  if (Utilities.newBlob(policyText).getBytes().length >
    CONFIG.MAX_AGENTS_FILE_BYTES) {
    throw new Error('The policy template exceeds the AGENTS.md size limit.');
  }
  return rootFolder.createFile(
    CONFIG.DRIVE_AGENTS_FILE_NAME,
    policyText,
    MimeType.PLAIN_TEXT
  );
}

function ensureInstallerSupplierProfileTemplate_(rootFolder, locale) {
  const names = getSupplierProfileNamesForLocale_(locale);
  const properties = PropertiesService.getScriptProperties();
  const workspace = ensureInstallerSupplierProfileWorkspace_(rootFolder, names,
    properties);
  const profileRoot = workspace.profileRoot;
  const templateFolder = workspace.templateFolder;
  const template = getLocalizedSupplierProfileTemplate_(locale);
  let state = getSupplierProfileTemplateState_(properties);
  const files = templateFolder.getFilesByName(names.templateFile);
  const matches = [];
  while (files.hasNext()) {
    const file = files.next();
    if (!file.isTrashed()) {
      matches.push(file);
    }
  }
  if (matches.length > 1) {
    throw new Error('More than one supplier profile template exists.');
  }
  if (matches.length === 0 && state && state.fileId) {
    throw new Error('The installer-managed supplier profile template is missing ' +
      'or was moved; refusing to create a replacement.');
  }
  if (matches.length === 1) {
    return reconcileInstallerSupplierProfileTemplate_(matches[0], rootFolder,
      templateFolder, locale, names.templateFile, template, properties, state);
  }
  state = buildSupplierProfileTemplateState_('planned', rootFolder,
    templateFolder, locale, names.templateFile, '', '');
  state.targetContent = template;
  state.ownershipToken = createInstallerSupplierProfileTemplateOwnershipToken_();
  delete state.content;
  saveSupplierProfileTemplateState_(properties, state);
  const created = templateFolder.createFile(
    names.templateFile,
    getInstallerSupplierProfileTemplateStagingContent_(template, state.ownershipToken),
    MimeType.PLAIN_TEXT
  );
  state.fileId = created.getId();
  state.status = 'created';
  saveSupplierProfileTemplateState_(properties, state);
  return reconcileInstallerSupplierProfileTemplate_(created, rootFolder,
    templateFolder, locale, names.templateFile, template, properties, state);
}

function reconcileInstallerSupplierProfileTemplate_(file, rootFolder,
  templateFolder, locale, fileName, template, properties, state) {
  const currentContent = file.getBlob().getDataAsString('UTF-8');
  if (!state) {
    throw new Error('The existing supplier profile template has no durable ' +
      'installer ownership state; refusing to adopt it.');
  } else {
    assertSupplierProfileTemplateStateMatches_(state, file, rootFolder,
      templateFolder, fileName);
    if (state.status === 'planned') {
      const stagingContent = getInstallerSupplierProfileTemplateStagingContent_(
        state.targetContent, state.ownershipToken
      );
      if (currentContent !== stagingContent) {
        throw new Error('The planned supplier profile template does not match the ' +
          'installer-owned staging marker; refusing to adopt it.');
      }
      state.fileId = file.getId();
      state.status = 'created';
      saveSupplierProfileTemplateState_(properties, state);
    }
    if (state.status === 'created') {
      if (currentContent !== getInstallerSupplierProfileTemplateStagingContent_(
        state.targetContent, state.ownershipToken
      )) {
        throw new Error('The created supplier profile template does not match the ' +
          'installer-owned staging marker; refusing to resume it.');
      }
      state.status = 'updating';
      state.content = currentContent;
      saveSupplierProfileTemplateState_(properties, state);
    } else if (state.status === 'updating') {
      if (currentContent === state.targetContent) {
        state.status = 'managed';
        state.content = state.targetContent;
        delete state.targetContent;
        delete state.ownershipToken;
        saveSupplierProfileTemplateState_(properties, state);
        return file;
      }
      if (currentContent !== state.content) {
        throw new Error('The managed supplier profile template was modified; ' +
          'refusing to overwrite it.');
      }
    } else if (state.status !== 'managed' || currentContent !== state.content) {
      throw new Error('The managed supplier profile template was modified; ' +
        'refusing to overwrite it.');
    }
  }

  if (currentContent === template) {
    return file;
  }
  state.status = 'updating';
  state.targetContent = template;
  saveSupplierProfileTemplateState_(properties, state);
  file.setContent(template);
  state.status = 'managed';
  state.content = template;
  delete state.targetContent;
  delete state.ownershipToken;
  saveSupplierProfileTemplateState_(properties, state);
  return file;
}

function getSupplierProfileTemplateState_(properties) {
  const raw = properties.getProperty(
    CONFIG.PROPERTY_KEYS.SUPPLIER_PROFILE_TEMPLATE_STATE
  );
  if (!raw) {
    return null;
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (error) {
    throw new Error('The supplier profile template state is malformed.');
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('The supplier profile template state is malformed.');
  }
  if (['planned', 'created', 'managed', 'updating'].indexOf(state.status) < 0 ||
    ['rootFolderId', 'templateFolderId', 'locale', 'fileName'].some(
      function (key) { return typeof state[key] !== 'string' || !state[key]; }
    ) || (state.status === 'planned' &&
      (state.fileId !== '' || typeof state.targetContent !== 'string' ||
        !state.targetContent ||
        !isInstallerSupplierProfileTemplateOwnershipToken_(state.ownershipToken))) ||
    (state.status === 'created' &&
      (typeof state.fileId !== 'string' || !state.fileId ||
        typeof state.targetContent !== 'string' || !state.targetContent ||
        !isInstallerSupplierProfileTemplateOwnershipToken_(state.ownershipToken))) ||
    (state.status === 'managed' &&
      (typeof state.fileId !== 'string' || !state.fileId ||
        typeof state.content !== 'string' || !state.content)) ||
    (state.status === 'updating' &&
      (typeof state.fileId !== 'string' || !state.fileId ||
        typeof state.content !== 'string' || !state.content ||
        typeof state.targetContent !== 'string' || !state.targetContent))) {
    throw new Error('The supplier profile template state is incomplete.');
  }
  return state;
}

function saveSupplierProfileTemplateState_(properties, state) {
  properties.setProperty(CONFIG.PROPERTY_KEYS.SUPPLIER_PROFILE_TEMPLATE_STATE,
    JSON.stringify(state));
}

function buildSupplierProfileTemplateState_(status, rootFolder, templateFolder,
  locale, fileName, fileId, content) {
  return {
    status: status,
    rootFolderId: rootFolder.getId(),
    templateFolderId: templateFolder.getId(),
    locale: locale,
    fileName: fileName,
    fileId: fileId,
    content: content
  };
}

function assertSupplierProfileTemplateStateMatches_(state, file, rootFolder,
  templateFolder, fileName) {
  if (state.rootFolderId !== rootFolder.getId() ||
    state.templateFolderId !== templateFolder.getId() ||
    state.fileName !== fileName ||
    (state.fileId && state.fileId !== file.getId())) {
    throw new Error('The supplier profile template identity does not match the ' +
      'installer-managed resource.');
  }
}

function createInstallerSupplierProfileTemplateOwnershipToken_() {
  const token = Utilities.getUuid();
  if (!isInstallerSupplierProfileTemplateOwnershipToken_(token)) {
    throw new Error('Could not generate a valid supplier profile template ownership token.');
  }
  return token;
}

function getInstallerSupplierProfileTemplateStagingContent_(template, token) {
  if (!isInstallerSupplierProfileTemplateOwnershipToken_(token)) {
    throw new Error('The planned supplier profile template state is incomplete.');
  }
  return template + '\n<!-- Google Drive Utilities Cataloger supplier profile template ownership: ' +
    token + ' -->';
}

function isInstallerSupplierProfileTemplateOwnershipToken_(token) {
  return typeof token === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
}

function ensureInstallerSupplierProfileWorkspace_(rootFolder, names, properties) {
  let state = getSupplierProfileWorkspaceState_(properties);
  if (!state) {
    state = migrateLegacySupplierProfileWorkspaceState_(rootFolder, names,
      properties);
  }
  const profileRoot = ensureInstallerManagedSupplierProfileFolder_(rootFolder,
    names.folder, 'profileRoot', properties, state);
  state = getSupplierProfileWorkspaceState_(properties);
  const templateFolder = ensureInstallerManagedSupplierProfileFolder_(
    profileRoot, names.templateFolder, 'templateFolder', properties, state
  );
  return { profileRoot: profileRoot, templateFolder: templateFolder };
}

function ensureInstallerManagedSupplierProfileFolder_(parent, name, key,
  properties, state) {
  const matches = getSingleNamedInstallerFolder_(parent, name);
  const idKey = key + 'Id';
  const nameKey = key + 'Name';
  const parentKey = key + 'ParentId';
  const statusKey = key + 'Status';
  const ownershipTokenKey = key + 'OwnershipToken';
  const isNewTemplateFolder = state && key === 'templateFolder' &&
    state.profileRootStatus === 'managed' &&
    state.templateFolderStatus === undefined;
  if (!state || isNewTemplateFolder) {
    if (matches.length > 0) {
      throw new Error('The existing supplier profile folder is not installer-managed; ' +
        'refusing to adopt it.');
    }
    state = state || { rootFolderId: parent.getId() };
    state[parentKey] = parent.getId();
    state[nameKey] = name;
    state[statusKey] = 'planned';
    state[idKey] = '';
    state[ownershipTokenKey] = createInstallerSupplierProfileFolderOwnershipToken_();
    saveSupplierProfileWorkspaceState_(properties, state);
  } else if (state[statusKey] !== undefined) {
    assertInstallerSupplierProfileFolderState_(state, parent, name, key);
  } else {
    throw new Error('The supplier profile workspace state is incomplete.');
  }
  if (state[statusKey] === 'managed') {
    if (matches.length !== 1 || matches[0].getId() !== state[idKey]) {
      throw new Error('The installer-managed supplier profile folder identity ' +
        'does not match the recorded resource.');
    }
    return matches[0];
  }
  if (state[statusKey] !== 'planned' && state[statusKey] !== 'created') {
    throw new Error('The supplier profile folder state is invalid.');
  }
  const marker = getInstallerSupplierProfileFolderOwnershipMarker_(
    state[ownershipTokenKey]
  );
  let folder;
  if (state[statusKey] === 'planned') {
    if (matches.length === 1) {
      if (matches[0].getDescription() !== marker ||
        !isPristineInstallerSupplierProfileFolder_(matches[0])) {
        throw new Error('The planned supplier profile folder does not match the ' +
          'installer-owned staging marker; refusing to adopt it.');
      }
      state[idKey] = matches[0].getId();
      state[statusKey] = 'managed';
      saveSupplierProfileWorkspaceState_(properties, state);
      return matches[0];
    }
    folder = parent.createFolder(name);
    state[idKey] = folder.getId();
    state[statusKey] = 'created';
    saveSupplierProfileWorkspaceState_(properties, state);
  } else {
    if (matches.length !== 1 || matches[0].getId() !== state[idKey]) {
      throw new Error('The created supplier profile folder identity does not ' +
        'match the recorded resource.');
    }
    folder = matches[0];
    if (!isPristineInstallerSupplierProfileFolder_(folder)) {
      throw new Error('The created supplier profile folder is no longer pristine; ' +
        'refusing to resume it.');
    }
  }
  if (folder.getDescription() === '') {
    folder.setDescription(marker);
  } else if (folder.getDescription() !== marker) {
    throw new Error('The created supplier profile folder does not match the ' +
      'installer-owned staging marker; refusing to resume it.');
  }
  state[statusKey] = 'managed';
  saveSupplierProfileWorkspaceState_(properties, state);
  return folder;
}

function getSingleNamedInstallerFolder_(parent, name) {
  const folders = parent.getFoldersByName(name);
  const matches = [];
  while (folders.hasNext()) {
    const folder = folders.next();
    if (!folder.isTrashed()) {
      matches.push(folder);
    }
  }
  if (matches.length > 1) {
    throw new Error('More than one folder exists: ' + name + '.');
  }
  return matches;
}

function isPristineInstallerSupplierProfileFolder_(folder) {
  return !folder.getFiles().hasNext() && !folder.getFolders().hasNext();
}

function createInstallerSupplierProfileFolderOwnershipToken_() {
  const token = Utilities.getUuid();
  if (!isInstallerSupplierProfileFolderOwnershipToken_(token)) {
    throw new Error('Could not generate a valid supplier profile folder ownership token.');
  }
  return token;
}

function getInstallerSupplierProfileFolderOwnershipMarker_(token) {
  if (!isInstallerSupplierProfileFolderOwnershipToken_(token)) {
    throw new Error('The planned supplier profile folder state is incomplete.');
  }
  return 'Google Drive Utilities Cataloger supplier profile ownership: ' + token;
}

function isInstallerSupplierProfileFolderOwnershipToken_(token) {
  return typeof token === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
}

function getSupplierProfileWorkspaceState_(properties) {
  const raw = properties.getProperty(
    CONFIG.PROPERTY_KEYS.SUPPLIER_PROFILE_WORKSPACE_STATE
  );
  if (!raw) {
    return null;
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (error) {
    throw new Error('The supplier profile workspace state is malformed.');
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('The supplier profile workspace state is malformed.');
  }
  return state;
}

function saveSupplierProfileWorkspaceState_(properties, state) {
  properties.setProperty(CONFIG.PROPERTY_KEYS.SUPPLIER_PROFILE_WORKSPACE_STATE,
    JSON.stringify(state));
}

function assertInstallerSupplierProfileFolderState_(state, parent, name, key) {
  const status = state[key + 'Status'];
  const id = state[key + 'Id'];
  if ((key === 'profileRoot' && state.rootFolderId !== parent.getId()) ||
    state[key + 'ParentId'] !== parent.getId() ||
    state[key + 'Name'] !== name) {
    throw new Error('The supplier profile folder state does not match the ' +
      'configured parent and name.');
  }
  if (status === 'managed' && (typeof id !== 'string' || !id)) {
    throw new Error('The managed supplier profile folder state is incomplete.');
  }
  if (status === 'planned' && (id !== '' ||
    !isInstallerSupplierProfileFolderOwnershipToken_(
      state[key + 'OwnershipToken']
    ))) {
    throw new Error('The planned supplier profile folder state is incomplete.');
  }
  if (status === 'created' && (typeof id !== 'string' || !id ||
    !isInstallerSupplierProfileFolderOwnershipToken_(
      state[key + 'OwnershipToken']
    ))) {
    throw new Error('The created supplier profile folder state is incomplete.');
  }
}

function migrateLegacySupplierProfileWorkspaceState_(rootFolder, names,
  properties) {
  const templateState = getSupplierProfileTemplateState_(properties);
  if (!templateState || templateState.status !== 'managed' ||
    templateState.rootFolderId !== rootFolder.getId()) {
    return null;
  }
  const profileRoots = getSingleNamedInstallerFolder_(rootFolder, names.folder);
  if (profileRoots.length !== 1) {
    return null;
  }
  const templateFolders = getSingleNamedInstallerFolder_(profileRoots[0],
    names.templateFolder);
  if (templateFolders.length !== 1 ||
    templateFolders[0].getId() !== templateState.templateFolderId) {
    return null;
  }
  const state = {
    rootFolderId: rootFolder.getId(),
    profileRootParentId: rootFolder.getId(),
    profileRootName: names.folder,
    profileRootStatus: 'managed',
    profileRootId: profileRoots[0].getId(),
    templateFolderParentId: profileRoots[0].getId(),
    templateFolderName: names.templateFolder,
    templateFolderStatus: 'managed',
    templateFolderId: templateFolders[0].getId()
  };
  saveSupplierProfileWorkspaceState_(properties, state);
  return state;
}

function getLocalizedSupplierProfileTemplate_(locale) {
  const localization = getLocalizationRegistry_()[locale];
  if (!localization || !localization.supplierProfileTemplate) {
    throw new Error('Unsupported supplier-profile locale: ' + locale);
  }
  return localization.supplierProfileTemplate.join('\n');
}

function ensureInstallerSpreadsheet_(rootFolder, spreadsheetId, title,
  automationConfig, timeZone, placeInRoot) {
  let spreadsheet;
  let created = false;
  if (spreadsheetId) {
    spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  } else {
    spreadsheet = SpreadsheetApp.create(title);
    PropertiesService.getScriptProperties().setProperties({
      ROOT_FOLDER_ID: rootFolder.getId(),
      SPREADSHEET_ID: spreadsheet.getId()
    }, false);
    created = true;
  }

  if (placeInRoot) {
    DriveApp.getFileById(spreadsheet.getId()).moveTo(rootFolder);
  }
  const localization = getInstallerLocalization_(
    automationConfig.locale || 'en'
  );
  const canConfigureSettings = created || placeInRoot ||
    spreadsheet.getSheets().every(function (sheet) {
      return sheet.getLastRow() === 0;
    });
  if (canConfigureSettings) {
    spreadsheet.setSpreadsheetTimeZone(timeZone);
    spreadsheet.setSpreadsheetLocale(localization.spreadsheetLocale);
  } else {
    if (spreadsheet.getSpreadsheetTimeZone() !== timeZone) {
      throw new Error(
        'Existing non-empty spreadsheet time zone must match: ' + timeZone
      );
    }
    if (spreadsheet.getSpreadsheetLocale() !==
      localization.spreadsheetLocale) {
      throw new Error(
        'Existing non-empty spreadsheet locale must match: ' +
          localization.spreadsheetLocale
      );
    }
  }
  initializeInstallerSheets_(spreadsheet, automationConfig, created);
  return spreadsheet;
}

function initializeInstallerSheets_(spreadsheet, automationConfig, created) {
  const sheetNames = [];
  const supplyBySheetName = Object.create(null);
  const electricitySheetNames = Object.create(null);
  automationConfig.canonical_supplies.forEach(function (supply) {
    const sheetName = automationConfig.sheet_by_supply[supply];
    if (!sheetName) {
      throw new Error('No spreadsheet tab is configured for supply: ' + supply);
    }
    if (sheetNames.indexOf(sheetName) === -1) {
      sheetNames.push(sheetName);
      supplyBySheetName[sheetName] = supply;
    }
    if (/^(electricity|luce)$/i.test(String(supply))) {
      electricitySheetNames[sheetName] = true;
    }
  });
  if (sheetNames.length === 0) {
    throw new Error('At least one spreadsheet tab must be configured.');
  }

  const initialSheets = spreadsheet.getSheets();
  if (created && initialSheets.length === 1 &&
    initialSheets[0].getLastRow() === 0) {
    initialSheets[0].setName(sheetNames[0]);
  }

  sheetNames.forEach(function (sheetName) {
    const headers = getInstallerSheetHeaders_(automationConfig.locale || 'en',
      Boolean(electricitySheetNames[sheetName]));
    const sheet = spreadsheet.getSheetByName(sheetName) ||
      spreadsheet.insertSheet(sheetName);
    if (sheet.getLastRow() === 0) {
      const headerRange = sheet.getRange(2, 1, 1, headers.length);
      headerRange.setValues([headers]);
      headerRange.setFontWeight('bold');
      headerRange.setBackground('#d9ead3');
      const lookup = Object.create(null);
      headers.forEach(function (header, index) {
        lookup[normalizeHeader_(header)] = index + 1;
      });
      writeInstallerServiceIdentityMetadata_(sheet, supplyBySheetName[sheetName], {
        headerRow: 2,
        lookup: lookup
      }, automationConfig.locale || 'en');
      sheet.setFrozenRows(2);
      sheet.getRange(3, 1, Math.max(1, sheet.getMaxRows() - 2), 1)
        .setNumberFormat('yyyy-mm-dd');
      sheet.getRange(3, 11, Math.max(1, sheet.getMaxRows() - 2), 4)
        .setNumberFormat('#,##0.00');
      sheet.autoResizeColumns(1, headers.length);
    } else {
      ensureInstallerServiceIdentityFields_(sheet, supplyBySheetName[sheetName],
        automationConfig.locale || 'en');
    }
  });
  initializeElectricityDashboard_(spreadsheet, automationConfig);

}

function ensureInstallerServiceIdentityFields_(sheet, supply, locale) {
  const localization = getInstallerLocalization_(locale);
  let layout = getSheetLayout_(sheet, localization.headerAliases);
  validateInstallerSheetHeaders_(sheet, locale);
  validateInstallerServiceIdentityControlPlacement_(layout, localization);
  const migration = beginInstallerServiceIdentityMigration_(sheet, supply,
    layout);
  const beforeCharts = migration.chartState;
  if (layout.headerRow === 1 ||
    !hasInstallerServiceIdentityMetadataRow_(sheet, layout)) {
    const rowAlreadyInserted = (migration.stages.controlRow === 'planned' ||
      migration.stages.controlRow === 'completed') &&
      isInstallerPristineControlRow_(sheet, layout, migration.headerRow);
    if (rowAlreadyInserted) {
      checkpointInstallerServiceIdentityMigration_(migration, {
        stages: { controlRow: 'completed' }
      });
    } else if (migration.stages.controlRow) {
      throw new Error('Service-identity migration checkpointed control row is no longer pristine.');
    } else {
      checkpointInstallerServiceIdentityMigration_(migration, {
        headerRow: layout.headerRow,
        stages: { controlRow: 'planned' }
      });
      sheet.insertRowsBefore(layout.headerRow, 1);
      checkpointInstallerServiceIdentityMigration_(migration, {
        stages: { controlRow: 'completed' }
      });
    }
    layout = getSheetLayout_(sheet, localization.headerAliases);
  }

  const holderHeader = localization.installerSheetHeaders[
    localization.installerSheetHeaders.indexOf('Account holder') >= 0 ?
      localization.installerSheetHeaders.indexOf('Account holder') :
      localization.installerSheetHeaders.indexOf('Intestatario')
  ];
  const addressHeader = localization.installerSheetHeaders[
    localization.installerSheetHeaders.indexOf('Service address') >= 0 ?
      localization.installerSheetHeaders.indexOf('Service address') :
      localization.installerSheetHeaders.indexOf('Indirizzo di fornitura')
  ];
  const holderColumn = findHeaderIndex_(layout.lookup,
    localization.headerAliases.accountHolder);
  const addressColumn = findHeaderIndex_(layout.lookup,
    localization.headerAliases.serviceAddress);
  const missingHeaders = [];
  if (!holderColumn) {
    missingHeaders.push(holderHeader);
  }
  if (!addressColumn) {
    missingHeaders.push(addressHeader);
  }
  if (missingHeaders.length > 0) {
    const insertionColumn = getInstallerServiceIdentityInsertionColumn_(layout,
      localization);
    if (!insertionColumn) {
      throw new Error('Cannot locate the contract or customer header in sheet ' +
        sheet.getName() + '.');
    }
    if (insertionColumn <= 3) {
      throw new Error('Service-identity columns cannot overlap the reserved ' +
        'migration control columns in sheet ' + sheet.getName() + '.');
    }
    const columnsAlreadyInserted =
      (migration.stages.identityColumns === 'planned' ||
        migration.stages.identityColumns === 'completed') &&
      isInstallerPristineIdentityColumns_(sheet, layout, migration);
    if (columnsAlreadyInserted) {
      checkpointInstallerServiceIdentityMigration_(migration, {
        stages: { identityColumns: 'completed' }
      });
    } else if (migration.stages.identityColumns) {
      throw new Error('Service-identity migration checkpointed columns are no longer pristine.');
    } else {
      checkpointInstallerServiceIdentityMigration_(migration, {
        insertionColumn: insertionColumn,
        missingHeaders: missingHeaders,
        stages: { identityColumns: 'planned' }
      });
      sheet.insertColumnsBefore(insertionColumn, missingHeaders.length);
      checkpointInstallerServiceIdentityMigration_(migration, {
        stages: { identityColumns: 'completed' }
      });
    }
    const headersAlreadyWritten =
      (migration.stages.identityHeaders === 'planned' ||
        migration.stages.identityHeaders === 'completed') &&
      hasInstallerIdentityHeaders_(sheet, layout, migration);
    if (headersAlreadyWritten) {
      checkpointInstallerServiceIdentityMigration_(migration, {
        stages: { identityHeaders: 'completed' }
      });
    } else {
      checkpointInstallerServiceIdentityMigration_(migration, {
        stages: { identityHeaders: 'planned' }
      });
      sheet.getRange(layout.headerRow,
        migration.insertionColumn || insertionColumn, 1,
        missingHeaders.length).setValues([missingHeaders]);
      checkpointInstallerServiceIdentityMigration_(migration, {
        stages: { identityHeaders: 'completed' }
      });
    }
    layout = getSheetLayout_(sheet, localization.headerAliases);
  }

  checkpointInstallerServiceIdentityMigration_(migration, {
    stages: { metadata: 'planned' }
  });
  writeInstallerServiceIdentityMetadata_(sheet, supply, layout, locale);
  checkpointInstallerServiceIdentityMigration_(migration, {
    stages: { metadata: 'completed' }
  });
  checkpointInstallerServiceIdentityMigration_(migration, {
    stages: { frozenRows: 'planned' }
  });
  sheet.setFrozenRows(Math.max(2, layout.headerRow));
  checkpointInstallerServiceIdentityMigration_(migration, {
    stages: { frozenRows: 'completed' }
  });
  checkpointInstallerServiceIdentityMigration_(migration, {
    stages: { charts: 'planned' }
  });
  restoreInstallerSheetChartState_(beforeCharts, sheet);
  assertInstallerSheetChartStatePreserved_(beforeCharts, sheet);
  checkpointInstallerServiceIdentityMigration_(migration, {
    stages: { charts: 'completed' }
  });
  clearInstallerServiceIdentityMigration_(migration);
  return layout;
}

function validateInstallerServiceIdentityControlPlacement_(layout, localization) {
  const normalizeHeader = typeof normalizeHeader_ === 'function' ?
    normalizeHeader_ : function (value) { return String(value || '').trim().toLowerCase(); };
  const reservedIdentityAliases = localization.headerAliases.accountHolder
    .concat(localization.headerAliases.serviceAddress)
    .map(normalizeHeader);
  (layout.headers || []).forEach(function (header, index) {
    if (reservedIdentityAliases.indexOf(normalizeHeader(header)) >= 0 &&
      index + 1 <= 3) {
      throw new Error('Service-identity columns cannot overlap the reserved ' +
        'migration control columns.');
    }
  });
  const holderColumn = findHeaderIndex_(layout.lookup,
    localization.headerAliases.accountHolder);
  const addressColumn = findHeaderIndex_(layout.lookup,
    localization.headerAliases.serviceAddress);
  if ((holderColumn && holderColumn <= 3) || (addressColumn && addressColumn <= 3)) {
    throw new Error('Service-identity columns cannot overlap the reserved ' +
      'migration control columns.');
  }
  if (holderColumn && addressColumn) {
    return;
  }
  const insertionColumn = getInstallerServiceIdentityInsertionColumn_(layout,
    localization);
  if (!insertionColumn || insertionColumn <= 3) {
    throw new Error('Service-identity columns cannot overlap the reserved ' +
      'migration control columns.');
  }
}

function getInstallerServiceIdentityInsertionColumn_(layout, localization) {
  const holderColumn = findHeaderIndex_(layout.lookup,
    localization.headerAliases.accountHolder);
  const addressColumn = findHeaderIndex_(layout.lookup,
    localization.headerAliases.serviceAddress);
  const customerColumn = findHeaderIndex_(layout.lookup,
    localization.headerAliases.customerCode);
  const contractColumn = findHeaderIndex_(layout.lookup,
    localization.headerAliases.contractNumber);
  if (!holderColumn && addressColumn) {
    return addressColumn;
  }
  if (!addressColumn && holderColumn) {
    return holderColumn + 1;
  }
  return customerColumn || contractColumn + 1;
}

function isInstallerPristineControlRow_(sheet, layout, expectedHeaderRow) {
  if (!expectedHeaderRow || layout.headerRow !== expectedHeaderRow + 1) {
    return false;
  }
  const values = sheet.getRange(layout.headerRow - 1, 1, 1,
    Math.max(1, layout.headers.length)).getDisplayValues();
  return values[0].every(function (value) {
    return String(value || '').trim() === '';
  });
}

function isInstallerPristineIdentityColumns_(sheet, layout, migration) {
  if (!migration.insertionColumn || !Array.isArray(migration.missingHeaders) ||
    migration.missingHeaders.length === 0) {
    return false;
  }
  const values = sheet.getRange(layout.headerRow, migration.insertionColumn, 1,
    migration.missingHeaders.length).getDisplayValues();
  return values[0].every(function (value) {
    return String(value || '').trim() === '';
  });
}

function hasInstallerIdentityHeaders_(sheet, layout, migration) {
  if (!migration.insertionColumn || !Array.isArray(migration.missingHeaders) ||
    migration.missingHeaders.length === 0) {
    return false;
  }
  const values = sheet.getRange(layout.headerRow, migration.insertionColumn, 1,
    migration.missingHeaders.length).getDisplayValues()[0];
  return migration.missingHeaders.every(function (header, index) {
    return String(values[index] || '').trim() === String(header).trim();
  });
}

function beginInstallerServiceIdentityMigration_(sheet, supply, layout) {
  if (typeof PropertiesService === 'undefined' || typeof CONFIG === 'undefined' ||
    !CONFIG.PROPERTY_KEYS.SERVICE_IDENTITY_MIGRATION_PREFIX ||
    typeof sheet.getSheetId !== 'function') {
    return { disabled: true, chartState: captureInstallerSheetChartState_(sheet),
      stages: {} };
  }
  const properties = PropertiesService.getScriptProperties();
  const key = CONFIG.PROPERTY_KEYS.SERVICE_IDENTITY_MIGRATION_PREFIX +
    sheet.getSheetId();
  const raw = properties.getProperty(key);
  let journal = raw ? JSON.parse(raw) : null;
  if (journal && (journal.sheetId !== sheet.getSheetId() ||
    journal.sheetName !== sheet.getName() || journal.supply !== supply)) {
    throw new Error('Service-identity migration checkpoint does not match sheet ' +
      sheet.getName() + '.');
  }
  if (!journal) {
    journal = {
      sheetId: sheet.getSheetId(),
      sheetName: sheet.getName(),
      supply: supply,
      chartState: captureInstallerSheetChartState_(sheet),
      stages: {}
    };
    properties.setProperty(key, JSON.stringify(journal));
  }
  journal.properties = properties;
  journal.key = key;
  journal.stages = journal.stages || {};
  return journal;
}

function checkpointInstallerServiceIdentityMigration_(migration, changes) {
  if (!migration || migration.disabled) {
    return;
  }
  if (changes.stages) {
    Object.keys(changes.stages).forEach(function (stage) {
      migration.stages[stage] = changes.stages[stage];
    });
  }
  Object.keys(changes).forEach(function (key) {
    if (key !== 'stages') {
      migration[key] = changes[key];
    }
  });
  migration.properties.setProperty(migration.key, JSON.stringify({
    sheetId: migration.sheetId,
    sheetName: migration.sheetName,
    supply: migration.supply,
    headerRow: migration.headerRow,
    insertionColumn: migration.insertionColumn,
    missingHeaders: migration.missingHeaders,
    chartState: migration.chartState,
    stages: migration.stages
  }));
}

function clearInstallerServiceIdentityMigration_(migration) {
  if (migration && !migration.disabled) {
    migration.properties.deleteProperty(migration.key);
  }
}

function hasInstallerServiceIdentityMetadataRow_(sheet, layout) {
  if (!sheet || !layout || layout.headerRow <= 1) {
    return false;
  }
  return String(
    sheet.getRange(layout.headerRow - 1, 1).getDisplayValue() || ''
  ).trim() === 'Controllo fornitura';
}

function writeInstallerServiceIdentityMetadata_(sheet, supply, layout, locale) {
  const headerRow = layout.headerRow;
  const metadataRow = headerRow > 1 ? headerRow - 1 : 1;
  const localization = getInstallerLocalization_(locale || 'en');
  validateInstallerServiceIdentityControlPlacement_(layout, localization);
  const isItalian = localization.spreadsheetLocale === 'it_IT';
  const holderColumn = findHeaderIndex_(layout.lookup,
    localization.headerAliases.accountHolder);
  const addressColumn = findHeaderIndex_(layout.lookup,
    localization.headerAliases.serviceAddress);
  if (!holderColumn || !addressColumn) {
    throw new Error('Cannot locate service-identity headers in sheet ' +
      sheet.getName() + '.');
  }
  const currentSupply = String(sheet.getRange(metadataRow, 2).getDisplayValue() || '').trim();
  const holderControl = sheet.getRange(metadataRow, holderColumn);
  const addressControl = sheet.getRange(metadataRow, addressColumn);
  const currentHolder = headerRow > 1 ?
    String(holderControl.getDisplayValue() || '').trim() : '';
  const currentAddress = headerRow > 1 ?
    String(addressControl.getDisplayValue() || '').trim() : '';
  const controlLabels = getInstallerServiceIdentityControlLabels_(localization);
  const holderValue = isInstallerServiceIdentityPlaceholder_(currentHolder,
    'accountHolder') ||
    !currentHolder ? controlLabels.accountHolderPlaceholder : currentHolder;
  const addressValue = isInstallerServiceIdentityPlaceholder_(currentAddress,
    'serviceAddress') ||
    !currentAddress ? controlLabels.serviceAddressPlaceholder : currentAddress;
  sheet.getRange(metadataRow, 1).setValue('Controllo fornitura');
  sheet.getRange(metadataRow, 2).setValue(currentSupply || supply);
  sheet.getRange(metadataRow, 3).setValue(
    isItalian ? 'Intestatario / indirizzo: modifica i campi di controllo' :
      'Account holder / address: edit the control fields'
  );
  writeInstallerServiceIdentityControlValue_(holderControl, holderValue);
  writeInstallerServiceIdentityControlValue_(addressControl, addressValue);
  styleInstallerServiceIdentityControl_(holderControl, holderValue,
    controlLabels.accountHolderPlaceholder, controlLabels.note, 'accountHolder');
  styleInstallerServiceIdentityControl_(addressControl, addressValue,
    controlLabels.serviceAddressPlaceholder, controlLabels.note, 'serviceAddress');
  updateInstallerServiceIdentityConditionalFormatting_(sheet, [
    { range: holderControl, placeholder: controlLabels.accountHolderPlaceholder,
      fieldKey: 'accountHolder' },
    { range: addressControl, placeholder: controlLabels.serviceAddressPlaceholder,
      fieldKey: 'serviceAddress' }
  ]);
  sheet.getRange(metadataRow, 1, 1, 3).setFontWeight('bold');
}

function getInstallerServiceIdentityControlLabels_(localization) {
  const isItalian = localization.spreadsheetLocale === 'it_IT';
  const configured = localization.serviceIdentityControls || {};
  return {
    accountHolderPlaceholder: configured.accountHolderPlaceholder ||
      (isItalian ? "Scrivi qui il nome dell'intestatario" :
        'Enter account holder here'),
    serviceAddressPlaceholder: configured.serviceAddressPlaceholder ||
      (isItalian ? "Scrivi qui l'indirizzo di fornitura" :
        'Enter service address here'),
    note: isItalian ?
      'Compila questo controllo manualmente oppure lascia che la prima fattura valida lo configuri.' :
      'Complete this control manually or let the first valid invoice configure it.'
  };
}

function getInstallerServiceIdentityPlaceholderValues_(fieldKey) {
  const values = [];
  const add = function (value) {
    const text = String(value || '').trim();
    if (text && values.indexOf(text) < 0) {
      values.push(text);
    }
  };
  const fallback = {
    accountHolder: [
      'Enter account holder here',
      "Scrivi qui il nome dell'intestatario"
    ],
    serviceAddress: [
      'Enter service address here',
      "Scrivi qui l'indirizzo di fornitura"
    ]
  };
  if (typeof getLocalizationRegistry_ !== 'function') {
    (fallback[fieldKey] || []).forEach(add);
    return values;
  }
  const registry = getLocalizationRegistry_();
  Object.keys(registry).forEach(function (locale) {
    const labels = getInstallerServiceIdentityControlLabels_(registry[locale]);
    add(fieldKey === 'accountHolder' ? labels.accountHolderPlaceholder :
      fieldKey === 'serviceAddress' ? labels.serviceAddressPlaceholder : '');
  });
  return values;
}

function isInstallerServiceIdentityPlaceholder_(value, fieldKey) {
  const text = String(value || '').trim();
  if (!text) {
    return false;
  }
  if (fieldKey) {
    return getInstallerServiceIdentityPlaceholderValues_(fieldKey)
      .indexOf(text) >= 0;
  }
  return getInstallerServiceIdentityPlaceholderValues_('accountHolder')
    .concat(getInstallerServiceIdentityPlaceholderValues_('serviceAddress'))
    .indexOf(text) >= 0;
}

function styleInstallerServiceIdentityControl_(control, value, placeholder,
  note, fieldKey) {
  const displayedValue = typeof control.getDisplayValue === 'function' ?
    String(control.getDisplayValue() || '').trim() : String(value || '').trim();
  const configured = Boolean(displayedValue &&
    !isInstallerServiceIdentityPlaceholder_(displayedValue, fieldKey));
  if (typeof control.setBackground === 'function') {
    control.setBackground(configured ? '#d9ead3' : '#fce8b2');
  }
  if (typeof control.setFontColor === 'function') {
    control.setFontColor(configured ? '#274e13' : '#7f6000');
  }
  if (typeof control.setFontWeight === 'function') {
    control.setFontWeight('bold');
  }
  if (typeof control.setNote === 'function') {
    control.setNote(note);
  }
  if (typeof control.setBorder === 'function') {
    const borderStyle = typeof SpreadsheetApp !== 'undefined' &&
      SpreadsheetApp.BorderStyle ?
      SpreadsheetApp.BorderStyle.SOLID_THICK : null;
    control.setBorder(true, true, true, true, false, false,
      configured ? '#6aa84f' : '#e69138', borderStyle);
  }
}

function updateInstallerServiceIdentityConditionalFormatting_(sheet,
  controls) {
  if (typeof SpreadsheetApp === 'undefined' ||
    typeof SpreadsheetApp.newConditionalFormatRule !== 'function' ||
    typeof sheet.getConditionalFormatRules !== 'function' ||
    typeof sheet.setConditionalFormatRules !== 'function') {
    return;
  }
  const rules = sheet.getConditionalFormatRules().filter(function (rule) {
    if (!rule || typeof rule.getBooleanCondition !== 'function') {
      return true;
    }
    const condition = rule.getBooleanCondition();
    if (!condition || typeof condition.getCriteriaValues !== 'function') {
      return true;
    }
    return !condition.getCriteriaValues().some(function (value) {
      return String(value || '').indexOf('GDUC_IDENTITY_') >= 0;
    });
  });
  controls.forEach(function (control) {
    if (!control.range || typeof control.range.getA1Notation !== 'function') {
      return;
    }
    const cell = control.range.getA1Notation().replace(
      /^([A-Z]+)(\d+)$/,
      '$$$1$$$2'
    );
    const placeholders = getInstallerServiceIdentityPlaceholderValues_(
      control.fieldKey);
    const warningTerms = ['(' + cell + '="")'].concat(placeholders.map(
      function (value) {
        return '(' + cell + '="' + value.replace(/"/g, '""') + '")';
      }));
    const warningFormula = '=' + warningTerms.join('+') +
      '+N("GDUC_IDENTITY_WARNING")';
    const configuredTerms = ['(' + cell + '<>"")'].concat(placeholders.map(
      function (value) {
        return '(' + cell + '<>"' + value.replace(/"/g, '""') + '")';
      }));
    const configuredFormula = '=' + configuredTerms.join('*') +
      '+N("GDUC_IDENTITY_CONFIGURED")';
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(warningFormula)
      .setBackground('#fce8b2')
      .setFontColor('#7f6000')
      .setBold(true)
      .setRanges([control.range])
      .build());
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(configuredFormula)
      .setBackground('#d9ead3')
      .setFontColor('#274e13')
      .setBold(true)
      .setRanges([control.range])
      .build());
  });
  sheet.setConditionalFormatRules(rules);
}

function writeInstallerServiceIdentityControlValue_(control, value) {
  if (typeof control.getFormula === 'function' && control.getFormula()) {
    return;
  }
  control.setValue(value);
}

function hasInstallerServiceIdentityControls_(sheet) {
  const layout = getSheetLayout_(sheet);
  const holderColumn = findHeaderIndex_(layout.lookup,
    getHeaderAliases_('accountHolder'));
  const addressColumn = findHeaderIndex_(layout.lookup,
    getHeaderAliases_('serviceAddress'));
  if (layout.headerRow <= 1 || !holderColumn || !addressColumn) {
    return false;
  }
  const holder = String(sheet.getRange(layout.headerRow - 1,
    holderColumn).getDisplayValue() || '').trim();
  const address = String(sheet.getRange(layout.headerRow - 1,
    addressColumn).getDisplayValue() || '').trim();
  return Boolean(holder && address &&
    !isInstallerServiceIdentityPlaceholder_(holder, 'accountHolder') &&
    !isInstallerServiceIdentityPlaceholder_(address, 'serviceAddress'));
}

function captureInstallerSheetChartState_(sheet) {
  if (!sheet || typeof sheet.getCharts !== 'function') {
    return [];
  }
  return sheet.getCharts().map(function (chart) {
    const options = typeof chart.getOptions === 'function' ? chart.getOptions() : null;
    const container = typeof chart.getContainerInfo === 'function' ?
      chart.getContainerInfo() : null;
    const builder = typeof chart.modify === 'function' ? chart.modify() : null;
    const builderState = {};
    ['ChartType', 'HiddenDimensionStrategy', 'MergeStrategy', 'NumHeaders',
      'TransposeRowsAndColumns'].forEach(function (property) {
      const getter = 'get' + property;
      if (builder && typeof builder[getter] === 'function') {
        builderState[property.charAt(0).toLowerCase() + property.slice(1)] =
          builder[getter]();
      } else if (typeof chart[getter] === 'function') {
        builderState[property.charAt(0).toLowerCase() + property.slice(1)] =
          chart[getter]();
      }
    });
    return {
      title: options ? String(options.get('title') || '') : '',
      width: options ? Number(options.get('width')) || 0 : 0,
      height: options ? Number(options.get('height')) || 0 : 0,
      row: container ? container.getAnchorRow() : 0,
      column: container ? container.getAnchorColumn() : 0,
      offsetX: container ? container.getOffsetX() : 0,
      offsetY: container ? container.getOffsetY() : 0,
      // Ranges are deliberately descriptive only. Inserting the control row
      // or identity columns makes Sheets adjust local chart ranges itself; a
      // later rebuild from this pre-mutation A1 notation would undo that
      // adjustment and can also move an external-sheet range onto this sheet.
      sourceRanges: typeof chart.getRanges === 'function' ? chart.getRanges().map(
        captureInstallerChartRangeDescriptor_) : [],
      options: captureInstallerChartOptions_(options),
      builderState: builderState
    };
  });
}

function captureInstallerChartRangeDescriptor_(range) {
  const rangeSheet = range && typeof range.getSheet === 'function' ?
    range.getSheet() : null;
  return {
    a1Notation: range && typeof range.getA1Notation === 'function' ?
      range.getA1Notation() : '',
    sheetId: rangeSheet && typeof rangeSheet.getSheetId === 'function' ?
      rangeSheet.getSheetId() : null,
    sheetName: rangeSheet && typeof rangeSheet.getName === 'function' ?
      rangeSheet.getName() : ''
  };
}

function captureInstallerChartOptions_(options) {
  // This is intentionally scoped to source-sheet migration. The dashboard
  // snapshot has a different managed-range lifecycle and its tests load that
  // source independently from Installer.gs.
  const preserved = {};
  if (!options) {
    return preserved;
  }
  ['annotations', 'areaOpacity', 'backgroundColor', 'bar', 'chartArea',
    'colors', 'curveType', 'dataOpacity', 'enableInteractivity', 'explorer',
    'fontName', 'fontSize', 'hAxis', 'height', 'is3D', 'isStacked', 'legend',
    'lineWidth', 'orientation', 'pieHole', 'pieSliceText', 'pointShape',
    'pointSize', 'reverseCategories', 'series', 'theme', 'tooltip',
    'trendlines', 'vAxes', 'vAxis', 'width', 'subtitle', 'subtitleTextStyle',
    'titleTextStyle', 'animation', 'axisTitlesPosition', 'crosshair',
    'focusTarget', 'histogram', 'interpolateNulls', 'intervals',
    'selectionMode', 'slices', 'targetAxisIndex', 'viewWindowMode'].forEach(
    function (key) {
      const value = options.get(key);
      if (value !== null && value !== undefined) {
        preserved[key] = value;
      }
    });
  return preserved;
}

function restoreInstallerSheetChartState_(before, sheet) {
  if (!before || typeof sheet.getCharts !== 'function' ||
    typeof sheet.updateChart !== 'function') {
    return;
  }
  const after = sheet.getCharts();
  before.forEach(function (state, index) {
    const chart = after[index];
    if (!chart || typeof chart.modify !== 'function') {
      return;
    }
    const builder = chart.modify();
    // Do not clear or re-add chart ranges. Apps Script has already preserved
    // their source-sheet binding and adjusted local coordinates for the row
    // and column insertions performed by this migration.
    if (typeof builder.setPosition === 'function') {
      builder.setPosition(state.row, state.column, state.offsetX, state.offsetY);
    }
    Object.keys(state.options).forEach(function (key) {
      builder.setOption(key, state.options[key]);
    });
    builder.setOption('title', state.title);
    builder.setOption('width', state.width);
    builder.setOption('height', state.height);
    const setters = {
      chartType: 'setChartType',
      hiddenDimensionStrategy: 'setHiddenDimensionStrategy',
      mergeStrategy: 'setMergeStrategy',
      numHeaders: 'setNumHeaders',
      transposeRowsAndColumns: 'setTransposeRowsAndColumns'
    };
    Object.keys(setters).forEach(function (property) {
      if (state.builderState[property] !== undefined &&
        typeof builder[setters[property]] === 'function') {
        builder[setters[property]](state.builderState[property]);
      }
    });
    sheet.updateChart(builder.build());
  });
}

function assertInstallerSheetChartStatePreserved_(before, sheet) {
  if (!before || typeof sheet.getCharts !== 'function') {
    return;
  }
  const after = captureInstallerSheetChartState_(sheet);
  if (before.length !== after.length || before.some(function (chart, index) {
    const afterChart = after[index];
    if (!afterChart || !installerChartRangeBindingsMatch_(chart.sourceRanges,
      afterChart.sourceRanges)) {
      return true;
    }
    const expectedPresentation = Object.assign({}, chart);
    const actualPresentation = Object.assign({}, afterChart);
    delete expectedPresentation.sourceRanges;
    delete actualPresentation.sourceRanges;
    return JSON.stringify(expectedPresentation) !== JSON.stringify(actualPresentation);
  })) {
    throw new Error('Supply-sheet chart presentation changed during service-identity migration.');
  }
}

function installerChartRangeBindingsMatch_(beforeRanges, afterRanges) {
  if (beforeRanges.length !== afterRanges.length) {
    return false;
  }
  return beforeRanges.every(function (beforeRange, index) {
    const afterRange = afterRanges[index];
    if (!afterRange) {
      return false;
    }
    // Older interrupted journals stored bare A1 strings. They do not carry
    // enough information to validate identity, but must remain resumable.
    if (typeof beforeRange === 'string') {
      return true;
    }
    return beforeRange.sheetId === afterRange.sheetId &&
      beforeRange.sheetName === afterRange.sheetName;
  });
}

function getInstallerSheetHeaders_(locale, isElectricity) {
  const localization = getInstallerLocalization_(locale);
  const headers = localization.installerSheetHeaders.slice();
  return isElectricity ? headers.concat(localization.electricityBandHeaders) :
    headers;
}

function getInstallerLocalization_(locale) {
  const localization = getLocalizationRegistry_()[locale];
  if (!localization || !String(localization.spreadsheetLocale || '').trim()) {
    throw new Error('Unsupported installer locale: ' + locale);
  }
  return localization;
}

function validateInstallerSheetHeaders_(sheet, locale) {
  const localization = getInstallerLocalization_(locale);
  const headers = getSheetLayout_(sheet,
    localization.headerAliases).headers.map(normalizeHeader_);
  const seenHeaders = Object.create(null);
  headers.forEach(function (header) {
    if (!header) {
      return;
    }
    if (seenHeaders[header]) {
      throw new Error(
        'Existing spreadsheet tab ' + sheet.getName() +
          ' contains duplicate normalized header: ' + header
      );
    }
    seenHeaders[header] = true;
  });
  ['issueDate', 'supplier', 'identifier', 'sourceFile'].forEach(function (key) {
    const aliases = localization.headerAliases[key].map(normalizeHeader_);
    const present = aliases.some(function (alias) {
      return headers.indexOf(alias) >= 0;
    });
    if (!present) {
      throw new Error(
        'Existing spreadsheet tab ' + sheet.getName() +
        ' is missing required header: ' + key
      );
    }
  });
}

function validateInstallerConfiguredSheets_() {
  const automationConfig = getAutomationConfig_();
  const spreadsheet = SpreadsheetApp.openById(getSpreadsheetId_());
  const checkedSheets = Object.create(null);
  automationConfig.canonical_supplies.forEach(function (supply) {
    const sheetName = automationConfig.sheet_by_supply[supply];
    const sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      throw new Error('Configured spreadsheet tab is missing: ' + sheetName);
    }
    if (!checkedSheets[sheetName]) {
      validateInstallerSheetHeaders_(
        sheet,
        automationConfig.locale || 'en'
      );
      checkedSheets[sheetName] = true;
    }
  });
}

function ensureInstallerDestinationFolders_(rootFolder, automationConfig) {
  getOrCreateFolderByPath_(rootFolder, automationConfig.archive_only_folder_path);
  const currentYear = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy');
  Object.keys(automationConfig.destination_templates).forEach(function (key) {
    const template = automationConfig.destination_templates[key];
    if (template) {
      getOrCreateFolderByPath_(
        rootFolder,
        String(template).replace('{year}', currentYear)
      );
    }
  });
}
