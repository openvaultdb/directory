// Tests for the Directory checks and the index writer (CC0-1.0). No network:
// the publisher repository (a copy of the Chinook shape, scripts/fixtures/chinookdb),
// the core meaning graph (scripts/fixtures/core) and the MeaningGraph registry's
// index are local stand-ins. Local git repositories stand in for https URLs
// through `urlFor`; each test builds its own world, breaks one thing and
// expects the check to name it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { addressOf, defaultBranch, gitEnv, openCommit, repositoryKey, setGitProtocols } from './lib/git.mjs';
import { buildIndex, checkDirectory, indexText, readDirectory, recordProblems } from './lib/directory.mjs';
import { indexMeaningRegistry, loadMeaningRegistry } from './lib/meaning.mjs';
import { parseModelSpec } from './lib/modelspec.mjs';

// The local repositories that stand in for https URLs are file:// URLs; git is allowed to read them.
setGitProtocols('https:file');

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'directory-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let count = 0;
const fresh = (name) => { const dir = join(scratch, `${name}-${count++}`); mkdirSync(dir, { recursive: true }); return dir; };

const chinookUrl = 'https://github.com/datatug/chinookdb';
const coreUrl = 'https://github.com/meaninggraph/core';
const coreAddress = 'meaning://github.com/meaninggraph/core';
const chinookAddress = 'meaning://github.com/datatug/chinookdb';
// The commit of core that scripts/fixtures/chinookdb pins; tests replace it with the local core commit.
const fixtureCorePin = 'cb97dbcd9e951b00e7d46cb2e0c4e120c24c8db7';

// ---- local repositories ----

