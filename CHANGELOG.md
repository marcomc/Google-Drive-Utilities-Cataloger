# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-16

### Added

#### Utility document automation

- Direct-root PDF intake with strict exclusion of folders, nested files,
  non-PDF files, hidden files, and the Drive policy file.
- Daily intake scanning plus an event-driven path using Google Workspace
  Events, Pub/Sub, and a 15-minute Apps Script poller.
- Installation-specific Pub/Sub topics and subscriptions, event-subscription
  renewal, topology validation, and controlled transport repair.
- Processing locks and durable per-file outcome fingerprints to prevent
  concurrent work and redundant AI requests.
- Manual single-file processing for controlled validation and recovery.

#### Gemini extraction

- Gemini Developer API and Vertex AI backends with configurable model and
  Vertex location.
- Optional automatic Vertex AI fallback for one hour after verified Gemini
  Developer API daily-quota exhaustion.
- One normal generation request per eligible PDF, bounded transient retries,
  and no retry for generic quota errors.
- PDF extraction into a strict JSON contract constrained by the configured
  spreadsheet headers and Drive policy.
- Provider usage logging for prompt, response, thinking, and total tokens,
  including an operational Vertex AI cost estimate.
- Non-generative installer validation of Gemini API keys, models, projects,
  and Vertex locations.

#### Classification and safety

- A trusted, size-limited `AGENTS.md` policy loaded from the Drive intake
  folder for every eligible document run.
- Explicit prompt-injection boundaries that treat PDF text, OCR, metadata, and
  links only as untrusted data.
- Configurable supply categories, suppliers, aliases, service-address rules,
  missing-address behavior, destination templates, sheet mappings, and
  billing-frequency overrides.
- Canonical handling for invoices, contracts, reports, import destinations,
  and archive-only destinations.
- Validation of required extraction fields, service-address decisions, and
  invoice total reconciliation before any mutation.
- SHA-256 duplicate detection combined with supplier, identifier, and issue
  date checks across Drive and the spreadsheet.
- Collision-safe canonical filenames and destination-folder verification
  without destructive rollback.

#### Drive, Sheets, and email

- Canonical PDF renaming, destination-folder creation, verified moves, and
  fallback paths for previously unknown but certain suppliers.
- Archive-only document handling without spreadsheet mutation.
- Chronological invoice-row insertion into localized Google Sheets tabs.
- Preservation of existing formulas, styles, column structure, and date and
  currency formats when inserting rows.
- Source-file hyperlinks plus post-write verification of invoice data,
  formulas, and Drive links.
- Localized per-file email reports for imported, archived, duplicate,
  needs-review, and error outcomes.
- Suppression of empty reports when no intake PDF was found.

#### Configuration and localization

- Private Script Properties for credentials, Drive and Sheet identifiers,
  runtime selection, automation rules, and event-transport state.
- Public `config.example.json` and private ignored `config.local.json`
  workflow.
- Separate English and Italian localization files for report labels, document
  labels, spreadsheet headers, and header aliases.
- Generic public `AGENTS.example.md` template, installed as Drive
  `AGENTS.md` while preserving an existing valid policy.

#### Installer and lifecycle

- A self-documenting Make interface whose default target prints help.
- Interactive, non-interactive, resumable, debug, preflight, and local-reset
  installer modes.
- Validation of Bash, Node.js, `npx`, `jq`, `gcloud`, `clasp`, billing access,
  Cloud project access, and account-level Apps Script API access.
- Google Cloud project creation or reuse, billing linkage, and selective API
  enablement for the chosen Gemini runtime.
- Standalone Apps Script project creation outside the checkout, source
  staging, manifest time-zone configuration, and owner-only API deployment.
- Spreadsheet creation or adoption, localized tab initialization, Drive
  policy creation, destination-folder creation, Script Properties, Pub/Sub,
  Workspace Events, and trigger provisioning.
- Private Gemini key transfer through an installation-specific, labeled,
  temporary Secret Manager resource without exposing the key in process
  arguments or installer state.
- Temporary least-privilege Secret Manager access, credential replacement on
  retry, rejected-credential cleanup, and cleanup after successful
  installation.
- Canonical and ownership-checked installer state paths with symlink
  protection, resumable phases, state-version validation, and safe local
  reset.
- Durable OAuth audience guidance for Workspace and personal Google accounts.
- Final validation of Pub/Sub topology, publisher IAM, Workspace event state,
  Script Properties, spreadsheet structure, and Apps Script triggers.

#### Operations and quality

- Structured Cloud Logging for trigger receipt, scan scope, per-file
  processing, Gemini requests and usage, email delivery, and run completion.
- Setup-status reporting that excludes credentials.
- CLI-first installation, configuration, operations, troubleshooting, cost,
  and controlled-validation documentation.
- Horizontal Mermaid flowcharts and operational use-case tables.
- ShellCheck, Markdownlint, Bash syntax, Apps Script syntax, installer helper,
  credential handoff, and Drive event topology tests.
- MIT license and repository publication guidance that keeps private mappings,
  configuration, installer state, and credentials out of Git.
