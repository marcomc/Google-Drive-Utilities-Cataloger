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
  const spreadsheet = ensureInstallerSpreadsheet_(
    rootFolder,
    validated.spreadsheetId || resumableSpreadsheetId,
    validated.spreadsheetTitle,
    validated.automationConfig,
    validated.timeZone,
    !validated.spreadsheetId
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
 * Verify the installed resources without processing intake PDFs.
 */
function validateCatalogerInstallation() {
  assertCatalogConfiguration_();
  const rootFolder = DriveApp.getFolderById(getRootFolderId_());
  loadDriveAgentsPolicy_(rootFolder);
  validateInstallerConfiguredSheets_();
  getSheetHeadersBySupply_();

  const expectedHandlers = [
    'runDailyUtilitiesCataloging',
    'processDriveEventQueue',
    'renewDriveEventSubscription'
  ];
  const triggerHandlers = ScriptApp.getProjectTriggers()
    .map(function (trigger) { return trigger.getHandlerFunction(); });
  const missingTriggerHandlers = expectedHandlers.filter(function (handler) {
    return triggerHandlers.indexOf(handler) < 0;
  });
  const duplicateTriggerHandlers = expectedHandlers.filter(function (handler) {
    return triggerHandlers.filter(function (candidate) {
      return candidate === handler;
    }).length > 1;
  });
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
      missingTriggerHandlers.length === 0 &&
      duplicateTriggerHandlers.length === 0,
    missingTriggerHandlers: missingTriggerHandlers,
    duplicateTriggerHandlers: duplicateTriggerHandlers,
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
    geminiModel: String(options.geminiModel).trim(),
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
  automationConfig.canonical_supplies.forEach(function (supply) {
    const sheetName = automationConfig.sheet_by_supply[supply];
    if (!sheetName) {
      throw new Error('No spreadsheet tab is configured for supply: ' + supply);
    }
    if (sheetNames.indexOf(sheetName) === -1) {
      sheetNames.push(sheetName);
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

  const headers = getInstallerSheetHeaders_(automationConfig.locale || 'en');
  sheetNames.forEach(function (sheetName) {
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

}

function getInstallerSheetHeaders_(locale) {
  return getInstallerLocalization_(locale).installerSheetHeaders.slice();
}

function getInstallerLocalization_(locale) {
  const localization = getLocalizationRegistry_()[locale];
  if (!localization || !String(localization.spreadsheetLocale || '').trim()) {
    throw new Error('Unsupported installer locale: ' + locale);
  }
  return localization;
}

function validateInstallerSheetHeaders_(sheet, locale) {
  const headers = getSheetLayout_(sheet).headers.map(normalizeHeader_);
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
  const localization = getInstallerLocalization_(locale);
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
