#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

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
  assert.match(applicationVersion, /^\d+\.\d+\.\d+$/);
  assert.match(changelog, new RegExp(
    '^## \\[' + applicationVersion.replace(/\./g, '\\.') + '\\]',
    'm'
  ));
  assert.doesNotThrow(() => context.validateAutomationConfig_(automationConfig));
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
  assert.match(deploymentHelper, /--json deployments/);
  assert.match(
    deploymentHelper,
    /script\.googleapis\.com\/v1\/projects\/.+\/deployments\//
  );
  assert.match(deploymentHelper, /EXECUTION_API/);
  assert.match(deploymentHelper, /MYSELF/);
  assert.match(deployScript, /remote_time_zone=/);
  assert.match(deployScript, /--json version/);
  assert.match(deployScript, /--json deploy/);
  assert.ok(
    deployScript.indexOf('read_apps_script_deployment') <
      deployScript.indexOf('push --force'),
    'deployment ownership must be checked before pushing source'
  );
  assert.ok(
    deployScript.indexOf('remote_time_zone=') < deployScript.indexOf('push --force'),
    'the installation time zone must be preserved before pushing source'
  );
  assert.match(
    deploymentGuide,
    /installable triggers[\s\S]{0,80}execute the\s+project HEAD/i
  );
  assert.match(deploymentGuide, /owner-only API executable/);
}

testCommittedJsonAndRuntimeConfig();
testNormalizedConfigurationCollisions();
testLocaleParity();
testDeploymentContract();

console.log('Project contract tests passed.');