const gitIn = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' } }).toString().trim();
const commitAll = (dir) => {
  gitIn(dir, 'add', '-A');
  gitIn(dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'files');
  return gitIn(dir, 'rev-parse', 'HEAD');
};
const writeFiles = (dir, files) => {
  for (const [path, text] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
};
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

// A local git repository holding `files` on main. With `side`, more files are
// committed on a branch that main does not contain: the stand-in for a commit
// that only a fork has, which GitHub still serves through the parent's URL.
function origin(files, { symlinks = {}, side, name = 'origin' } = {}) {
  const dir = fresh(name);
  gitIn(dir, 'init', '-q', '-b', 'main');
  writeFiles(dir, files);
  for (const [path, target] of Object.entries(symlinks)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    symlinkSync(target, join(dir, path));
  }
  const commit = commitAll(dir);
  let sideCommit;
  if (side) {
    gitIn(dir, 'checkout', '-q', '-b', 'side');
    writeFiles(dir, side);
    sideCommit = commitAll(dir);
    gitIn(dir, 'checkout', '-q', 'main');
  }
  return { dir, url: `file://${dir}`, commit, sideCommit, more: (extra) => { writeFiles(dir, extra); return commitAll(dir); } };
}

const fixtureCore = readTree(join(root, 'scripts', 'fixtures', 'core'));
const fixtureChinook = readTree(join(root, 'scripts', 'fixtures', 'chinookdb'));
const realRecord = parseYaml(readFileSync(join(root, 'databases', '$records', 'chinook.yaml'), 'utf8'));

const meaningIndex = ({ chinook, core, edit } = {}) => {
  const graphs = [
    { id: 'chinook', title: 'Chinook', kind: 'dataset', status: 'draft', address: chinookAddress, repository: chinookUrl, commit: chinook, meaning_files: ['model/chinook.meaning.yaml'], maintainers: ['trakhimenok'] },
    { id: 'core', title: 'Core', kind: 'universal', status: 'draft', address: coreAddress, repository: coreUrl, commit: core, meaning_files: ['*.meaning.yaml'], maintainers: ['trakhimenok'] },
  ];
  edit?.(graphs);
  const checksum = `sha256:${createHash('sha256').update(JSON.stringify(graphs)).digest('hex')}`;
  return indexMeaningRegistry({ format: 'meaning-registry/draft-1', checksum, graphs }, 'the test registry');
};

// A world: core and the publisher as local repositories, the MeaningGraph
// registry's index, and a copy of this repository's collections with the real
// record pointing at the publisher's commit. Each test changes what it breaks:
//   publisher(files): edits the publisher's files (a Map of path -> text) before the commit
//   core(files):      the same for core
//   record(data):     edits the record
//   registry(graphs): edits the MeaningGraph registry's graphs
//   directory(dir):   edits the Directory's own files
function world({ publisher, core: editCore, record: editRecord, registry, directory: editDirectory, coreSide, pin, publisherOptions, extraCoreCommit } = {}) {
  const coreFiles = new Map(fixtureCore);
  editCore?.(coreFiles);
  const coreOrigin = origin(coreFiles, { name: 'core', side: coreSide });
  const corePin = pin?.(coreOrigin) ?? coreOrigin.commit;
  const extraCore = extraCoreCommit?.(coreOrigin);
  const files = new Map(fixtureChinook);
  files.set('model/chinook.meaning.yaml', files.get('model/chinook.meaning.yaml').replaceAll(fixtureCorePin, corePin));
  publisher?.(files, { corePin, coreCommit: coreOrigin.commit });
  const publisherOrigin = origin(files, { name: 'chinookdb', ...publisherOptions });
  const dir = fresh('directory');
  for (const name of ['.ingitdb', 'databases', 'maintainers']) cpSync(join(root, name), join(dir, name), { recursive: true });
  const record = { ...realRecord, commit: publisherOrigin.commit };
  editRecord?.(record);
  writeFileSync(join(dir, 'databases', '$records', 'chinook.yaml'), stringifyYaml(record));
  editDirectory?.(dir);
  const urls = new Map([[chinookUrl, publisherOrigin.url], [coreUrl, coreOrigin.url]]);
  const meaningRegistry = meaningIndex({ chinook: publisherOrigin.commit, core: coreOrigin.commit, edit: registry });
  return { dir, publisher: publisherOrigin, core: coreOrigin, corePin, extraCore, meaningRegistry, urls, urlFor: (url) => urls.get(url) ?? url, cacheDir: fresh('cache') };
}
const options = (w, extra = {}) => ({ root: w.dir, urlFor: w.urlFor, cacheDir: w.cacheDir, meaningRegistry: w.meaningRegistry, fetched: new Set(), branches: new Map(), ...extra });
const index = async (w, extra) => JSON.parse(await buildIndex(options(w, extra)));
// Writes the index the way `npm run index` does, then checks.
const checked = async (w, extra) => {
  writeFileSync(join(w.dir, 'index.json'), await buildIndex(options(w, extra)));
  return checkDirectory(options(w, extra));
};
const problemsOf = async (w, extra) => {
  const { problems } = await checkDirectory(options(w, extra));
  return problems.filter((problem) => !problem.startsWith('index.json'));
};
const expectProblem = (problems, pattern) => assert.ok(problems.some((problem) => pattern.test(problem)), `expected a problem matching ${pattern}, got:\n${problems.join('\n') || '(none)'}`);
const edited = (path, change) => (files) => files.set(path, change(files.get(path)));
const manifestEdit = (change) => edited('ovdb.yaml', (text) => { const manifest = parseYaml(text); change(manifest); return stringifyYaml(manifest); });
const meaningEdit = (change) => edited('model/chinook.meaning.yaml', (text) => { const doc = parseYaml(text); change(doc); return stringifyYaml(doc); });
const field = (database, recordset, name) => database.recordsets.find((entry) => entry.name === recordset).fields.find((entry) => entry.name === name);

// ---- the index ----

test('a well-formed database passes every check, so the failures below are about what each test broke', async () => {
  const w = world();
  const { problems, databases } = await checked(w);
  assert.deepEqual(problems, []);
  assert.equal(databases, 1);
});

test('index.json follows the contract: recordsets and fields from the ModelSpec, meanings resolved at pinned commits', async () => {
  const w = world();
  const result = await index(w);
  assert.equal(result.format, 'ovdb-directory/draft-1');
  assert.equal(result.databases.length, 1);
  const [chinook] = result.databases;
  assert.equal(chinook.id, 'chinook');
  assert.equal(chinook.title, 'Chinook music store');
  assert.equal(chinook.status, 'draft');
  assert.equal(chinook.url, 'https://chinookdb.com/ovdb/dbs/chinook');
  assert.deepEqual(chinook.deployment, { url: 'https://cloud.openvaultdb.com/ovdb/dbs/chinook', engine: 'sqlite' });
  assert.equal(chinook.repository, chinookUrl);
  assert.equal(chinook.commit, w.publisher.commit);
  assert.equal(chinook.manifest, 'ovdb.yaml');
  assert.equal(chinook.licence, 'MIT');
  assert.deepEqual(chinook.meaning_graph, { id: 'chinook', address: chinookAddress });
  const entities = Object.keys(JSON.parse(fixtureChinook.get('model/chinook.modelspec.json')).entities).sort();
  assert.deepEqual(chinook.recordsets.map((recordset) => recordset.name), entities);

  const customer = chinook.recordsets.find((recordset) => recordset.name === 'Customer');
  assert.equal(customer.url, 'https://cloud.openvaultdb.com/ovdb/dbs/chinook/collections/Customer');
  assert.deepEqual(customer.meanings, [{
    graph: 'chinook',
    concept: 'customer',
    label: 'Customer',
    role: 'entity',
    address: `${chinookAddress}/customer?ref=${w.publisher.commit}`,
    extends: [{ graph: 'core', concept: 'customer', label: 'Customer', address: `${coreAddress}/customer?ref=${w.corePin}` }],
  }]);
  assert.deepEqual(field(chinook, 'Customer', 'Country'), {
    name: 'Country',
    type: 'string',
    meanings: [{
      graph: 'chinook',
      concept: 'customer-country',
      label: 'Customer country',
      role: 'value',
      address: `${chinookAddress}/customer-country?ref=${w.publisher.commit}`,
      extends: [],
      values_of: { graph: 'core', concept: 'country', label: 'Country', address: `${coreAddress}/country?ref=${w.corePin}` },
    }],
  });
  const billing = field(chinook, 'Invoice', 'BillingCountry').meanings[0];
  assert.equal(billing.concept, 'billing-country');
  assert.deepEqual(billing.values_of, { graph: 'core', concept: 'country', label: 'Country', address: `${coreAddress}/country?ref=${w.corePin}` });
  // Types come from the ModelSpec; an entity reference has the type "reference" and says what it references.
  assert.deepEqual(field(chinook, 'Customer', 'SupportRepId').type, 'reference');
  assert.equal(field(chinook, 'Customer', 'SupportRepId').references, 'Employee');
  assert.equal('references' in field(chinook, 'Customer', 'Country'), false, 'a scalar field has no references');
  assert.deepEqual(chinook.model, { name: 'chinook', path: 'model/chinook.modelspec.hcl' });
  assert.equal(field(chinook, 'Track', 'UnitPrice').type, 'decimal');
  assert.equal(field(chinook, 'Invoice', 'InvoiceDate').type, 'datetime');
  // Fields keep the ModelSpec's order; a field nothing is bound to has no meanings.
  assert.deepEqual(customer.fields.slice(0, 3).map((entry) => entry.name), ['CustomerId', 'FirstName', 'LastName']);
  assert.deepEqual(field(chinook, 'Customer', 'FirstName').meanings, []);
});

test('the licence is the data licence, and a recordset has a url only when the manifest gives a recordset_page template', async () => {
  const [other] = (await index(world({ publisher: manifestEdit((manifest) => { manifest.licences.data = 'CC-BY-4.0'; }) }))).databases;
  assert.equal(other.licence, 'CC-BY-4.0', 'licences.data, not licences.model (MIT)');
  const [plain] = (await index(world({ publisher: manifestEdit((manifest) => { delete manifest.deployment.recordset_page; }) }))).databases;
  for (const recordset of plain.recordsets) assert.ok(!('url' in recordset), `${recordset.name} has no url: the url is never built by appending to deployment.url`);
  const [templated] = (await index(world({ publisher: manifestEdit((manifest) => { manifest.deployment.recordset_page = 'https://cloud.openvaultdb.com/x/{name}/rows'; }) }))).databases;
  assert.equal(templated.recordsets.find((recordset) => recordset.name === 'Album').url, 'https://cloud.openvaultdb.com/x/Album/rows');
  for (const recordsetPage of ['https://cloud.openvaultdb.com/x', 'https://cloud.openvaultdb.com/{name}/{name}', 'http://cloud.openvaultdb.com/{name}']) {
    expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.deployment.recordset_page = recordsetPage; }) })), /ovdb\.yaml: deployment\.recordset_page must be an https URL template with \{name\} once/);
  }
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { delete manifest.licences.data; }) })), /ovdb\.yaml: licences\.data is required/);
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.deployment.discovery = 'https://cloud.openvaultdb.com/.well-known/openvaultdb'; }) })), /deployment\.discovery must be on the same origin as url \(https:\/\/chinookdb\.com\)/);
});

