# OVDB Directory data

The public data of the OpenVaultDB Directory: for each database, the canonical
URL people write to refer to it, the publisher repository it is published from,
the commit that is its current reviewed version, and its recordsets and fields
with the [MeaningGraph](https://github.com/meaninggraph/registry) concepts they
carry. The Directory website is a separate repository; it reads
[`index.json`](index.json) from here and holds no list of its own.

| Id | Canonical URL | Repository at commit | Status |
|---|---|---|---|
| `chinook` | `https://chinookdb.com/ovdb/dbs/chinook` | [datatug/chinookdb@be96bf4](https://github.com/datatug/chinookdb/tree/be96bf45fdfa13559b6627d281c1e30ce92ad38f) | draft |

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

The file name is the id: `databases/$records/chinook.yaml` registers `chinook`.

| Column | Required | Meaning |
|---|---|---|
| (key) | yes | Lower-case letters, digits and single hyphens, at most 80 characters. Equals the manifest's `id`. |
| `format` | yes | `ovdb-directory/draft-1`. |
| `title` | yes | A short name. |
| `description` | yes | What the database holds, in a few sentences. |
| `status` | yes | `draft`, `published` or `deprecated`. |
| `url` | yes | The canonical identity: the database's connection URL, an https URL without credentials, query, fragment or trailing slash. It stays the same if the deployment moves. Equals the manifest's `url`. |
| `repository` | yes | The publisher repository's https URL on an allowed host (today only `github.com`), as `https://github.com/{org}/{repo}`: no `.git`, trailing slash, `.` or `..` segments. |
| `commit` | yes | Full 40-character commit id of the current reviewed version, in the history of the repository's default branch. |
| `manifest` | yes | The manifest's path in the repository, relative to the repository root. The publisher's `OVDB.md` must list it. |
| `meaning_graph` | yes | The record key of the database's meaning graph in the MeaningGraph registry (`meaninggraph/registry`). |
| `maintainers` | yes | GitHub handles; each one has a `maintainers` record. |

### `maintainers`: one record per maintainer

Keyed by GitHub handle, with a `name`.

### What a publisher provides

A publisher repository opts in with a root `OVDB.md` whose frontmatter is
`ovdb: 1` and `publish: [./ovdb.yaml]`, an explicit list of manifest paths
relative to the repository root, never a glob. The manifest (`ovdb-manifest/draft-1`,
for example [`ovdb.yaml` of Chinook](https://github.com/datatug/chinookdb/blob/be96bf45fdfa13559b6627d281c1e30ce92ad38f/ovdb.yaml))
declares the canonical `url`, the `deployment` (`url`, `engine`, `discovery` on
the canonical origin, and an optional `recordset_page` template with `{name}`),
the `model` files (the ModelSpec JSON and, optionally, the human-readable
source `hcl`), the `meaning` file and its graph (`id` and `address`), the
publisher, the `licences` (`data`, `model`, `meaning`) and the `recordsets`.
Every path is relative to the repository root and must be a regular file tracked
at the pinned commit: no `..`, leading `/`, `.` or empty segment, no glob, and
symbolic links are refused. Every URL a manifest publishes (`url`,
`deployment.url`, `deployment.discovery`, `deployment.recordset_page`,
`publisher.url`) is public https: no credentials, query or fragment, no IP
address (in any spelling), `localhost`, single-label name, or local or internal
name (`.local`, `.internal`, `.lan`, …). The canonical `url` also has `ovdb` as a
complete path segment or as a subdomain, as the Directory's convention asks
(`https://acme.com/ovdb/sales`, `https://ovdb.acme.com/sales`).

## `index.json`

Generated by `npm run index`; CI fails when the committed file differs from what
the script writes. Everything in it is read at pinned commits: the ModelSpec and
the meaning file at the record's `commit`, and every concept the meaning file
reaches through a `meaning://…?ref=<commit>` address at the commit that
address pins, resolved through the MeaningGraph registry.

```json
{
  "format": "ovdb-directory/draft-1",
  "checksum": "sha256:…",
  "databases": [{
    "id": "chinook",
    "title": "…", "description": "…", "status": "draft",
    "url": "https://chinookdb.com/ovdb/dbs/chinook",
    "deployment": { "url": "https://cloud.openvaultdb.com/ovdb/dbs/chinook", "engine": "sqlite" },
    "repository": "https://github.com/datatug/chinookdb",
    "commit": "<40 hex>",
    "manifest": "ovdb.yaml",
    "licence": "MIT",
    "model": { "name": "chinook", "path": "model/chinook.modelspec.hcl" },
    "meaning_graph": { "id": "chinook", "address": "meaning://github.com/datatug/chinookdb" },
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
- `licence` is the manifest's `licences.data`: the licence of the database's data.
- `model.name` is the ModelSpec module name. `model.path` is the meaning file's
  `models:` entry for that module, made relative to the repository root: a
  regular file tracked at the pinned commit. When the manifest has `model.hcl`
  it must be that same file.
- `recordsets` are the ModelSpec entities, and their names are the collection
  names the deployment serves. A recordset's `url` is the manifest's
  `deployment.recordset_page` template with `{name}` filled in, and is absent
  when the manifest has no template: it is never built by appending to
  `deployment.url`.
- A field's `type` is the ModelSpec property type. A property that references
  another entity has `"type": "reference"` and `"references": "<Entity>"`.
- `M` is a meaning, bound to a recordset (role `entity`) or to a field (any
  other `meaning/draft-1` binding role):

  ```json
  {
    "graph": "chinook",
    "concept": "customer-country",
    "label": "Customer country",
    "role": "value",
    "address": "meaning://github.com/datatug/chinookdb/customer-country?ref=<40 hex>",
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
  when the concept extends nothing (a recordset's entity concept, such as
  Chinook's `customer`, extends core `customer`). `values_of` is the concept's own
  `values-of` only, never inherited through `extends`, and it is absent when the
  concept sets none. Each `values_of` entry carries its own `extends` chain, so a
  page for a broader concept still finds the field: `Employee.ReportsTo` takes its
  values from Chinook's `employee`, which extends core `employee` and core
  `person`, so core `person` finds it. `label` is the concept's English label.
  A concept page's "In OVDB databases" section lists every `M` whose concept,
  `extends` chain, `values_of` or `values_of.extends` chain names that concept.

## How to register a database

1. The publisher adds a root `OVDB.md` and a manifest to its repository and
   merges them to the default branch.
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
recordset and field: as `concept` (with its `graph`), in `extends`, or in
`values_of`. Read a build's input only from the default branch, and fail the
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
     subdomain; its discovery document is on the canonical origin;
     `licences.meaning` is what the meaning file declares;
   - `meaning_graph` is registered in the MeaningGraph registry
     (`https://raw.githubusercontent.com/meaninggraph/registry/main/index.json`,
     read with its checksum verified), for the same repository, with the same
     address, and lists the manifest's meaning file;
   - `recordsets` are exactly the ModelSpec entities;
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
cached repository is used only after its configuration, alternates and objects
have been verified (and is fetched again otherwise), and git runs with hooks and
fsmonitor switched off, so nothing a pull request commits can run code in CI or on
a maintainer's machine.

`npm test` proves each check fails on a broken entry, offline, with local
repositories standing in for the publisher and for the core meaning graph (a
copy of Chinook's manifest, ModelSpec and meaning file is in
[`scripts/fixtures`](scripts/fixtures)): an unknown commit, a commit only a side
branch has, a missing or unlisted `OVDB.md`, a manifest that disagrees with the
record, recordsets that are not the ModelSpec entities, a binding to a missing
entity or property, an unregistered graph, an address without or with a bad
`?ref=`, an `extends` cycle or a chain over the limit, a bad or missing concept id,
a model path that is missing, a link or leaves the repository, a manifest URL
that is http, has credentials, a query, a fragment, names an IP address in any
spelling, `localhost` or an internal host, a canonical `url` without `ovdb`, a
planted hook or configuration in a cached repository, a damaged cache, a stale
`index.json`, repository values of every
refused shape (`.git`, other hosts, `http`, `ssh`, `..`, option-like or
shell-like text), git's environment and protocol restrictions, and that
nothing is interpreted by a shell. `npm run test:ingitdb` (with `INGITDB_CLI`
set to the CLI) proves inGitDB rejects each broken constraint of the collection
definitions.

### Journey test

`npm run test:journey` runs a Playwright test that walks the journey between the
two sites by clicking links only: search "country" on meaninggraph.io (the
concept must not be on the page before the search, and the result must be marked
registered), the core Country concept, "In OVDB databases", `Customer.Country` on
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

`npm run test:journey:selftest` shows the journey cannot go green while a step is
broken: it runs the spec against mock sites ([`tests/journey/fixtures`](tests/journey/fixtures))
and expects it to pass on the good pair and to fail on each pair with one
deliberate defect (a search that returns nothing, a result that is not
registered, a missing Customer recordset, a wrong field anchor, a concept page
that omits the recordset, and others). It needs no real sites, only a browser, and
runs in CI.

## Licence

Everything in this repository (the records, the collection definitions,
`index.json`, the scripts) is [CC0-1.0](LICENSE). The publishers keep their own
licences, which each manifest states.
