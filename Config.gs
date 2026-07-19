const CONFIG = Object.freeze({
  APP_VERSION: '0.1.1',
  DEFAULT_MODEL: 'gemini-3.5-flash',
  DAILY_TRIGGER_HOUR: 7,
  EVENT_POLL_MINUTES: 15,
  MAX_RUNTIME_MS: 280000,
  // Base64 expands the PDF by roughly one third. Keep enough room below the
  // Apps Script 50 MB URL Fetch POST limit for the prompt and JSON envelope.
  MAX_PDF_BYTES: 35 * 1024 * 1024,
  // The policy is staged with the complete private bootstrap payload in a
  // Secret Manager version, whose payload must remain below 64 KiB.
  MAX_AGENTS_FILE_BYTES: 40 * 1024,
  // Apps Script limits one PropertiesService value to 9 KB. Keep margin for
  // platform accounting and reject oversized configuration before bootstrap.
  MAX_AUTOMATION_CONFIG_BYTES: 8 * 1024,
  // Script Properties have a 500 KB total limit. Reserve most of that space
  // for configuration, per-file state, mutation journals, and transport data.
  MAX_PENDING_REPORT_BYTES: 256 * 1024,
  // Keep invoice extraction below the model's response ceiling.
  GEMINI_MAX_OUTPUT_TOKENS: 8192,
  // Gemini 3.5 Flash defaults to medium thinking. Make it explicit so the
  // Developer API and Vertex AI fallback use the same runtime behavior.
  GEMINI_35_FLASH_THINKING_LEVEL: 'medium',
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
    AUTOMATION_TRIGGER_SCHEDULES: 'AUTOMATION_TRIGGER_SCHEDULES',
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
    INTAKE_FILE_STATE_PREFIX: 'INTAKE_FILE_STATE_',
    PENDING_REPORT_PREFIX: 'PENDING_REPORT_',
    MUTATION_JOURNAL_PREFIX: 'MUTATION_JOURNAL_',
    MUTATION_RECOVERY_ALERT_PREFIX: 'MUTATION_RECOVERY_ALERT_',
    GOOGLE_CLOUD_PROJECT_ID: 'GOOGLE_CLOUD_PROJECT_ID',
    PUBSUB_TOPIC: 'PUBSUB_TOPIC',
    PUBSUB_SUBSCRIPTION: 'PUBSUB_SUBSCRIPTION',
    WORKSPACE_EVENT_SUBSCRIPTION: 'WORKSPACE_EVENT_SUBSCRIPTION',
    WORKSPACE_EVENT_EXPIRES_AT: 'WORKSPACE_EVENT_EXPIRES_AT',
    TIME_ZONE_RECONFIGURATION: 'TIME_ZONE_RECONFIGURATION'
  })
});

/**
 * Return the runtime configuration without exposing the Gemini credential.
 */
