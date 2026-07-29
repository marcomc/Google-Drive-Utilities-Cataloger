# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-07-29 - Electricity dashboard and localized imports

### Added

- Electricity-consumption dashboards with monthly F1/F2/F3 comparisons by
  year, annual band totals, localized English and Italian labels, and preserved
  user-adjusted managed-chart geometry.
- F1, F2, and F3 consumption and unit-cost columns for electricity sheets.

### Changed

- Preserve the complete F1/F2/F3 consumption detail reported on electricity
  invoices, including monoraria contracts with the same unit price in each
  band.
- Identify customer and contract values from their localized invoice labels
  instead of relying on the spreadsheet locale or English field names.

### Fixed

- Keep Energygas `CL...` customer codes out of contract-number fields.
- Validate dashboard source headers and supported capacity before creating
  derived sheets or charts, avoiding partial presentation state.
- Protect technical-sheet ownership, retain managed-chart source ranges, and
  refresh dashboard year series when a newly imported electricity invoice adds
  a year not already represented in the comparison data.
- Roll back corrected pre-existing invoice rows, including their formulas,
  source link, and original position, when a later import mutation fails.
- Reject dashboard refreshes that exceed source or year capacity, and preserve
  existing managed charts if replacement chart insertion fails.
- Roll back a newly inserted invoice row if its dashboard refresh fails, and
  restore reimported strings as literal text during rollback.
- Restrict preserved custom chart ranges to each chart's reserved technical
  data block.
- Apply and read back the corresponding installation-specific Drive runtime
  policy, preserving its local routing rules.
- Force dashboard regeneration after a restored invoice row, preserve advanced
  managed-chart formatting, and expand a custom chart range only on a new-year
  refresh.
- Rebuild electricity statistics after replacement imports and journal recovery,
  normalize reported F1/F2/F3 quantities to numeric kWh values, retain the
  correct Energygas customer code, and skip dashboard work for other supplies.
- Reject ambiguous single-separator F1/F2/F3 quantities and rebuild the
  dashboard after rolling back a failed newly inserted electricity invoice.
- Normalize unambiguous repeated-separator F1/F2/F3 quantities without
  rejecting large electricity consumption values.
- Reject electricity imports when an installed dashboard's required source
  headers are missing or have been renamed.
- Reject imports when a visible electricity dashboard survives without its
  managed technical sheet, instead of leaving broken charts stale.
- Reject dashboard pairs with an unmanaged technical sheet and preserve
  separately selected category and series chart ranges as years expand.
- Reject installer reruns against a damaged existing dashboard source and
  refresh electricity statistics after journal recovery deletes an inserted row.
- Preserve existing technical dashboard data across refresh failures and extend
  a user-shortened all-bands range as electricity invoice rows are added.
- Allocate the complete temporary technical-data backup and retain managed
  chart font-size customization during refresh.
- Prevent dashboard aliases to every configured supply tab and clean up a
  temporary technical backup if snapshot creation fails.

## [0.2.0] - 2026-07-23 - Gemini 3.6 Flash

### Changed

- Use the stable `gemini-3.6-flash` model by default for Gemini Developer API
  and Vertex AI fallback, with explicit medium thinking and the existing
  8,192-token extraction response budget.

## [0.1.1] - 2026-07-19

### Fixed

- Reconcile managed triggers by removing duplicates and adding only missing
  schedules, without replacing healthy triggers.
- Report managed trigger counts and wait for active catalog processing before
  trigger reconciliation.

## [0.1.0] - 2026-07-18

### Added

#### Configurable installation time zone

- IANA time-zone configuration in `config.local.json`, defaulting to
  `Europe/Rome`, with runtime database validation and temporary
  `GDUC_TIME_ZONE` overrides.
- Explicit `--reconfigure-time-zone` installer mode that keeps installer state,
  spreadsheet settings, and `AUTOMATION_CONFIG_JSON` synchronized without
  reusing deleted bootstrap credentials or changing operational automation.
- Guarded Apps Script pushes that restore the tracked manifest after success,
  failure, or handled interruption, plus isolated integration coverage for
  push and remote rollback failures.
