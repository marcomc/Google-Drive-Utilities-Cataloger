# Google Drive Utilities Cataloger Instructions

## Apps Script Event Processing

- Keep polling cadence, Pub/Sub message data volume, and Apps Script trigger
  quota/latency costs distinct in architecture and operational documentation.
- Create `clasp` projects outside the source checkout. Move only the required
  local configuration into the repository, and do not publish generated
  `.clasp.json` files.
- Emit concise, structured progress logs for trigger receipt, lock outcome,
  scan scope, per-file result, notification result, and run completion. Do not
  log credentials, recipients, document text, or extracted values.
- Use event payload file identifiers and durable per-file outcome state before
  invoking quota-limited AI APIs. Do not rescan and reprocess an entire intake
  folder for each event; retry unchanged failures only through the scheduled
  fallback path.