function getSetupStatus() {
  const properties = PropertiesService.getScriptProperties();
  const key = CONFIG.PROPERTY_KEYS;
  return {
    applicationVersion: CONFIG.APP_VERSION,
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

function getApplicationVersion() {
  return CONFIG.APP_VERSION;
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
 * Set the Gemini model used by both the primary Developer API backend and the
 * temporary Vertex AI fallback. Intended for owner-controlled maintenance.
 */
function configureGeminiModel(model) {
  const normalizedModel = String(model || '').trim();
  if (!/^gemini-[a-z0-9][a-z0-9._-]+$/.test(normalizedModel)) {
    throw new Error('GEMINI_MODEL must be a Gemini model identifier.');
  }
  PropertiesService.getScriptProperties().setProperty(
    CONFIG.PROPERTY_KEYS.GEMINI_MODEL,
    normalizedModel
  );
  return getSetupStatus();
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
 * A temporary Vertex route exists only after a verified terminal Gemini API
 * availability limit, such as daily quota or depleted prepayment credits.
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
 * Switch the primary runtime to Gemini Developer API and enable a one-hour
 * temporary Vertex route when that API reports a terminal availability limit.
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

  validateAutomationConfig_(automationConfig, {
    allowLegacyMissingTimeZone: true
  });
  return automationConfig;
}

function validateAutomationConfig_(automationConfig, options) {
  const validationOptions = options || {};
  if (!automationConfig || typeof automationConfig !== 'object' ||
    Array.isArray(automationConfig)) {
    throw new Error('AUTOMATION_CONFIG_JSON must contain an object.');
  }
  if (Utilities.newBlob(JSON.stringify(automationConfig)).getBytes().length >
    CONFIG.MAX_AUTOMATION_CONFIG_BYTES) {
    throw new Error(
      'AUTOMATION_CONFIG_JSON exceeds the safe 8 KiB Script Property limit.'
    );
  }
  const hasTimeZone = Object.prototype.hasOwnProperty.call(
    automationConfig,
    'time_zone'
  );
  if (
    (!hasTimeZone && !validationOptions.allowLegacyMissingTimeZone) ||
    (hasTimeZone && !isValidIanaTimeZone_(automationConfig.time_zone))
  ) {
    throw new Error(
      'AUTOMATION_CONFIG_JSON time_zone must be a valid IANA time zone.'
    );
  }
  const requiredArrayKeys = ['canonical_supplies', 'canonical_suppliers', 'address_rules'];
  requiredArrayKeys.forEach(function (propertyKey) {
    if (!Array.isArray(automationConfig[propertyKey])) {
      throw new Error('AUTOMATION_CONFIG_JSON requires the ' + propertyKey + ' array.');
    }
  });
  ['canonical_supplies', 'canonical_suppliers'].forEach(function (propertyKey) {
    const values = automationConfig[propertyKey];
    if (values.length === 0 || values.some(function (value) {
      return typeof value !== 'string' || !value.trim() ||
        /[\/\\\u0000-\u001f]/.test(value);
    }) || new Set(values).size !== values.length) {
      throw new Error('AUTOMATION_CONFIG_JSON ' + propertyKey +
        ' must contain unique, non-empty strings.');
    }
    const normalizedValues = values.map(function (value) {
      return normalizeConfigIdentity_(value);
    });
    if (normalizedValues.some(function (value) { return !value; }) ||
      new Set(normalizedValues).size !== normalizedValues.length) {
      throw new Error('AUTOMATION_CONFIG_JSON ' + propertyKey +
        ' contains normalized duplicates or empty identities.');
    }
  });

  if (automationConfig.address_missing_type &&
    ['import', 'archive_only'].indexOf(automationConfig.address_missing_type) === -1) {
    throw new Error('AUTOMATION_CONFIG_JSON address_missing_type must be import or archive_only.');
  }
  const addressRuleIdentities = Object.create(null);
  automationConfig.address_rules.forEach(function (rule) {
    if (!rule || typeof rule.match !== 'string' || !rule.match.trim() ||
      ['import', 'archive_only'].indexOf(rule.type) === -1) {
      throw new Error('AUTOMATION_CONFIG_JSON address_rules entries require match and a valid type.');
    }
    const normalizedMatch = normalizeConfigIdentity_(rule.match);
    if (!normalizedMatch || addressRuleIdentities[normalizedMatch]) {
      throw new Error(
        'AUTOMATION_CONFIG_JSON address_rules contains an empty or duplicate match.'
      );
    }
    addressRuleIdentities[normalizedMatch] = true;
  });

  const requiredObjectKeys = [
    'supply_aliases',
    'supplier_aliases',
    'destination_templates',
    'sheet_by_supply'
  ];
  requiredObjectKeys.forEach(function (propertyKey) {
    if (!automationConfig[propertyKey] ||
      typeof automationConfig[propertyKey] !== 'object' ||
      Array.isArray(automationConfig[propertyKey])) {
      throw new Error('AUTOMATION_CONFIG_JSON requires the ' + propertyKey + ' object.');
    }
  });
  automationConfig.canonical_supplies.forEach(function (supply) {
    if (typeof automationConfig.sheet_by_supply[supply] !== 'string' ||
      !automationConfig.sheet_by_supply[supply].trim() ||
      /[\[\]*?:\/\\]/.test(automationConfig.sheet_by_supply[supply])) {
      throw new Error('AUTOMATION_CONFIG_JSON requires a sheet mapping for: ' + supply);
    }
  });
  validateConfigAliasMap_(
    automationConfig.supply_aliases,
    automationConfig.canonical_supplies,
    'supply'
  );
  validateConfigAliasMap_(
    automationConfig.supplier_aliases,
    automationConfig.canonical_suppliers,
    'supplier'
  );

  validateConfiguredFolderPath_(automationConfig.archive_only_folder_path, false);
  Object.keys(automationConfig.destination_templates).forEach(function (key) {
    const parts = key.split('|');
    if (parts.length !== 2 ||
      automationConfig.canonical_supplies.indexOf(parts[0]) < 0 ||
      automationConfig.canonical_suppliers.indexOf(parts[1]) < 0) {
      throw new Error('AUTOMATION_CONFIG_JSON destination template key is invalid: ' + key);
    }
    validateConfiguredFolderPath_(automationConfig.destination_templates[key], true);
  });

  if (!Array.isArray(automationConfig.frequency_overrides || [])) {
    throw new Error('AUTOMATION_CONFIG_JSON frequency_overrides must be an array.');
  }
  const frequencyOverrideKeys = Object.create(null);
  (automationConfig.frequency_overrides || []).forEach(function (override) {
    if (!override ||
      automationConfig.canonical_suppliers.indexOf(override.supplier) < 0 ||
      automationConfig.canonical_supplies.indexOf(override.supply_type) < 0 ||
      typeof override.frequency !== 'string' || !override.frequency.trim()) {
      throw new Error('AUTOMATION_CONFIG_JSON frequency_overrides entry is invalid.');
    }
    const key = override.supplier + '\u0000' + override.supply_type;
    if (frequencyOverrideKeys[key]) {
      throw new Error(
        'AUTOMATION_CONFIG_JSON frequency_overrides contains a duplicate tuple.'
      );
    }
    frequencyOverrideKeys[key] = true;
  });

  if (automationConfig.locale &&
    getSupportedLocales_().indexOf(automationConfig.locale) < 0) {
    throw new Error('AUTOMATION_CONFIG_JSON locale must be one of: ' +
      getSupportedLocales_().join(', ') + '.');
  }
}

function isValidIanaTimeZone_(timeZone) {
  if (
    typeof timeZone !== 'string' ||
    !timeZone ||
    timeZone !== timeZone.trim() ||
    /^[+-]/.test(timeZone)
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timeZone }).format();
    return true;
  } catch (error) {
    return false;
  }
}

function validateConfigAliasMap_(aliases, canonicalValues, label) {
  const canonicalIdentities = Object.create(null);
  canonicalValues.forEach(function (value) {
    canonicalIdentities[normalizeConfigIdentity_(value)] = value;
  });
  const aliasIdentities = Object.create(null);
  Object.keys(aliases).forEach(function (alias) {
    const target = aliases[alias];
    if (canonicalValues.indexOf(target) < 0) {
      throw new Error(
        'AUTOMATION_CONFIG_JSON ' + label + ' alias targets an unknown value.'
      );
    }
    const normalizedAlias = normalizeConfigIdentity_(alias);
    if (!normalizedAlias) {
      throw new Error(
        'AUTOMATION_CONFIG_JSON ' + label + ' alias has an empty identity.'
      );
    }
    if (canonicalIdentities[normalizedAlias]) {
      throw new Error(
        'AUTOMATION_CONFIG_JSON ' + label + ' alias shadows a canonical value.'
      );
    }
    if (aliasIdentities[normalizedAlias]) {
      throw new Error(
        'AUTOMATION_CONFIG_JSON ' + label + ' aliases contain a normalized collision.'
      );
    }
    aliasIdentities[normalizedAlias] = target;
  });
}

function validateConfiguredFolderPath_(path, allowYearPlaceholder) {
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('AUTOMATION_CONFIG_JSON requires a non-empty folder path.');
  }
  const yearPlaceholders = (path.match(/\{year\}/g) || []).length;
  if ((!allowYearPlaceholder && yearPlaceholders > 0) ||
    yearPlaceholders > 1) {
    throw new Error('AUTOMATION_CONFIG_JSON contains an invalid year placeholder.');
  }
  path.split('/').forEach(function (segment) {
    const candidate = allowYearPlaceholder ?
      segment.replace('{year}', '2000') : segment;
    if (!candidate || candidate === '.' || candidate === '..' ||
      /[\\\u0000-\u001f]/.test(candidate) ||
      /\{(?!year\})/.test(segment)) {
      throw new Error('AUTOMATION_CONFIG_JSON contains an unsafe folder path.');
    }
  });
}

function normalizeConfigIdentity_(value) {
  return String(value || '').trim().toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
