# Configuration Reference

This document is the source of truth for private runtime settings and
installation-specific processing rules. Keep private values out of the
repository, documentation, and issue trackers.

## Contents

- [Gemini runtime](#gemini-runtime)
- [Script Properties](#script-properties)
- [Local configuration file](#local-configuration-file)
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

Only a `429` response explicitly identifying a daily request quota triggers one
Vertex retry and a one-hour temporary Vertex route. Other transient network,
`408`, `429`, and selected `5xx` failures receive one bounded retry on the
current backend; generic rate-limit errors do not cause Vertex usage.

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
| `GEMINI_MODEL` | Optional; defaults to `gemini-2.5-flash`. |
| `VERTEX_AI_LOCATION` | Optional for `vertex_ai`; defaults to `global`. |

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
| `canonical_supplies` | Canonical utility categories used in folders and Sheets. |
| `canonical_suppliers` and `supplier_aliases` | Supplier names and spelling variants. |
| `supply_aliases` | Terms recognized in documents for each utility category. |
| `address_rules` | Printed service addresses and `import` or `archive_only` action. |
| `address_missing_type` | Optional `import` or `archive_only` action when the printed address is missing. Omit it to require review. |
| `archive_only_folder_path` | Folder below the intake root for archive-only documents. |
| `destination_templates` | `supply\|supplier` destination paths; `{year}` is supported. |
| `sheet_by_supply` | Exact spreadsheet tab for each imported supply. |
| `frequency_overrides` | Optional supplier-and-supply frequency overrides. |

A non-empty printed address that does not match an `address_rules` entry always
produces `NEEDS REVIEW`; `address_missing_type` does not weaken that rule.
Each frequency override has this shape:

```json
{
  "supplier": "WATER PROVIDER",
  "supply_type": "Water",
  "frequency": "bimonthly"
}
```

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

The policy can guide classification and extraction. It cannot extend the
configured resource scope, change the required JSON result, or make PDF content
trusted.

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
