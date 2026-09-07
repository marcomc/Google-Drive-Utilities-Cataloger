# Adaptive invoice templates: feasibility and experiment plan

Research date: 2026-09-06. Status: proposed experiment; not implemented.
Backlog: [adaptive extraction templates](../TODO.md#propositions).

## Recommendation and agreed constraints

Run a bounded comparison before adopting automatically generated templates.
The first objective is more accurate extraction on the first attempt, retaining
AI interpretation on every invoice. A template added to the full PDF does not
inherently reduce input tokens; savings must come from less irrelevant context,
fewer repair calls, or a genuinely smaller evidence payload.

Agreed defaults:

- Prioritize Apps Script and existing Google services. Compare an external PDF
  component only as an alternative if the simpler options are insufficient.
- Keep AI on every invoice to interpret month-to-month nuances and exceptions.
- Identify templates by supplier, supply type, and document-format family.
  Support several supplies per supplier and coexisting formats per supply.
- Preserve whole-document classification, trusted policy precedence, identity
  checks, monetary reconciliation, and the existing import contract.
- This proposal authorizes no runtime implementation, deployment, production
  reimport, or automatic change to approved supplier profiles.

## Current implementation and observed evidence

The repository already has manually approved supplier reading guides. In
[UtilitiesCataloging.gs](../UtilitiesCataloging.gs),
`loadTrustedExtractionPolicy_` appends all approved supplier profiles to the
Drive policy. `buildExtractionPrompt_` instructs the model to use only the
matching supplier/supply guidance. `callGeminiForPdfWithBackend_` sends the full
PDF and prompt on each extraction attempt, including validator-guided repairs.
There is no preliminary PDF text or layout extractor in this checkout.

The current [configuration](../Config.gs) permits three extraction attempts,
with separate transport retries, and uses a 280-second processing deadline.
The Developer API path uses stateless Interactions requests; Vertex uses
`generateContent`. Backend capabilities must therefore be evaluated separately.

The base prompt measured 16,077 characters before installation policy, supplier
profiles, configuration, and sheet headers. Its response schema was another
2,117 bytes. These are source-derived sizes, not tokenizer measurements or the
size of a complete production request.

Read-only Cloud Logging inspection on 2026-09-06 returned the following snapshot:

| Measure | Observation |
| --- | ---: |
| Observed interval, UTC | 2026-08-30 19:39 to 2026-09-06 13:54 |
| Matching events returned | 616; query limit of 2,000 not reached |
| Distinct PDF IDs with usage telemetry | 12 |
| Responses with usage telemetry | 152 |
| First / second / third extraction responses | 67 / 48 / 37 |
| Median input tokens per response | 12,577.5 |
| Median total tokens per response | 17,074.5 |
| Vertex / Developer API usage responses | 149 / 3 |

The query selected the cataloger component's generation request, response,
usage, and file-completion events over seven days. Only aggregate counts are
recorded here; no invoice content or file identifiers are included.

This sample includes repeated processing and is not a representative monthly
workload or a template benchmark. The 85 second/third-attempt responses show
that repairs are worth measuring, not that templates could eliminate all of
them. These mostly Vertex observations cannot establish Developer API free-tier
headroom. No new model extraction was run for this investigation.

Separate event waiting time, AI extraction time, and Sheets/Drive mutation time.
The event path currently polls every 15 minutes; a template would not shorten
that scheduling delay. See [event processing and observability](OPERATIONS.md).

## Techniques and trade-offs

| Priority | Approach | Expected benefit and limitation |
| --- | --- | --- |
| 1 | Full PDF plus compact format guides | Keeps visual context and AI interpretation; benefit depends on fewer repairs or less irrelevant guidance. |
| 2 | Preliminary reading, then one guide plus the full PDF | Can reduce guide/context volume, but adds preprocessing latency and service quota usage. |
| 3 | Structured PDF extraction plus selected evidence for AI | Could reduce AI input further, but requires reliable evidence coverage and a more capable PDF component. |
| 4 | Managed document parser | Comparison option; added service costs and domain mapping make it a lower-priority choice. |

### OCR and template precedents

[invoice2data's official tutorial](https://github.com/invoice-x/invoice2data/blob/master/docs/tutorial.md)
describes JSON/YAML templates with matching keywords, exclusions, regular
expressions, and section-delimited extraction. This is a useful reference for
declarative field locators, not proof that an automatically generated template
is correct. Its extraction behavior also depends on the PDF reader used.

Prefer section anchors and relative relationships to rigid page coordinates.
For example, locate a selling rate within its parent selling-cost section,
rather than assume that a fixed rectangle on page two always contains it.
Month, amount, row-count, or pagination changes need not create a new format.
Repeated labels and subordinate `di cui` rows must retain their section context.

[Drive API conversion](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
offers a PDF-to-Google-Docs/OCR route accessible from Apps Script. However,
[Google's conversion guidance](https://support.google.com/drive/answer/176692)
warns that tables and columns may not be detected reliably. Evaluate it first
for supplier, supply, and format recognition rather than as the sole source of
monetary values. Account for temporary document creation, cleanup, latency,
permissions, and conversion quotas in any later experiment.

[pdfplumber](https://github.com/jsvine/pdfplumber) exposes word positions and
table extraction, particularly for digitally generated PDFs. It requires a
Python runtime outside Apps Script and does not itself solve OCR for scans.
Keep it as a comparison alternative, not a new deployment dependency by default.

[Document AI Invoice Parser](https://docs.cloud.google.com/document-ai/docs/processors-list#processor_invoice-parser)
supports Italian and generic invoice fields. Its documented schema does not
establish coverage of this project's detailed utility categories or electricity
bands; domain mapping and validation would still need evaluation. Compare
[service pricing](https://cloud.google.com/products/document-ai/pricing) before
assuming that replacing Gemini work with managed parsing saves money.

### Token usage, caching, and free tiers

[Gemini's document-processing documentation](https://ai.google.dev/gemini-api/docs/document-processing)
states that Gemini 3 includes native PDF text without charging for those
extracted text tokens, while PDF visual processing has its own token reporting.
Consequently, converting an entire PDF to ordinary prompt text is not
necessarily cheaper. Measure actual usage and billing semantics for the chosen
model and backend rather than equating text size with savings.

A durable template registry is distinct from model context caching. The
[generateContent caching documentation](https://ai.google.dev/gemini-api/docs/generate-content/caching)
describes storage costs and states that cached tokens still count toward token
limits. Do not assume monthly template reuse justifies a long-lived paid cache.
[Interactions](https://ai.google.dev/gemini-api/docs/interactions-overview)
also supports implicit caching in stateless mode; enabling conversation storage
is not required for the proposed template experiment.

[Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) distinguish
requests per minute, input tokens per minute, and requests per day, with limits
varying by model and project. Smaller inputs mainly help token limits; fewer
extraction and repair calls can also help request limits. No fixed free-tier
capacity or percentage saving is assumed in this proposal.

## Proposed template lifecycle

Use declarative JSON stored in an installation-managed Drive area. The minimum
candidate content is supplier, supply type, format family/version, required and
incompatible recognition signals, section anchors, field labels and units,
evidence relationships, provenance, and validation status. Store no reusable
invoice-specific amounts, customer identifiers, or executable code.

1. For a recognized format, guide the AI extraction and check applicability
   against the current document, not only supplier and supply names.
2. For an unknown or ambiguous format, use the current full-document path.
3. After validated extraction, generate a candidate guide automatically.
4. Replay candidates against independent invoices and incompatible examples
   before enabling reuse. The invoice that generated a template cannot alone
   demonstrate that it generalizes.
5. When a format changes, create a new version and preserve older valid formats.
   Unreadable data, a conflicting amount, or a failed extraction alone does not
   prove that the layout changed.

Generated guides remain a separate data layer; they cannot silently become
approved policy or overwrite an approved supplier profile. A successful total
reconciliation alone does not prove correct allocation of every cost category.
Unknown supply types must not automatically create configuration, destination
folders, or spreadsheet mappings.

The main feasibility question is recognition before inference. Drive metadata
alone does not reliably establish supplier, supply, and format. Compare a
bounded guide catalog selected within the same AI request against a preliminary
Drive/OCR read selecting one guide before that request. Do not add a separate
LLM routing call by default. Any future generation or fallback path must respect
the shared processing deadline and explicitly account for all outbound calls.

## Experiment and adoption decision

1. Build a manually verified corpus grouped by supplier, supply, format, and
   month. Keep later months out of candidate generation. If independent samples
   are unavailable, report the affected template as unvalidated.
2. Establish a baseline separating initial extraction, validator repairs,
   transport retries, and event waiting time.
3. Compare baseline A with B, full PDF plus compact guides selected in the same
   AI call, and C, preliminary Drive/OCR selection plus one guide and full PDF.
   Retain AI interpretation for every invoice in each comparison.
4. Define and exercise candidate generation, independent replay, activation,
   reuse, mismatch fallback, and coexisting versions as described above.
5. Cover one supplier with electricity and gas, multiple formats for one supply,
   later-month invoices, legacy/new layouts, adjustments and credits, repeated
   labels in different sections, scans, and missing or contradictory evidence.
6. Decide adoption from measured quality, processing time, and amortized resource
   use. Keep the current production path if benefits are absent or quality falls.

Compare against manually verified values, not merely the current model's output
or whether an invoice passed arithmetic validation. Record per-field accuracy,
incorrectly accepted imports, review outcomes, repair/fallback frequency, every
model request, input/output/thinking tokens, and median/p95 latency. Report
extraction-only and end-to-end timing separately when each is actually measured.

Use the same model version and backend across comparison arms, recording the
resolved version rather than relying only on a mutable model alias. Include
template generation, preprocessing, failed matches, fallback, and maintenance
in the totals. Run extraction comparisons without production spreadsheet writes;
any future integration validation needs isolated output targets.

Let `G` be initial generation/validation cost, `B` baseline cost per invoice,
and `E` expected cost with templates, including preprocessing, repairs, fallback,
and maintenance. When `B > E`, the break-even reuse count is `G / (B - E)`.
Use consistent units and assess money, tokens, and time separately. If `B <= E`,
there is no economic break-even under those assumptions. Expected reuse depends
on billing frequency and how long the format remains applicable.

Adoption requires no observed quality regression or new incorrectly accepted
imports in the evaluation set and a positive measured benefit over the expected
reuse horizon. A small passing corpus is limited evidence, not a guarantee.
No benchmark results, savings percentage, automatic activation threshold, or
production rollout are claimed by this research-only proposal.
