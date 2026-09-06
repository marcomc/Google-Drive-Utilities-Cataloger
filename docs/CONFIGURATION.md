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

Only a `429` response explicitly identifying a daily request quota or depleted
Gemini API prepayment credits triggers one Vertex retry and a one-hour
temporary Vertex route. Other transient network, `408`, generic `429`, and
selected `5xx` failures receive one bounded retry on the current backend;
short-lived rate limits do not cause Vertex usage.

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
| `GEMINI_MODEL` | Optional; defaults to Google's `gemini-flash-latest` alias for both Gemini Developer API and Vertex AI fallback. |
| `VERTEX_AI_LOCATION` | Optional for `vertex_ai`; defaults to `global`. |

The default `gemini-flash-latest` alias follows Google's newest release of the
Flash model variation. Google documents that this alias is hot-swapped when a
new Flash release becomes available and provides advance notice for breaking
changes. The alias does not pin a numeric Flash version; record the provider's
reported model version when available rather than inferring it from the alias.
The default Developer API request uses Google's Interactions API with an
8,192-token output budget, explicit `medium` thinking, structured JSON output,
and `store:false` so invoice documents are not retained as Interaction state.
Vertex AI continues to use `generateContent`, the same alias and output budget,
with an explicit `thinkingBudget: 4096`.

Persisted `gemini-3.6-flash` and `gemini-3.7-flash` values are automatically
treated as `gemini-flash-latest`, so source deployment upgrades existing
installations without a separate Script Properties change. The owner-only
`validateConfiguredGeminiAccess` function performs a harmless metadata/token
count validation against every enabled backend. Any other valid model
identifier remains an explicit pin and is not replaced automatically.
Reasoning controls follow the selected API and documented
[Interactions](https://ai.google.dev/gemini-api/docs/thinking#controlling-thinking)
and [Vertex](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking)
model capabilities:
Gemini 2.5 pins use `medium` through Interactions and a 4,096-token thinking
budget through Vertex; `gemini-3-pro-preview` uses `high` through Interactions.
Unclassified pins omit unsupported reasoning settings and retain the explicit
response limit.

Supplier values written to Sheets use the exact configured canonical spelling.
The built-in `ENERGYGAS` abbreviation is accepted as `Energygas Italia` when
that canonical supplier is configured. Existing reference year/month cells can
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
