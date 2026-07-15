const CONFIG = Object.freeze({
  DEFAULT_MODEL: 'gemini-2.5-flash',
  DAILY_TRIGGER_HOUR: 7,
  EVENT_POLL_MINUTES: 1,
  MAX_RUNTIME_MS: 280000,
  MAX_PDF_BYTES: 50 * 1024 * 1024,
  MAX_AGENTS_FILE_BYTES: 100 * 1024,
  DRIVE_AGENTS_FILE_NAME: 'AGENTS.md',
  MONEY_TOLERANCE: 0.02,
  PROPERTY_KEYS: Object.freeze({
    GEMINI_API_KEY: 'GEMINI_API_KEY',
    GEMINI_MODEL: 'GEMINI_MODEL',
    NOTIFICATION_RECIPIENT: 'NOTIFICATION_RECIPIENT',
    ROOT_FOLDER_ID: 'ROOT_FOLDER_ID',
    SPREADSHEET_ID: 'SPREADSHEET_ID',
    AUTOMATION_CONFIG_JSON: 'AUTOMATION_CONFIG_JSON',
    GOOGLE_CLOUD_PROJECT_ID: 'GOOGLE_CLOUD_PROJECT_ID',
    PUBSUB_TOPIC: 'PUBSUB_TOPIC',
    PUBSUB_SUBSCRIPTION: 'PUBSUB_SUBSCRIPTION',
    WORKSPACE_EVENT_SUBSCRIPTION: 'WORKSPACE_EVENT_SUBSCRIPTION',
    WORKSPACE_EVENT_EXPIRES_AT: 'WORKSPACE_EVENT_EXPIRES_AT'
  })
});

/**
 * Return the runtime configuration without exposing the Gemini credential.
 */
function getSetupStatus() {
  const properties = PropertiesService.getScriptProperties();
  const key = CONFIG.PROPERTY_KEYS;
  return {
    geminiApiKeyConfigured: Boolean(properties.getProperty(key.GEMINI_API_KEY)),
    geminiModel: properties.getProperty(key.GEMINI_MODEL) || CONFIG.DEFAULT_MODEL,
    notificationRecipientConfigured: Boolean(
      properties.getProperty(key.NOTIFICATION_RECIPIENT)
    ),
    rootFolderConfigured: Boolean(properties.getProperty(key.ROOT_FOLDER_ID)),
    spreadsheetConfigured: Boolean(properties.getProperty(key.SPREADSHEET_ID)),
    automationConfigConfigured: Boolean(properties.getProperty(key.AUTOMATION_CONFIG_JSON)),
    cloudProjectConfigured: Boolean(properties.getProperty(key.GOOGLE_CLOUD_PROJECT_ID)),
    pubSubConfigured: Boolean(properties.getProperty(key.PUBSUB_SUBSCRIPTION)),
    workspaceEventSubscription: properties.getProperty(key.WORKSPACE_EVENT_SUBSCRIPTION) || '',
    workspaceEventExpiresAt: properties.getProperty(key.WORKSPACE_EVENT_EXPIRES_AT) || ''
  };
}

/**
 * Validate the values that must be saved manually in Script Properties.
 */
function assertCatalogConfiguration_() {
  const key = CONFIG.PROPERTY_KEYS;
  const missing = [
    key.GEMINI_API_KEY,
    key.NOTIFICATION_RECIPIENT,
    key.ROOT_FOLDER_ID,
    key.SPREADSHEET_ID,
    key.AUTOMATION_CONFIG_JSON
  ].filter(function (propertyKey) {
    return !getScriptProperty_(propertyKey);
  });

  if (missing.length > 0) {
    throw new Error('Configure these Script Properties first: ' + missing.join(', '));
  }

  getAutomationConfig_();
}

function getScriptProperty_(propertyKey) {
  return PropertiesService.getScriptProperties().getProperty(propertyKey) || '';
}

function getGeminiModel_() {
  return getScriptProperty_(CONFIG.PROPERTY_KEYS.GEMINI_MODEL) || CONFIG.DEFAULT_MODEL;
}

function getRootFolderId_() {
  return getScriptProperty_(CONFIG.PROPERTY_KEYS.ROOT_FOLDER_ID);
}

function getSpreadsheetId_() {
  return getScriptProperty_(CONFIG.PROPERTY_KEYS.SPREADSHEET_ID);
}

function getAutomationConfig_() {
  const raw = getScriptProperty_(CONFIG.PROPERTY_KEYS.AUTOMATION_CONFIG_JSON);
  if (!raw) {
    throw new Error('Configure AUTOMATION_CONFIG_JSON in Script Properties first.');
  }

  let automationConfig;
  try {
    automationConfig = JSON.parse(raw);
  } catch (error) {
    throw new Error('AUTOMATION_CONFIG_JSON does not contain valid JSON: ' + error.message);
  }

  const requiredArrayKeys = ['canonical_supplies', 'canonical_suppliers', 'address_rules'];
  requiredArrayKeys.forEach(function (propertyKey) {
    if (!Array.isArray(automationConfig[propertyKey])) {
      throw new Error('AUTOMATION_CONFIG_JSON requires the ' + propertyKey + ' array.');
    }
  });
  const requiredObjectKeys = ['supply_aliases', 'supplier_aliases', 'destination_templates', 'sheet_by_supply'];
  requiredObjectKeys.forEach(function (propertyKey) {
    if (!automationConfig[propertyKey] || typeof automationConfig[propertyKey] !== 'object' ||
      Array.isArray(automationConfig[propertyKey])) {
      throw new Error('AUTOMATION_CONFIG_JSON requires the ' + propertyKey + ' object.');
    }
  });
  if (!automationConfig.archive_only_folder_path) {
    throw new Error('AUTOMATION_CONFIG_JSON requires archive_only_folder_path.');
  }
  if (automationConfig.locale && getSupportedLocales_().indexOf(automationConfig.locale) < 0) {
    throw new Error('AUTOMATION_CONFIG_JSON locale must be one of: ' +
      getSupportedLocales_().join(', ') + '.');
  }

  return automationConfig;
}
