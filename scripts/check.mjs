// Checks the Directory data, CC0-1.0 like everything else here.
//
//   node scripts/check.mjs [directory]   (default: this repository)
//
// Run after `ingitdb validate` (structure, types, required columns, enums,
// foreign keys). This adds what needs the publisher's repository: each record's
// commit is in the history of the repository's default branch, its root OVDB.md
// lists the manifest, the manifest's required fields, url and meaning graph
// agree with the record and with meaninggraph/registry, the recordsets are the
// ModelSpec entities, every meaning binding names a real entity and property,
// every meaning address resolves at its pinned commit, and index.json is what
// `npm run index` writes. A manifest that names its model and meaning graph by
// pinned address (a shared model) is resolved through the ModelSpec and
// MeaningGraph registries; a pin that differs from a registry's own is a warning.
// The printing is in lib/cli.mjs.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck } from './lib/cli.mjs';

const root = process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url)));
process.exitCode = await runCheck({ root });
