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

const { hasRequiredEntrypoint, missingEntrypoints, sourceSyntaxError } = require(
  './lib/apps-script-entrypoints.js');

function validateSourceFiles(files) {
  const failures = [];
  const sources = files.map((sourceFile) => fs.readFileSync(sourceFile, 'utf8'));
  missingEntrypoints(sources).forEach((entrypoint) => {
    failures.push(`Missing required Apps Script entrypoint: ${entrypoint}`);
  });

  for (const sourceFile of files) {
    const syntaxError = sourceSyntaxError(fs.readFileSync(sourceFile, 'utf8'));
    if (syntaxError) {
      failures.push(`${path.relative(projectRoot, sourceFile)}: ${syntaxError}`);
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
