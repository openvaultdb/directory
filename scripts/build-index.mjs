// Writes index.json from the records and the publisher repositories they pin
// (CC0-1.0). CI fails when the committed index.json differs from what this
// writes. Reads the MeaningGraph registry's index.json from its default branch
// and fails loudly when it cannot; there is no stale fallback.
//
//   node scripts/build-index.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from './lib/directory.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
try {
  writeFileSync(join(root, 'index.json'), await buildIndex({ root, onWarning: (warning) => console.error(`warning: ${warning}`) }));
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
console.log('wrote index.json');
