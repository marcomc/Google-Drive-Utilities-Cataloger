const CONFIG = Object.freeze({
  DEFAULT_MODEL: 'gemini-2.5-flash',
  DAILY_TRIGGER_HOUR: 7,
  EVENT_POLL_MINUTES: 15,
  MAX_RUNTIME_MS: 280000,
  MAX_PDF_BYTES: 50 * 1024 * 1024,
  MAX_AGENTS_FILE_BYTES: 100 * 1024,
  MAX_INTAKE_STATE_ENTRIES: 50,
  GEMINI_MAX_TRANSIENT_ATTEMPTS: 2,
  GEMINI_INITIAL_RETRY_DELAY_MS: 1000,
  GEMINI_VERTEX_FALLBACK_COOLDOWN_MS: 60 * 60 * 1000,
  // Update this only after checking the Vertex AI list-price page. This is an
  // operational estimate; Cloud Billing remains the accounting source of truth.
  VERTEX_GEMINI_25_FLASH_USD_PER_MILLION_TOKENS: Object.freeze({
    input: 0.30,
    output: 2.50
  }),
  DRIVE_AGENTS_FILE_NAME: 'AGENTS.md',
  MONEY_TOLERANCE: 0.02,
  PROPERTY_KEYS: Object.freeze({
    GEMINI_API_KEY: 'GEMINI_API_KEY',
    GEMINI_BACKEND: 'GEMINI_BACKEND',
    GEMINI_MODEL: 'GEMINI_MODEL',
    VERTEX_AI_LOCATION: 'VERTEX_AI_LOCATION',
    GEMINI_AUTO_VERTEX_FALLBACK: 'GEMINI_AUTO_VERTEX_FALLBACK',
    GEMINI_VERTEX_FALLBACK_UNTIL: 'GEMINI_VERTEX_FALLBACK_UNTIL',
    NOTIFICATION_RECIPIENT: 'NOTIFICATION_RECIPIENT',
    ROOT_FOLDER_ID: 'ROOT_FOLDER_ID',
    SPREADSHEET_ID: 'SPREADSHEET_ID',
    AUTOMATION_CONFIG_JSON: 'AUTOMATION_CONFIG_JSON',
    INTAKE_FILE_STATE: 'INTAKE_FILE_STATE',
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
    geminiBackend: getGeminiBackend_(),
    geminiEffectiveBackend: getEffectiveGeminiBackend_(),
    geminiAutoVertexFallbackEnabled: isAutomaticVertexFallbackEnabled_(),
    geminiVertexFallbackUntil: getTemporaryVertexFallbackUntilIso_(),
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

  if (getGeminiBackend_() === 'gemini_api' && !getScriptProperty_(key.GEMINI_API_KEY)) {
    throw new Error('Configure GEMINI_API_KEY for the gemini_api backend.');
  }
  if (getGeminiBackend_() === 'vertex_ai' && !getScriptProperty_(key.GOOGLE_CLOUD_PROJECT_ID)) {
    throw new Error('Configure GOOGLE_CLOUD_PROJECT_ID for the vertex_ai backend.');
  }
  if (getGeminiBackend_() === 'gemini_api' && isAutomaticVertexFallbackEnabled_() &&
    !getScriptProperty_(key.GOOGLE_CLOUD_PROJECT_ID)) {
    throw new Error('Configure GOOGLE_CLOUD_PROJECT_ID for automatic Vertex AI fallback.');
  }

  getAutomationConfig_();
}

function getScriptProperty_(propertyKey) {
  return PropertiesService.getScriptProperties().getProperty(propertyKey) || '';
}

function getGeminiModel_() {
  return getScriptProperty_(CONFIG.PROPERTY_KEYS.GEMINI_MODEL) || CONFIG.DEFAULT_MODEL;
}

/**
 * Select the Gemini Developer API (API key) or Vertex AI (Cloud OAuth) runtime.
 */
function getGeminiBackend_() {
  const backend = getScriptProperty_(CONFIG.PROPERTY_KEYS.GEMINI_BACKEND) || 'gemini_api';
  if (['gemini_api', 'vertex_ai'].indexOf(backend) < 0) {
    throw new Error('GEMINI_BACKEND must be gemini_api or vertex_ai.');
  }
  return backend;
}

function isAutomaticVertexFallbackEnabled_() {
  return getScriptProperty_(CONFIG.PROPERTY_KEYS.GEMINI_AUTO_VERTEX_FALLBACK) === 'true';
}

function getTemporaryVertexFallbackUntil_() {
  const until = Number(getScriptProperty_(CONFIG.PROPERTY_KEYS.GEMINI_VERTEX_FALLBACK_UNTIL));
  return isFinite(until) && until > Date.now() ? until : 0;
}

function getTemporaryVertexFallbackUntilIso_() {
  const until = getTemporaryVertexFallbackUntil_();
  return until ? new Date(until).toISOString() : '';
}

/**
 * Keep the configured Gemini Developer API backend as the primary runtime.
 * A temporary Vertex route exists only after a verified Free Tier daily limit.
 */
function getEffectiveGeminiBackend_() {
  const primaryBackend = getGeminiBackend_();
  if (primaryBackend === 'gemini_api' && isAutomaticVertexFallbackEnabled_() &&
    getTemporaryVertexFallbackUntil_()) {
    return 'vertex_ai';
  }
  return primaryBackend;
}

/**
 * Switch the primary runtime to Gemini Developer API Free Tier and enable a
 * one-hour temporary Vertex route when that API reports its daily limit.
 */
function configureGeminiFreeTierWithVertexFallback() {
  const properties = PropertiesService.getScriptProperties();
  const key = CONFIG.PROPERTY_KEYS;
  if (!properties.getProperty(key.GEMINI_API_KEY)) {
    throw new Error('Configure GEMINI_API_KEY before enabling Gemini Free Tier.');
  }
  if (!properties.getProperty(key.GOOGLE_CLOUD_PROJECT_ID)) {
    throw new Error('Configure GOOGLE_CLOUD_PROJECT_ID before enabling Vertex AI fallback.');
  }
  properties.setProperties({
    GEMINI_BACKEND: 'gemini_api',
    GEMINI_AUTO_VERTEX_FALLBACK: 'true'
  }, false);
  properties.deleteProperty(key.GEMINI_VERTEX_FALLBACK_UNTIL);
  return getSetupStatus();
}

function getVertexAiLocation_() {
  return getScriptProperty_(CONFIG.PROPERTY_KEYS.VERTEX_AI_LOCATION) || 'global';
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

  if (automationConfig.address_missing_type &&
    ['import', 'archive_only'].indexOf(automationConfig.address_missing_type) === -1) {
    throw new Error('AUTOMATION_CONFIG_JSON address_missing_type must be import or archive_only.');
  }
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
