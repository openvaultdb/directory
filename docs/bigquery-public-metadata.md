# Public BigQuery metadata evidence

The optional `metadata_observations` member of an inactive
`ovdb-source/draft-2` BigQuery discovery is additive browse evidence. It does
not change the source format or dataset locator. WDI, Google Trends and the
scoped Citi Bike candidate all remain inactive, with unverified dataset
existence/location, blocked queries, unconfigured execution project, cost
admission not granted, runtime acceptance pending, owned retention unverified
and provider result-retention authorization pending. The WDI canonical record
now carries one reviewed provider metadata observation of the exact
`bigquery-public-data.world_bank_wdi.country_summary` table in `US` at
`2026-10-07T14:50:22Z`. The Google Trends record carries two
provider metadata observations of `top_terms` and `international_top_terms`
in `US` at `2026-10-07T15:39:14Z`. These observations do not establish
dataset-wide coverage or freshness. The Trends publication step used only
`datasets.get` and `tables.get`; it created no query job and read no rows.

The public observation is **separate from transient provider/client metadata**.
Never persist a `MetadataDiscovery`, complete `TableSchema`, provider response,
or query ledger as this evidence. A future publisher must obtain separately
authorized metadata, recursively project it, independently review publication
rights and its exact resource/time binding, and only then author evidence.
An envelope and matching digest prove structural integrity, not provider
authenticity, rights, freshness or execution admission.

## Envelope and provenance

Each array item has exactly these keys:

| Key | Public value |
| --- | --- |
| `format` | `ovdb-bigquery-observation/draft-1` |
| `source_id` | Exact enclosing source ID |
| `source_project`, `dataset_id` | Exact enclosing candidate locator |
| `table_id` | One exact native table, traditional identifier subset |
| `location` | Exact `US`, `EU`, or lower-case hyphenated regional location |
| `object_type` | `TABLE`, `VIEW`, `EXTERNAL`, `MATERIALIZED_VIEW`, `SNAPSHOT` |
| `observed_at` | Canonical UTC second `YYYY-MM-DDTHH:mm:ssZ` |
| `projection` | `partial-public-schema` |
| `provenance` | Exactly `kind`, `method`, `verifier` as below |
| `schema` | Bounded recursive public fields |
| `sha256` | `sha256:` plus 64 lower-case hex digits |

`provenance.kind` is `provider-metadata` for an independently reviewed
metadata-only observation or `synthetic-fixture` for authored tests.
`method` is `datasets.get+tables.get`, describing dataset METADATA then table
STORAGE_STATS reads. `verifier` is the non-identifying contract label
`public-projection-review-v1`; it is not a person, actor, OAuth subject or
authorization receipt. The fixed label cannot substitute for private review
evidence. Exact provider methods/resources and projection review must be
checked privately before publication. The public source project is the
allowlisted data host; job/billing projects and identity project IDs are excluded.

The digest covers the **partial public envelope**, excluding only `sha256`.
Recursively sort object keys using ascending ASCII order, preserve array order,
encode compact UTF-8 JSON without insignificant spaces or trailing newline,
then SHA-256 those bytes. This is neither a raw-response hash nor a source-row
hash. `scripts/testdata/bigquery-public-observation.json` is an explicitly
synthetic golden fixture shared with the Directory renderer.

## Recursive schema allowlist and limits

Each field has exactly `name`, native `type`, explicit normalized `mode`, and
optionally nested `fields`. Normalize an omitted provider mode to `NULLABLE`
before publication; public evidence requires it explicitly. Modes are
`NULLABLE`, `REQUIRED`, `REPEATED`. Field names are traditional ASCII
identifiers, 1–300 characters, case-insensitively unique within each sibling
list. Tables and datasets use traditional identifiers up to 1024 characters.
Unsupported flexible identifiers fail closed in this first version.

Types are `STRING`, `BYTES`, `INTEGER`, `INT64`, `FLOAT`, `FLOAT64`, `BOOLEAN`,
`BOOL`, `TIMESTAMP`, `DATE`, `TIME`, `DATETIME`, `GEOGRAPHY`, `NUMERIC`,
`BIGNUMERIC`, `JSON`, `RECORD`, `STRUCT`, `RANGE`. Only `RECORD`/`STRUCT` admit
nested `fields`, and require a nonempty nested list. Every schema list is
nonempty. Preserve provider field order and native aliases. There are **no
approved optional type descriptors** in this version. Precision, scale,
maximum length, range element type, collation and rounding mode are excluded;
therefore even these native types are deliberately incomplete for execution.
Any later descriptor requires a reviewed versioned contract with individual
shape/bounds and privacy tests.

Reject all unknown keys recursively, including descriptions, policy tags,
security/governance objects, ACLs, default/generated expressions, tokens,
actor/principal/consent IDs, job projects, raw responses, rows, etags, SQL/view
definitions, external storage/configuration and source/provider statistics.
Never salvage a rejected envelope by silently deleting its unknown fields;
projection happens before publication and validation then rejects leakage.

Bounds: at most 8 field levels (top-level is 1), 500 total fields per table,
64 KiB compact UTF-8 JSON per envelope including its digest, 16 distinct exact
tables and 256 KiB total compact observation-array JSON per source. Duplicate
table identities are rejected. Structural traversal rejects hostile depth/count
before digest serialization. Out-of-bounds metadata stays unpublished rather
than being silently truncated.

## Fixtures, generation and browse delivery

Canonical record validation and `sourceEntries` reject synthetic observations.
Registry tests can explicitly opt in to synthetic validation, but canonical
index generation has no fixture override. The existing sorted source index
and `sourcesChecksum` include valid provider-kind evidence automatically for
every entry; no per-source list or alternate registry is introduced. The WDI
record retains the single reviewed `country_summary` observation, while the
Google Trends record carries the two exact table observations; Citi Bike
retains none.

The website separately validates the identical closed projection. Synthetic
evidence requires both an explicit fixture validation option and a fixture
marker. Fixture output remains blocked by the existing deploy guard. Directory
cards lead to their normal cold `/sources/<id>/` pages; pages display exact
table, location/type/time, nested native schema, provenance and digest while
retaining every admission blocker. Fixture pages label the whole observation
synthetic and say no provider call occurred. Provider-kind pages limit claims
to the named tables and observation times; candidate locators stay unverified.

Website support renders the WDI and Google Trends observations on
their inactive source pages. Further publication still needs authorized
projection/review; structural capability is not that authorization. This work
neither calls jobs/tabledata APIs, grants cost/retention/rights, creates a
copy/snapshot, binds semantic models, nor adds DataTug UI. Source object type
`SNAPSHOT` describes metadata only; it never creates a snapshot.

Field/type reference: [Google Table REST resource](https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/tables).