test('the extends chain runs nearest first through bare ids and addresses, and values_of may name a concept of the database itself', async () => {
  const w = world();
  const [chinook] = (await index(w)).databases;
  const employee = chinook.recordsets.find((recordset) => recordset.name === 'Employee').meanings[0];
  assert.deepEqual(employee.extends.map((entry) => `${entry.graph}:${entry.concept}`), ['core:employee', 'core:person']);
  assert.deepEqual(employee.extends.map((entry) => entry.address), [`${coreAddress}/employee?ref=${w.corePin}`, `${coreAddress}/person?ref=${w.corePin}`]);
  const manager = field(chinook, 'Employee', 'ReportsTo').meanings.find((meaning) => meaning.concept === 'manager');
  assert.equal(manager.extends[0].concept, 'manager');
  assert.deepEqual(manager.values_of, { graph: 'chinook', concept: 'employee', label: 'Employee', address: `${chinookAddress}/employee?ref=${w.publisher.commit}` });
});

test('values_of is the concept\'s own values-of only, not inherited through extends', async () => {
  const w = world({
    publisher: meaningEdit((doc) => {
      doc.concepts.push({
        id: 'home-country', kind: 'attribute', of: 'customer', extends: 'customer-country', labels: { en: 'Home country' }, description: 'A narrower customer country.',
        bindings: [{ model: 'modelspec:///chinook.Customer', property: 'State', role: 'value' }],
      });
    }),
  });
  const [chinook] = (await index(w)).databases;
  const [home] = field(chinook, 'Customer', 'State').meanings;
  assert.deepEqual(home.extends.map((entry) => entry.concept), ['customer-country']);
  assert.ok(!('values_of' in home), 'the parent customer-country takes its values from core country; home-country does not say so itself');
});

test('model comes from the manifest: name (else the ModelSpec module) and the source file', async () => {
  const [named] = (await index(world({ publisher: manifestEdit((manifest) => { manifest.model.name = 'chinook'; }) }))).databases;
  assert.deepEqual(named.model, { name: 'chinook', path: 'model/chinook.modelspec.hcl' });
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.model.name = 'other'; }) })), /ovdb\.yaml: model\.name is other, but the ModelSpec at model\/chinook\.modelspec\.json is module chinook/);
  const [json] = (await index(world({ publisher: manifestEdit((manifest) => { delete manifest.model.hcl; }), }))).databases;
  assert.deepEqual(json.model, { name: 'chinook', path: 'model/chinook.modelspec.json' });
});

