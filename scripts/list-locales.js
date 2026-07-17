#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const context = vm.createContext({});

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

const locales = context.getSupportedLocales_();
if (!Array.isArray(locales) || locales.length === 0 ||
  locales.some((locale) => !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale))) {
  throw new Error('Localization registry contains an invalid locale code.');
}
process.stdout.write(`${locales.join(' ')}\n`);
