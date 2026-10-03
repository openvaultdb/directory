// Tests that inGitDB itself rejects broken records (CC0-1.0): each case copies
// the Directory data, breaks one constraint of a collection definition, and expects
// `ingitdb validate` to exit 2. INGITDB_CLI names the binary (CI installs the
// release the workflow pins); the tests fail, rather than skip, without it.
//
//   INGITDB_CLI=/path/to/ingitdb node --test scripts/test-ingitdb.mjs
//
// The URL forms of `url` and `repository` are not here: inGitDB does not
// validate a column's `format`, so scripts/check.mjs checks them (scripts/test.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = process.env.INGITDB_CLI;
const scratch = mkdtempSync(join(tmpdir(), 'directory-ingitdb-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let count = 0;

const record = (dir, collection, key) => join(dir, collection, '$records', `${key}.yaml`);
const edit = (collection, key, change) => (dir) => {
  const path = record(dir, collection, key);
  const data = parseYaml(readFileSync(path, 'utf8'));
  change(data);
  writeFileSync(path, stringifyYaml(data));
};

function validate(change) {
  const dir = join(scratch, `db-${count++}`);
  mkdirSync(dir);
  for (const name of ['.ingitdb', 'databases', 'maintainers']) cpSync(join(root, name), join(dir, name), { recursive: true });
  change?.(dir);
  try {
    execFileSync(cli, ['validate', `--path=${dir}`, '--safe-diagnostics'], { stdio: 'pipe' });
    return 0;
  } catch (error) {
    return error.status;
  }
}

test('INGITDB_CLI names the inGitDB binary', () => {
  assert.ok(cli, 'set INGITDB_CLI to the ingitdb binary');
  assert.match(execFileSync(cli, ['version']).toString(), /\d+\.\d+\.\d+/);
});

test('the Directory data as committed is a valid inGitDB database', () => {
  assert.equal(validate(), 0);
});

const cases = {
  'databases: title missing (required)': edit('databases', 'chinook', (x) => { delete x.title; }),
  'databases: description missing (required)': edit('databases', 'chinook', (x) => { delete x.description; }),
  'databases: status outside its enum': edit('databases', 'chinook', (x) => { x.status = 'live'; }),
  'databases: format outside its enum': edit('databases', 'chinook', (x) => { x.format = 'x'; }),
  'databases: commit of 39 characters (length)': edit('databases', 'chinook', (x) => { x.commit = x.commit.slice(1); }),
  'databases: commit of 41 characters (length)': edit('databases', 'chinook', (x) => { x.commit += 'a'; }),
  'databases: commit missing (required)': edit('databases', 'chinook', (x) => { delete x.commit; }),
  'databases: empty title (min_length)': edit('databases', 'chinook', (x) => { x.title = ''; }),
  'databases: title of 121 characters (max_length)': edit('databases', 'chinook', (x) => { x.title = 'a'.repeat(121); }),
  'databases: title that is a number (type)': edit('databases', 'chinook', (x) => { x.title = 123; }),
  'databases: url missing (required)': edit('databases', 'chinook', (x) => { delete x.url; }),
  'databases: repository missing (required)': edit('databases', 'chinook', (x) => { delete x.repository; }),
  'databases: manifest missing (required)': edit('databases', 'chinook', (x) => { delete x.manifest; }),
  'databases: empty manifest (min_length)': edit('databases', 'chinook', (x) => { x.manifest = ''; }),
  'databases: meaning_graph missing (required)': edit('databases', 'chinook', (x) => { delete x.meaning_graph; }),
  'databases: unknown maintainer (foreign_key)': edit('databases', 'chinook', (x) => { x.maintainers = ['nobody']; }),
  'databases: unknown second maintainer (foreign_key on a list)': edit('databases', 'chinook', (x) => { x.maintainers = ['trakhimenok', 'nobody']; }),
  'databases: empty maintainers (min_length)': edit('databases', 'chinook', (x) => { x.maintainers = []; }),
  'databases: maintainers missing (required)': edit('databases', 'chinook', (x) => { delete x.maintainers; }),
  'databases: unknown column': edit('databases', 'chinook', (x) => { x.colour = 'blue'; }),
  'maintainers: name missing (required)': edit('maintainers', 'trakhimenok', (x) => { delete x.name; x.nick = 'a'; }),
  'maintainers: empty name (min_length)': edit('maintainers', 'trakhimenok', (x) => { x.name = ''; }),
};

for (const [name, change] of Object.entries(cases)) {
  test(`inGitDB rejects ${name}`, () => {
    assert.equal(validate(change), 2, 'ingitdb validate exits 2 on invalid data');
  });
}