test('an address resolves at the commit its ?ref= pins, not at core\'s current commit', async () => {
  const w = world({
    extraCoreCommit: (core) => core.more(new Map([['geo.meaning.yaml', fixtureCore.get('geo.meaning.yaml').replace('en: Country\n', 'en: Nation\n')]])),
  });
  assert.notEqual(w.extraCore, w.corePin);
  const [chinook] = (await index(w)).databases;
  assert.equal(field(chinook, 'Customer', 'Country').meanings[0].values_of.label, 'Country');
  // Pinning the newer commit shows the newer label.
  const newer = world({
    pin: (core) => core.more(new Map([['geo.meaning.yaml', fixtureCore.get('geo.meaning.yaml').replace('en: Country\n', 'en: Nation\n')]])),
  });
  const [chinookNewer] = (await index(newer)).databases;
  assert.equal(field(chinookNewer, 'Customer', 'Country').meanings[0].values_of.label, 'Nation');
  assert.equal(field(chinookNewer, 'Customer', 'Country').meanings[0].values_of.address, `${coreAddress}/country?ref=${newer.corePin}`);
});

test('the index is deterministic and its checksum is the sha256 of the databases array', async () => {
  const w = world();
  const first = await buildIndex(options(w));
  const second = await buildIndex(options(w, { cacheDir: fresh('cache') }));
  assert.equal(first, second);
  const parsed = JSON.parse(first);
  assert.equal(parsed.checksum, `sha256:${createHash('sha256').update(JSON.stringify(parsed.databases)).digest('hex')}`);
  assert.ok(first.endsWith('}\n'));
  // Entries are written sorted by id whatever order they come in.
  const text = JSON.parse(indexText([{ id: 'b' }, { id: 'a' }]));
  assert.deepEqual(text.databases.map((entry) => entry.id), ['a', 'b']);
});

test('index.json that is missing or differs from what npm run index writes fails', async () => {
  const w = world();
  expectProblem((await checkDirectory(options(w))).problems, /^index\.json is missing/);
  await checked(w);
  writeFileSync(join(w.dir, 'index.json'), readFileSync(join(w.dir, 'index.json'), 'utf8').replace('Chinook music store', 'Chinook'));
  expectProblem((await checkDirectory(options(w))).problems, /^index\.json differs from what npm run index writes/);
});

test('buildIndex names every problem and writes nothing when one database fails', async () => {
  const w = world({ publisher: manifestEdit((manifest) => { manifest.url = 'https://chinookdb.com/ovdb/dbs/other'; }) });
  await assert.rejects(() => buildIndex(options(w)), /cannot build index\.json:\n  databases\/\$records\/chinook\.yaml: ovdb\.yaml: url is https:\/\/chinookdb\.com\/ovdb\/dbs\/other/);
});

// ---- the publisher repository ----

test('an unknown commit fails', async () => {
  const w = world({ record: (record) => { record.commit = '0c34c1a3e0616fa53810916503b3bf3c8a925800'; } });
  expectProblem(await problemsOf(w), /^databases\/\$records\/chinook\.yaml: commit 0c34c1a3e0616fa53810916503b3bf3c8a925800 is not in the history of main/);
});

test('a commit that is not on the default branch fails, even though the host would serve it', async () => {
  const w = world({ publisherOptions: { side: new Map([['extra.txt', 'only on a side branch\n']]) } });
  // The side commit really is fetchable from the repository; it is just not main's.
  assert.doesNotThrow(() => openCommit(w.publisher.url, w.publisher.sideCommit, w.cacheDir));
  writeFileSync(join(w.dir, 'databases', '$records', 'chinook.yaml'), stringifyYaml({ ...realRecord, commit: w.publisher.sideCommit }));
  expectProblem(await problemsOf(w), /^databases\/\$records\/chinook\.yaml: commit [0-9a-f]{40} is not in the history of main, the default branch of https:\/\/github\.com\/datatug\/chinookdb \(a commit only a fork or another branch has\)/);
});

test('OVDB.md must exist, parse, opt in and list the manifest by explicit path', async () => {
  expectProblem(await problemsOf(world({ publisher: (files) => files.delete('OVDB.md') })), /OVDB\.md: OVDB\.md .*does not exist at commit/);
  expectProblem(await problemsOf(world({ publisher: (files) => files.set('OVDB.md', '# no frontmatter\n') })), /OVDB\.md has no YAML frontmatter/);
  expectProblem(await problemsOf(world({ publisher: (files) => files.set('OVDB.md', '---\novdb: 2\npublish: [./ovdb.yaml]\n---\n') })), /OVDB\.md: ovdb must be 1/);
  expectProblem(await problemsOf(world({ publisher: (files) => files.set('OVDB.md', '---\novdb: 1\npublish: [./other.yaml]\n---\n') })), /OVDB\.md does not list \.\/ovdb\.yaml in publish \(it lists \.\/other\.yaml\)/);
  expectProblem(await problemsOf(world({ publisher: (files) => files.set('OVDB.md', '---\novdb: 1\npublish: ["./*.yaml", "./ovdb.yaml"]\n---\n') })), /OVDB\.md: publish entry "\.\/\*\.yaml" must be an explicit path/);
  expectProblem(await problemsOf(world({ publisher: (files) => files.set('OVDB.md', '---\novdb: 1\npublish: ["../ovdb.yaml"]\n---\n') })), /publish entry "\.\.\/ovdb\.yaml" must be an explicit path starting with \.\//);
});

test('a listed file that is a symbolic link is refused, never read through', async () => {
  const w = world({ publisher: (files) => files.delete('OVDB.md'), publisherOptions: { symlinks: { 'OVDB.md': '/etc/hosts' } } });
  expectProblem(await problemsOf(w), /OVDB\.md: OVDB\.md .*is not a regular file at commit .*symbolic link/);
});

test('the manifest needs its required fields, and its url, id and graph must agree with the record', async () => {
  const missing = await problemsOf(world({ publisher: manifestEdit((manifest) => { delete manifest.deployment.engine; delete manifest.licences; manifest.format = 'ovdb-manifest/draft-0'; }) }));
  expectProblem(missing, /ovdb\.yaml: format must be ovdb-manifest\/draft-1/);
  expectProblem(missing, /ovdb\.yaml: deployment\.engine is required/);
  expectProblem(missing, /ovdb\.yaml: licences\.model is required/);
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.url = 'https://chinookdb.com/ovdb/dbs/other'; }) })), /ovdb\.yaml: url is https:\/\/chinookdb\.com\/ovdb\/dbs\/other, but the record's url is https:\/\/chinookdb\.com\/ovdb\/dbs\/chinook/);
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.id = 'other'; }) })), /ovdb\.yaml: id is other, but the record is chinook/);
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.meaning.graph.id = 'core'; }) })), /ovdb\.yaml: meaning\.graph\.id is core, but the record's meaning_graph is chinook/);
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.publisher.repository = 'https://github.com/someone/else'; }) })), /publisher\.repository is https:\/\/github\.com\/someone\/else, but the record's repository/);
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.model.modelspec = '../outside.json'; }) })), /ovdb\.yaml: model\.modelspec is required/);
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.model.modelspec = 'model/missing.json'; }) })), /model\.modelspec model\/missing\.json does not exist at commit/);
  expectProblem(await problemsOf(world({ publisher: (files) => files.set('ovdb.yaml', ': : not yaml [') })), /ovdb\.yaml is not valid YAML/);
});

