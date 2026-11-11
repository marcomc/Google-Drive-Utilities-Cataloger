# Approved invoice contracts

The engine contains no supplier-specific aliases, defaults or cost mappings.
Approved profiles supply reading knowledge as data. Profile creation, revision
and approval remain manual; automatic authoring is a separate TODO proposal.

## Trust and scope

The configured intake folder owns the profile workspace. Only approved
`PROFILO.md`/`PROFILE.md` documents under its verified profile root are loaded,
using the installation locale's names and metadata keys. Pending proposals are
ignored. A profile binds to its configured canonical supplier and declared
supplies. Two profiles for the same supplier may cover disjoint supplies;
overlapping or wildcard scopes are rejected before extraction.

A model cannot select a contract or supply executable policy. The runtime binds
the reviewed contract after canonical supplier/supply normalization. Profiles
cannot override the global reference convention: every invoice uses the first
month/year of its actual billed service period. Historical recaps, credited
periods, payment dates and offer validity do not establish that period.

## Declarative format

Start from [the manual example](../supplier-profiles/PROFILE.example.md).
A profile may contain one fenced `invoice-contract` JSON block with `version: 1`
and canonical `supplies`. Unknown keys and malformed contracts fail closed.

| Key | Contract |
| --- | --- |
| `components` | Unique lowercase IDs for independently printed monetary amounts. Explain each location in profile prose. |
| `checks` | `total` equals the sum of `parts`, within the configured monetary tolerance. |
| `products` | Verify a configured `quantity_header` multiplied by its printed selling `rate_header` equals the named `total` reference. Both headers must be recognized quantity/rate fields, writable, present, unambiguous and numeric. |
| `allocations` | Sum component `parts` into a canonical cost field or configured numeric header. |
| `defaults` | Numeric defaults for exact headers, admitted only after explicit absence evidence. Literal `aliases` and complete `absence_statements` are optional. |
| `electricity_consumption` | Enable quantity/rate evidence checks for this scope. |
| `customer_code_prefixes` | Literal prefixes for recognizing a customer code mislabelled as a contract number. |
| `identifier_absence_statements` | Complete literal absence diagnostics; `{supplier}` and `{customer_code}` are the only substitutions. |

References are component IDs, `field:cost_consumption`,
`field:cost_non_consumption`, `field:vat`, `field:total`, or `header:EXACT HEADER`.
Allocations can write only the two canonical cost fields or configured writable
monetary headers. Quantity/rate fields and VAT/final-total headers are rejected
as allocation/default targets before extraction, including when used by a
product check. They cannot change VAT, final total, identifiers or formulas.
`group` separates alternative canonical/detail representations; repeated source
leaves within a group are rejected. `replace_from` explicitly names printed
parent components that may be replaced by the declared child allocation.
Any other supplied conflicting value remains blocking.

A component marked `reference_only: true` can check a recap but cannot be
allocated. Optional component absence requires both `absence_value` and a
nonempty list of complete literal `absence_statements`. The extraction must
return matching `absence_evidence`; an absence flag alone cannot authorize zero.
Unreadable or ambiguous evidence is never absence.

The response returns `source_components` with each declared ID, finite native
numeric `amount`, and `source_evidence` of `printed` or `explicit_absence`.
Missing, extra or duplicate components block admission. Retained diagnostics
classified as non-blocking by import validation do not suppress a validated
allocation; ambiguous, conflicting or unrecognized problems still block it. Checks compare printed
parents and children independently; no residual balancing is permitted.
Cycles, repeated leaves and duplicate targets are rejected. Collections are
bounded to 100 entries, supplies to 20 and literal strings to 200 characters.
Profiles cannot execute arbitrary expressions or regular expressions. Product
checks are a fixed quantity-times-rate operation and never infer missing inputs.
They consume finite numeric values after the existing field-specific localized
normalization; accepted localized rate/quantity strings remain supported, while
ambiguous grouping and prose fail before product validation. Source component
amounts must always be native JSON numbers.

For a bill that includes network and system charges in several printed parent
sections, transcribe each component and its parent independently. Check each
printed parent against its children, then allocate the exclusive components
to the configured detail columns once. A separate charge must have printed
evidence or an explicitly reviewed absence statement; a nested recap alone does
not authorize another charge. Conflicting supplied values remain blocking.
Profiles with fixed column bindings require those writable columns to exist.

## Manual installation migration

1. Preserve existing approved profile prose and evidence sources. Review the
   former installation-specific rules and express them in the matching existing
   supplier/supply profiles. Do not generate or approve a profile automatically.
2. Back up the current Drive policy and profiles and record exact item IDs and
   content hashes before updates. Apply the corresponding generic runtime
   policy change separately from source deployment; deployment does not sync it.
3. Run owner-only `validateApprovedInvoiceProfiles()`. If `configured` is false,
   explicitly select the existing workspace with
   `configureApprovedProfileWorkspace({rootFolderId, profileRootId, templateFolderId})`.
   This verifies parentage, exact identities, unique localized names and all
   approved profiles before storing workspace identity. It creates no resources
   and rejects changing an existing workspace to different IDs.
4. Run validation again and verify fresh cloud downloads against the reviewed
   hashes. Repeated workspace configuration is idempotent. A failed readback
   requires a fresh read before retrying; never assume the write did not occur.
5. Preview representative existing PDFs before processing. Check components,
   cost roles, totals, actual service periods and target cell types. Missing
   workspace state blocks ordinary extraction until this migration is complete.

Historical reference corrections require a fresh row snapshot and source PDF,
exact identity and prior-value checks, a journal, narrow reference-cell writes
and fresh readback. Do not reimport a correct financial row to change its month.
