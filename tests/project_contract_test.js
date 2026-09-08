#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const { hasRequiredEntrypoint, validateSourceFiles } = require(
  path.join(projectRoot, 'scripts/validate-apps-script.js')
);

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, file), 'utf8'));
}

function loadFunction(file, functionName) {
  const context = vm.createContext({});
  vm.runInContext(
    fs.readFileSync(path.join(projectRoot, file), 'utf8'),
    context,
    { filename: file }
  );
  return context[functionName]();
}

function loadConfigContext() {
  const context = vm.createContext({
    Utilities: {
      newBlob: (value) => ({
        getBytes: () => Array.from(Buffer.from(String(value), 'utf8'))
      })
    }
  });
  fs.readdirSync(path.join(projectRoot, 'locales'))
    .filter((file) => file.endsWith('.gs'))
    .sort()
    .forEach((file) => {
      vm.runInContext(
        fs.readFileSync(path.join(projectRoot, 'locales', file), 'utf8'),
        context,
        { filename: `locales/${file}` }
      );
    });
  ['Localization.gs', 'Config.gs'].forEach((file) => {
    vm.runInContext(
      fs.readFileSync(path.join(projectRoot, file), 'utf8'),
      context,
      { filename: file }
    );
  });
  return context;
}

function shape(value) {
  if (Array.isArray(value)) {
    return [
      'array',
      ...Array.from(new Set(value.map((item) => JSON.stringify(shape(item)))))
        .map((item) => JSON.parse(item))
    ];
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, shape(value[key])])
    );
  }
  return typeof value;
}

function testCommittedJsonAndRuntimeConfig() {
  const automationConfig = readJson('config.example.json');
  const manifest = readJson('appsscript.json');
  const installerSource = fs.readFileSync(
    path.join(projectRoot, 'Installer.gs'),
    'utf8'
  );
  const dashboardSource = fs.readFileSync(
    path.join(projectRoot, 'ElectricityDashboard.gs'),
    'utf8'
  );
  const utilitiesSource = fs.readFileSync(
    path.join(projectRoot, 'UtilitiesCataloging.gs'),
    'utf8'
  );
  const englishLocale = fs.readFileSync(
    path.join(projectRoot, 'locales', 'en.gs'),
    'utf8'
  );
  const italianLocale = fs.readFileSync(
    path.join(projectRoot, 'locales', 'it.gs'),
    'utf8'
  );
  const installerShell = fs.readFileSync(
    path.join(projectRoot, 'scripts/install.sh'),
    'utf8'
  );
  const changelog = fs.readFileSync(
    path.join(projectRoot, 'CHANGELOG.md'),
    'utf8'
  );
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.match(installerSource, /getSheetHeadersBySupply_\(\)/);
  assert.match(installerSource, /function validateConfiguredGeminiAccess\(\)/);
  assert.match(installerSource, /initializeElectricityDashboard_\(spreadsheet, automationConfig\)/);
  assert.match(utilitiesSource,
    /refreshElectricityDashboardAfterInvoiceImport_\(spreadsheet, automationConfig,/);
  assert.match(dashboardSource,
    /captureElectricityChartLayouts_\(dashboard, technical, labels\)/);
  assert.match(dashboardSource, /getElectricityDashboardLabels_\(locale\)/);
  assert.match(dashboardSource, /getLocalizationRegistry_\(\)\[locale\]/);
  assert.match(dashboardSource, /ELECTRICITY_DASHBOARD_SOURCE_ROWS_ = 10000/);
  assert.doesNotMatch(dashboardSource, /\$1002(?:[^0-9]|$)/);
  assert.match(englishLocale, /Electricity Statistics/);
  assert.match(italianLocale, /Statistiche Luce/);
  assert.doesNotMatch(installerSource, /getAllSheetHeaders_/);
  assert.match(installerShell, /\.ackDeadlineSeconds == 300/);
  assert.doesNotMatch(installerShell, /\.ackDeadlineSeconds == 60/);
  assert.doesNotMatch(
    installerShell,
    /-A "\$\{(?:AUTH_DIR|MANAGEMENT_AUTH_DIR|auth_dir)\}"/
  );
  assert.match(installerShell, /-A "\$\{AUTH_DIR\}\/\.clasprc\.json"/);
  assert.match(
    installerShell,
    /-A "\$\{MANAGEMENT_AUTH_DIR\}\/\.clasprc\.json"/
  );
  assert.match(installerShell, /-A "\$\{auth_dir\}\/\.clasprc\.json"/);

  const context = loadConfigContext();
  const applicationVersion = vm.runInContext('CONFIG.APP_VERSION', context);
  assert.equal(
    vm.runInContext('CONFIG.DEFAULT_MODEL', context),
    'gemini-flash-latest'
  );
  assert.match(applicationVersion, /^\d+\.\d+\.\d+$/);
  const latestReleaseMatch = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m);
  assert.ok(latestReleaseMatch, 'CHANGELOG.md must start with a release heading.');
  assert.equal(applicationVersion, latestReleaseMatch[1]);
  assert.doesNotThrow(() => context.validateAutomationConfig_(automationConfig));
}

