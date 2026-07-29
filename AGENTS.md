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
- When inserting template rows, copy formulas with range-level formula paste so
  relative references adjust; do not replay source formula strings verbatim.
- Journal cross-service mutations before changing Sheets or Drive. Persist the
  per-file outcome and email body before clearing the journal; recover journals
  before sending pending reports.
- Keep installer-owned `clasp` authorization isolated from the global profile.
  Pass `clasp -A` the exact `.clasprc.json` path, not its containing directory,
  and cover the real CLI argument shape in tests rather than only mocking the
  command name.
  Pass complete private bootstrap data through the temporary Secret Manager
  handoff, never through command arguments or installer state.
- Persist the identity of a newly created remote resource before subsequent
  validation so a transient inspection failure cannot duplicate it on resume.
  Validate existing mutation targets before changing project source or state.
- Keep `CONFIG.APP_VERSION`, the changelog release, setup status, structured
  logs, and per-file report version synchronized.
- Classify automatic paid-backend fallback only from provider-specific,
  explicit terminal quota or credit signals. Never infer it from an HTTP status
  or documentation URL alone; retain negative tests for transient rate limits
  and responses from the paid backend.
- Classify mixed PDFs from the whole document. An unambiguous fiscal invoice
  takes precedence over cover notices, regulations, annexes, and embedded
  reports; reserve blocking problem output for uncertainties that prevent safe
  import.
- Do not allocate credential files inside command substitutions: subshell
  cleanup registrations do not reach the parent process. Stream secrets over
  stdin when possible; otherwise create and track temporary files in the
  parent shell.
