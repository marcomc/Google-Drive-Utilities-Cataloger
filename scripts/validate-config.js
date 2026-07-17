#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const configPath = path.resolve(process.argv[2] || '');

if (!process.argv[2]) {
  console.error('Usage: node scripts/validate-config.js <config.json>');
  process.exit(2);
}

try {
  const automationConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
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
  vm.runInContext(
    fs.readFileSync(path.join(projectRoot, 'Localization.gs'), 'utf8'),
    context,
    { filename: 'Localization.gs' }
  );
  vm.runInContext(
    fs.readFileSync(path.join(projectRoot, 'Config.gs'), 'utf8'),
    context,
    { filename: 'Config.gs' }
  );
  context.validateAutomationConfig_(automationConfig);
  console.log('Automation configuration is valid.');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
