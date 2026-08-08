# Google Drive Utilities Cataloger Instructions

## Runtime policy synchronization

- Treat the repository `AGENTS.md` as development guidance for the coding
  agent, and treat the separate `AGENTS.md` in the configured Google Drive
  intake folder as the runtime policy read by the Apps Script and Vertex AI.
- Whenever `AGENTS.example.md` is created or updated, apply the corresponding
  reviewed policy change to the live `AGENTS.md` in the Drive folder that
  contains the user's configured utilities spreadsheet. The folder name is
  installation-specific and must not be hard-coded as `Forniture`.
- Never assume that updating this repository file updates the live Drive policy.
  When testing the application or implementing a change reveals a rule that
  should improve runtime classification, extraction, safety, or import
  behavior, apply the corresponding reviewed change to the live Drive
  `AGENTS.md` as a separate operational update.
- Verify the live Drive copy after updating it and record the policy change in
  the relevant test evidence or operational documentation. Do not overwrite
  the live policy automatically during source deployment.

## Apps Script Event Processing

- Keep polling cadence, Pub/Sub message data volume, and Apps Script trigger
  quota/latency costs distinct in architecture and operational documentation.
- Budget long-poll schedules from measured idle execution time and the Apps
  Script daily trigger-runtime quota before reducing the polling interval.
- Create `clasp` projects outside the source checkout. Move only the required
  local configuration into the repository, and do not publish generated
  `.clasp.json` files.
- Before an automated `clasp push`, verify that the configured deployment ID
  belongs to the target script, preserve installation-specific manifest values,
  and distinguish project HEAD used by installable triggers from the versioned
  API executable deployment.
- After a versioned Apps Script deployment update, retry only an identity-valid
  read that reports the exact version observed at preflight. Treat a different
  version, authorization, transport, identity, and entry-point failures as
  terminal, and test exact post-update read and wait counts for retryable and
  terminal paths.
- After uploading an Apps Script version, inspect that exact version's content
  for every required top-level entrypoint before moving the owner-only API
  deployment; a local source or syntax check cannot prove the deployed artifact
  exposes the function.
- Do not use Apps Script Execution API calls to create or remove installable
  triggers: that API cannot manage triggers, and existing installable triggers
  execute the project HEAD rather than the API executable's pinned version.
- When an installer must temporarily modify a tracked manifest before a remote
  push, isolate the mutation in a subshell: create and validate the backup
  before mutation, restore it with an `EXIT` and signal trap, and clean up
  allocation failures before the trap exists. Test successful pushes, failed
  pushes, and handled interruptions, and never depend on a dirty worktree to
  preserve installation-specific settings across resume.
- A settings-only reconfiguration must not reuse an installation bootstrap
  secret after that temporary secret has been deleted. Use a narrow explicit
  runtime contract and preserve existing credentials, triggers, transport, and
  processing state unless the user explicitly requests those changes.
- Emit concise, structured progress logs for trigger receipt, lock outcome,
  scan scope, per-file result, notification result, and run completion. Do not
  log credentials, recipients, filenames, document text, or extracted values.
- Count quota-limited model calls at the outbound request boundary, not from
  trigger executions. Record provider token usage separately from versioned
  cost estimates, and keep Cloud Billing as the accounting source of truth.
- For structured output from thinking models, set and test explicit thinking
  and response budgets; log the finish reason without logging document data,
  and fail closed unless the provider explicitly reports a successful terminal
  reason such as `STOP`.
- Do not authorize address-derived routing from extracted fields alone:
  corroborate the configured street, civic number, and city against address
  evidence. During state-less OAuth recovery, adopt only an exact legacy local
  auth profile and exactly one owner-only configured deployment; fail closed
  on ambiguity.
- Use event payload file identifiers and durable per-file outcome state before
  invoking quota-limited AI APIs. Do not rescan and reprocess an entire intake
  folder for each event; retry unchanged failures only through the scheduled
  fallback path.
- Validate the complete script-scoped Pub/Sub topic and subscription identity
  before every pull or acknowledgement. Treat an entirely absent pair as an
  unconfigured no-op where appropriate, and reject partial or mismatched state.
- Serialize every processing entry point with the shared processing lock and
  every trigger or transport mutation with the lifecycle lock.
- Because Apps Script trigger metadata does not expose its cadence, persist each
  managed trigger's canonical desired schedule. On reconciliation, preserve a
  matching or legacy trigger and replace only a changed recorded schedule; test
  fresh install, legacy baseline migration, unchanged reconciliation, schedule
  changes, and replacement cleanup failure.
- Write untrusted spreadsheet text as literal rich text. Reject normalized
  duplicate headers and never overwrite formula-backed columns.
- Treat spreadsheet charts as user-owned presentation state. Never recreate,
  move, resize, or reset unmanaged charts from code. When automation must
  regenerate one of its own title-identified charts, first record its position,
  dimensions, title, source range, and formatting; keep the chart bound to its
  reserved technical-data block and restore its user-adjusted presentation.