function testRequiredEntrypointValidationIsTopLevelAndNegativeSafe() {
  const { requiredEntrypoints, missingEntrypoints, sourceSyntaxError } = require(
    '../scripts/lib/apps-script-entrypoints.js');
  assert.equal(requiredEntrypoints.length, 22);
  const sources = requiredEntrypoints.map((name) => `function ${name}() {}`);
  assert.deepEqual(missingEntrypoints(sources), [], 'cross-file declarations');
  const temporaryDirectory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gduc-entrypoints-'));
  try {
    const files = sources.map((source, index) => {
      const file = path.join(temporaryDirectory, `${index}.gs`);
      fs.writeFileSync(file, source);
      return file;
    });
    assert.deepEqual(validateSourceFiles(files), []);
    requiredEntrypoints.forEach((entrypoint, index) => {
      assert.deepEqual(missingEntrypoints(sources.filter((_, i) => i !== index)), [entrypoint]);
      assert.deepEqual(validateSourceFiles(files.filter((_, i) => i !== index)),
        [`Missing required Apps Script entrypoint: ${entrypoint}`]);
      const declaration = `function ${entrypoint}() {}`;
      [
        `// ${declaration}`,
        `function* ${entrypoint}() {}`,
        `async function* ${entrypoint}() {}`,
        `/*\n${declaration}\n*/`,
        JSON.stringify(declaration),
        '`' + declaration + '`',
        `function wrapper() {\n${declaration}\n}`,
        `const value =\n${declaration}`,
        `const value = function named() {\n${declaration}\n};`,
        `if (false)\n${declaration}`,
        `if ((false)) /* guarded */\n${declaration}`,
        `if (true) {} else\n${declaration}`,
        `while (false)\n${declaration}`,
        `for (; false;)\n${declaration}`,
        `for (const item of [])\n${declaration}`,
        `do\n${declaration} while (false);`,
        `label:\n${declaration}`,
        `const pattern = /}${declaration.replace(' {}', '')}/;`,
        `function wrapper() { const pattern = /}/; ${declaration} }`
      ].forEach((source) => {
        assert.equal(hasRequiredEntrypoint(source, entrypoint), false, source);
      });
      [`async ${declaration}`, `/* comment */\n${declaration}`, `const value = 1;\n${declaration}`,
        `const value = (() => 1)()\n${declaration}`, `if (false) {}\n${declaration}`,
        `const pattern = /{/;\n${declaration}`,
        `const pattern = /[}/]/;\n${declaration}`,
        `const pattern = /\\/{/;\n${declaration}`,
        `const quotient = (12) / 3;\n${declaration}`,
        `if (false) /{/;\n${declaration}`
      ].forEach((source) => assert.equal(hasRequiredEntrypoint(source, entrypoint), true, source));
    });
    assert.equal(sourceSyntaxError('throw new Error("must not execute");'), null);
    assert.ok(sourceSyntaxError(sources.join('\n') + '('));
    assert.ok(sourceSyntaxError('return;'));
    assert.equal(hasRequiredEntrypoint('return; function required() {}', 'required'), false);
    const gate = require('node:child_process').spawnSync(process.execPath,
      [path.join(projectRoot, 'scripts/lib/apps-script-entrypoints.js')],
      { input: JSON.stringify([...sources, '(']), encoding: 'utf8' });
    assert.equal(gate.status, 1);
    assert.match(gate.stderr, /source failed syntax validation/);
    for (const [source, expectedType] of [
      ['async function wrapper(){ await /}function required(){}/; }', 'undefined'],
      ['const result = function () {} / 2;\nfunction required() {}', 'function'],
      ['const value = `${`;\nfunction required() {}\n`}`;', 'undefined'],
      ['const value = `${`{`}`;\nfunction required() {}', 'function'],
      ['const pattern = /{/;\nfunction required() {}', 'function'],
      ['const pattern = /}function required()/;', 'undefined'],
      ['function wrapper() { /}/; function required() {} }', 'undefined'],
      ['function wrapper() { const pattern = +/}/; function required() {} }', 'undefined'],
      ['if (false) {} /{/; function required() {}', 'function'],
      ['const ratio = {} / 2; function required() {}', 'function'],
      ['let number = 2; const ratio = number++ / 2; function required() {}', 'function'],
      ['function wrapper() { const pattern = /}/; function required() {} }', 'undefined']
    ]) {
      assert.equal(vm.runInNewContext(source + '; typeof required'), expectedType);
      assert.equal(hasRequiredEntrypoint(source, 'required'), expectedType === 'function');
      const artifactSources = [source.replaceAll('required', requiredEntrypoints[0]), ...sources.slice(1)];
      const artifactGate = require('node:child_process').spawnSync(process.execPath,
        [path.join(projectRoot, 'scripts/lib/apps-script-entrypoints.js')],
        { input: JSON.stringify(artifactSources), encoding: 'utf8' });
      assert.equal(artifactGate.status, expectedType === 'function' ? 0 : 1, source);
    }
    assert.equal(vm.runInNewContext('if (false)\nfunction required() {}\ntypeof required'), 'undefined');
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function testEntrypointValidationIsSelfContainedAfterRelocation() {
  const { spawnSync } = require('node:child_process');
  const { requiredEntrypoints } = require('../scripts/lib/apps-script-entrypoints.js');
  const fixtureRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gduc-parser-copy-'));
  try {
    fs.cpSync(path.join(projectRoot, 'scripts'), path.join(fixtureRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, 'locales'));
    assert.equal(fs.existsSync(path.join(fixtureRoot, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(fixtureRoot, 'scripts/node_modules')), false);
    const guardFile = path.join(fixtureRoot, 'offline-guard.js');
    fs.writeFileSync(guardFile, `
      const Module = require('node:module');
      const path = require('node:path');
      const root = __dirname + path.sep;
      const originalLoad = Module._load;
      const forbidden = new Set(['net', 'http', 'https', 'http2', 'dns', 'dgram', 'tls',
        'child_process', 'worker_threads']);
      Module._load = function (request, parent, isMain) {
        const name = request.replace(/^node:/, '').split('/')[0];
        if (forbidden.has(name)) throw new Error('Network and subprocess APIs are disabled');
        if (!Module.isBuiltin(request)) {
          const resolved = Module._resolveFilename(request, parent, isMain);
          if (!resolved.startsWith(root) || resolved.includes(path.sep + 'node_modules' + path.sep)) {
            throw new Error('External package loading is disabled');
          }
        }
        return originalLoad.apply(this, arguments);
      };
      globalThis.fetch = () => { throw new Error('Network APIs are disabled'); };
    `);
    const options = {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }
    };
    const run = (args, input) => spawnSync(process.execPath,
      ['--no-global-search-paths', '--require', guardFile, ...args], { ...options, input });
    assert.notEqual(run(['-e', 'require("node:https")']).status, 0);
    assert.notEqual(run(['-e', 'fetch("https://example.invalid")']).status, 0);
    assert.notEqual(run(['-e', 'require("acorn")']).status, 0);

    // These statements would fail if either admission path executed source.
    const sources = ['throw new Error("Source must not execute");',
      ...requiredEntrypoints.map((name) => `function ${name}() {}`)];
    sources.forEach((source, index) => fs.writeFileSync(path.join(fixtureRoot, `${index}.gs`), source));
    const local = run(['scripts/validate-apps-script.js']);
    assert.equal(local.status, 0, local.stderr);
    const artifact = run(['scripts/lib/apps-script-entrypoints.js'], JSON.stringify(sources));
    assert.equal(artifact.status, 0, artifact.stderr);
    const generatorSources = [...sources.slice(0, -1), `function* ${requiredEntrypoints.at(-1)}() {}`];
    const generator = run(['scripts/lib/apps-script-entrypoints.js'], JSON.stringify(generatorSources));
    assert.equal(generator.status, 1);
    assert.match(generator.stderr, new RegExp(requiredEntrypoints.at(-1)));
    const finalSourceFile = path.join(fixtureRoot, `${sources.length - 1}.gs`);
    fs.writeFileSync(finalSourceFile, generatorSources.at(-1));
    const generatorLocal = run(['scripts/validate-apps-script.js']);
    assert.equal(generatorLocal.status, 1);
    assert.match(generatorLocal.stderr, new RegExp(requiredEntrypoints.at(-1)));
    fs.writeFileSync(finalSourceFile, sources.at(-1));
    const missing = run(['scripts/lib/apps-script-entrypoints.js'], JSON.stringify(sources.slice(0, -1)));
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, new RegExp(requiredEntrypoints.at(-1)));
    const invalid = run(['scripts/lib/apps-script-entrypoints.js'], JSON.stringify([...sources, 'return;']));
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /source failed syntax validation/);
    fs.writeFileSync(path.join(fixtureRoot, 'return.gs'), 'return;');
    const invalidLocal = run(['scripts/validate-apps-script.js']);
    assert.equal(invalidLocal.status, 1);
    assert.match(invalidLocal.stderr, /return.*outside of function/);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function testNormalizedConfigurationCollisions() {
  const context = loadConfigContext();
  const original = readJson('config.example.json');
  const mutate = (callback) => {
    const config = JSON.parse(JSON.stringify(original));
    callback(config);
    return config;
  };

  assert.throws(
    () => context.validateAutomationConfig_(mutate((config) => {
      config.canonical_suppliers.push('WATER-PROVIDER');
    })),
    /normalized duplicates/
  );
  assert.throws(
    () => context.validateAutomationConfig_(mutate((config) => {
      config.supplier_aliases['ENERGY PROVIDER LIMITED'] = 'ENERGY PROVIDER';
      config.supplier_aliases['ENERGY-PROVIDER-LIMITED'] = 'WATER PROVIDER';
    })),
    /normalized collision/
  );
  assert.throws(
    () => context.validateAutomationConfig_(mutate((config) => {
      config.supply_aliases.water = 'Water';
    })),
    /shadows a canonical/
  );
  assert.throws(
    () => context.validateAutomationConfig_(mutate((config) => {
      config.frequency_overrides = [
        {
          supplier: 'WATER PROVIDER',
          supply_type: 'Water',
          frequency: 'monthly'
        },
        {
          supplier: 'WATER PROVIDER',
          supply_type: 'Water',
          frequency: 'bimonthly'
        }
      ];
    })),
    /duplicate tuple/
  );
  assert.throws(
    () => context.validateAutomationConfig_(mutate((config) => {
      config.address_rules[0].match = '!!!';
    })),
    /empty or duplicate match/
  );
  assert.throws(
    () => context.validateAutomationConfig_(mutate((config) => {
      config.oversized = 'x'.repeat(9000);
    })),
    /safe 8 KiB/
  );
  assert.throws(
    () => context.validateAutomationConfig_(mutate((config) => {
      delete config.time_zone;
    })),
    /valid IANA time zone/
  );
  assert.doesNotThrow(
    () => context.validateAutomationConfig_(mutate((config) => {
      delete config.time_zone;
    }), { allowLegacyMissingTimeZone: true })
  );
  assert.throws(
    () => context.validateAutomationConfig_(mutate((config) => {
      config.time_zone = 'Europe/Not-A-Zone';
    }), { allowLegacyMissingTimeZone: true }),
    /valid IANA time zone/
  );
  assert.throws(
    () => context.validateAutomationConfig_(mutate((config) => {
      config.time_zone = 'Europe/Not-A-Zone';
    })),
    /valid IANA time zone/
  );
  ['+02:00', '-05:30', ' Europe/Rome '].forEach((timeZone) => {
    assert.throws(
      () => context.validateAutomationConfig_(mutate((config) => {
        config.time_zone = timeZone;
      })),
      /valid IANA time zone/
    );
  });
}

function testLocaleParity() {
  const english = loadFunction('locales/en.gs', 'getEnglishLocalization_');
  const italian = loadFunction('locales/it.gs', 'getItalianLocalization_');
  assert.deepEqual(shape(italian), shape(english));
  assert.equal(
    italian.headerAliases.month.includes('numero mese di riferimento'),
    true
  );
  assert.equal(italian.headerAliases.contractNumber.includes('codice contratto'), true);
  assert.equal(italian.headerAliases.customerCode.includes('codice cliente'), true);
}

function testDeploymentContract() {
  const workflow = fs.readFileSync(
    path.join(projectRoot, '.github/workflows/deploy-apps-script.yml'),
    'utf8'
  );
  const deploymentGuide = fs.readFileSync(
    path.join(projectRoot, 'docs/DEPLOYMENT.md'),
    'utf8'
  );

  assert.match(workflow, /^on:\n  push:\n    branches:\n      - main$/m);
  assert.doesNotMatch(workflow, /pull_request:/);
  const deployScript = fs.readFileSync(
    path.join(projectRoot, 'scripts/deploy-apps-script.sh'),
    'utf8'
  );
  const deploymentHelper = fs.readFileSync(
    path.join(projectRoot, 'scripts/lib/apps-script-deployment.sh'),
    'utf8'
  );
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /run: \.\/scripts\/deploy-apps-script\.sh/);
  assert.match(deployScript, /A newer main revision exists; skipping stale deployment/);
  assert.match(deployScript, /read_apps_script_deployment/);
  assert.match(deployScript, /validate_owner_only_api_deployment/);
  assert.match(deployScript, /read_apps_script_version_content/);
  assert.match(deployScript, /validate_apps_script_version_entrypoints/);
  assert.match(deploymentHelper, /run_apps_script_clasp_json/);
  assert.match(
    deploymentHelper,
    /run_apps_script_clasp_json[\s\S]{0,160}deployments/
  );
  assert.match(
    deploymentHelper,
    /script\.googleapis\.com\/v1\/projects\/.+\/deployments\//
  );
  assert.match(deploymentHelper, /EXECUTION_API/);
  assert.match(deploymentHelper, /MYSELF/);
  assert.match(deployScript, /remote_time_zone=/);
  assert.match(deployScript, /run_apps_script_clasp_json/);
  assert.match(
    deployScript,
    /run_apps_script_clasp_json[\s\S]{0,160}version/
  );
  assert.match(
    deployScript,
    /run_apps_script_clasp_json[\s\S]{0,240}deploy/
  );
  assert.doesNotMatch(deployScript, /installAutomationTriggers/);
  assert.ok(
    deployScript.indexOf('read_apps_script_deployment') <
      deployScript.indexOf('push --force'),
    'deployment ownership must be checked before pushing source'
  );
  assert.ok(
    deployScript.indexOf('remote_time_zone=') < deployScript.indexOf('push --force'),
    'the installation time zone must be preserved before pushing source'
  );
  assert.ok(
    deployScript.indexOf('validate_apps_script_version_entrypoints') <
      deployScript.indexOf('deploy \\'),
    'required entrypoints must be verified before deployment mutation'
  );
  assert.match(
    deploymentGuide,
    /installable triggers[\s\S]{0,160}project HEAD/i
  );
  assert.match(deploymentGuide, /owner-only API executable/);
}

testCommittedJsonAndRuntimeConfig();
testRequiredEntrypointValidationIsTopLevelAndNegativeSafe();
testEntrypointValidationIsSelfContainedAfterRelocation();
testNormalizedConfigurationCollisions();
testLocaleParity();
testDeploymentContract();

console.log('Project contract tests passed.');