test('recordsets are exactly the ModelSpec entities', async () => {
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.recordsets = manifest.recordsets.filter((name) => name !== 'Genre'); }) })), /ovdb\.yaml: recordsets lacks ModelSpec entities: Genre/);
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.recordsets.push('Ghost'); }) })), /ovdb\.yaml: recordsets names things that are not ModelSpec entities: Ghost/);
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.recordsets.push('Genre'); }) })), /ovdb\.yaml: recordsets lists a name twice/);
});

test('the meaning licence the manifest states is the one the meaning file declares', async () => {
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.licences.meaning = 'MIT'; }) })), /licences\.meaning is MIT, but model\/chinook\.meaning\.yaml declares CC0-1\.0/);
});

test('a ModelSpec that is not JSON, or has no entities, fails', async () => {
  expectProblem(await problemsOf(world({ publisher: (files) => files.set('model/chinook.modelspec.json', '{') })), /model\/chinook\.modelspec\.json: is not JSON/);
  expectProblem(await problemsOf(world({ publisher: (files) => files.set('model/chinook.modelspec.json', '{"modelspec":"1","module":{"name":"chinook"},"entities":{}}') })), /model\/chinook\.modelspec\.json: has no entities/);
  const broken = parseModelSpec(JSON.stringify({ modelspec: '1', module: { name: 'm' }, entities: { A: { key: ['x'], properties: { x: { entity: 'Missing' } } } } }));
  assert.match(broken.problems.join('\n'), /A\.x references entity Missing/);
});

// ---- the MeaningGraph registry ----

test('the meaning graph must be registered in the MeaningGraph registry, for this repository', async () => {
  expectProblem(await problemsOf(world({ registry: (graphs) => graphs.splice(0, 1) })), /meaning_graph chinook is not registered in the MeaningGraph registry \(the test registry\)/);
  expectProblem(await problemsOf(world({ registry: (graphs) => { graphs[0].repository = 'https://github.com/someone/else'; graphs[0].address = 'meaning://github.com/someone/else'; } })), /meaning_graph chinook is registered for https:\/\/github\.com\/someone\/else, not for https:\/\/github\.com\/datatug\/chinookdb/);
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.meaning.graph.address = 'meaning://github.com/datatug/other'; }) })), /meaning\.graph\.address is meaning:\/\/github\.com\/datatug\/other, but the MeaningGraph registry registers chinook as meaning:\/\/github\.com\/datatug\/chinookdb/);
  expectProblem(await problemsOf(world({ registry: (graphs) => { graphs[0].meaning_files = ['other.meaning.yaml']; } })), /meaning\.file model\/chinook\.meaning\.yaml is not one of the meaning files the MeaningGraph registry lists for chinook/);
});

test('the MeaningGraph registry index must be readable and match its checksum, or the build fails loudly', async () => {
  const ok = (body, status = 200) => async () => ({ ok: status === 200, status, text: async () => body });
  await assert.rejects(() => loadMeaningRegistry({ url: 'https://example.test/index.json', fetchImpl: ok('', 404) }), /cannot read https:\/\/example\.test\/index\.json: HTTP 404/);
  await assert.rejects(() => loadMeaningRegistry({ url: 'https://example.test/index.json', fetchImpl: async () => { throw new Error('offline'); } }), /cannot read https:\/\/example\.test\/index\.json: offline/);
  await assert.rejects(() => loadMeaningRegistry({ url: 'https://example.test/index.json', fetchImpl: ok('not json') }), /is not JSON/);
  await assert.rejects(() => loadMeaningRegistry({ url: 'https://example.test/index.json', fetchImpl: ok(JSON.stringify({ format: 'meaning-registry/draft-1', checksum: 'sha256:00', graphs: [] })) }), /does not match its own checksum/);
  await assert.rejects(() => loadMeaningRegistry({ url: 'https://example.test/index.json', fetchImpl: ok(JSON.stringify({ format: 'other/1', graphs: [] })) }), /expected meaning-registry\/draft-1/);
  const graphs = [];
  const good = JSON.stringify({ format: 'meaning-registry/draft-1', checksum: `sha256:${createHash('sha256').update(JSON.stringify(graphs)).digest('hex')}`, graphs });
  assert.equal((await loadMeaningRegistry({ url: 'https://example.test/index.json', fetchImpl: ok(good) })).byId.size, 0);
});

