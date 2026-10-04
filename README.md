# OVDB Directory data

The public data of the OpenVaultDB Directory: for each database, the canonical
URL people write to refer to it, the publisher repository it is published from,
the commit that is its current reviewed version, and its recordsets and fields
with the [MeaningGraph](https://github.com/meaninggraph/registry) concepts they
carry. The Directory website is a separate repository; it reads
[`index.json`](index.json) from here and holds no list of its own.

| Record ID | Canonical database identity | Repository at commit | Status |
|---|---|---|---|
| `chinook` | `https://demodb.dev/chinook/` | [demo-db/chinook@26e852c](https://github.com/demo-db/chinook/tree/26e852cca00101f53a84ef8ee1f1ae389067f5cf) | draft |
| `northwind` | `https://demodb.dev/northwind/` | [demo-db/northwind@e747265](https://github.com/demo-db/northwind/tree/e74726515c3833620b54b7a50d1d273276dd23c1) | draft |
| `pubs` | `https://demodb.dev/pubs/` | [demo-db/pubs@6c06c5c](https://github.com/demo-db/pubs/tree/6c06c5c7395b03ff1a02c2b1a21485add3e1b65b) | draft |
| `sakila` | `https://demodb.dev/sakila/` | [demo-db/sakila@6567d30](https://github.com/demo-db/sakila/tree/6567d30aec1592fe0917934a8bbe74ff70b04b01) | draft |
| `adventureworks` | `https://demodb.dev/adventureworks/` | [demo-db/adventureworks@cd8dcdf](https://github.com/demo-db/adventureworks/tree/cd8dcdf2079fe31480ad6d6c024b8c17cb91beea) | draft |
| `employees` | `https://demodb.dev/employees/` | [demo-db/employees@2455bb3](https://github.com/demo-db/employees/tree/2455bb327aa8444ec496d36e2fe6dcacfc58dc0a) | draft |

## This repository is the source of truth

The Directory's data is this Git repository, not a database service.
Registering a database, or moving it to a new commit, is a pull request; CI
fetches the publisher repository at that commit and runs the checks, so a
database that does not check cannot be listed.

- **Review and history come free.** Every registration is a reviewed pull
  request with an author, a diff and a permanent record.
- **Nothing broken gets in.** The check runs before the merge, in the same
  place as the change.
- **It is where the databases are.** Publishers keep their manifests in their
  own repositories and are pinned by commit; this data uses the same words: a
  repository, a commit, a pull request.
- **Anyone can read, fork or mirror it** without an account or a key, and it
  costs nothing to run.

A Firestore collection, if one is ever added, is only a search index: it is
generated from this repository after each merge to `main`, nobody edits it, and
it is rebuilt from here when in doubt. When the two disagree, this repository is
right.

## It is an inGitDB database

The data is an [inGitDB](https://github.com/ingitdb/ingitdb-cli) database: plain
YAML files in Git, with collection definitions that say which columns each
record has. It can be read as plain files, written by pull request, and it is
validated in two layers (see [Checks](#checks)).

```
.ingitdb/root-collections.yaml         the two collections and their directories
databases/.collection/definition.yaml  the columns of a database record
databases/$records/<id>.yaml           one record per database, keyed by id
maintainers/$records/<github-handle>.yaml
index.json                             every database in one file, generated
scripts/                               the checks and the index.json writer
tests/journey/                         the MeaningGraph and Directory journey test
```

Ways to read it:

- **Plain files.** Fetch `databases/$records/<id>.yaml`, or `index.json` for
  everything at once.
- **The inGitDB CLI**, in a clone:
  `ingitdb select --path . --from databases --where 'meaning_graph==chinook' --fields '$id,url,commit'`
- **Go, through [DALgo](https://github.com/dal-go/dalgo)**, with the
  [`dalgo2ingitdb`](https://github.com/ingitdb/dalgo2ingitdb) adapter.

## Format: `ovdb-directory/draft-1`

A draft: it may change before `ovdb-directory/1`.

### `databases`: one record per database

The file name is the Directory record id: `databases/$records/chinook.yaml` gives
the stable `recordId` `chinook`; the public identity is the record's `url`. The
index keeps the provider's `localId` separate, since multiple publishers may
reuse the same server-local name.

The website page path for a global identity is `/ovdb/{hostname}{path}/`; for
example, `https://demodb.dev/northwind/` is listed at
`https://directory.openvaultdb.com/ovdb/demodb.dev/northwind/`. The former
`/databases/{recordId}/` route remains a permanent redirect after migration.

| Column | Required | Meaning |
|---|---|---|
| (key) | yes | Stable Directory record ID: lower-case letters, digits and single hyphens, at most 80 characters. It remains the compatibility alias; a JSON descriptor's `localId` is the manifest's `id`. |
| `format` | yes | `ovdb-directory/draft-1`. |
| `title` | yes | A short name. |
| `description` | yes | What the database holds, in a few sentences. |
| `status` | yes | `draft`, `published` or `deprecated`. |
| `url` | yes | The canonical global database identity: a public https URL without credentials, query or fragment. Its host and safe path are independent of the server API route. Equals the manifest's `url` and, when present, the published JSON descriptor's `id`. |
| `repository` | yes | The publisher repository's https URL on an allowed host (today only `github.com`), as `https://github.com/{org}/{repo}`: no `.git`, trailing slash, `.` or `..` segments. |
| `commit` | yes | Full 40-character commit id of the current reviewed version, in the history of the repository's default branch. |
| `manifest` | yes | The manifest's path in the repository, relative to the repository root. The publisher's `OVDB.md` must list it. |
| `database_manifest` | no | Path to the publisher's `ovdb-database/draft-1` JSON descriptor. `OVDB.md` must list it; when present it supplies `localId`, `serverId`, `serverDbBaseUrl` and `apiUrl`. Legacy YAML-only publishers remain supported. |
| `meaning_graph` | yes | The record key of the database's meaning graph in the MeaningGraph registry (`meaninggraph/registry`). |
| `maintainers` | yes | GitHub handles; each one has a `maintainers` record. |

### `maintainers`: one record per maintainer

Keyed by GitHub handle, with a `name`.

### What a publisher provides

A publisher repository opts in with a root `OVDB.md` whose frontmatter is
`ovdb: 1` and `publish: [./ovdb.yaml]`, an explicit list of manifest paths
relative to the repository root, never a glob. The manifest (`ovdb-manifest/draft-1`,
for example [`ovdb.yaml` of Chinook](https://github.com/demo-db/chinook/blob/f11b1192ed9f48cdd4f788d1d4ffde0e972ee04b/ovdb.yaml))
declares the canonical `url`, the `deployment` (`url`, `engine`, `discovery` on
the canonical origin, and an optional `recordset_page` template with `{name}`),
an optional `homepage` (the publisher's own web page for the database, which a site
may show as a link to its website; a public https URL on any origin, at most 200
characters, held to the rules for every URL below),
the `model` (its files, or its address when it is published elsewhere; see
[Two forms](#two-forms-own-model-or-shared-model)), the `meaning` file and its
graph, the publisher, the `licences` (`data`, `model`, `meaning`), the
`recordsets` and optional `recordset_entities` mapping. Every path is relative to the repository root and must be a regular file tracked
at the pinned commit: no `..`, leading `/`, `.` or empty segment, no glob, and
symbolic links are refused. The model's source (`model.hcl`) ends in
`.modelspec.hcl`.

#### Two forms: own model or shared model

A manifest names its model one of two ways, and the Directory tells them apart by
whether the manifest has local model files (`model.modelspec` or `model.hcl`).
The forms do not mix.

**Own model.** The model and the meaning file are in the publisher's repository:
`model.modelspec` (the ModelSpec JSON), optionally `model.hcl` (its source),
`meaning.file`, `meaning.graph.id` and `meaning.graph.address`, and the three
`licences`. `model.address` is optional; when given it is the ModelSpec registry's
address of the model, `modelspec://github.com/{org}/{repo}/{module}`, which for a
manifest with its own model files is its own repository and the ModelSpec's
module name, without `?ref=`. The host, organisation and repository are written
in lower case; the module name is case-sensitive. A foreign address next to local
model files is refused, as are `meaning.address` and `recordsets_partial`.

A manifest that gives `model.address` makes the check read the ModelSpec registry.
If the registry has that address, the manifest's `model.modelspec` must be the same
model as the registry's `files.json`: the same parsed JSON, with the same order of
entities, properties and every other key (only white space may differ). The order
counts because an entity's property order is the field order of its recordset in
`index.json`, so databases with one `model.address` always list the same fields in the
same order. The comparison is made at the registry's commit, so it happens only when
this record's `commit` is that commit; with another commit the check prints a warning
that the model was not compared. An address the registry does not know is not
compared. Because of this, a manifest that names a `model.address` needs the ModelSpec
registry to be readable: if it cannot be read (after a timeout and one retry), the
check fails with a problem that names the registry and the cause, as it does for the
MeaningGraph registry; it never falls back to old data.

ModelSpec entities and properties use publishable identifiers. A source collection may have a native name that is not an identifier, such as Northwind's `Order Details`. Keep that exact collection name in `recordsets` and map it to its ModelSpec entity:

```yaml
recordsets:
  - Customers
  - Order Details
recordset_entities:
  "Order Details": OrderDetails
```

`recordset_entities` maps native collection names to ModelSpec entity names. Names not listed in the mapping keep the existing same-name behavior. Each ModelSpec entity maps to exactly one recordset, and every entity of an own model must appear. Meaning bindings use the ModelSpec name (`modelspec:///northwind.OrderDetails`); Directory pages, API links and recordset URLs keep the native collection name (`Order Details`). The `{name}` in `deployment.recordset_page` is URL-encoded as one path component.

**Shared model.** The model and the meaning graph are published in other
repositories, and this manifest points at them instead of copying them, so that
every hoster of the same model is a database of that model. There are no local
model files and no local meaning file, and both pins are required:

```yaml
model:
  address: modelspec://github.com/demo-db/chinook/chinook?ref=<40 hex>
meaning:
  address: meaning://github.com/demo-db/chinook?ref=<40 hex>
  file: model/chinook.meaning.yaml    # the graph's file, in the graph's repository, that binds the model
  graph:
    id: chinook                       # the MeaningGraph registry id; equals the record's meaning_graph
licences:
  data: ODbL-1.0                      # the hoster's; the model's and meaning's licences are the registries'
recordsets: [Album, Artist, …]        # every entity of the model
```

Resolution, in order; each step that fails is a problem and the database is not
listed:

1. `model.address` and `meaning.address` follow one spelling rule: host,
   organisation and repository are written in lower case (a manifest that writes
   capitals is refused; the module name of a model is case-sensitive and written as
   it is). Every lookup of a repository address in a registry ignores that case, in
   the manifest and in a meaning file's `meaning://` addresses and `models:` entries
   alike: a model or graph that a registry registers with capitals is found by the
   lower-case address. `index.json` spells a graph the way its registry does and a
   model address in lower case. A registry that lists one repository twice, in two
   cases, is a problem. `model.address`,
   with its `?ref=` removed, must be registered in the ModelSpec registry
   (`https://raw.githubusercontent.com/modelspec-org/registry/main/index.json`,
   format `modelspec-registry/draft-1`, checksum verified; `MODELSPEC_REGISTRY_INDEX_URL`
   reads another index, which must be an https URL on `raw.githubusercontent.com` (the
   only host; a `github.com/.../raw/...` link always answers with a redirect, which is
   final, so it could not be read), on the default port and without credentials: a
   `data:`, `file:` or `http:` URL, a plain path or another host is refused). It is read only when a
   database names its model by address. Both registry indexes are read with one
   20-second deadline for the whole read and one retry of a failure that may pass (no
   connection, no answer, a 5xx or 429); a redirect or any other answer is final and
   a redirect is never followed; a failure names the registry and its cause. `meaning.address`, without its pin, must be registered in the
   MeaningGraph registry, under the record's `meaning_graph`. Neither address may
   name the publisher's own repository: a model there is the own-model form, and a
   meaning graph there cannot go with a model published elsewhere. A hoster that
   wants its own meaning graph with a shared model puts the graph in a third
   repository and registers it in the MeaningGraph registry.
2. Each pinned commit must be in the history of the default branch of the model's
   (respectively the graph's) repository. The pins need not be the registries' own;
   when they differ the check prints a warning and reads the pinned commit (the
   warning is printed only for a pin that is accepted).
3. The ModelSpec JSON (`files.json` of the registry's record) is read at the
   model's pin, and the model's source (`files.source`) is only checked there to be a
   tracked regular file. `meaning.file` must be one of the registry's `meaning_files`
   for the graph (the manifest always names it), and is read at the graph's pin, with
   the same hardened git and cache as everywhere else. The JSON's module is the
   registered one. The registry's paths are the ones that hold at the registry's own
   commit. When the manifest pins that commit they are read as they are. When it
   pins another commit they must exist there: the Directory does not guess where
   files moved, and a path that is missing is a problem that names both commits (the
   registry's and the manifest's). The limit is real: if a model's repository moves
   its files and the registry follows, a database pinned to an older commit fails
   until it pins the registry's commit.
4. The meaning file's `models:` entry for the module says which model it binds. A
   relative path is the model's source in the meaning graph's own repository, at the
   graph's own commit, so it is accepted only when the graph and the model live in
   the same repository, the two pins are the same commit, and the path is the
   registry's `files.source`. When they live in different repositories a relative
   path cannot say which model is meant and is refused; the entry must be the
   model's address instead (`chinook: modelspec://github.com/demo-db/chinook/chinook`,
   with `?ref=` only if it is the manifest's pin). Bindings are written
   `modelspec:///{module}.{Entity}`, or with the shared model's own address (and pin)
   spelled out; a binding to any other model is refused.
5. `recordsets` equals the model's entities. To publish a subset the manifest lists
   it explicitly and sets `recordsets_partial: true`; the list must be a strict
   subset and must contain every entity a listed entity references. Bindings to
   entities left out are ignored. `deployment.recordset_page` works as in the own
   form.
6. `licences.data` is the hoster's and is required. `licences.model` and
   `licences.meaning` are optional; when given they must equal the `licence` of the
   ModelSpec registry's record and the `meaning_licence` of the MeaningGraph
   registry's record, which are where those licences come from.

The publisher repository's `OVDB.md`, the manifest's `url`, `id`, `publisher` and
`deployment` rules are the same in both forms.

One deployment is listed once. A database may not claim, in any of its `url`,
`deployment.url` and `deployment.recordset_page` template, an address that another
database claims in any of them, nor an address that sits under another database's `url` or
`deployment.url`: a hoster could otherwise list another publisher's live deployment as its
own, by its deployment url, by its recordset pages, by a page of the deployment
(`.../collections/Album`) or by the other database's canonical `url` (which can redirect to
the deployment). "Under" means the same host and the other address's path followed by `/`,
so `/dbs/chinook/collections/Album` is under `/dbs/chinook` and `/dbs/chinook2` is not. It
works in both directions: a database whose `url` is a parent of another's addresses (`/dbs`
over `/dbs/chinook`) is refused too, reported on the database with the longer address. A
database may use one value in two of its own fields, and its own `recordset_page` may be
under its own `url` or `deployment.url`, as Chinook's is. Databases with sibling paths
(`/dbs/a` and `/dbs/b`) are different databases. The rule compares text, after the
normalisations that the URL rules below already force (one spelling of the host, no port, no
percent escape, only plain characters), and every field is compared the same way: ignoring
case and a trailing slash. That is conservative (a path may be case-sensitive, but two
listings that differ only in case are refused anyway). The whole `recordset_page` template is
compared, so two honest databases on one host whose templates differ after `{name}` are both
listed. What the rule cannot see is two different host names that serve one database, or a
proxy in front of another publisher's deployment: that is the reviewer's question when a
registration pull request is opened.

The canonical `url` is on an origin that the publisher is expected to control, and
the check cannot prove it. A legacy YAML-only publisher keeps `deployment.discovery`
on the same origin as `url`; a publisher with the public JSON descriptor places it
on the `serverId` origin. The Directory does not fetch the discovery document, so
it does not see who answers there. A client that relies on the identity must fetch
the discovery document and check that it lists the `url`.

### What the index guarantees about every URL it publishes

Every URL a manifest publishes or reads (`url`, `deployment.url`, `deployment.discovery`,
`deployment.recordset_page`, `publisher.url`, `homepage`), the descriptor's server URLs,
and the `url` of a record, is checked on the text as written, never on what a URL parser
makes of it. In `index.json` (`id`, `url`, `deployment.url`, server URLs, each recordset's
`url`, `homepage`) every one of them is:

- `https`, with no user information, no port (not even `:443`), no query and no fragment;
- a host of two or more dot-separated labels, each 1 to 63 characters of lower-case ASCII
  letters, digits and hyphen, none starting or ending with a hyphen, at most 253
  characters in all; not an IP address (in any spelling), `localhost`, a single-label name
  or a local, internal or reserved name (`.local`, `.internal`, `.lan`, `.svc`, `.home`,
  `.test`, `.example`, `.invalid`, `.onion`, …);
- a path of only `A-Z a-z 0-9 . _ ~ / -`, with canonical encoded segments allowed only in
  a global database identity: no `//`, no `.` or `..`
  segment, and no quote, apostrophe, ampersand, backtick, angle bracket, brace,
  parenthesis, semicolon, comma, equals sign, space or other punctuation;
- written in one canonical spelling (no trailing dot or empty label in the host).

`homepage` is also at most 200 characters. A `recordset_page` has `{name}` exactly once,
in the path only, and every URL generated from it is checked again. A deployment whose path
needs a space, a non-ASCII character or other punctuation cannot be listed.

What this does not say: that the page exists, that the name is not a look-alike (an `xn--`
name is ASCII), or that the name does not resolve to a private address
(`127.0.0.1.nip.io`). A site that shows a URL must still HTML-escape it, whatever it
guarantees, and clients must check the address they connect to.

The canonical `url` is a public HTTPS database identity. Its path may be empty or
contain multiple safe segments, independently of the server's API path. Each segment
is checked for traversal and encoded separators; the Directory route preserves the
canonical encoded spelling and adds a trailing slash only to the UI path. For example,
`https://example.org/db/northwind/` maps to `/ovdb/example.org/db/northwind/`, while
`https://northwind.example.com/` maps to `/ovdb/northwind.example.com/`.

The old OVDB host/path marker remains available as a legacy classification helper. Its
short two-label suffix list (17 common ones, kept by hand in scripts/lib/urls.mjs, not
the public suffix list) is used only to decide whether an old URL contains that marker;
it does not restrict new canonical database identities.

Names that reach `index.json` are checked too: ModelSpec entity, property and
module names are identifiers (`[A-Za-z_][A-Za-z0-9_]*`, since recordset names are
used in URLs and anchors), property types are type names, concept labels are
plain strings, binding roles are `meaning/draft-1` roles, licences are SPDX-shaped.

## `index.json`

Generated by `npm run index`; CI fails when the committed file differs from what
the script writes. Everything in it is read at pinned commits: for an own model
the ModelSpec and the meaning file at the record's `commit`; for a shared model the
ModelSpec at `model.address`'s pin and the meaning file at `meaning.address`'s pin;
and every concept the meaning file reaches through a `meaning://…?ref=<commit>`
address at the commit that address pins, resolved through the MeaningGraph registry.

```json
{
  "format": "ovdb-directory/draft-1",
  "checksum": "sha256:…",
  "databases": [{
    "id": "https://demodb.dev/chinook/",
    "recordId": "chinook",
    "localId": "chinook",
    "directoryPath": "/ovdb/demodb.dev/chinook/",
    "serverId": "https://demodb.dev/ovdb",
    "serverDbBaseUrl": "https://demodb.dev/ovdb/db/chinook/",
    "apiUrl": "https://demodb.dev/ovdb/v1/databases/chinook",
    "title": "…", "description": "…", "status": "draft",
    "url": "https://demodb.dev/chinook/",
    "deployment": { "url": "https://cloud.openvaultdb.com/ovdb/dbs/chinook", "engine": "sqlite" },
    "homepage": "https://chinook.demodb.dev/",
    "repository": "https://github.com/demo-db/chinook",
    "commit": "<40 hex>",
    "manifest": "ovdb.yaml",
    "licence": "MIT",
    "model": { "name": "chinook", "path": "model/chinook.modelspec.hcl", "address": "modelspec://github.com/demo-db/chinook/chinook" },
    "meaning_graph": { "id": "chinook", "address": "meaning://github.com/demo-db/chinook" },
    "recordsets": [{
      "name": "Customer",
      "url": "https://cloud.openvaultdb.com/ovdb/dbs/chinook/collections/Customer",
      "meanings": [M],
      "fields": [{ "name": "Country", "type": "string", "meanings": [M] }]
    }]
  }]
}
```

- `checksum` is `sha256:` and the hex SHA-256 of the compact `JSON.stringify` of
  `index.databases`, the same definition as the MeaningGraph registry's. It is a
  change token: compare it as a string (two fetches with the same checksum are
  the same data). To verify a file, parse it and hash the compact `JSON.stringify`
  of the parsed `databases` array; the file itself is indented, so the hash is
  not of its bytes, and a serialiser that orders keys differently or escapes
  differently (`&`, `<`, `>`) gives a different hash. Databases are sorted by
  `id`, recordsets by name; fields keep the ModelSpec's order; meanings are
  sorted by concept and role.
- `id` is the canonical global database identity from `url`; `recordId` is the
  Directory registry filename key and remains available for legacy route redirects.
  `localId` comes from the JSON descriptor when present, and otherwise retains the
  existing legacy record key. `directoryPath` is derived as `/ovdb/{host}{path}/`,
  normalizing a UI trailing slash while preserving the original identity. The
  optional server fields come from the descriptor and are absent for YAML-only publishers.
- `homepage` is the manifest's `homepage`, and is absent when the manifest has none
  (a client shows no website link then). It is not on the canonical `url`'s origin
  by rule, so it says nothing about who controls that origin. It is at most 200
  characters and as plain as every URL in the index (see
  [what the index guarantees](#what-the-index-guarantees-about-every-url-it-publishes)).
- `licence` is the manifest's `licences.data`: the licence of the database's data.
- A meaning's `address` carries the pinned commit of the meaning graph's repository:
  the record's `commit` for an own model, `meaning.address`'s pin for a shared one.
- `model.name` is the ModelSpec module name. `model.path` is the model's source, a
  `.modelspec.hcl` file tracked at the pinned commit, in the model's repository.
  For an own model it is the meaning file's `models:` entry for that module, joined
  to the meaning file's directory (so `../x.modelspec.hcl` from `model/sub/` is
  fine, leaving the repository is not); when the manifest has `model.hcl` it must be
  that same file. For a shared model it is the `files.source` of the ModelSpec
  registry's record. `model.address` is the model's address in the ModelSpec
  registry without a pin, host, organisation and repository in lower case, the
  module as written; it is always present for a shared model and present for an own
  model when the manifest gives one (checked against its own repository, and
  compared with the registry's model when the registry has the address, see
  [Two forms](#two-forms-own-model-or-shared-model)). Databases that share a `model.address` are databases of the
  same model, whoever hosts them. A model that lives in another repository than the
  database's also has `model.repository` (its https URL, as the registry records it)
  and `model.commit` (the manifest's pin); both are absent when the model is in the
  database's own repository, so a link to the model's file for a shared-model
  database is `{model.repository}/blob/{model.commit}/{model.path}`.
- `recordsets` are the native collection names the deployment serves. Each
  recordset has `modelEntity`, the corresponding ModelSpec entity name (the
  same value by default, or from `recordset_entities` when they differ). A
  recordset's `url` is the manifest's
  `deployment.recordset_page` template with `{name}` filled in, and is absent
  when the manifest has no template: it is never built by appending to
  `deployment.url`.
- A field's `type` is the ModelSpec property type. A property that references
  another entity has `"type": "reference"` and `"references"` set to that
  entity's native recordset name when it is listed.
- `M` is a meaning, bound to a recordset (role `entity`) or to a field (any
  other `meaning/draft-1` binding role):

  ```json
  {
    "graph": "chinook",
    "concept": "customer-country",
    "label": "Customer country",
    "role": "value",
    "address": "meaning://github.com/demo-db/chinook/customer-country?ref=<40 hex>",
    "extends": [],
    "values_of": {
      "graph": "core",
      "concept": "country",
      "label": "Country",
      "address": "meaning://github.com/meaninggraph/core/country?ref=<40 hex>",
      "extends": []
    }
  }
  ```

  This is `Customer.Country` as it stands in `index.json`: Chinook's
  `customer-country` is an attribute of customer whose values are countries, so it
  extends nothing and takes its values from core `country`. `extends` is the full
  "is a kind of" chain, nearest first, resolved at the pinned commits; it is `[]`
  when the concept extends nothing. A recordset's entity concept is different:
  Chinook's `customer` extends core `customer`. `values_of` is the concept's own
  `values-of` only, never inherited through `extends`, and it is absent when the
  concept sets none. Each `values_of` entry carries its own `extends` chain, so a
  page for a broader concept still finds the field: `Employee.ReportsTo` takes its
  values from Chinook's `employee`, which extends core `employee` and core
  `person`, so core `person` finds it. `label` is the concept's English label.
  A concept page's "In OVDB databases" section lists every `M` whose concept,
  `extends` chain, `values_of` or `values_of.extends` chain names that concept.

## How to register a database

1. The publisher adds a root `OVDB.md` and a manifest to its repository and
   merges them to the default branch. A hoster of a model that is already
   published (and registered in the ModelSpec and MeaningGraph registries) writes
   the shared-model form of the manifest and copies neither the model nor the
   meaning file.
2. Open a pull request here that adds `databases/$records/<id>.yaml` pinning a
   commit of the publisher repository that contains both, and
   `maintainers/$records/<handle>.yaml` if a maintainer is new here.
3. Regenerate the index: `npm ci && npm run index`, and commit `index.json`.

Run the checks locally with `ingitdb validate` and `npm run check`; CI runs both
on the pull request. The checks run git over https only and ignore your global
and system git configuration (so an `insteadOf` rewrite to ssh does not apply)
and any inherited `GIT_*` repository variables. Behind a proxy or a private
certificate authority, set `HTTPS_PROXY` or `GIT_SSL_CAINFO`.

## How to use it

To list databases, read `index.json` from the default branch
(`https://raw.githubusercontent.com/openvaultdb/directory/main/index.json`). To
find the databases that carry a concept, look for it in the `meanings` of every
recordset and field: as `concept` (with its `graph`), in `extends`, as
`values_of`, or in the `extends` chain of `values_of`. Read a build's input only from the default branch, and fail the
build when it cannot be read; do not fall back to stale data.

## Versioning

Moving a database to a new version is a pull request that changes `commit`; the
checks run against the new commit. Older commits stay valid for anyone who pins
them: a commit is immutable, and this repository only says which commit is
current.

## Checks

Two layers run in CI ([`.github/workflows/check.yml`](.github/workflows/check.yml)):

1. **inGitDB** ([`ingitdb/ingitdb-action`](https://github.com/ingitdb/ingitdb-action),
   at a pinned commit and CLI release) validates every record against its
   collection definition: column types, required columns, the `status` and
   `format` values, the 40-character `commit`, no unknown columns, and the
   foreign key (`maintainers` name maintainer records).
2. **The checks** (`npm run check`, [`scripts/check.mjs`](scripts/check.mjs))
   cover what a collection definition cannot express, and everything that needs
   the publisher repository:
   - ids follow the id rule; `url` is canonical and registered once;
     `repository`, `commit` and `manifest` are well formed before any of them
     reaches git;
   - the commit can be fetched, is in the history of the repository's default
     branch (GitHub serves a fork's commits through the parent repository's
     URL, so "can be fetched" alone would let a fork's commit be registered
     under the parent's name), and every commit an address pins is too;
   - the publisher's root `OVDB.md` has `ovdb: 1` and lists the manifest by
     explicit path; every file read is a regular file at the commit;
   - the manifest has its required fields; its `url`, `id`, meaning graph and
     publisher repository equal the record's; every URL it publishes is public
     https (no IP address, local or internal host, credentials, query or
     fragment) and the canonical `url` has `ovdb` as a path segment or
     subdomain; its discovery document is on the canonical origin; no other
     database has the same `deployment.url` or `recordset_page` template; for an own
     model, `licences.meaning` is what the meaning file declares (a shared model's
     licences are the registries');
   - `meaning_graph` is registered in the MeaningGraph registry
     (`https://raw.githubusercontent.com/meaninggraph/registry/main/index.json`,
     read with its checksum verified) and lists the manifest's meaning file; for an
     own model it is registered for the same repository, with the same address
     (for a shared model, `meaning.address` is registered under that id);
   - `recordsets` map one-to-one to ModelSpec entities, by equal names or the
     explicit `recordset_entities` mapping (a shared model's manifest may list a
     subset, explicitly, with `recordsets_partial: true`);
   - an own model that names a registered `model.address` is the registered model
     (compared with the registry's `files.json`, or a warning when the commits
     differ);
   - a shared model resolves as described under
     [Two forms](#two-forms-own-model-or-shared-model): its address is registered in
     the ModelSpec registry, its meaning graph in the MeaningGraph registry, both
     pins are on the default branches of their repositories, the model and the
     meaning file are read at those pins, the meaning file says which model it
     binds, and a pin that differs from a registry's own is a warning;
   - every meaning binding names an entity and a property that exist in the
     ModelSpec; concept ids are well formed and present; every `extends` and
     `values-of` resolves at its pinned commit through the MeaningGraph registry,
     and an `extends` chain longer than 50 concepts is a problem, never cut;
   - the model's source file (`model.path`) is a tracked regular file at the
     commit;
   - `index.json` is what `npm run index` writes.

The git cache is the user's, not the checkout's: `$XDG_CACHE_HOME/ovdb-directory`
(or `~/.cache/ovdb-directory`), created private and refused if it is a link, owned
by another user or writable by others; a cache inside the checkout is refused. A
cached repository is used only after it has been verified, and is made again
otherwise: the directory is not itself a link; its configuration holds only keys this
check writes (a closed list, so a hook that git 2.54 and later define in
configuration, `hook.<name>.command`, is refused like every other setting that makes
git run something); a history clone's `remote.origin.url` is the URL it was cloned
from and a one-commit repository has no remote; there are no alternates, grafts,
replace refs, links or index; and every object hashes to its name. Git runs with
hooks, fsmonitor, replace refs and lazy fetching switched off (`GIT_NO_LAZY_FETCH`: a
missing object is never fetched from a remote the configuration names), so nothing a
pull request commits can run code in CI or on a maintainer's machine. The cache holds
bare repositories only: there is no checkout, no index to trust and no work-tree
`.gitattributes`, and files are read from the object store byte for byte. Each repository is
made in a temporary directory and renamed into place, so two runs that start on an
empty cache at the same time both work. A history clone is brought up to date by a
fetch that asks for the clone's own `tree:0` filter (without it the server may send
deltas against trees the commits-only clone lacks, which git must not fetch itself).
If that fetch cannot be made into the cached clone anyway, the clone is not trusted:
a fresh one is made once, with the same hardening as a first clone, and replaces it
(two runs on the same unusable clone both work). Only a remote that fails the fresh
clone too is an error, with the remote's own message, and the cache is left as it was.

`npm test` proves, offline, that each check fails on a broken entry. Local
repositories stand in for the publisher and for the core meaning graph (a copy of
Chinook's manifest, ModelSpec and meaning file is in
[`scripts/fixtures`](scripts/fixtures)), and the ModelSpec registry's index comes
from a fixture, like the MeaningGraph registry's. It covers:

- **Records and the publisher repository:** an unknown commit, a commit only a side
  branch has, a missing or unlisted `OVDB.md`, a manifest that disagrees with the
  record, repository values of every refused shape (`.git`, other hosts, `http`,
  `ssh`, `..`, option-like or shell-like text), and a stale `index.json`.
- **Model and meaning:** recordsets that are not the ModelSpec entities, a binding
  to a missing entity or property (and to an entity or module whose name starts
  with `_`), an unregistered graph, an address without or with a bad `?ref=`, an
  `extends` cycle or a chain over the limit, a bad or missing concept id, a model
  path that is missing, a link, not a `.modelspec.hcl` file or leaves the
  repository, and malformed meaning data of every shape tried, a registry's
  `meaning_files` that is not a list of paths among them.
- **Shared model:** an unregistered model or meaning graph address, a missing pin, a
  pin that is not on the default branch, local model files next to a foreign
  address, a module or recordset that is not the model's, a recordset list that is
  not the model's entities (or a bad partial list), a meaning graph in another
  repository that does not say which model it binds, a relative `models:` path
  when the two pins are different commits, a registry path that does not exist at a
  pin other than the registry's, a model or graph the registry registers with capitals,
  a graph id from the registry that is not a plain id (lower-case words joined by hyphens),
  an index URL that is not https, and registry reads that time out, are tried twice and
  name the registry when they fail.
- **Across records:** two databases with the same global `url`, per-database
  `serverDbBaseUrl` or `apiUrl`, duplicate computed Directory routes, or the same
  `deployment.url` or `recordset_page` template. Distinct descriptors may share a
  discovery URL only when their `serverId` and discovery origin agree. An address under another database's `url` or `deployment.url`,
  and a port or percent escape that would make a second spelling of one; an own model that is not the registered one, or has its
  properties in another order.
- **URLs and names:** a manifest URL that is http, has credentials, a query or a
  fragment, names an IP address in any spelling, `localhost` or an internal host,
  has `{name}` in the host, or is written in a second spelling, has a port or a percent
  escape; any URL field (and `homepage`) that has a quote, an apostrophe, an ampersand, a
  backtick or any character outside the plain set, a long `homepage`; names and values
  that are not identifiers or plain strings.
- **Output:** the warnings and the errors reach what `npm run check` and
  `npm run index` print.
- **The git cache:** a planted hook (in `hooks/` or defined in configuration),
  replace ref, graft, remote, link, index or setting is refused; a damaged cache
  is made again; an object that is missing is never fetched on git's own;
  two runs on a cold cache both work; git's environment and protocol restrictions;
  and that nothing is interpreted by a shell.

A second hoster of the Chinook model, listed under the same model address as
Chinook itself with the same fields and meanings, is a case that passes.

`npm run test:ingitdb` (with `INGITDB_CLI` set to the CLI) proves inGitDB rejects
each broken constraint of the collection definitions.

### Journey test

`npm run test:journey` runs a Playwright test that walks the journey between the
two sites by clicking links only: search "country" on meaninggraph.io (the result
must be marked registered), the core Country concept, "In OVDB databases", `Customer.Country` on
the Directory's Chinook page with that field in view, a concept link back, and
both catalogues. It takes the two sites' base URLs and follows names read from
`index.json`; every step asserts the exact target of the link it follows, and the
`#recordset-<Name>` and `#field-<Recordset>-<Field>` anchors of every recordset and
field:

```
MEANINGGRAPH_BASE_URL=http://localhost:4321 OVDB_DIRECTORY_BASE_URL=http://localhost:4322 npm run test:journey
```

Build both sites with the same two variables: step 3 expects the link on
meaninggraph.io to land on `OVDB_DIRECTORY_BASE_URL`, and the Directory's concept
links to land on `MEANINGGRAPH_BASE_URL`.

Without both variables every test is skipped, not failed. `OVDB_DIRECTORY_INDEX_URL`
reads the index from a URL instead of this checkout; `PLAYWRIGHT_CHANNEL=chrome`
runs the installed Chrome (otherwise `npx playwright install chromium` once).

`npm run test:journey:selftest` runs the spec against mock sites
([`tests/journey/fixtures`](tests/journey/fixtures)) and expects it to pass on the
good pair and to fail, on the assertion that belongs to it, on each of the
deliberate defects listed in `mock-sites.mjs` (a search that returns nothing, a
result that is not registered, a missing Customer recordset or its anchor, a
recordset without concepts, a wrong field anchor, a concept page that omits the
recordset, no live-deployment link, an example badge on Chinook, no example
cards, or three links, list items or cards that only use the word "example", no
synonyms, a Synonyms section with only a language tag or an empty one, a synonym
that is `undefined`, `null`, `unknown` or "none yet", and others). It matches the
`Error:` line of the one assertion that failed, so a failure on a neighbouring
assertion is noticed, and expects the other two journeys to pass. It does not show
that no defect is possible outside that list. It needs no real sites, only a
browser, and runs in CI.

The synonyms check expects a concept page to have a label "Synonyms" followed by
groups: for each language a language tag and then the synonyms (or one plain list, or
"Synonyms: a, b" on one line). Language tags are not synonyms; a section with no
synonym left (only a tag, nothing, or the next heading at once), or with a
placeholder such as `undefined` or "none yet", fails. The example-card check counts
items that have a heading of their own, say "example" or "sample" in their own text
or in the short label before their list, and are not links to a database of the
Directory. Both are best-effort readings of a page, not of data: the index holds no
synonyms and no example cards. A site layout the checks do not expect is a failure
to fix in the checks or in the site, not something they guess around.

## Notifying the sites

A change to `index.json` on `main` notifies the sites built from it, so they redeploy. `.github/workflows/notify-sites.yml` starts the `deploy.yml` workflow, on `main`, of each site listed in `scripts/notify-sites.json`, sending only a reason; each site works out for itself what changed and stops at once when nothing did. The workflow can also be run by hand on `main`.

**Tokens.** Each site is started with a token, stored as a repository secret whose name `scripts/notify-sites.json` gives per site, one secret per site owner. A token is a fine-grained personal access token whose resource owner is that owner, limited to the one site repository, with the single permission Actions: read and write. A site whose secret is missing is skipped with a notice and the run stays green; a secret that is present but rejected turns the run red at the end, after every site was attempted. The workflow runs only for a push to `main` or a manual run on `main` in this repository, never for a pull request or a fork, and each token reaches only the one `gh` call for its site.

**Landing order.** Land the deploy workflows of the sites first (until a site has one, starting it fails), then this change, then add the secrets.

## Licence

Everything in this repository (the records, the collection definitions,
`index.json`, the scripts) is [CC0-1.0](LICENSE). The publishers keep their own
licences, which each manifest states.