- Live-baseline maintenance transactions that pause catalog processing during
  reconfiguration and preserve installed remote source files while changing
  only the manifest timezone.
- Backward-compatible migration of pre-timezone runtime configuration from the
  existing spreadsheet timezone, without interrupting scheduled processing.

#### Deployment automation

- Pull-request validation with `make check` before merging into `main`.
- Automatic Apps Script source deployment when an approved pull request updates
  protected `main`, with serialized execution, stale-run detection, and target
  verification before mutation.
- Project HEAD updates for installable triggers plus numbered Apps Script
  versions labelled with the merged commit SHA and updates to the stable,
  owner-only API executable deployment.
- Preservation of the installation-specific Apps Script time zone during source
  upload without recreating triggers, Script Properties, or Google resources.
- Production GitHub Actions concurrency control and isolated deployment secrets
  documented in the deployment guide.
- Apps Script Deployments API validation of deployment identity and the
  owner-only `EXECUTION_API` entry point before source upload, followed by
  post-update version and entry-point preservation checks.
- Fail-closed installer handling for missing or incompatible API deployments,
  without automatic deletion, state clearing, or replacement.
- Pre-upload installer verification of existing deployment identity, exact
  manifest, and owner-only entry point, with creation-marker reconciliation and
  immediate persistence of a newly created deployment ID so retries do not
  duplicate it or split project HEAD from the numbered executable.
- OAuth-safe deployment inspection with explicit diagnostics for missing
  authorization and Apps Script API status failures, without credential data in
  command arguments or logs.

#### Development workflow

- Project guidance that distinguishes coding-agent instructions from the live
  Drive runtime policy and requires reviewed runtime-policy improvements to be
  applied and verified separately.
- CI and deployment validation pinned to checksum-verified ShellCheck 0.11.0,
  matching the local all-severity shell gate and avoiding runner package drift.

#### Utility document automation

- Direct-root PDF intake with strict exclusion of folders, nested files,
  non-PDF files, hidden files, and the Drive policy file.
- Daily intake scanning plus create, move, and content-change events using
  Google Workspace Events, Pub/Sub, and a 15-minute Apps Script poller.
- Installation-specific Pub/Sub topics and subscriptions, event-subscription
  maximum-TTL patch renewal, long-running operation polling, live topology
  validation, missing-subscription self-healing, and controlled transport
  repair.
- Strict script-scoped Pub/Sub resource identity across provision, repair, and
  renewal, with mismatched stored names rejected instead of overwritten or
  accepted as a compatibility transport.
- Script-scoped Pub/Sub identity validation before every event pull,
  acknowledgement lease change, or acknowledgement, with safe no-op behavior
  when the transport is entirely absent.
- Recovery from the explicit Workspace Events
  `SUBSCRIPTION_ACCESS_DENIED` terminal signal while unrelated `403` failures
  continue to fail closed for operator review.
- Maximum-duration Workspace Events creation by omitting `ttl`, avoiding a
  live API interpretation of `"0s"` as an already-expired subscription while
  retaining the documented zero-TTL patch for renewal.
- One-message pulls with a five-minute acknowledgement lease and acknowledgement
  only after durable processing state.
- Shared processing and lifecycle locks plus durable per-file processing
  leases and outcome fingerprints to prevent concurrent work and redundant AI
  requests.
- Manual single-file processing for controlled validation and recovery.
- Early target validation and target-scoped journal recovery for manual
  single-file processing, without recovering unrelated files.

#### Gemini extraction

- Gemini Developer API and Vertex AI backends with configurable model and
  Vertex location.
- Optional automatic Vertex AI fallback for one hour after verified Gemini
  Developer API daily-quota exhaustion or depleted prepayment credits, while
  generic short-lived rate limits remain on the primary backend.
- One normal generation request per eligible PDF, one bounded retry for
  transient network, `408`, `429`, and selected `5xx` failures, and no backend
  switch for generic quota errors.
- PDF extraction into a strict JSON contract constrained by the configured
  per-supply spreadsheet headers and Drive policy.
- Provider-enforced JSON Schema output for both Gemini Developer API and
  Vertex AI, preventing trailing model text from invalidating an otherwise
  successful extraction response.
