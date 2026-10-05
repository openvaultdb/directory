// What `npm run check` and `npm run index` do and print (CC0-1.0), apart from reading
// arguments, so that tests can run them against a local world and read what they print.
// scripts/check.mjs and scripts/build-index.mjs are the thin entry points.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIndex, checkDirectory } from './directory.mjs';

const stdio = { out: (line) => console.log(line), err: (line) => console.error(line) };

// `warning:` lines first (they say what differs from a registry and what was read anyway), then
// `error:` lines and the count when anything is wrong. Returns the exit code.
export async function runCheck(options, { out, err } = stdio) {
  const { problems, warnings, databases } = await checkDirectory(options);
  for (const warning of warnings) err(`warning: ${warning}`);
  if (problems.length > 0) {
    for (const problem of problems) err(`error: ${problem}`);
    err(`${problems.length} problem${problems.length === 1 ? '' : 's'} in ${databases} database${databases === 1 ? '' : 's'}`);
    return 1;
  }
  out(`ok: ${databases} database${databases === 1 ? '' : 's'} checked`);
  return 0;
}

// Writes index.json under options.root, printing each warning; nothing is written when anything is wrong.
// Returns the exit code.
export async function runIndex(options, { out, err } = stdio) {
  try {
    writeFileSync(join(options.root, 'index.json'), await buildIndex({ ...options, onWarning: (warning) => err(`warning: ${warning}`) }));
  } catch (error) {
    if (error.code === 'DEPENDENCY_UNRUNNABLE') throw error;
    err(`error: ${error.message}`);
    return 1;
  }
  out('wrote index.json');
  return 0;
}