test('checkDirectory reports an unreadable MeaningGraph registry as a problem and never falls back', async () => {
  const w = world();
  const { problems } = await checkDirectory({ ...options(w), meaningRegistry: undefined, loadRegistry: async () => { throw new Error('cannot read https://example.test/index.json: HTTP 503'); } });
  expectProblem(problems, /^MeaningGraph registry: cannot read https:\/\/example\.test\/index\.json: HTTP 503/);
  await assert.rejects(() => buildIndex({ ...options(w), meaningRegistry: undefined, loadRegistry: async () => { throw new Error('offline'); } }), /cannot build index\.json:\n  MeaningGraph registry: offline/);
});

// ---- bindings and address resolution ----

test('every binding must name a real ModelSpec entity and property', async () => {
  const binding = (model, property, role = 'value') => meaningEdit((doc) => {
    doc.concepts.push({ id: 'extra', kind: 'attribute', labels: { en: 'Extra' }, description: 'x', bindings: [{ model, ...(property ? { property } : {}), role }] });
  });
  expectProblem(await problemsOf(world({ publisher: binding('modelspec:///chinook.Ghost', undefined, 'entity') })), /concept extra: binding modelspec:\/\/\/chinook\.Ghost names an entity that is not in the ModelSpec/);
  expectProblem(await problemsOf(world({ publisher: binding('modelspec:///chinook.Customer', 'Nope') })), /concept extra: binding modelspec:\/\/\/chinook\.Customer names property Nope, which Customer does not have in the ModelSpec/);
  expectProblem(await problemsOf(world({ publisher: binding('modelspec:///other.Customer', 'Country') })), /names module other, but the ModelSpec at model\/chinook\.modelspec\.json is module chinook/);
  expectProblem(await problemsOf(world({ publisher: binding('modelspec://github.com/x/y/chinook.Customer', 'Country') })), /names a model outside this database/);
  expectProblem(await problemsOf(world({ publisher: binding('not a ref', 'Country') })), /is not a modelspec:\/\/\/\{module\}\.\{Entity\} reference/);
  expectProblem(await problemsOf(world({ publisher: binding('modelspec:///chinook.Customer', undefined, 'value') })), /with role value must name a property/);
});

test('a meaning file whose models entry is not the manifest\'s model.hcl fails', async () => {
  expectProblem(await problemsOf(world({ publisher: meaningEdit((doc) => { doc.models.chinook = 'other.modelspec.hcl'; }) })), /the chinook model is model\/other\.modelspec\.hcl, but ovdb\.yaml says model\.hcl is model\/chinook\.modelspec\.hcl/);
});

test('an address that does not resolve fails: unregistered graph, no ?ref=, unknown or off-branch commit, unknown concept, a cycle', async () => {
  const country = `${coreAddress}/country`;
  // Sets customer-country's values-of to `to`, a string or a function of core's pinned commit.
  const valuesOf = (to) => (files, context) => meaningEdit((doc) => {
    doc.concepts.find((entry) => entry.id === 'customer-country')['values-of'] = typeof to === 'function' ? to(context.corePin) : to;
  })(files);
  expectProblem(await problemsOf(world({ publisher: valuesOf((pin) => `meaning://github.com/nobody/graph/country?ref=${pin}`) })), /concept customer-country: values-of: meaning:\/\/github\.com\/nobody\/graph is not registered in the MeaningGraph registry/);
  expectProblem(await problemsOf(world({ publisher: valuesOf(country) })), /concept customer-country: values-of: meaning:\/\/github\.com\/meaninggraph\/core needs a \?ref= pin/);
  expectProblem(await problemsOf(world({ publisher: valuesOf(`${country}?ref=main`) })), /a pin is a full 40-character commit id/);
  expectProblem(await problemsOf(world({ publisher: valuesOf(`${country}?ref=0c34c1a3e0616fa53810916503b3bf3c8a925800`) })), /meaning:\/\/github\.com\/meaninggraph\/core\?ref=0c34c1a3e0616fa53810916503b3bf3c8a925800: commit 0c34c1a3e0616fa53810916503b3bf3c8a925800 is not in the history of main/);
  expectProblem(await problemsOf(world({ publisher: valuesOf((pin) => `${coreAddress}/atlantis?ref=${pin}`) })), /atlantis\?ref=[0-9a-f]{40} names concept atlantis, which core does not have at/);
  // A commit that only a side branch of core has.
  const side = world({ coreSide: new Map([['extra.meaning.yaml', 'format: meaning/draft-1\nid: extra\nname: Extra\ndescription: x\nlicense: CC0-1.0\nconcepts: []\n']]), pin: (core) => core.sideCommit });
  expectProblem(await problemsOf(side), /is not in the history of main, the default branch of https:\/\/github\.com\/meaninggraph\/core \(a commit only a fork or another branch has\)/);
  // extends that loops back.
  const loop = world({
    publisher: meaningEdit((doc) => {
      doc.concepts.find((entry) => entry.id === 'artist').extends = 'album';
      doc.concepts.find((entry) => entry.id === 'album').extends = 'artist';
    }),
  });
  expectProblem(await problemsOf(loop), /concept artist: extends returns to artist/);
});

