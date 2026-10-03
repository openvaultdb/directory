// Writes index.json from the records and the publisher repositories they pin
// (CC0-1.0). CI fails when the committed index.json differs from what this
// writes. Reads the MeaningGraph registry's index.json from its default branch
// and fails loudly when it cannot; there is no stale fallback.
//
//   node scripts/build-index.mjs
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIndex } from './lib/cli.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.exitCode = await runIndex({ root });
