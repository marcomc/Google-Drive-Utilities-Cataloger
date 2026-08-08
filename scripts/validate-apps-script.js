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

const requiredEntrypoints = [
  'runDailyUtilitiesCataloging',
  'retryFailedUtilitiesCataloging',
  'processSingleIntakeFile',
  'processSingleIntakeFileByName'
];

function hasRequiredEntrypoint(source, entrypoint) {
  return new RegExp(`^function\\s+${entrypoint}\\s*\\(`, 'm').test(source);
}

function validateSourceFiles(files) {
  const failures = [];
  const allSource = files.map((sourceFile) =>
    fs.readFileSync(sourceFile, 'utf8')).join('\n');
  requiredEntrypoints.forEach((entrypoint) => {
    if (!hasRequiredEntrypoint(allSource, entrypoint)) {
      failures.push(`Missing required Apps Script entrypoint: ${entrypoint}`);
    }
  });

  for (const sourceFile of files) {
    try {
      // Compile without executing Apps Script globals.
      new Function(fs.readFileSync(sourceFile, 'utf8'));
    } catch (error) {
      failures.push(`${path.relative(projectRoot, sourceFile)}: ${error.message}`);
    }
  }
  return failures;
}

if (require.main === module) {
  const failures = validateSourceFiles(sourceFiles);
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }

  console.log(`Apps Script syntax passed for ${sourceFiles.length} files.`);
}

module.exports = { hasRequiredEntrypoint, validateSourceFiles };
