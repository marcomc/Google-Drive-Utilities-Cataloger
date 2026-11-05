# Configuration Reference

This document is the source of truth for private runtime settings and
installation-specific processing rules. Keep private values out of the
repository, documentation, and issue trackers.

## Contents

- [Gemini runtime](#gemini-runtime)
- [Script Properties](#script-properties)
- [Local configuration file](#local-configuration-file)
- [Supply identity controls](#supply-identity-controls)
- [Drive policy](#drive-policy)
- [Localization](#localization)
- [Configuration validation](#configuration-validation)

## Gemini runtime

Choose one primary runtime:

| Primary runtime | Required setup | Billing model |
| --- | --- | --- |
| Gemini Developer API | Private `GEMINI_API_KEY` from a Google AI Studio project. | Free or paid tier inherited from the key's project. |
| Vertex AI | Vertex AI API enabled on the linked Cloud project. | Google Cloud billing; no API key. |

For Gemini Developer API Free Tier with one-hour automatic Vertex fallback,
select `gemini_api_with_vertex_fallback` in the installer. For a manual
installation, enable Vertex AI on the linked Cloud project, provide the
Developer API key, then run the owner-only
`configureGeminiFreeTierWithVertexFallback` function once. It keeps
`gemini_api` as the primary backend.

Only a `429` response explicitly identifying a terminal daily request quota or
depleted Gemini API prepayment credits triggers one immediate Vertex retry and
a one-hour temporary Vertex route. An explicit per-model capacity or model
quota failure advances through the configured Developer API model chain. If
the whole chain fails, the unchanged PDF is retried after 1, 5, 15, and 30
minutes by a managed trigger. A fifth failed chain round can activate the same
temporary Vertex route when automatic fallback is enabled. Other transient
network, `408`, generic `429`, and selected `5xx` failures receive one bounded
retry on the current backend; short-lived rate limits and bare HTTP status
codes do not cause Vertex usage.
The Interactions API's `quota_exceeded` code identifies daily exhaustion;
`rate_limit_exceeded` keeps the transient retry path. A `too_many_requests`
response advances to the next Developer API model only when its structured
message identifies a concrete Gemini model quota; other responses with that
code keep the transient retry path.
Legacy responses require a structured daily-quota violation or the explicit
prepayment-depletion message. Quota names, shared metrics and documentation
links alone never activate paid fallback.

## Script Properties

The automated installer writes these properties through its owner-only
bootstrap. For manual maintenance, open the standalone Apps Script project,
then use **Project Settings > Script Properties > Edit script properties**.

| Property | Value |
| --- | --- |
| `GEMINI_BACKEND` | Optional: `gemini_api` (default) or `vertex_ai`. |
| `GEMINI_API_KEY` | Required only for `gemini_api`; save this private value in a password manager. |
| `GEMINI_AUTO_VERTEX_FALLBACK` | Optional `true`; requires a configured Vertex AI project. |
| `NOTIFICATION_RECIPIENT` | Recipient for processing reports. |
| `ROOT_FOLDER_ID` | Drive intake-folder ID. |
| `SPREADSHEET_ID` | Destination spreadsheet ID. |
| `AUTOMATION_CONFIG_JSON` | Complete contents of `config.local.json`. |
| `GOOGLE_CLOUD_PROJECT_ID` | Linked standard Cloud project ID, required for Drive events. |
| `GEMINI_MODEL` | Fallback model ID and optional explicit pin. Automatic selection is enabled by default for new installations. |
| `GEMINI_MODEL_AUTO_SELECTION` | `true` selects the newest stable Flash-Lite model independently for each enabled provider; `false` pins `GEMINI_MODEL`. |
| `VERTEX_AI_LOCATION` | Optional for `vertex_ai`; defaults to `global`. |

With automatic selection enabled, the application lists stable Flash-Lite
models from each provider's own catalog, sorts versioned IDs newest first, and
probes candidates with a minimal PDF generation request. Gemini API model
catalogs do not expose a GA launch-stage field, so the selector excludes
preview-style IDs and confirms generation access with the configured key. The
Vertex catalog is filtered to `launchStage=GA` and `versionState=STABLE` before
the same generation probe. Catalog membership alone never marks a model ready.
Each provider's result is cached for 24 hours; temporary catalog or inference
failures retain that provider's last verified selection. `refreshGeminiModelSelectionCaches()`
refreshes all configured provider caches outside invoice processing. PDF
processing never performs catalog discovery; a missing cache fails closed, and
a stale verified cache remains usable during refresh failures. The managed hourly
`maintainGeminiModelSelections` trigger refreshes one due provider/tier pair per
execution, with a 24-hour cooldown per pair and Flash-Lite pairs first. Pinned
mode performs no discovery. Gemini
API and Vertex may resolve to different model IDs. Model discovery has no price metadata; the
Flash-Lite family is the economical tier policy, not a guarantee of the lowest
price. `gemini-flash-latest` is not used as a Vertex publisher-model alias.
After three Flash-Lite attempts fail an approved invoice-contract cost check,
automatic mode can use a separately catalogued and generation-probed stable
Flash model for one targeted repair. The same maintenance operation refreshes
its 24-hour cache together with Flash-Lite selections. Catalog calls
have no caller-configurable timeout in Apps Script, so a missing cache
disables only this optional escalation and leaves the ordinary validated
Flash-Lite result path intact.

`configureGeminiModelSelection('latest_ga_flash_lite')` enables discovery;
`configureGeminiModelSelection('pinned')` disables it, and
`configureGeminiModel('gemini-3.5-flash-lite')` sets a pin and disables
discovery. `validateConfiguredGeminiAccess()` reports the independently
resolved IDs and verifies metadata plus bounded generation readiness for each
enabled provider. The default Developer API request uses Google's Interactions
API with a 16,384-token output budget, model-appropriate thinking controls,
structured JSON output,
and `store:false` so invoice documents are not retained as Interaction state.
Thinking and response tokens share this ceiling; the budget leaves room for
complete JSON after reasoning on detailed invoices. Incomplete responses remain
blocking and follow the existing bounded model-chain retry schedule.
Vertex AI uses `generateContent` with its independently selected model and
output budget. Versioned Flash-Lite models use low thinking; the API-specific
configuration retains the supported controls for older model families. Vertex
uses its REST field casing (`thinkingConfig.thinkingLevel`) while the Gemini
Interactions API uses `generation_config.thinking_level`.

If `GDUC_GEMINI_MODEL` is explicitly set during installation, automatic model
selection is disabled and that model is pinned. Otherwise new installations
enable provider-specific discovery. Existing installations remain unchanged
until `configureGeminiModelSelection('latest_ga_flash_lite')` is called.

For automatic mode, eligible models from the provider catalog are tried from
newest to older if a generation request reports that a model is unavailable.

Explicit capacity and model-quota failures advance to the next model. If the
whole list remains unavailable, the existing persisted 1/5/15/30-minute retry
rounds apply; the configured temporary Vertex AI fallback starts only after the
rounds are exhausted. An explicit terminal daily-quota or depleted-credit
signal still moves directly to Vertex AI when automatic fallback is enabled.

Reasoning controls follow the selected API and documented
[Interactions](https://ai.google.dev/gemini-api/docs/thinking#controlling-thinking)
and [Vertex](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking)
model capabilities:
Versioned Gemini 2 pins use `medium` through Interactions and a 4,096-token
thinking budget through Vertex. Versioned Gemini 3 and later Flash-Lite, Flash
and Pro families use low, medium and high thinking respectively. Family/version
recognition uses patterns rather than a release list.
Unclassified pins omit unsupported reasoning settings and retain the explicit
response limit.

Supplier values written to Sheets use the exact configured canonical spelling.
Supplier abbreviations require explicit configured aliases; the engine contains
no supplier-specific aliases, extraction defaults or cost allocations. The
owner-only `renameCatalogerSupplierIdentity(previous, target)` updates a single
configured identity and its references, preserving the previous spelling as an
alias. Ambiguous configurations are rejected before writing properties.
Approved profile contracts carry document-specific reading rules and numeric
absence defaults; see [Invoice contracts](INVOICE_CONTRACTS.md).
The extraction reference year/month anchor the start of the actual billed
service period. For every supply, the sheet reference-month field displays `mm`
for one month, `mm–mm` for several months in one year, or `mm/YYYY–mm/YYYY`
across years. The reference-year field remains the start year as literal text.
For example, May-August 2026 is year `2026`, month `05–08`; November 2025-February
2026 is year `2025`, month `11/2025–02/2026`. Partial-month cycles also show both
endpoint months. Both valid, ordered service dates are required, independently
of invoice date, payment date or inferred cadence. Custom formulas that assume
a numeric month need an explicit range-aware design; the importer preserves
formula-backed columns and does not silently rewrite user formulas.
Pinned mode tries only the configured model ID on each enabled backend; it
contains no embedded alternative model list. Automatic mode selects candidates
from each backend's live catalog independently.
Existing reference year/month cells can
be normalized with the owner-only
`migrateCatalogerReferencePeriodText` maintenance function.

`configureGeminiBackend` is an owner-only maintenance function for selecting
`gemini_api` or the already configured `vertex_ai` backend. Use it temporarily
only when an operator has confirmed a Developer API outage and accepts the
Vertex AI billing path; restore `gemini_api` after the recovery. HTTP status
alone must not enable paid fallback automatically.

Do not set `PUBSUB_TOPIC`, `PUBSUB_SUBSCRIPTION`,
`WORKSPACE_EVENT_SUBSCRIPTION`, or `WORKSPACE_EVENT_EXPIRES_AT`. The automation
creates and maintains them.

## Local configuration file

`config.example.json` is the public template. From the repository root, create
a private copy beside it. The automated installer does this when needed:

```sh
cp config.example.json config.local.json
jq empty config.local.json
```

Replace every placeholder. The installer rejects an unchanged template and
writes the complete object to `AUTOMATION_CONFIG_JSON` during resume. For a
manual installation, paste the complete file contents into that Script
Property. Runtime does not read a JSON file from Drive or Apps Script source.
The serialized object must remain at or below 8 KiB; the validator keeps that
margin below the official
[9 KB per-value Apps Script limit](https://developers.google.com/apps-script/guides/services/quotas).

`config.local.json` is ignored by Git and clasp. Do not commit or upload it.

| JSON key | What to customize |
| --- | --- |
| `locale` | `en` for English or `it` for Italian output and sheet-header aliases. |
| `time_zone` | IANA time zone used by Apps Script and the spreadsheet; defaults to `Europe/Rome`. |
| `canonical_supplies` | Canonical utility categories used in folders and Sheets. |
| `canonical_suppliers` and `supplier_aliases` | Supplier names and spelling variants. |
| `supply_aliases` | Terms recognized in documents for each utility category. |
| `address_rules` | Printed service addresses and `import` or `archive_only` action. |
| `address_missing_type` | Optional `import` or `archive_only` action when the printed address is missing. Omit it to require review. |
| `archive_only_folder_path` | Folder below the intake root for archive-only documents. |
| `destination_templates` | `supply\|supplier` destination paths; `{year}` is supported. |
| `sheet_by_supply` | Exact spreadsheet tab for each imported supply. |
| `frequency_overrides` | Optional supplier-and-supply frequency overrides. |

For invoices, `address_rules` is not the ownership baseline. The importer
compares the printed account holder and service address with the control values
in the target supply sheet. Supplier, contract, and customer identifiers may
change when the provider changes. `address_rules` continues to classify
non-invoice documents and archive-only cases; it does not override invoice
identity verification.

`ENFORCE_SERVICE_ADDRESS_IDENTITY` is an optional Script Property. It defaults
to `true`; set it to `false` only as a temporary, owner-approved operational
exception while a reviewed semantic address matcher is unavailable. With the
exception active, the account-holder comparison remains required, the printed
address remains stored on the imported row, and every monetary and duplicate
check remains unchanged. It does not relax the complete-address requirement
when establishing a new supply's initial identity controls.
Each frequency override has this shape:

```json
{
  "supplier": "WATER PROVIDER",
  "supply_type": "Water",
  "frequency": "bimonthly"
}
```

## Supply identity controls

Every configured supply tab has two control fields immediately above its
headers:

| Field | Purpose |
| --- | --- |
| `Account holder` / `Intestatario` | Expected full name of the contract holder. |
| `Service address` / `Indirizzo di fornitura` | Expected street, civic number, and city. |

Empty controls show localized prompts with an amber warning state; completed
controls turn green automatically. On a pristine supply tab, the first valid
invoice replaces both prompts with its printed account holder and a canonical
address built from the corroborated street, civic number, postal code when
available, and city.

For an existing installation, run the owner-controlled
`migrateCatalogerServiceIdentityFields` function once after deployment. The
operation inserts the two columns between contract number and customer code,
adds the control row, and is safe to repeat. A migrated tab that already has
invoice rows remains fail-closed until both controls are completed manually;
the importer never derives a new baseline from later history. Partially filled
or formula-backed blank controls also require manual correction. Imported rows
retain the printed holder and address, so address changes remain visible in the
historical record.

Comparison ignores case, punctuation, repeated whitespace, line breaks, common
Italian street abbreviations, reviewed honorific prefixes, and a trailing
province code after the complete city. Street-name connectors and qualifiers
remain significant, as do every civic-number and city token; field order, CAP, and formatting do not have to match. A missing
control value or mismatch produces `NEEDS REVIEW` without changing Drive or
Sheets, except for the explicit pristine-tab first-import bootstrap above.

## Drive policy

The installer creates the intake `AGENTS.md` from
[AGENTS.example.md](../AGENTS.example.md) when it is absent. For a manual
installation, copy the template to the root of the Drive intake folder and
name that Drive copy exactly `AGENTS.md`.

```text
Repository:           AGENTS.example.md
Drive intake folder:  AGENTS.md
```

Customize only the Drive copy with installation-specific classification and
extraction rules. Do not commit it, publish it, or upload it with clasp. The
script requires exactly one readable, non-empty policy file, up to 40 KiB,
before it processes an eligible PDF.

For invoice fields that have separate spreadsheet columns, direct the model to
extract each printed value independently. For example, keep a contract number
and customer/client code distinct rather than using one as a fallback for the
other.

The policy can guide classification and extraction. It cannot extend the
configured resource scope, change the required JSON result, or make PDF content
trusted.

## Supplier profiles

The optional localized supplier-profile folder is a separate policy layer
inside the intake folder. A supplier subfolder contributes guidance only when
it contains the exact approved profile file for the installation locale. The
importer ignores every pending proposal folder.

For each supplier, copy the installer-created localized template from the
managed supplier-profile folder in the Drive intake folder. It supplies the
locale's exact profile filename and accepted front-matter keys and values; for
example, Italian installations require `PROFILO.md` with `stato: approvato`
and `fornitore`, not the English `PROFILE.md` fields. The repository's
[canonical profile template](../supplier-profiles/PROFILE.example.md) is an
English reference only. Record the official website and each bill-reading guide
with its version/date, source tier (`official` or `external`), and verification
date. An external guide is reference material only and needs manual approval
before it appears in the approved profile.

The installer records the localized template it creates. It can update only
that exact, unmodified managed template (including the known pre-marker
template from an earlier installation). If a template has been edited or was
not created by the installer, setup stops and preserves it; copy it into a
supplier profile instead of editing the shared template.

## Localization

Locale data is separated from the automation logic:

```text
Localization.gs       Locale registry and shared lookup helpers
locales/en.gs         English labels and header aliases
locales/it.gs         Italian labels and header aliases
```

To add a language, copy `locales/en.gs`, set its `spreadsheetLocale`, translate
labels and aliases only, register the locale code in `Localization.gs`, then
set that code in `config.local.json`. The CLI installer derives its supported
codes from that registry. Keep the internal document-type values `Invoice`,
`Contract`, and `Report` in English.

## Configuration validation

Before activation:

1. Validate the complete configuration contract:

   ```bash
   node scripts/validate-config.js config.local.json
   ```

2. Run `make install-resume`; it validates properties, policy, event transport,
   and triggers.
3. For manual installations, confirm every required Script Property and one
   valid Drive `AGENTS.md`, then run `getSetupStatus`.

Continue with [controlled validation](INSTALLATION.md#controlled-validation).

To change only the time zone after installation, edit `time_zone` and run
`make install-reconfigure-time-zone`. The installer validates it through the
runtime IANA database, rejects fixed UTC offsets, and keeps installer state and
`AUTOMATION_CONFIG_JSON` synchronized. See
[Reconfigure time zone](INSTALLATION.md#reconfigure-time-zone).
