// Runs one conformance case of the manifest mapping (scripts/fixtures/manifest-conformance.json) through the
// Directory checker, against local stand-ins for the publisher's repository, the MeaningGraph registry and the
// ModelSpec registry. Test support (CC0-1.0): scripts/test-manifest-conformance.mjs uses it, and so does any
// script that wants the Directory's verdict on the same case files as another checker.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { setGitProtocols } from './lib/git.mjs';
import { buildIndex, checkDirectory, manifestProblems } from './lib/directory.mjs';
import { indexMeaningRegistry } from './lib/meaning.mjs';
import { indexModelRegistry } from './lib/modelspec.mjs';

// The local repositories that stand in for https URLs are file:// URLs; git is allowed to read them.
setGitProtocols('https:file');

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const conformance = JSON.parse(readFileSync(join(root, 'scripts', 'fixtures', 'manifest-conformance.json'), 'utf8'));

const scratch = mkdtempSync(join(tmpdir(), 'directory-conformance-'));
let count = 0;
const fresh = (name) => { const dir = join(scratch, `${name}-${count++}`); mkdirSync(dir, { recursive: true }); return dir; };
// Removes everything this module made.
export const cleanup = () => rmSync(scratch, { recursive: true, force: true });

const gitEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1',
});
const gitIn = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', env: gitEnv() }).toString().trim();
const readTree = (dir) => {
  const files = new Map();
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.set(relative(dir, path), readFileSync(path, 'utf8'));
    }
  };
  walk(dir);
  return files;
};

const chinookUrl = 'https://github.com/demo-db/chinook';
const coreUrl = 'https://github.com/meaninggraph/core';
const fixture = readTree(join(root, 'scripts', 'fixtures', 'chinookdb'));
const record = parseYaml(`format: ovdb-directory/draft-1
title: Chinook music store
description: The Chinook sample database.
status: draft
url: https://chinookdb.com/ovdb/dbs/chinook
repository: https://github.com/demo-db/chinook
commit: f11b1192ed9f48cdd4f788d1d4ffde0e972ee04b
manifest: ovdb.yaml
meaning_graph: chinook
maintainers: [trakhimenok]
`);

// The base manifest with the case's format, recordsets and recordset_entities in place of its own.
export const manifestFor = (part) => {
  const { format: _format, recordsets: _recordsets, recordset_entities: _entities, ...rest } = parseYaml(fixture.get('ovdb.yaml'));
  return { ...(Object.hasOwn(part, 'format') ? { format: part.format } : {}), ...rest, ...(Object.hasOwn(part, 'recordsets') ? { recordsets: part.recordsets } : {}), ...(Object.hasOwn(part, 'recordset_entities') ? { recordset_entities: part.recordset_entities } : {}) };
};

// The publisher's files for a case: the Chinook fixture with the case's model (module shop), a meaning file
// that binds nothing, and the case's manifest.
export const filesFor = (part, vocabulary) => {
  const files = new Map(fixture);
  files.set('model/chinook.modelspec.json', JSON.stringify(conformance.models[vocabulary]));
  const meaning = parseYaml(files.get('model/chinook.meaning.yaml'));
  meaning.models = { shop: 'chinook.modelspec.hcl' };
  meaning.concepts = [];
  files.set('model/chinook.meaning.yaml', stringifyYaml(meaning));
  files.set('ovdb.yaml', stringifyYaml(manifestFor(part)));
  return files;
};

// The Directory checker's verdict on a case: { manifest, problems, warnings, index } where `manifest` is the
// manifest stage alone, `problems` and `warnings` are the whole check's, and `index` is the database's index
// entry (null when the check refuses).
export async function directoryVerdict(part, vocabulary = 'current') {
  const files = filesFor(part, vocabulary);
  const publisher = fresh('publisher');
  gitIn(publisher, 'init', '-q', '-b', 'main');
  for (const [path, text] of files) {
    mkdirSync(dirname(join(publisher, path)), { recursive: true });
    writeFileSync(join(publisher, path), text);
  }
  gitIn(publisher, 'add', '-A');
  gitIn(publisher, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'files');
  const commit = gitIn(publisher, 'rev-parse', 'HEAD');

  const dir = fresh('directory');
  for (const name of ['.ingitdb', 'databases', 'maintainers']) cpSync(join(root, name), join(dir, name), { recursive: true });
  const recordsDir = join(dir, 'databases', '$records');
  for (const name of readdirSync(recordsDir)) rmSync(join(recordsDir, name), { recursive: true, force: true });
  writeFileSync(join(recordsDir, 'chinook.yaml'), stringifyYaml({ ...record, commit }));

  const graphs = [
    { id: 'chinook', title: 'Chinook', kind: 'dataset', status: 'draft', address: 'meaning://github.com/demo-db/chinook', repository: chinookUrl, commit, meaning_files: ['model/chinook.meaning.yaml'], maintainers: ['trakhimenok'] },
    { id: 'core', title: 'Core', kind: 'universal', status: 'draft', address: 'meaning://github.com/meaninggraph/core', repository: coreUrl, commit: '0'.repeat(40), meaning_files: ['*.meaning.yaml'], maintainers: ['trakhimenok'] },
  ];
  const meaningRegistry = indexMeaningRegistry({ format: 'meaning-registry/draft-1', checksum: `sha256:${createHash('sha256').update(JSON.stringify(graphs)).digest('hex')}`, graphs }, 'the conformance registry');
  const urls = new Map([[chinookUrl, `file://${publisher}`]]);
  const options = {
    root: dir, urlFor: (url) => urls.get(url) ?? url, cacheDir: fresh('cache'), meaningRegistry,
    loadModelRegistry: async () => indexModelRegistry({ format: 'modelspec-registry/draft-1', checksum: `sha256:${createHash('sha256').update('[]').digest('hex')}`, models: [] }, 'the conformance model registry'),
    fetched: new Set(), branches: new Map(),
  };
  const result = await checkDirectory(options);
  const problems = result.problems.filter((problem) => !problem.startsWith('index.json'));
  const index = problems.length === 0 ? JSON.parse(await buildIndex(options)).databases[0] : null;
  return { manifest: manifestProblems(manifestFor(part)), problems, warnings: result.warnings, index };
}
