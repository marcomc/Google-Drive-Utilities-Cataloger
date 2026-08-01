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
    if (!isPristineInstallerSupplierProfileTemplate_(currentContent, template)) {
      throw new Error('The existing supplier profile template is not installer-managed ' +
        'or pristine; refusing to overwrite it.');
    }
    state = buildSupplierProfileTemplateState_('managed', rootFolder,
      templateFolder, locale, fileName, file.getId(), currentContent);
    saveSupplierProfileTemplateState_(properties, state);
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

function isPristineInstallerSupplierProfileTemplate_(content, template) {
  return content === template || content === template.replace(
    '\nmanaged_by: Google Drive Utilities Cataloger\n', '\n'
  );
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
  const electricitySheetNames = Object.create(null);
  automationConfig.canonical_supplies.forEach(function (supply) {
    const sheetName = automationConfig.sheet_by_supply[supply];
    if (!sheetName) {
      throw new Error('No spreadsheet tab is configured for supply: ' + supply);
    }
    if (sheetNames.indexOf(sheetName) === -1) {
      sheetNames.push(sheetName);
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
      const headerRange = sheet.getRange(1, 1, 1, headers.length);
      headerRange.setValues([headers]);
      headerRange.setFontWeight('bold');
      headerRange.setBackground('#d9ead3');
      sheet.setFrozenRows(1);
      sheet.getRange(2, 1, Math.max(1, sheet.getMaxRows() - 1), 1)
        .setNumberFormat('yyyy-mm-dd');
      sheet.getRange(2, 7, Math.max(1, sheet.getMaxRows() - 1), 4)
        .setNumberFormat('#,##0.00');
      sheet.autoResizeColumns(1, headers.length);
    } else {
      validateInstallerSheetHeaders_(sheet, automationConfig.locale || 'en');
    }
  });
  initializeElectricityDashboard_(spreadsheet, automationConfig);

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
