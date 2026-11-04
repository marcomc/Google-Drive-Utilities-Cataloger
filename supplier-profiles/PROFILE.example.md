---
status: approved
supplier: SUPPLIER NAME
supplies: [supply]
verified_on: YYYY-MM-DD
---

# Supplier profile: SUPPLIER NAME

## Sources

- Official website: <https://example.invalid/>
- Bill-reading guides: version/date, source tier, URL, verification date.

## Document structure

- Invoice: stable visual sections, required evidence, and known variants.
- Report: stable visual sections, required evidence, and known variants.
- Version history: describe changes and their effective date/range.

## Navigation

- Classify from printed evidence and structure together; do not use filename alone.
- After classification, inspect the documented sections in order and reconcile totals.
- A structural mismatch is evidence for review or a pending proposal, never a
  reason to invent data.
- Keep identifiers and all other non-quantitative document values as literal
  text, including digit-only values and leading zeroes.

## Invoice contract

This optional, manually reviewed block declares numeric source evidence and
additive checks. Use the installation's canonical supply name. Component IDs
are local to this profile; the importer never interprets them as supplier names.
This example uses only canonical cost fields, so it does not require additional
spreadsheet columns.

```invoice-contract
{
  "version": 1,
  "supplies": ["SUPPLY NAME"],
  "components": [
    {"id": "consumption"},
    {"id": "non_consumption"},
    {"id": "printed_total"}
  ],
  "checks": [
    {"total": "printed_total", "parts": ["consumption", "non_consumption", "field:vat"]},
    {"total": "field:total", "parts": ["printed_total"]}
  ],
  "allocations": [
    {"target": "field:cost_consumption", "parts": ["consumption"], "group": "canonical"},
    {"target": "field:cost_non_consumption", "parts": ["non_consumption"], "group": "canonical"}
  ],
  "defaults": []
}
```

Document exactly where each component is printed, which rows are subtotals or
repeated references, and which current service period is billed. The reference
month is always the first month of that actual period, including advance billing
and year boundaries; historical, credited and future-notice dates are not the
current period.

## Maintenance

- Put a revised profile in `Pending approval` for review; never overwrite this
  approved profile automatically.
