# Google Drive Utilities Cataloger Instructions

## Apps Script Event Processing

- Keep polling cadence, Pub/Sub message data volume, and Apps Script trigger
  quota/latency costs distinct in architecture and operational documentation.
- Budget long-poll schedules from measured idle execution time and the Apps
  Script daily trigger-runtime quota before reducing the polling interval.
- Create `clasp` projects outside the source checkout. Move only the required
  local configuration into the repository, and do not publish generated
  `.clasp.json` files.
- Emit concise, structured progress logs for trigger receipt, lock outcome,
  scan scope, per-file result, notification result, and run completion. Do not
  log credentials, recipients, filenames, document text, or extracted values.
- Count quota-limited model calls at the outbound request boundary, not from
  trigger executions. Record provider token usage separately from versioned
  cost estimates, and keep Cloud Billing as the accounting source of truth.
- Use event payload file identifiers and durable per-file outcome state before
  invoking quota-limited AI APIs. Do not rescan and reprocess an entire intake
  folder for each event; retry unchanged failures only through the scheduled
  fallback path.
- Serialize every processing entry point with the shared processing lock and
  every trigger or transport mutation with the lifecycle lock.
- Write untrusted spreadsheet text as literal rich text. Reject normalized
  duplicate headers and never overwrite formula-backed columns.
- When inserting template rows, copy formulas with range-level formula paste so
  relative references adjust; do not replay source formula strings verbatim.
- Journal cross-service mutations before changing Sheets or Drive. Persist the
  per-file outcome and email body before clearing the journal; recover journals
  before sending pending reports.
- Keep installer-owned `clasp` authorization isolated from the global profile.
  Pass complete private bootstrap data through the temporary Secret Manager
  handoff, never through command arguments or installer state.
- Do not allocate credential files inside command substitutions: subshell
  cleanup registrations do not reach the parent process. Stream secrets over
  stdin when possible; otherwise create and track temporary files in the
  parent shell.