// ---- the records ----

const directoryOf = (records) => ({ databases: records, maintainers: [{ key: 'trakhimenok', data: { name: 'x' } }] });
const recordWith = (change, key = 'chinook') => ({ key, file: `databases/$records/${key}.yaml`, data: { ...realRecord, ...change } });

test('the record as committed is well formed', () => {
  assert.deepEqual(recordProblems(readDirectory(root)), []);
});

test('records that are not well formed are refused before any git command runs', async () => {
  const refused = [
    'http://github.com/datatug/chinookdb',
    'git@github.com:datatug/chinookdb.git',
    'ssh://git@github.com/datatug/chinookdb',
    'https://github.com/datatug/chinookdb.git',
    'https://github.com/datatug/chinookdb.GIT',
    'https://github.com/datatug/chinookdb/',
    'https://github.com/datatug',
    'https://github.com/datatug/chinookdb/tree/main',
    'https://github.com/datatug/..',
    'https://github.com/./chinookdb',
    'https://www.github.com/datatug/chinookdb',
    'https://user@github.com/datatug/chinookdb',
    'https://github.com:443/datatug/chinookdb',
    'https://127.0.0.1/datatug/chinookdb',
    'https://evil.example/datatug/chinookdb',
    'https://github.com/datatug/chinookdb?x=1',
    'https://github.com/datatug/chinook db',
    'https://github.com/datatug/chinook;touch-pwned',
    'https://github.com/datatug/$(touch-pwned)',
    '--upload-pack=touch pwned',
    '-ohttps://github.com/datatug/chinookdb',
    'file:///tmp/x',
    '',
    42,
  ];
  for (const repository of refused) {
    const problems = recordProblems(directoryOf([recordWith({ repository })]));
    expectProblem(problems, /repository must be an https URL of a repository on github\.com/);
    assert.equal(repositoryKey(repository), null, `${repository} is not a repository`);
    assert.equal(addressOf(repository), null);
  }
  assert.equal(repositoryKey('https://github.com/datatug/chinookdb'), 'github.com/datatug/chinookdb');
  assert.equal(addressOf('https://github.com/datatug/chinookdb'), chinookAddress);
});

test('a record with a shell-shaped or option-shaped value never reaches git', async () => {
  const marker = join(scratch, 'pwned');
  const w = world({ record: (record) => { record.manifest = '--upload-pack=touch pwned'; record.commit = '--upload-pack=touch pwned'; } });
  const { problems } = await checkDirectory(options(w));
  expectProblem(problems, /commit must be a full 40-character lower-case commit id/);
  expectProblem(problems, /manifest must be a relative path inside the repository/);
  assert.ok(!problems.some((problem) => /cannot fetch|cannot read the history/.test(problem)), 'git was not asked about these values');
  assert.ok(!existsSync(marker) && !existsSync('pwned'));
  for (const manifest of ['../ovdb.yaml', '/etc/passwd', 'a/../../b', './ovdb.yaml', 'model/*.yaml', 'ovdb.yaml/', 'a b.yaml', 'a;b.yaml']) {
    expectProblem(recordProblems(directoryOf([recordWith({ manifest })])), /manifest must be a relative path inside the repository/);
  }
  expectProblem(recordProblems(directoryOf([recordWith({ commit: 'ABCDEF0c34c1a3e0616fa53810916503b3bf3c8a' })])), /commit must be a full 40-character lower-case commit id/);
  expectProblem(recordProblems(directoryOf([recordWith({ commit: 'abc123' })])), /commit must be a full 40-character lower-case commit id/);
});