- Boolean custom-sheet values preserved consistently across structured-output
  schema, extraction validation, spreadsheet writes, and result verification.
- Gemini 3.5 Flash extraction with medium thinking, an 8,192-token response
  budget, and explicit incomplete-response detection.
- Provider usage logging for prompt, response, thinking, and total tokens,
  finish reason, and an operational Vertex AI cost estimate.
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
- Collision-safe canonical filenames, normalized configuration-identity
  validation, and destination-folder verification.
- Per-file mutation journals and provenance-checked compensation for
  interrupted Sheet, rename, and move operations.

#### Drive, Sheets, and email

- Canonical PDF renaming, destination-folder creation, verified moves, and
  fallback paths for previously unknown but certain suppliers.
- Archive-only document handling without spreadsheet mutation.
- Chronological invoice-row insertion into localized Google Sheets tabs.
- Separate contract-number and customer-code extraction and spreadsheet fields;
  the two values are never substituted for one another.
- Preservation of existing formulas, styles, column structure, and date and
  currency formats when inserting rows.
- Post-write verification that accepts Google Sheets' numeric coercion only
  for the two-digit reference-month field while keeping identifiers strict.
- Literal writes for all untrusted text, with duplicate normalized headers and
  formula-backed columns rejected.
- Root-relative source-file hyperlinks plus post-write verification of invoice
  data, formulas, and Drive links.
- Localized per-file email reports for imported, archived, duplicate,
  needs-review, and error outcomes.
- Application version in every per-file email report, structured log event,
  and setup-status response.
- Single-line normalization of untrusted report fields to prevent filenames or
  extracted narrative text from spoofing additional email labels.
- Durable email outbox with per-item, per-email, and total Script Properties
  storage bounds, retry on a later run, and suppression when there are no new
  or pending outcomes.

#### Configuration and localization

- Private Script Properties for credentials, Drive and Sheet identifiers,
  runtime selection, automation rules, and event-transport state.
- Public `config.example.json` and private ignored `config.local.json`
  workflow.
- Preflight and runtime enforcement of a safe 8 KiB automation-configuration
  ceiling below the Apps Script per-property quota.
- Separate English and Italian localization files for report labels, document
  labels, spreadsheet locale metadata, headers, and header aliases.
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
- Idempotent placement repair for installer-created spreadsheets and
  fail-closed locale/time-zone checks for populated user-supplied workbooks.
- Complete private bootstrap transfer through an installation-specific,
  labeled, temporary Secret Manager resource without exposing private values
  in process arguments or installer state.
- Temporary least-privilege Secret Manager access, credential replacement on
  retry, rejected-credential cleanup, and cleanup after successful
  installation.
- Canonical and ownership-checked installer state paths with symlink
  protection, a restrictive process creation mask, a portable cross-process
  lock, atomic state writes, resumable phases, state-version validation, and
  safe local reset.
- Separate owner-only `clasp` authorization profiles for management and
  runtime bootstrap, with permission repair and cleanup on success or reset.
- Separate consent before changing billing on a reused Cloud project.
- Durable OAuth audience guidance for Workspace and personal Google accounts.
- Final validation of Pub/Sub topology, publisher IAM, Workspace event state,
  Script Properties, spreadsheet structure, and Apps Script triggers.
- Installer validation that reuses the runtime's bounded header-row detection,
  allowing existing spreadsheets with a title row above their real headers.

#### Operations and quality

- Structured Cloud Logging for trigger receipt, scan scope, per-file
  processing, Gemini requests and usage, email delivery, and run completion.
- Setup-status reporting that excludes credentials.
- CLI-first installation, configuration, operations, troubleshooting, cost,
  and controlled-validation documentation.
- Horizontal Mermaid flowcharts and operational use-case tables.
- ShellCheck, Markdownlint, Bash syntax, Apps Script syntax, installer helper,
  private bootstrap, Drive event topology, runtime safety, configuration
  collision, JSON, and localization contract tests.
- MIT license and repository publication guidance that keeps private mappings,
  configuration, installer state, and credentials out of Git.
