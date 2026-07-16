#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const sourceFiles = [
  ...fs.readdirSync(projectRoot)
    .filter((fileName) => fileName.endsWith('.gs'))
    .map((fileName) => path.join(projectRoot, fileName)),
  ...fs.readdirSync(path.join(projectRoot, 'locales'))
    .filter((fileName) => fileName.endsWith('.gs'))
    .map((fileName) => path.join(projectRoot, 'locales', fileName))
];

const failures = [];
for (const sourceFile of sourceFiles) {
  try {
    // Compile without executing Apps Script globals.
    new Function(fs.readFileSync(sourceFile, 'utf8'));
  } catch (error) {
    failures.push(`${path.relative(projectRoot, sourceFile)}: ${error.message}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`Apps Script syntax passed for ${sourceFiles.length} files.`);