test('ids, formats, statuses, urls and maintainers follow the record rules; a url is registered once', () => {
  expectProblem(recordProblems(directoryOf([recordWith({}, 'Chinook_DB')])), /id "Chinook_DB" must be lower-case letters, digits and single hyphens/);
  expectProblem(recordProblems(directoryOf([recordWith({ format: 'ovdb-directory/draft-2' })])), /format must be ovdb-directory\/draft-1/);
  expectProblem(recordProblems(directoryOf([recordWith({ status: 'live' })])), /status must be one of draft, published, deprecated/);
  expectProblem(recordProblems(directoryOf([recordWith({ maintainers: ['nobody'] })])), /maintainer nobody has no record in maintainers\//);
  expectProblem(recordProblems(directoryOf([recordWith({ meaning_graph: 'Not An Id' })])), /meaning_graph must be a MeaningGraph registry id/);
  for (const url of ['http://chinookdb.com/ovdb/dbs/chinook', 'https://chinookdb.com/ovdb/dbs/chinook/', 'https://chinookdb.com/ovdb/dbs/chinook?x=1', 'https://CHINOOKDB.com/ovdb/dbs/chinook', 'https://user@chinookdb.com/x', 'chinookdb.com/x', 'https://chinookdb.com/x#y']) {
    expectProblem(recordProblems(directoryOf([recordWith({ url })])), /url must be a canonical https URL/);
  }
  expectProblem(recordProblems(directoryOf([recordWith({}), recordWith({ url: 'https://CHINOOKDB.com/ovdb/dbs/chinook'.replace('CHINOOKDB', 'chinookdb') }, 'chinook-again')])), /url https:\/\/chinookdb\.com\/ovdb\/dbs\/chinook is registered under 2 ids \(chinook, chinook-again/);
});

test('a file in $records that is not <key>.yaml is a problem', async () => {
  const w = world({ directory: (dir) => writeFileSync(join(dir, 'databases', '$records', 'notes.txt'), 'x') });
  expectProblem(await problemsOf(w), /^databases\/\$records\/notes\.txt: a record is a <key>\.yaml file/);
});

// ---- git hardening ----

test('git only talks https unless the tests allow file', () => {
  const o = origin(new Map([['a.txt', 'a']]), { name: 'proto' });
  setGitProtocols('https');
  try {
    assert.throws(() => defaultBranch(o.url), /protocol|not allowed|transport/i);
  } finally { setGitProtocols('https:file'); }
  assert.equal(defaultBranch(o.url), 'main');
});

test('the global and system git configuration is ignored, and inherited GIT_ variables are dropped', () => {
  const o = origin(new Map([['a.txt', 'a']]), { name: 'config' });
  const config = join(fresh('home'), 'gitconfig');
  // An insteadOf rewrite would turn this unreachable URL into the real repository.
  writeFileSync(config, `[url "${o.url}"]\n\tinsteadOf = file:///nonexistent-origin\n`);
  const saved = { ...process.env };
  try {
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_DIR = join(scratch, 'not-a-repository');
    process.env.GIT_WORK_TREE = join(scratch, 'not-a-work-tree');
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'protocol.allow';
    process.env.GIT_CONFIG_VALUE_0 = 'never';
    const env = gitEnv();
    assert.equal(env.GIT_CONFIG_GLOBAL, devNull);
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GIT_WORK_TREE, undefined);
    assert.equal(env.GIT_CONFIG_COUNT, undefined);
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GIT_ALLOW_PROTOCOL, 'https:file');
    assert.throws(() => defaultBranch('file:///nonexistent-origin'), /does not appear to be a git repository|could not read|unable to|not a git repository/i);
    assert.equal(defaultBranch(o.url), 'main', 'a real URL still works with the inherited variables set');
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});

test('a URL or commit that looks like an option is never read as one (--end-of-options), and nothing goes through a shell', () => {
  const marker = join(scratch, 'option-ran');
  assert.throws(() => defaultBranch(`--upload-pack=touch ${marker}`));
  assert.throws(() => openCommit(`--upload-pack=touch ${marker}`, 'a'.repeat(40), fresh('cache')));
  assert.throws(() => openCommit('file:///nonexistent', '--upload-pack=touch x', fresh('cache')), /is not a full commit id/);
  assert.ok(!existsSync(marker));
  // A path with shell metacharacters is just a path: execFileSync passes it as one argument.
  const hostile = join(scratch, 'dir with $(touch shell-ran) and ; touch shell-ran2 and `touch shell-ran3`');
  mkdirSync(hostile, { recursive: true });
  const o = origin(new Map([['a.txt', 'a']]), { name: 'shell' });
  cpSync(o.dir, hostile, { recursive: true });
  assert.equal(defaultBranch(`file://${hostile}`), 'main');
  const files = openCommit(`file://${hostile}`, o.commit, fresh('cache'));
  assert.equal(files.read('a.txt'), 'a');
  for (const name of ['shell-ran', 'shell-ran2', 'shell-ran3']) assert.ok(!existsSync(join(process.cwd(), name)) && !existsSync(join(hostile, name)));
});

test('openCommit reads regular files only, and expands * within one path segment', () => {
  const o = origin(new Map([['a.meaning.yaml', 'a'], ['sub/b.meaning.yaml', 'b'], ['plain.txt', 'p']]), { name: 'tree', symlinks: { 'link.meaning.yaml': 'plain.txt' } });
  const files = openCommit(o.url, o.commit, fresh('cache'));
  assert.deepEqual(files.match('*.meaning.yaml'), ['a.meaning.yaml', 'link.meaning.yaml']);
  assert.deepEqual(files.match('sub/*.meaning.yaml'), ['sub/b.meaning.yaml']);
  assert.deepEqual(files.match('plain.txt'), ['plain.txt']);
  assert.deepEqual(files.match('missing.txt'), []);
  assert.equal(files.status('plain.txt'), 'file');
  assert.equal(files.status('link.meaning.yaml'), 'link');
  assert.equal(files.status('nope'), 'missing');
  assert.throws(() => files.read('link.meaning.yaml'), /is not a regular file/);
  assert.equal(files.read('sub/b.meaning.yaml'), 'b');
});

test('the committed index.json has the contract shape and its own checksum', () => {
  const path = join(root, 'index.json');
  if (!existsSync(path)) return; // the first commit of a database adds it
  const committed = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(committed.format, 'ovdb-directory/draft-1');
  assert.equal(committed.checksum, `sha256:${createHash('sha256').update(JSON.stringify(committed.databases)).digest('hex')}`);
  const records = readDirectory(root).databases.map((record) => record.key).sort();
  assert.deepEqual(committed.databases.map((database) => database.id), records);
  assert.equal(readFileSync(path, 'utf8'), `${JSON.stringify(committed, null, 2)}\n`);
});
