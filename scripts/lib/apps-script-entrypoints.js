'use strict';

const acorn = require('./vendor/acorn/acorn.js');

// Public owner API contract shared by source validation and version admission.
const requiredEntrypoints = Object.freeze([
  "runDailyUtilitiesCataloging",
  "retryFailedUtilitiesCataloging",
  "processSingleIntakeFile",
  "processSingleIntakeFileByName",
  "previewUtilityInvoiceExtraction",
  "getSetupStatus",
  "getApplicationVersion",
  "configureGeminiModel",
  "configureGeminiBackend",
  "configureGeminiFreeTierWithVertexFallback",
  "migrateCatalogerEnergygasCanonicalSpelling",
  "bootstrapCatalogerInstallation",
  "validateCatalogerInstallation",
  "validateConfiguredGeminiAccess",
  "migrateCatalogerServiceIdentityFields",
  "migrateCatalogerReferencePeriodText",
  "beginCatalogerTimeZoneReconfiguration",
  "reconfigureCatalogerTimeZone",
  "rollbackCatalogerTimeZoneReconfiguration",
  "finishCatalogerTimeZoneReconfiguration",
  "rotateGeminiDeveloperApiKeyFromSecret"
]);

function parseSource(source) {
  return acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
}

function declaredEntrypoints(source) {
  return parseSource(source).body
    .filter((statement) => statement.type === 'FunctionDeclaration' && !statement.generator)
    .map((statement) => statement.id.name);
}

function hasRequiredEntrypoint(source, entrypoint) {
  try {
    return declaredEntrypoints(source).includes(entrypoint);
  } catch {
    return false;
  }
}

function sourceSyntaxError(source) {
  try {
    parseSource(source);
    // Retain the local Node runtime's compile check as well as script parsing.
    // Neither operation executes Apps Script globals or user source.
    new Function(source);
    return null;
  } catch (error) {
    return error.message;
  }
}

function missingEntrypoints(sources) {
  const declared = new Set();
  for (const source of sources) {
    try {
      declaredEntrypoints(source).forEach((entrypoint) => declared.add(entrypoint));
    } catch {
      // Invalid source contributes no declarations; callers report its syntax
      // failure separately and reject the complete artifact before admission.
    }
  }
  return requiredEntrypoints.filter((entrypoint) => !declared.has(entrypoint));
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    const sources = JSON.parse(input);
    if (sources.some((source) => sourceSyntaxError(source))) {
      console.error('Apps Script version source failed syntax validation.');
      process.exitCode = 1;
      return;
    }
    const missing = missingEntrypoints(sources);
    missing.forEach((entrypoint) => {
      console.error(`Apps Script version is missing required entrypoint ${entrypoint}.`);
    });
    process.exitCode = missing.length ? 1 : 0;
  });
}

module.exports = { requiredEntrypoints, hasRequiredEntrypoint, missingEntrypoints, sourceSyntaxError };