- Validate every required source header and capacity limit before creating a
  derived dashboard, helper sheet, chart, or other managed spreadsheet
  artifact. A missing prerequisite must leave no partial presentation state.
- Before clearing or reusing a derived technical sheet, reject a source-sheet
  alias and require a managed ownership marker or an exact legacy contract;
  never infer ownership from the displayed name alone. Derived charts must keep
  user-adjusted source ranges within their managed data block, and imported
  data that expands a derived dimension (such as a new year) must refresh the
  affected formulas and chart series.
- When inserting template rows, copy formulas with range-level formula paste so
  relative references adjust; do not replay source formula strings verbatim.
- Journal cross-service mutations before changing Sheets or Drive. Persist the
  per-file outcome and email body before clearing the journal; recover journals
  before sending pending reports.
- When a downstream import fails after validated extraction, preserve a labeled
  non-imported extraction snapshot, failure stage, and rollback status in the
  configured-recipient report without adding document data to Cloud logs.
  Derive rollback completion from the actual remaining recoverable mutations,
  and cover complete, incomplete, and recovery-failure report states.
- Treat every Sheets/Drive mutation as a state-machine boundary: persist a
  completed row insert, replacement, move, rename, or deletion before the next
  fallible refresh or external mutation. Fallback journal writes must repeat
  the completed-state fields, and recovery must resume from that checkpoint
  without requiring the old resource to still exist. Separate the mutation,
  checkpoint, and downstream refresh error phases; never mark a mutation
  complete from a catch block that also handles the mutation itself.
- For a replacement-row rollback, snapshot and restore the original cell number
  formats as well as values and formulas. Exercise a failed replacement after a
  temporary format change so identifiers retain their original presentation.
- When rebuilding managed charts, preserve public state beyond the chart
  options map, including source ranges, geometry, chart type, range merge
  strategy, header count, hidden-dimension strategy, null interpolation, and
  row/column transposition. Cover refresh, rollback, and journal-recovery paths
  with customized-chart regressions.
- Keep installer-owned `clasp` authorization isolated from the global profile.
  Pass `clasp -A` the exact `.clasprc.json` path, not its containing directory,
  and cover the real CLI argument shape in tests rather than only mocking the
  command name.
  Treat the saved Desktop OAuth client at
  `$XDG_CONFIG_HOME/gduc/ci-deployment-oauth.json` or
  `$HOME/.config/gduc/ci-deployment-oauth.json` as the canonical local recovery
  source. When `invalid_grant` occurs, run `make renew-clasp-auth`; it must
  recreate the isolated local profile from that client and validate the stored
  owner-only deployment before any source mutation. Do not assume an existing
  `.clasprc.json` is valid and do not ask for a new client download unless the
  canonical path is absent or invalid.
  Route every installer or CI `clasp --json` deployment list, creation, and
  inspection operation through the shared authorization-aware helper. Preserve
  the actionable `invalid_grant` remediation without relaying provider stderr,
  and test each path before it can mutate a deployment.
  Pass complete private bootstrap data through the temporary Secret Manager
  handoff, never through command arguments or installer state.
- Journal planned ownership before creating a remote resource, then persist its
  exact created identity before metadata, validation, or another fallible step
  so an interruption cannot strand or duplicate it. On resume, adopt a
  planned-only resource only through an exact pristine staging contract, and
  fail closed for stale, malformed, mismatched, or user-owned candidates.
  Apply the same contract to temporary and backup resources; a generated
  unique name is not an ownership marker.
  Validate existing mutation targets before changing project source or state.
- Keep `CONFIG.APP_VERSION`, the changelog release, setup status, structured
  logs, and per-file report version synchronized.
- After an accepted Apps Script deployment update, verify metadata with a
  bounded read-only poll. Retry only the exact validated pre-update version;
  treat authorization, identity, entry-point, transport, and any other
  unexpected version as immediate failures, and test their exact read and wait
  counts.
- Classify automatic paid-backend fallback only from provider-specific,
  explicit terminal quota or credit signals. Never infer it from an HTTP status
  or documentation URL alone; retain negative tests for transient rate limits
  and responses from the paid backend.
- Classify mixed PDFs from the whole document. An unambiguous fiscal invoice
  takes precedence over cover notices, regulations, annexes, and embedded
  reports; reserve blocking problem output for uncertainties that prevent safe
  import.
- Before supporting automated report archival, define trusted report-specific
  date semantics and an explicit destination in the runtime policy; never
  infer either from invoice-only requirements or address routing. Cover reports
  without issue dates and their destination selection with fixtures.
- Do not allocate credential files inside command substitutions: subshell
  cleanup registrations do not reach the parent process. Stream secrets over
  stdin when possible; otherwise create and track temporary files in the
  parent shell.
