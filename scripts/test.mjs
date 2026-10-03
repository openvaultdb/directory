// Tests for the Directory checks and the index writer (CC0-1.0). No network:
// the publisher repository (a copy of the Chinook shape, scripts/fixtures/chinookdb),
// the core meaning graph (scripts/fixtures/core) and the MeaningGraph registry's
// index are local stand-ins. Local git repositories stand in for https URLs
// through `urlFor`; each test builds its own world, breaks one thing and
// expects the check to name it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { addressOf, cacheRepoSound, defaultBranch, defaultCacheDir, git, gitEnv, historyPath, onBranch, openCommit, repositoryKey, setGitProtocols } from './lib/git.mjs';
import { runCheck, runIndex } from './lib/cli.mjs';
import { hasOvdbMarker, publicHttpsProblem } from './lib/urls.mjs';
import { buildIndex, checkDirectory, indexText, readDirectory, recordProblems, urlProblem } from './lib/directory.mjs';
import { indexMeaningRegistry, loadMeaningRegistry } from './lib/meaning.mjs';
import { indexModelRegistry, loadModelRegistry, modelRegistryDefaultUrl, parseModelSpec } from './lib/modelspec.mjs';

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
// A manifest with its own model files that names its model's address reads the ModelSpec registry; unless a test says
// otherwise that registry has no models, so no address is registered and nothing is compared.
const emptyModelRegistry = async () => modelIndex({ commit: '0'.repeat(40), edit: (models) => models.splice(0) });
const options = (w, extra = {}) => ({ root: w.dir, urlFor: w.urlFor, cacheDir: w.cacheDir, meaningRegistry: w.meaningRegistry, loadModelRegistry: emptyModelRegistry, fetched: new Set(), branches: new Map(), ...extra });
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

test('index.json has the documented shape: recordsets and fields from the ModelSpec, meanings resolved at pinned commits', async () => {
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
      values_of: { graph: 'core', concept: 'country', label: 'Country', address: `${coreAddress}/country?ref=${w.corePin}`, extends: [] },
    }],
  });
  const billing = field(chinook, 'Invoice', 'BillingCountry').meanings[0];
  assert.equal(billing.concept, 'billing-country');
  assert.deepEqual(billing.values_of, { graph: 'core', concept: 'country', label: 'Country', address: `${coreAddress}/country?ref=${w.corePin}`, extends: [] });
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
  for (const [recordsetPage, problem] of [['https://cloud.openvaultdb.com/x', /must contain \{name\} exactly once/], ['https://cloud.openvaultdb.com/{name}/{name}', /must contain \{name\} exactly once/], ['http://cloud.openvaultdb.com/{name}', /must be https, not http/]]) {
    expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.deployment.recordset_page = recordsetPage; }) })), new RegExp(`ovdb\\.yaml: deployment\\.recordset_page ${problem.source}`));
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
  // The values_of entry carries its own chain, so a page for a broader concept still finds the field.
  assert.deepEqual(manager.values_of, {
    graph: 'chinook', concept: 'employee', label: 'Employee', address: `${chinookAddress}/employee?ref=${w.publisher.commit}`,
    extends: [
      { graph: 'core', concept: 'employee', label: 'Employee', address: `${coreAddress}/employee?ref=${w.corePin}` },
      { graph: 'core', concept: 'person', label: 'Person', address: `${coreAddress}/person?ref=${w.corePin}` },
    ],
  });
});

// What a concept page's "In OVDB databases" section lists: every meaning whose concept, extends chain or values_of
// (or that entry's own extends chain) names the concept.
const carriers = (database, graph, concept) => {
  const names = (entry) => entry && entry.graph === graph && entry.concept === concept;
  const found = [];
  for (const recordset of database.recordsets) {
    for (const [fieldName, meanings] of [[undefined, recordset.meanings], ...recordset.fields.map((entry) => [entry.name, entry.meanings])]) {
      if (meanings.some((m) => names(m) || m.extends.some(names) || names(m.values_of) || m.values_of?.extends.some(names))) found.push(fieldName ? `${recordset.name}.${fieldName}` : recordset.name);
    }
  }
  return found;
};

test('a page for a broader concept finds a field through values_of and its extends chain alone (core Person finds Employee.ReportsTo)', async () => {
  const [chinook] = (await index(world())).databases;
  const person = carriers(chinook, 'core', 'person');
  assert.ok(person.includes('Employee.ReportsTo'), person.join(', '));
  assert.ok(person.includes('Customer.SupportRepId'), person.join(', '));
  assert.ok(carriers(chinook, 'core', 'employee').includes('Employee.ReportsTo'));
  assert.ok(carriers(chinook, 'chinook', 'employee').includes('Customer.SupportRepId'));
  assert.ok(!carriers(chinook, 'core', 'person').includes('Customer.Country'));
  assert.ok(carriers(chinook, 'core', 'country').includes('Invoice.BillingCountry'));
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

test('model comes from the meaning file\'s models entry: its name is the ModelSpec module, its path a regular file at the commit', async () => {
  const [named] = (await index(world({ publisher: manifestEdit((manifest) => { manifest.model.name = 'chinook'; }) }))).databases;
  assert.deepEqual(named.model, { name: 'chinook', path: 'model/chinook.modelspec.hcl' });
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.model.name = 'other'; }) })), /ovdb\.yaml: model\.name is other, but the ModelSpec at model\/chinook\.modelspec\.json is module chinook/);
  // Without model.hcl in the manifest the path still comes from the meaning file, never from the JSON.
  const [json] = (await index(world({ publisher: manifestEdit((manifest) => { delete manifest.model.hcl; }) }))).databases;
  assert.deepEqual(json.model, { name: 'chinook', path: 'model/chinook.modelspec.hcl' });
});

test('model.path is refused unless it is a .modelspec.hcl regular file at the pinned commit that stays inside the repository', async () => {
  const models = (declared) => meaningEdit((doc) => { doc.models.chinook = declared; });
  const shape = /models must name the ModelSpec module chinook with a relative path that stays inside the repository/;
  // Refused before anything is read: escaping the repository, absolute, glob, pathspec magic, empty segments, not a string.
  for (const declared of ['../../outside.hcl', '../../../x.modelspec.hcl', '/etc/passwd', 'chinook.*.hcl', ':(icase)chinook.modelspec.hcl', 'model//chinook.modelspec.hcl', 'a b.modelspec.hcl', 42, null]) {
    expectProblem(await problemsOf(world({ publisher: models(declared) })), shape);
  }
  expectProblem(await problemsOf(world({ publisher: meaningEdit((doc) => { delete doc.models; }) })), shape);
  expectProblem(await problemsOf(world({ publisher: meaningEdit((doc) => { doc.models = ['chinook.modelspec.hcl']; }) })), shape);
  expectProblem(await problemsOf(world({ publisher: meaningEdit((doc) => { doc.models = 'chinook.modelspec.hcl'; }) })), shape);
  // Only a model source: the JSON, the meaning file itself or any other file is not one.
  for (const declared of ['chinook.modelspec.json', 'chinook.meaning.yaml', 'chinook.modelspec.hcl.txt', 'checksums.json']) {
    expectProblem(await problemsOf(world({ publisher: models(declared) })), /must be a \.modelspec\.hcl file/);
  }
  expectProblem(await problemsOf(world({ publisher: (files) => files.delete('model/chinook.modelspec.hcl') })), /the chinook model model\/chinook\.modelspec\.hcl does not exist at commit/);
  expectProblem(await problemsOf(world({ publisher: models('other.modelspec.hcl') })), /the chinook model model\/other\.modelspec\.hcl does not exist at commit/);
  // A symbolic link is not a file of the repository.
  const link = world({ publisher: (files) => files.delete('model/chinook.modelspec.hcl'), publisherOptions: { symlinks: { 'model/chinook.modelspec.hcl': 'chinook.modelspec.json' } } });
  expectProblem(await problemsOf(link), /the chinook model model\/chinook\.modelspec\.hcl is not a regular file at commit/);
  // The manifest's model.hcl, when given, is the same file; it gets the same path rules.
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.model.hcl = 'model/other.modelspec.hcl'; }) })), /the chinook model is model\/chinook\.modelspec\.hcl, but ovdb\.yaml says model\.hcl is model\/other\.modelspec\.hcl/);
  for (const hcl of ['../outside.modelspec.hcl', '/abs.modelspec.hcl', 'model//x.modelspec.hcl', 'model/./x.modelspec.hcl', 'model/*.hcl', 'model/chinook.modelspec.json']) {
    expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.model.hcl = hcl; }) })), /ovdb\.yaml: model\.hcl must be a relative path inside the repository/);
  }
});

test('a models entry is joined to the meaning file\'s directory: ../x.hcl from model/sub/ is fine, leaving the repository is not', async () => {
  const nested = (files, declared) => {
    files.set('model/sub/chinook.meaning.yaml', stringifyYaml({ ...parseYaml(files.get('model/chinook.meaning.yaml')), models: { chinook: declared } }));
    files.delete('model/chinook.meaning.yaml');
    manifestEdit((manifest) => { manifest.meaning.file = 'model/sub/chinook.meaning.yaml'; })(files);
  };
  const registry = (graphs) => { graphs[0].meaning_files = ['model/sub/chinook.meaning.yaml']; };
  const inside = world({ publisher: (files) => nested(files, '../chinook.modelspec.hcl'), registry });
  const [chinook] = (await index(inside)).databases;
  assert.deepEqual(chinook.model, { name: 'chinook', path: 'model/chinook.modelspec.hcl' });
  const escaping = world({ publisher: (files) => nested(files, '../../../chinook.modelspec.hcl'), registry });
  expectProblem(await problemsOf(escaping), /models must name the ModelSpec module chinook with a relative path that stays inside the repository/);
});

// ---- the model's address ----

test('model.address, when the manifest has one, is validated and emitted; databases that share it are of the same model', async () => {
  const own = 'modelspec://github.com/datatug/chinookdb/chinook';
  const [withAddress] = (await index(world({ publisher: manifestEdit((manifest) => { manifest.model.address = own; }) }))).databases;
  assert.deepEqual(withAddress.model, { name: 'chinook', path: 'model/chinook.modelspec.hcl', address: own });
  const [without] = (await index(world())).databases;
  assert.ok(!('address' in without.model), 'absent when the manifest has none');
  const refused = [
    ['modelspec://github.com/datatug/chinookdb', /model\.address must be modelspec:\/\/\{host\}\/\{org\}\/\{repo\}\/\{module\}/],
    ['modelspec://github.com/datatug/chinookdb/chinook/extra', /model\.address must be modelspec/],
    ['modelspec:///chinook', /model\.address must be modelspec/],
    ['https://github.com/datatug/chinookdb/chinook', /model\.address must be modelspec/],
    ['modelspec://github.com/datatug/chinookdb/chinook?ref=abc', /model\.address must be modelspec/],
    ['modelspec://github.com/datatug/chinookdb/chinook#x', /model\.address must be modelspec/],
    ['modelspec://evil.example/datatug/chinookdb/chinook', /must name a repository on github\.com/],
    ['modelspec://github.com/DataTug/ChinookDB/chinook', /must be written in lower case/],
    ['modelspec://github.com/someone/else/chinook', /names github\.com\/someone\/else, but the model's files are in github\.com\/datatug\/chinookdb/],
    ['modelspec://github.com/datatug/chinookdb/other', /names module other, but the ModelSpec at model\/chinook\.modelspec\.json is module chinook/],
    [`${own}?ref=${'a'.repeat(40)}`, /must not carry \?ref= when the model's files are in the same repository/],
  ];
  for (const [address, pattern] of refused) {
    expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.model.address = address; }) })), pattern);
  }
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
  expectProblem(await problemsOf(world({ publisher: binding('modelspec:///chinook.Customer', 'Nope') })), /concept extra: binding modelspec:\/\/\/chinook\.Customer names property "Nope", which Customer does not have in the ModelSpec/);
  expectProblem(await problemsOf(world({ publisher: binding('modelspec:///other.Customer', 'Country') })), /names module other, but the ModelSpec at model\/chinook\.modelspec\.json is module chinook/);
  expectProblem(await problemsOf(world({ publisher: binding('modelspec://github.com/x/y/chinook.Customer', 'Country') })), /names a model outside this database/);
  expectProblem(await problemsOf(world({ publisher: binding('not a ref', 'Country') })), /is not a modelspec:\/\/\/\{module\}\.\{Entity\} reference/);
  expectProblem(await problemsOf(world({ publisher: binding('modelspec:///chinook.Customer', undefined, 'value') })), /with role value must name a property/);
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
  for (const url of ['http://chinookdb.com/ovdb/dbs/chinook', 'https://chinookdb.com/ovdb/dbs/chinook/', 'https://chinookdb.com/ovdb/dbs/chinook?x=1', 'https://CHINOOKDB.com/ovdb/dbs/chinook', 'https://user@chinookdb.com/ovdb/x', 'chinookdb.com/ovdb/x', 'https://chinookdb.com/ovdb/x#y']) {
    expectProblem(recordProblems(directoryOf([recordWith({ url })])), /url (must|is not|contains)/);
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

test('the committed index.json has the documented shape and its own checksum', () => {
  const path = join(root, 'index.json');
  if (!existsSync(path)) return; // the first commit of a database adds it
  const committed = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(committed.format, 'ovdb-directory/draft-1');
  assert.equal(committed.checksum, `sha256:${createHash('sha256').update(JSON.stringify(committed.databases)).digest('hex')}`);
  const records = readDirectory(root).databases.map((record) => record.key).sort();
  assert.deepEqual(committed.databases.map((database) => database.id), records);
  assert.equal(readFileSync(path, 'utf8'), `${JSON.stringify(committed, null, 2)}\n`);
});

// ---- chains, ids, spelling ----

const chainFile = (length) => stringifyYaml({
  format: 'meaning/draft-1', id: 'chain', name: 'Chain', description: 'A long chain.', license: 'CC0-1.0',
  concepts: Array.from({ length }, (_, n) => ({
    id: `l${String.fromCharCode(97 + Math.floor(n / 26))}${String.fromCharCode(97 + (n % 26))}`,
    kind: 'entity',
    labels: { en: `Link ${n}` },
    description: 'x',
    ...(n < length - 1 ? { extends: `l${String.fromCharCode(97 + Math.floor((n + 1) / 26))}${String.fromCharCode(97 + ((n + 1) % 26))}` } : {}),
  })),
});
const deep = (concept) => (files, { corePin }) => meaningEdit((doc) => {
  doc.concepts.push({ id: 'deep', kind: 'entity', extends: `${coreAddress}/${concept}?ref=${corePin}`, labels: { en: 'Deep' }, description: 'x' });
})(files);

test('an extends chain over the limit is a problem, never silently cut', async () => {
  const long = world({ core: (files) => files.set('chain.meaning.yaml', chainFile(60)), publisher: deep('laa') });
  expectProblem(await problemsOf(long), /concept deep: extends chain is longer than 50 concepts/);
  const fine = world({ core: (files) => files.set('chain.meaning.yaml', chainFile(40)), publisher: deep('laa') });
  assert.deepEqual(await problemsOf(fine), []);
  const [chinook] = (await index(fine)).databases;
  assert.equal(chinook.recordsets.length, 11);
});

test('concept ids are validated and a concept without one is reported, in this database and in the graphs it reaches', async () => {
  const bindings = [{ model: 'modelspec:///chinook.Genre', role: 'entity' }];
  expectProblem(await problemsOf(world({ publisher: meaningEdit((doc) => { doc.concepts.push({ id: 'Genre Thing?ref=evil', kind: 'entity', labels: { en: 'x' }, description: 'x', bindings }); }) })), /concept id "Genre Thing\?ref=evil" must be lower-case words joined by single hyphens/);
  expectProblem(await problemsOf(world({ publisher: meaningEdit((doc) => { doc.concepts.push({ kind: 'entity', labels: { en: 'x' }, description: 'x', bindings }); }) })), /model\/chinook\.meaning\.yaml: concept #\d+ has no id/);
  expectProblem(await problemsOf(world({ publisher: meaningEdit((doc) => { doc.concepts.push({ id: 7, kind: 'entity', bindings }); }) })), /concept #\d+ has no id/);
  expectProblem(await problemsOf(world({ publisher: meaningEdit((doc) => { doc.concepts.push(null); }) })), /concept #\d+ has no id/);
  // A foreign graph with a bad concept list is a problem, not an exception that ends the whole run.
  const mapping = world({ core: (files) => files.set('geo.meaning.yaml', 'format: meaning/draft-1\nid: geo\nname: Geo\ndescription: x\nlicense: CC0-1.0\nconcepts:\n  country: {kind: entity}\n') });
  expectProblem(await problemsOf(mapping), /geo\.meaning\.yaml: concepts must be a list/);
  const noId = world({ core: (files) => files.set('geo.meaning.yaml', 'format: meaning/draft-1\nid: geo\nname: Geo\ndescription: x\nlicense: CC0-1.0\nconcepts:\n  - kind: entity\n') });
  expectProblem(await problemsOf(noId), /geo\.meaning\.yaml: concept #1 has no id/);
  const badId = world({ core: (files) => files.set('geo.meaning.yaml', 'format: meaning/draft-1\nid: geo\nname: Geo\ndescription: x\nlicense: CC0-1.0\nconcepts:\n  - id: Country\n    kind: entity\n') });
  expectProblem(await problemsOf(badId), /concept id "Country" must be lower-case words joined by single hyphens/);
});

test('addresses use the canonical spelling the MeaningGraph registry registers, whatever case the record writes the repository in', async () => {
  const variant = 'https://github.com/DataTug/ChinookDB';
  const w = world({ record: (record) => { record.repository = variant; }, publisher: manifestEdit((manifest) => { delete manifest.publisher.repository; }) });
  w.urls.set(variant, w.publisher.url);
  const [chinook] = (await index(w)).databases;
  assert.equal(chinook.repository, variant, 'the record\'s own value is kept');
  assert.equal(chinook.meaning_graph.address, chinookAddress);
  const all = JSON.stringify(chinook.recordsets);
  assert.ok(!all.includes('DataTug') && !all.includes('ChinookDB'), 'no address uses the record\'s spelling');
  assert.equal(field(chinook, 'Customer', 'Country').meanings[0].address, `${chinookAddress}/customer-country?ref=${w.publisher.commit}`);
  // publisher.repository may differ only in case too.
  const same = world({ record: (record) => { record.repository = variant; } });
  same.urls.set(variant, same.publisher.url);
  assert.deepEqual(await problemsOf(same), []);
});

// ---- URL rules ----

test('public URLs are https only, without credentials, query or fragment, and never name an IP address, a local, internal or reserved host', () => {
  const refused = [
    ['http://example.com/ovdb/x', /must be https/], ['ftp://example.com/x', /must be https/], ['file:///etc/passwd', /must be https/],
    ['https://user:pw@example.com/x', /credentials/], ['https://user@example.com/x', /credentials/],
    ['https://example.com/x?a=1', /query/], ['https://example.com/x?', /query/], ['https://example.com/x#a', /fragment/], ['https://example.com/x#', /fragment/],
    ['https://127.0.0.1/x', /IP address/], ['https://127.1/x', /IP address/], ['https://0x7f.0.0.1/x', /IP address/], ['https://2130706433/x', /IP address/],
    ['https://017700000001/x', /IP address/], ['https://0/x', /IP address/], ['https://10.0.0.1/x', /IP address/], ['https://192.168.1.1/x', /IP address/],
    ['https://172.16.0.1/x', /IP address/], ['https://169.254.169.254/latest/meta-data', /IP address/], ['https://100.64.0.1/x', /IP address/],
    ['https://[::1]/x', /IP address/], ['https://[::ffff:7f00:1]/x', /IP address/], ['https://[fe80::1]/x', /IP address/], ['https://[fd00::1]/x', /IP address/],
    ['https://8.8.8.8/x', /IP address/],
    ['https://localhost/x', /ends with a dot|single-label|local, internal or reserved/], ['https://localhost./x', /ends with a dot|single-label|local, internal or reserved/], ['https://LOCALHOST/x', /ends with a dot|single-label|local, internal or reserved/],
    ['https://foo.localhost/x', /local, internal or reserved/], ['https://printer.local/x', /local, internal or reserved/], ['https://metadata.google.internal/x', /local, internal or reserved/],
    ['https://db.corp/x', /local, internal or reserved/], ['https://host.lan/x', /local, internal or reserved/], ['https://box.home.arpa/x', /local, internal or reserved/], ['https://nas/x', /single-label/],
    ['https://%6c%6f%63%61%6c%68%6f%73%74/x', /ends with a dot|single-label|local, internal or reserved/],
    ['https://example.com/%2e%2e/x', /writes %2e|canonically/], ['https://EXAMPLE.com/x', /canonically/], ['https://example.com/a b', /whitespace|canonically/], ['https://example.com\\x', /backslash/],
    ['https://chinookdb.com./ovdb/x', /ends with a dot/], ['https://acme..com/ovdb/x', /empty label/], ['https://.acme.com/ovdb/x', /empty label|not a URL/],
    ['https://acme.com/ovdb//x', /empty path segment/], ['https://acme.com/ovdb/%63hinook', /writes %63 for c/], ['https://acme.com/a/%7Ex', /writes %7E for ~/],
    ['https://kubernetes.default.svc/ovdb/x', /local, internal or reserved/], ['https://foo.home/ovdb/x', /local, internal or reserved/], ['https://foo.test/ovdb/x', /local, internal or reserved/],
    ['https://foo.example/ovdb/x', /local, internal or reserved/], ['https://foo.invalid/ovdb/x', /local, internal or reserved/], ['https://foo.onion/ovdb/x', /local, internal or reserved/],
    ['https://1.0.0.127.in-addr.arpa/x', /local, internal or reserved/],
    ['', /not a URL/], ['not a url', /whitespace|not a URL/], [42, /not a URL/], [null, /not a URL/],
  ];
  for (const [value, pattern] of refused) {
    const problem = publicHttpsProblem(value);
    assert.ok(problem && pattern.test(problem), `${JSON.stringify(value)}: expected ${pattern}, got ${problem}`);
  }
  for (const accepted of ['https://example.com/x', 'https://cloud.openvaultdb.com/ovdb/dbs/chinook', 'https://ovdb.acme.com/sales', 'https://acme.com:8443/ovdb/x', 'https://xn--bcher-kva.de/ovdb']) {
    assert.equal(publicHttpsProblem(accepted), null, accepted);
  }
  assert.match(publicHttpsProblem('https://example.com/x', { template: true }), /\{name\} exactly once/);
  for (const template of ['https://169.254.169.{name}/latest', 'https://metadata.google.{name}/x', 'https://{name}.example.com/x', 'https://{name}@example.com/x', 'https://example.com:{name}/x', 'https://{name}']) {
    assert.match(publicHttpsProblem(template, { template: true }) ?? '', /\{name\} in the path only|exactly once|not a URL/, template);
  }
  assert.equal(publicHttpsProblem('https://example.com/{name}', { template: true }), null);
});

test('the canonical url needs ovdb as a complete path segment or as a subdomain', () => {
  for (const url of ['https://example.com/sales', 'https://acme.com/ovdbx/sales', 'https://acme.com/xovdb/sales', 'https://ovdb.com/sales', 'https://ovdb.co.uk/sales', 'https://ovdb.com.au/sales', 'https://acme.ovdb/sales', 'https://notovdb.acme.com/sales']) {
    assert.match(urlProblem(url) ?? '', /ovdb as a complete path segment or as a subdomain/, url);
  }
  for (const url of ['https://acme.com/ovdb/sales', 'https://acme.com/data/ovdb/sales', 'https://ovdb.acme.com/sales', 'https://x.ovdb.acme.co.uk/sales', 'https://ovdb.acme.co.uk/sales', 'https://chinookdb.com/ovdb/dbs/chinook']) {
    assert.equal(urlProblem(url), null, url);
  }
  assert.equal(hasOvdbMarker('https://acme.com/ovdb'), true);
  for (const url of ['https://127.0.0.1/ovdb/x', 'https://localhost/ovdb/x', 'https://169.254.169.254/ovdb/x', 'https://[::1]/ovdb/x', 'https://intranet.local/ovdb/x']) {
    expectProblem(recordProblems(directoryOf([recordWith({ url })])), /url .*(IP address|local, internal or reserved|single-label)/);
  }
});

test('every URL a manifest publishes is held to the same rules', async () => {
  const set = (change) => ({ publisher: manifestEdit(change) });
  const cases = [
    ['url', (manifest) => { manifest.url = 'https://127.0.0.1/ovdb/dbs/chinook'; }, /ovdb\.yaml: url https:\/\/127\.0\.0\.1 is an IP address|ovdb\.yaml: url 127\.0\.0\.1 is an IP address/],
    ['url without ovdb', (manifest) => { manifest.url = 'https://chinookdb.com/sales'; }, /ovdb\.yaml: url must have ovdb as a complete path segment or as a subdomain/],
    ['deployment.url ip', (manifest) => { manifest.deployment.url = 'https://169.254.169.254/latest'; }, /ovdb\.yaml: deployment\.url 169\.254\.169\.254 is an IP address/],
    ['deployment.url localhost', (manifest) => { manifest.deployment.url = 'https://localhost/ovdb/dbs/chinook'; }, /ovdb\.yaml: deployment\.url localhost is a single-label name/],
    ['deployment.url http', (manifest) => { manifest.deployment.url = 'http://cloud.openvaultdb.com/ovdb/dbs/chinook'; }, /ovdb\.yaml: deployment\.url must be https, not http/],
    ['deployment.url userinfo', (manifest) => { manifest.deployment.url = 'https://user:pw@cloud.openvaultdb.com/ovdb/dbs/chinook'; }, /ovdb\.yaml: deployment\.url must not contain credentials/],
    ['deployment.url query', (manifest) => { manifest.deployment.url = 'https://cloud.openvaultdb.com/ovdb/dbs/chinook?token=1'; }, /ovdb\.yaml: deployment\.url must not contain a query/],
    ['deployment.url fragment', (manifest) => { manifest.deployment.url = 'https://cloud.openvaultdb.com/ovdb/dbs/chinook#x'; }, /ovdb\.yaml: deployment\.url must not contain a fragment/],
    ['deployment.url internal', (manifest) => { manifest.deployment.url = 'https://metadata.google.internal/ovdb/x'; }, /ovdb\.yaml: deployment\.url metadata\.google\.internal is a local, internal or reserved name/],
    ['discovery', (manifest) => { manifest.deployment.discovery = 'https://10.0.0.5/.well-known/openvaultdb'; }, /ovdb\.yaml: deployment\.discovery 10\.0\.0\.5 is an IP address/],
    ['recordset_page ip', (manifest) => { manifest.deployment.recordset_page = 'https://127.0.0.1/{name}'; }, /ovdb\.yaml: deployment\.recordset_page 127\.0\.0\.1 is an IP address/],
    ['recordset_page ipv6', (manifest) => { manifest.deployment.recordset_page = 'https://[::1]/{name}'; }, /ovdb\.yaml: deployment\.recordset_page \[::1\] is an IP address/],
    ['recordset_page query', (manifest) => { manifest.deployment.recordset_page = 'https://cloud.openvaultdb.com/c?name={name}'; }, /ovdb\.yaml: deployment\.recordset_page must not contain a query/],
    ['publisher.url', (manifest) => { manifest.publisher.url = 'http://github.com/datatug'; }, /ovdb\.yaml: publisher\.url must be https, not http/],
  ];
  for (const [name, change, pattern] of cases) {
    const problems = await problemsOf(world(set(change)));
    assert.ok(problems.some((problem) => pattern.test(problem)), `${name}: expected ${pattern}, got:\n${problems.join('\n') || '(none)'}`);
  }
});

// ---- the git cache ----

const planted = (dir, marker) => {
  mkdirSync(dir, { recursive: true });
  gitIn(dir, 'init', '-q', '--bare');
  writeFileSync(join(dir, 'hooks', 'reference-transaction'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  chmodSync(join(dir, 'hooks', 'reference-transaction'), 0o755);
};
const fires = (dir, marker) => {
  // Positive control: with plain git a ref update in that repository runs the hook.
  const tree = gitIn(dir, 'mktree');
  const commit = gitIn(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit-tree', tree, '-m', 'x');
  gitIn(dir, 'update-ref', 'refs/heads/control', commit);
  const ran = existsSync(marker);
  rmSync(marker, { force: true });
  return ran;
};

test('a hook in a repository found in the cache never runs', async () => {
  const w = world();
  const marker = join(scratch, `hook-ran-${count++}`);
  const branch = 'main';
  const url = w.urlFor(chinookUrl);
  const history = join(w.cacheDir, 'history');
  const target = historyPath(history, url, branch);
  planted(target, marker);
  assert.equal(fires(target, marker), true, 'the planted hook does run with plain git, so the test means something');
  const { problems } = await checkDirectory({ ...options(w), cacheDir: w.cacheDir });
  assert.deepEqual(problems.filter((problem) => !problem.startsWith('index.json')), []);
  assert.equal(existsSync(marker), false, 'the planted hook did not run during the check');
});

test('a cached repository whose configuration is not one this module writes, or whose objects are damaged, is thrown away and fetched again', async () => {
  const w = world();
  const cache = fresh('cache');
  // openCommit fills the cache; damage a stored object and read again.
  const first = openCommit(w.publisher.url, w.publisher.commit, cache);
  assert.match(first.read('OVDB.md'), /ovdb: 1/);
  const repo = readdirSync(cache).map((name) => join(cache, name)).find((path) => existsSync(join(path, 'HEAD')));
  assert.ok(repo && cacheRepoSound(repo, { commit: w.publisher.commit }));
  const objects = [];
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).forEach((entry) => { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (!path.includes(`${join(repo, 'objects')}/info`)) objects.push(path); });
  walk(join(repo, 'objects'));
  for (const path of objects) { chmodSync(path, 0o644); writeFileSync(path, 'damaged'); }
  assert.equal(cacheRepoSound(repo, { commit: w.publisher.commit }), false, 'fsck sees the damage');
  assert.match(openCommit(w.publisher.url, w.publisher.commit, cache).read('OVDB.md'), /ovdb: 1/, 'fetched again');
  assert.ok(cacheRepoSound(repo, { commit: w.publisher.commit }));
  // A configuration this module never writes is refused outright.
  for (const line of ['[core]\n\thooksPath = /tmp/evil', '[core]\n\tfsmonitor = /tmp/evil', '[url "file:///tmp/evil"]\n\tinsteadOf = https://github.com/', '[include]\n\tpath = /tmp/evil', '[alias]\n\tx = !touch pwned', '[protocol]\n\tallow = always']) {
    const sound = fresh('repo');
    gitIn(sound, 'init', '-q', '--bare');
    assert.equal(cacheRepoSound(sound), true);
    writeFileSync(join(sound, 'config'), `${readFileSync(join(sound, 'config'), 'utf8')}${line}\n`);
    assert.equal(cacheRepoSound(sound), false, line);
  }
  const alternates = fresh('repo');
  gitIn(alternates, 'init', '-q', '--bare');
  writeFileSync(join(alternates, 'objects', 'info', 'alternates'), `${scratch}\n`);
  assert.equal(cacheRepoSound(alternates), false, 'alternates');
  // Replace refs, grafts, links below the directory, and a shallow file that is not the pinned commit's.
  const odd = (name, change) => {
    const dir = fresh('repo');
    gitIn(dir, 'init', '-q', '--bare');
    assert.equal(cacheRepoSound(dir), true, name);
    change(dir);
    assert.equal(cacheRepoSound(dir), false, name);
  };
  odd('a replace ref', (dir) => { mkdirSync(join(dir, 'refs', 'replace'), { recursive: true }); writeFileSync(join(dir, 'refs', 'replace', 'a'.repeat(40)), `${'b'.repeat(40)}\n`); });
  odd('a packed replace ref', (dir) => writeFileSync(join(dir, 'packed-refs'), `${'b'.repeat(40)} refs/replace/${'a'.repeat(40)}\n`));
  odd('grafts', (dir) => { mkdirSync(join(dir, 'info'), { recursive: true }); writeFileSync(join(dir, 'info', 'grafts'), `${'a'.repeat(40)} ${'b'.repeat(40)}\n`); });
  odd('a symbolic link below the directory', (dir) => symlinkSync(scratch, join(dir, 'refs', 'heads', 'link')));
  odd('a symbolic link as a subdirectory', (dir) => { rmSync(join(dir, 'hooks'), { recursive: true, force: true }); symlinkSync(scratch, join(dir, 'hooks')); });
  odd('a shallow file in a whole history clone', (dir) => writeFileSync(join(dir, 'shallow'), `${'a'.repeat(40)}\n`));
  const shallow = fresh('repo');
  gitIn(shallow, 'init', '-q', '--bare');
  writeFileSync(join(shallow, 'shallow'), `${'a'.repeat(40)}\n`);
  assert.equal(cacheRepoSound(shallow, { commit: 'a'.repeat(40) }), true, 'the shallow file a one-commit fetch writes');
  assert.equal(cacheRepoSound(shallow, { commit: 'b'.repeat(40) }), false, 'a shallow file naming another commit');
});

test('a replace ref in a cached repository cannot make one commit read as another', async () => {
  const w = world();
  const cache = fresh('cache');
  openCommit(w.publisher.url, w.publisher.commit, cache);
  const repo = readdirSync(cache).map((name) => join(cache, name)).find((path) => existsSync(join(path, 'HEAD')));
  // Plant a replace ref for the pinned commit pointing at another commit made in the same repository.
  const tree = gitIn(repo, 'mktree');
  const other = gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit-tree', tree, '-m', 'other');
  mkdirSync(join(repo, 'refs', 'replace'), { recursive: true });
  writeFileSync(join(repo, 'refs', 'replace', w.publisher.commit), `${other}\n`);
  // The repository is not sound, so it is replaced, and the pinned commit's own files are read.
  assert.match(openCommit(w.publisher.url, w.publisher.commit, cache).read('OVDB.md'), /ovdb: 1/);
  assert.equal(existsSync(join(repo, 'refs', 'replace', w.publisher.commit)), false);
});

test('two runs that start on a cold cache at the same time both succeed', async () => {
  const w = world();
  const cache = fresh('cache');
  const script = `import { setGitProtocols, onBranch, openCommit, defaultBranch } from ${JSON.stringify(new URL('./lib/git.mjs', import.meta.url).href)};
    setGitProtocols('https:file');
    const [url, commit, cache] = process.argv.slice(1);
    const branch = defaultBranch(url);
    if (!onBranch(url, branch, commit, cache + '/history')) throw new Error('not on the branch');
    const files = openCommit(url, commit, cache + '/repositories');
    if (!/ovdb: 1/.test(files.read('OVDB.md'))) throw new Error('wrong content');`;
  for (let round = 0; round < 3; round += 1) {
    const roundCache = join(cache, `round-${round}`);
    const results = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve) => {
      execFile(process.execPath, ['--input-type=module', '-e', script, w.publisher.url, w.publisher.commit, roundCache], (error, stdout, stderr) => resolve({ error, stderr }));
    })));
    for (const { error, stderr } of results) assert.equal(error, null, stderr);
  }
});

test('a .cache in the checkout is never read as the cache: the default cache is per user, outside it, and a cache inside the checkout is refused', async () => {
  const w = world();
  const marker = join(scratch, `checkout-hook-ran-${count++}`);
  const dir = historyPath(join(w.dir, '.cache', 'history'), w.urlFor(chinookUrl), 'main');
  planted(dir, marker);
  const home = fresh('xdg');
  chmodSync(home, 0o700);
  const saved = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = home;
  try {
    const { problems } = await checkDirectory({ ...options(w), cacheDir: undefined });
    assert.deepEqual(problems.filter((problem) => !problem.startsWith('index.json')), []);
    assert.equal(existsSync(marker), false);
    assert.ok(existsSync(join(home, 'ovdb-directory', 'history')), 'the cache went to the per-user directory');
    assert.equal(defaultCacheDir(), join(home, 'ovdb-directory'));
    assert.equal(statSync(join(home, 'ovdb-directory')).mode & 0o777, 0o700);
    chmodSync(join(home, 'ovdb-directory'), 0o777);
    assert.throws(() => defaultCacheDir(), /writable by others/);
    chmodSync(join(home, 'ovdb-directory'), 0o700);
    rmSync(join(home, 'ovdb-directory'), { recursive: true });
    symlinkSync(w.dir, join(home, 'ovdb-directory'));
    assert.throws(() => defaultCacheDir(), /not a directory/);
  } finally {
    if (saved === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = saved;
  }
  const { problems } = await checkDirectory({ ...options(w), cacheDir: join(w.dir, '.cache') });
  expectProblem(problems, /the git cache .* is inside the checkout .*; it must live outside it/);
});

// ---- what reaches index.json ----

const modelEdit = (change) => edited('model/chinook.modelspec.json', (text) => { const doc = JSON.parse(text); change(doc); return JSON.stringify(doc); });

test('a recordset url is built from names that cannot change what it points at: {name} only in the path, names are identifiers, every generated url is checked again', async () => {
  // The three ways a name used to change the host or path of the url.
  const cases = [
    ['https://169.254.169.{name}/latest/meta-data', '254', /\{name\} in the path only/],
    ['https://metadata.google.{name}/computeMetadata/v1', 'internal', /\{name\} in the path only/],
    ['https://cloud.openvaultdb.com/a/b/{name}/admin', '..', /entity name ".." must be an identifier/],
  ];
  for (const [template, entity, pattern] of cases) {
    const w = world({
      publisher: (files, context) => {
        manifestEdit((manifest) => { manifest.deployment.recordset_page = template; manifest.recordsets = manifest.recordsets.map((name) => (name === 'Genre' ? entity : name)); })(files, context);
        files.set('model/chinook.modelspec.json', files.get('model/chinook.modelspec.json').replaceAll('"Genre"', JSON.stringify(entity)));
      },
    });
    const problems = await problemsOf(w);
    expectProblem(problems, pattern);
    await assert.rejects(() => buildIndex(options(w)), /cannot build index\.json/);
  }
  // Names that are not identifiers never reach the index, whatever the template says.
  for (const name of ['<img src=x onerror=alert(1)>', 'a b', 'a/b', 'a.b', '1abc', '', 'caf\u00e9']) {
    const w = world({ publisher: modelEdit((doc) => { doc.entities[name] = doc.entities.Genre; }) });
    expectProblem(await problemsOf(w), /entity name .* must be an identifier/);
    const property = world({ publisher: modelEdit((doc) => { doc.entities.Genre.properties[name] = { type: 'string' }; }) });
    expectProblem(await problemsOf(property), /property name .* must be an identifier/);
  }
  expectProblem(await problemsOf(world({ publisher: modelEdit((doc) => { doc.entities.Genre.properties.Name.type = '<b>string</b>'; }) })), /has type "<b>string<\/b>", which is not a type name/);
  expectProblem(await problemsOf(world({ publisher: modelEdit((doc) => { doc.module.name = 'a-b'; }) })), /has no module\.name that is an identifier/);
  // The generated urls of the real template are exactly the ones the manifest's template gives.
  const [chinook] = (await index(world())).databases;
  assert.equal(chinook.recordsets.find((recordset) => recordset.name === 'Genre').url, 'https://cloud.openvaultdb.com/ovdb/dbs/chinook/collections/Genre');
});

test('values a publisher writes are checked before they are published: engine, licences, labels, roles', async () => {
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.deployment.engine = '<script>'; }) })), /ovdb\.yaml: deployment\.engine is required/);
  for (const key of ['data', 'model', 'meaning']) {
    expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.licences[key] = 'MIT <b>'; }) })), new RegExp(`ovdb\\.yaml: licences\\.${key} is required`));
  }
  const concept = (extra) => meaningEdit((doc) => { doc.concepts.push({ id: 'extra', kind: 'attribute', labels: { en: 'Extra' }, description: 'x', bindings: [{ model: 'modelspec:///chinook.Customer', property: 'Country', role: 'value' }], ...extra }); });
  expectProblem(await problemsOf(world({ publisher: concept({ labels: { en: { nested: 'x' } } }) })), /concept extra: the en label must be a plain string/);
  expectProblem(await problemsOf(world({ publisher: concept({ labels: { en: 'a <b>bold</b> label' } }) })), /concept extra: the en label must be a plain string/);
  expectProblem(await problemsOf(world({ publisher: concept({ labels: { en: 'x'.repeat(201) } }) })), /the en label must be a plain string of at most 200/);
  expectProblem(await problemsOf(world({ publisher: concept({ labels: 'Extra' }) })), /concept extra: labels must map language codes to labels/);
  expectProblem(await problemsOf(world({ publisher: concept({ bindings: [{ model: 'modelspec:///chinook.Customer', property: 'Country', role: 'anything goes <b>' }] }) })), /binding role "anything goes <b>" must be one of entity, identifier, display-name, foreign-key, value/);
  expectProblem(await problemsOf(world({ publisher: concept({ bindings: [{ model: 'modelspec:///chinook.Customer', property: 'Country' }] }) })), /binding role undefined must be one of/);
});

test('malformed meaning data is a problem, never an exception that ends the run', async () => {
  const concept = (extra) => meaningEdit((doc) => { doc.concepts.push({ id: 'extra', kind: 'attribute', labels: { en: 'Extra' }, description: 'x', ...extra }); });
  const cases = [
    [concept({ bindings: { model: 'modelspec:///chinook.Customer', role: 'entity' } }), /concept extra: bindings must be a list/],
    [concept({ bindings: 'modelspec:///chinook.Customer' }), /concept extra: bindings must be a list/],
    [concept({ bindings: [null] }), /concept extra: every binding must be a mapping/],
    [concept({ bindings: ['x'] }), /concept extra: every binding must be a mapping/],
    [concept({ bindings: [[1]] }), /concept extra: every binding must be a mapping/],
    [concept({ bindings: [{ model: 'modelspec:///chinook.Customer', property: ['Country'], role: 'value' }] }), /names property \["Country"\]/],
    [concept({ bindings: [{ model: 'modelspec:///chinook.Customer', property: { a: 1 }, role: 'value' }] }), /names property \{"a":1\}/],
    [concept({ extends: 5 }), /concept extra: extends must be a concept reference/],
    [concept({ 'values-of': { a: 1 } }), /concept extra: values-of must be a concept reference/],
    [concept({ labels: null }), /labels must map language codes to labels/],
    [concept({ labels: [] }), /labels must map language codes to labels/],
    [meaningEdit((doc) => { doc.concepts.push([1, 2]); }), /concept #\d+ has no id/],
    [meaningEdit((doc) => { doc.models = null; }), /models must name the ModelSpec module chinook/],
    [meaningEdit((doc) => { doc.models = { chinook: { a: 1 } }; }), /models must name the ModelSpec module chinook/],
    [meaningEdit((doc) => { doc.concepts = { a: 1 }; }), /has no concepts list/],
    [(files) => files.set('model/chinook.meaning.yaml', '[1, 2, 3]'), /has no concepts list/],
    [(files) => files.set('model/chinook.meaning.yaml', 'null'), /has no concepts list/],
    [(files) => files.set('model/chinook.meaning.yaml', '"just a string"'), /has no concepts list/],
  ];
  for (const [publisher, pattern] of cases) {
    let problems;
    try { problems = await problemsOf(world({ publisher })); } catch (error) { assert.fail(`threw ${error.stack}`); }
    expectProblem(problems, pattern);
  }
});

// ---- a database whose model and meaning graph are published in other repositories ----

const hosterUrl = 'https://github.com/acme/chinook-hosting';
const hosterFile = 'databases/$records/chinook-acme.yaml';
const modelAddr = 'modelspec://github.com/datatug/chinookdb/chinook';
const meaningOnlyUrl = 'https://github.com/acme/chinook-meaning';
const meaningOnlyAddress = 'meaning://github.com/acme/chinook-meaning';

const modelIndex = ({ commit, edit } = {}) => {
  const models = [{
    id: 'chinook', title: 'Chinook', status: 'draft', address: modelAddr, repository: chinookUrl, commit, module: 'chinook', licence: 'MIT',
    files: { source: 'model/chinook.modelspec.hcl', json: 'model/chinook.modelspec.json' }, maintainers: ['trakhimenok'],
  }];
  edit?.(models);
  const checksum = `sha256:${createHash('sha256').update(JSON.stringify(models)).digest('hex')}`;
  return indexModelRegistry({ format: 'modelspec-registry/draft-1', checksum, models }, 'the test ModelSpec registry');
};

const chinookEntities = Object.keys(JSON.parse(fixtureChinook.get('model/chinook.modelspec.json')).entities).sort();

// The hoster's manifest: no model files and no meaning file of its own, both pinned by address.
const hosterManifest = (w) => ({
  format: 'ovdb-manifest/draft-1',
  id: 'chinook-acme',
  title: 'Chinook at Acme',
  description: 'The Chinook sample database, hosted by Acme.',
  url: 'https://ovdb.acme.com/dbs/chinook',
  deployment: { url: 'https://cloud.acme.com/ovdb/dbs/chinook', engine: 'postgres', discovery: 'https://ovdb.acme.com/.well-known/openvaultdb', recordset_page: 'https://cloud.acme.com/ovdb/dbs/chinook/collections/{name}' },
  model: { address: `${modelAddr}?ref=${w.publisher.commit}` },
  meaning: { file: 'model/chinook.meaning.yaml', address: `${chinookAddress}?ref=${w.publisher.commit}`, graph: { id: 'chinook' } },
  publisher: { name: 'Acme', url: 'https://github.com/acme', repository: hosterUrl },
  licences: { data: 'ODbL-1.0' },
  recordsets: chinookEntities,
});

// The Chinook world of `world()` plus a second hoster of the same model, and the ModelSpec registry's index.
//   manifest(manifest, w): edits the hoster's manifest        hoster(files, w): edits the hoster's files
//   record(record, w):     edits the hoster's record           models(models):    edits the ModelSpec registry
//   meaningRepo(w):        puts the meaning graph in a repository of its own: { files, file }, registered as chinook-meaning
//   chinook:               options of world() (publisher, registry, publisherOptions, ...)
function sharedWorld({ manifest: editManifest, hoster: editHoster, record: editRecord, models, meaningRepo, chinook = {} } = {}) {
  const w = world(chinook);
  const manifest = hosterManifest(w);
  const record = {
    format: 'ovdb-directory/draft-1', title: 'Chinook at Acme', description: 'The Chinook sample database, hosted by Acme.', status: 'draft', url: manifest.url,
    repository: hosterUrl, commit: '', manifest: 'ovdb.yaml', meaning_graph: 'chinook', maintainers: ['trakhimenok'],
  };
  if (meaningRepo) {
    const { files, file } = meaningRepo(w);
    const meaningOrigin = origin(files, { name: 'meaning-only' });
    w.urls.set(meaningOnlyUrl, meaningOrigin.url);
    w.meaningRegistry = meaningIndex({
      chinook: w.publisher.commit,
      core: w.core.commit,
      edit: (graphs) => graphs.push({ id: 'chinook-meaning', title: 'Chinook meaning', kind: 'dataset', status: 'draft', address: meaningOnlyAddress, repository: meaningOnlyUrl, commit: meaningOrigin.commit, meaning_files: [file], maintainers: ['trakhimenok'] }),
    });
    manifest.meaning = { file, address: `${meaningOnlyAddress}?ref=${meaningOrigin.commit}`, graph: { id: 'chinook-meaning' } };
    record.meaning_graph = 'chinook-meaning';
  }
  editManifest?.(manifest, w);
  const files = new Map([['OVDB.md', '---\novdb: 1\npublish: [./ovdb.yaml]\n---\n'], ['ovdb.yaml', stringifyYaml(manifest)]]);
  editHoster?.(files, w);
  const hosterOrigin = origin(files, { name: 'hoster' });
  w.urls.set(hosterUrl, hosterOrigin.url);
  record.commit = hosterOrigin.commit;
  editRecord?.(record, w);
  writeFileSync(join(w.dir, hosterFile), stringifyYaml(record));
  w.modelRegistry = modelIndex({ commit: w.publisher.commit, edit: models });
  return { ...w, hoster: hosterOrigin };
}
const sharedOptions = (w, extra = {}) => options(w, { modelRegistry: w.modelRegistry, ...extra });
const sharedProblems = async (w, extra) => {
  const { problems } = await checkDirectory(sharedOptions(w, extra));
  return problems.filter((problem) => problem.startsWith(hosterFile));
};
const sharedIndex = async (w, extra) => JSON.parse(await buildIndex(sharedOptions(w, extra)));
const hosterManifestEdit = (change) => ({ manifest: change });
// Chinook's own manifest also names the model's address, as the real one does.
const chinookNamesModel = { publisher: manifestEdit((manifest) => { manifest.model.address = modelAddr; }) };

test('a second hoster of Chinook points at the published model and meaning graph and is listed under the same model', async () => {
  const w = sharedWorld({ chinook: chinookNamesModel });
  writeFileSync(join(w.dir, 'index.json'), await buildIndex(sharedOptions(w)));
  const checkedResult = await checkDirectory(sharedOptions(w));
  assert.deepEqual(checkedResult.problems, []);
  assert.deepEqual(checkedResult.warnings, []);
  assert.equal(checkedResult.databases, 2);
  const result = await sharedIndex(w);
  assert.deepEqual(result.databases.map((database) => database.id), ['chinook', 'chinook-acme']);
  const [chinook, acme] = result.databases;
  // Both are databases of the same model: the same normalised address, without a pin.
  assert.equal(chinook.model.address, modelAddr);
  assert.equal(acme.model.address, modelAddr);
  // Chinook's model is in its own repository: no repository or commit. The hoster's model is elsewhere, at its pin.
  assert.deepEqual(chinook.model, { name: 'chinook', path: 'model/chinook.modelspec.hcl', address: modelAddr });
  assert.deepEqual(acme.model, { name: 'chinook', path: 'model/chinook.modelspec.hcl', address: modelAddr, repository: chinookUrl, commit: w.publisher.commit });
  // The hoster's own facts are its own.
  assert.equal(acme.url, 'https://ovdb.acme.com/dbs/chinook');
  assert.equal(acme.repository, hosterUrl);
  assert.equal(acme.commit, w.hoster.commit);
  assert.equal(acme.licence, 'ODbL-1.0', 'licences.data of the hoster, not the model licence');
  assert.deepEqual(acme.deployment, { url: 'https://cloud.acme.com/ovdb/dbs/chinook', engine: 'postgres' });
  assert.equal(acme.recordsets.find((recordset) => recordset.name === 'Track').url, 'https://cloud.acme.com/ovdb/dbs/chinook/collections/Track');
  // Fields and meanings are the model's and the meaning graph's, whoever hosts: the same as Chinook's, pin for pin.
  assert.deepEqual(acme.meaning_graph, chinook.meaning_graph);
  assert.deepEqual(acme.recordsets.map((recordset) => recordset.name), chinook.recordsets.map((recordset) => recordset.name));
  for (const [theirs, ours] of chinook.recordsets.map((recordset, position) => [recordset, acme.recordsets[position]])) {
    assert.deepEqual(ours.meanings, theirs.meanings, `${theirs.name} meanings`);
    assert.deepEqual(ours.fields, theirs.fields, `${theirs.name} fields`);
  }
  assert.equal(field(acme, 'Customer', 'Country').meanings[0].address, `${chinookAddress}/customer-country?ref=${w.publisher.commit}`, 'a meaning address carries the pinned commit of the graph repository');
  assert.equal(field(acme, 'Customer', 'Country').meanings[0].values_of.address, `${coreAddress}/country?ref=${w.corePin}`);
});

test('the ModelSpec registry is read only when a database names its model by address', async () => {
  let loads = 0;
  const loaderFor = (commit) => async () => { loads += 1; return modelIndex({ commit }); };
  const plain = world();
  assert.equal((await index(plain, { loadModelRegistry: loaderFor(plain.publisher.commit) })).databases.length, 1);
  assert.equal(loads, 0, 'a directory of own-model databases that name no address never reads it');
  const naming = world(chinookNamesModel);
  assert.equal((await index(naming, { loadModelRegistry: loaderFor(naming.publisher.commit) })).databases.length, 1);
  assert.equal(loads, 1, 'an own model that names its address reads it, to compare the model with the registered one');
  loads = 0;
  const shared = sharedWorld();
  assert.equal((await sharedIndex(shared, { modelRegistry: undefined, loadModelRegistry: loaderFor(shared.publisher.commit) })).databases.length, 2);
  assert.equal(loads, 1);
});

test('a pin that differs from the one a registry registers is a warning, not a problem, and the pinned commit is the one read', async () => {
  const w = sharedWorld({
    chinook: chinookNamesModel,
    manifest: (manifest, world_) => {
      const newer = world_.publisher.more(new Map([['NOTES.txt', 'newer than the registries\n']]));
      manifest.model.address = `${modelAddr}?ref=${newer}`;
      manifest.meaning.address = `${chinookAddress}?ref=${newer}`;
      world_.newer = newer;
    },
  });
  const warned = [];
  const { problems, warnings } = await checkDirectory(sharedOptions(w));
  assert.deepEqual(problems.filter((problem) => !problem.startsWith('index.json')), []);
  assert.equal(warnings.length, 2);
  expectProblem(warnings, new RegExp(`^${hosterFile.replace('$', '\\$')}: model\\.address pins [0-9a-f]{40}, but the ModelSpec registry registers ${modelAddr.replaceAll('/', '\\/')} at ${w.publisher.commit}; the pinned commit is read`));
  expectProblem(warnings, new RegExp(`meaning\\.address pins [0-9a-f]{40}, but the MeaningGraph registry registers chinook at ${w.publisher.commit}`));
  const result = JSON.parse(await buildIndex(sharedOptions(w, { onWarning: (warning) => warned.push(warning) })));
  assert.equal(warned.length, 2);
  const acme = result.databases.find((database) => database.id === 'chinook-acme');
  assert.notEqual(acme.model.commit, w.publisher.commit);
  assert.ok(field(acme, 'Customer', 'Country').meanings[0].address.endsWith(`?ref=${acme.model.commit}`), 'meaning addresses carry the pinned commit of the graph repository');
});

test('a shared model\'s address must be registered in the ModelSpec registry, in the written form, and pinned', async () => {
  expectProblem(await sharedProblems(sharedWorld({ models: (models) => models.splice(0, 1) })), new RegExp(`${hosterFile.replace('$', '\\$')}: ovdb\\.yaml: model\\.address ${modelAddr.replaceAll('/', '\\/')} is not registered in the ModelSpec registry \\(the test ModelSpec registry\\)`));
  // The module is case-sensitive: another case is another module, which is not registered.
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest, w) => { manifest.model.address = `modelspec://github.com/datatug/chinookdb/Chinook?ref=${w.publisher.commit}`; }))), /model\.address modelspec:\/\/github\.com\/datatug\/chinookdb\/Chinook is not registered/);
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest, w) => { manifest.model.address = `modelspec://github.com/datatug/chinookdb/other?ref=${w.publisher.commit}`; }))), /model\.address modelspec:\/\/github\.com\/datatug\/chinookdb\/other is not registered/);
  // The repository part is written in lower case.
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest, w) => { manifest.model.address = `modelspec://github.com/DataTug/ChinookDB/chinook?ref=${w.publisher.commit}`; }))), /model\.address .* must be written in lower case \(host, organisation and repository; the module name is case-sensitive\)/);
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest, w) => { manifest.model.address = `modelspec://evil.example/datatug/chinookdb/chinook?ref=${w.publisher.commit}`; }))), /model\.address .* must name a repository on github\.com/);
  // The pin is required, and is a full commit id.
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest) => { manifest.model.address = modelAddr; }))), /ovdb\.yaml: model\.address must carry \?ref=<40 hex> when the model is in another repository/);
  for (const ref of ['main', 'abc123', 'A'.repeat(40)]) {
    expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest) => { manifest.model.address = `${modelAddr}?ref=${ref}`; }))), /model\.address must be modelspec:\/\/\{host\}\/\{org\}\/\{repo\}\/\{module\}\?ref=<40 hex>/);
  }
  // A commit that does not exist is not in the history of the default branch.
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest) => { manifest.model.address = `${modelAddr}?ref=${'0'.repeat(40)}`; }))), /model\.address pins commit 0{40}, which is not in the history of main, the default branch of https:\/\/github\.com\/datatug\/chinookdb/);
  // The registry's own record has to be well formed.
  expectProblem(await sharedProblems(sharedWorld({ models: (models) => { models[0].repository = 'https://github.com/someone/else'; } })), /the ModelSpec registry's record for modelspec:\/\/github\.com\/datatug\/chinookdb\/chinook is not well formed/);
  expectProblem(await sharedProblems(sharedWorld({ models: (models) => { models[0].files.source = 'model/chinook.modelspec.json'; } })), /is not well formed \(files\.source must be a \.modelspec\.hcl path/);
});

test('a shared meaning graph must be registered in the MeaningGraph registry, under the record\'s graph id, and pinned', async () => {
  expectProblem(await sharedProblems(sharedWorld({ chinook: { registry: (graphs) => graphs.splice(0, 1) } })), /ovdb\.yaml: meaning\.address meaning:\/\/github\.com\/datatug\/chinookdb is not registered in the MeaningGraph registry \(the test registry\)/);
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest, w) => { manifest.meaning.address = `meaning://github.com/nobody/graph?ref=${w.publisher.commit}`; }))), /meaning\.address meaning:\/\/github\.com\/nobody\/graph is not registered/);
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest, w) => { manifest.meaning.address = `meaning://github.com/DataTug/ChinookDB?ref=${w.publisher.commit}`; }))), /meaning\.address .* must be written in lower case/);
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest) => { manifest.meaning.address = chinookAddress; }))), /ovdb\.yaml: meaning\.address must carry \?ref=<40 hex>/);
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest) => { manifest.meaning.address = `${chinookAddress}?ref=main`; }))), /meaning\.address must be meaning:\/\/\{host\}\/\{org\}\/\{repo\}\?ref=<40 hex>/);
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest) => { manifest.meaning.address = `${chinookAddress}?ref=${'0'.repeat(40)}`; }))), /meaning\.address pins commit 0{40}, which is not in the history of main, the default branch of https:\/\/github\.com\/datatug\/chinookdb/);
  // The record's graph id is the registry's id for the address.
  expectProblem(await sharedProblems(sharedWorld({ record: (record) => { record.meaning_graph = 'core'; }, manifest: (manifest) => { manifest.meaning.graph.id = 'core'; } })), /meaning\.address names meaning:\/\/github\.com\/datatug\/chinookdb, which the MeaningGraph registry registers as chinook, but the record's meaning_graph is core/);
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest) => { manifest.meaning.graph.id = 'core'; }))), /ovdb\.yaml: meaning\.graph\.id is core, but the record's meaning_graph is chinook/);
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest) => { manifest.meaning.graph.address = 'meaning://github.com/datatug/other'; }))), /meaning\.graph\.address is meaning:\/\/github\.com\/datatug\/other, but meaning\.address names meaning:\/\/github\.com\/datatug\/chinookdb/);
  // meaning.file is one the registry lists for the graph; and it is required.
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest) => { manifest.meaning.file = 'model/other.meaning.yaml'; }))), /meaning\.file model\/other\.meaning\.yaml is not one of the meaning files the MeaningGraph registry lists for chinook/);
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest) => { delete manifest.meaning.file; }))), /ovdb\.yaml: meaning\.file \(the file of the graph, in the graph's repository, that binds the model\) is required/);
  expectProblem(await sharedProblems(sharedWorld({ chinook: { registry: (graphs) => { graphs[0].meaning_files = ['other.meaning.yaml']; } } })), /meaning\.file model\/chinook\.meaning\.yaml is not one of the meaning files/);
});

test('a pinned commit that is only on a side branch is refused for the model and for the meaning graph, though the host would serve it', async () => {
  const chinook = { publisherOptions: { side: new Map([['extra.txt', 'only on a side branch\n']]) } };
  const modelSide = sharedWorld({ chinook, manifest: (manifest, w) => { manifest.model.address = `${modelAddr}?ref=${w.publisher.sideCommit}`; } });
  assert.doesNotThrow(() => openCommit(modelSide.publisher.url, modelSide.publisher.sideCommit, modelSide.cacheDir));
  const refused = await sharedProblems(modelSide);
  expectProblem(refused, /ovdb\.yaml: model\.address pins commit [0-9a-f]{40}, which is not in the history of main, the default branch of https:\/\/github\.com\/datatug\/chinookdb \(a commit only a fork or another branch has\)/);
  assert.ok(!refused.some((problem) => /meaning\.address pins/.test(problem)), 'only the model pin is off the branch');
  expectProblem(await sharedProblems(sharedWorld({ chinook, manifest: (manifest, w) => { manifest.meaning.address = `${chinookAddress}?ref=${w.publisher.sideCommit}`; } })), /ovdb\.yaml: meaning\.address pins commit [0-9a-f]{40}, which is not in the history of main/);
  await assert.rejects(() => buildIndex(sharedOptions(modelSide)), /cannot build index\.json/);
});

test('the two forms do not mix: local model files with a foreign address, a shared model with a local meaning file, and the keys of the other form', async () => {
  // Own model files and an address in another repository (pinned or not).
  const foreign = 'modelspec://github.com/acme/other/chinook';
  for (const address of [foreign, `${foreign}?ref=${'a'.repeat(40)}`]) {
    const problems = await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.model.address = address; }) }));
    expectProblem(problems, /model\.address names github\.com\/acme\/other, but the model's files are in github\.com\/datatug\/chinookdb; a manifest with its own model files addresses its own repository\. To use a model published in another repository, remove the local model files and the local meaning file and pin model\.address and meaning\.address instead/);
  }
  // Own model files with a pinned meaning address: the meaning is local too.
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.meaning.address = `${chinookAddress}?ref=${'a'.repeat(40)}`; }) })), /ovdb\.yaml: meaning\.address is only for a shared model/);
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.recordsets_partial = true; }) })), /ovdb\.yaml: recordsets_partial is only for a shared model/);
  // A shared model whose meaning file is local (no meaning.address), or that has only model.address, or none of the two.
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest) => { delete manifest.meaning.address; }))), /ovdb\.yaml: meaning\.address is required when model\.address names a model in another repository/);
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest) => { delete manifest.model; }))), /ovdb\.yaml: model must name the model by local files \(model\.modelspec\) or, for a model published in another repository, by model\.address with \?ref=<40 hex>/);
  // Naming this very repository by pin is not a shared model.
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest, w) => { manifest.model.address = `modelspec://github.com/acme/chinook-hosting/chinook?ref=${w.publisher.commit}`; }))), /model\.address .* names this repository; a model or meaning file in the publisher's own repository is named by local files/);
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest, w) => { manifest.meaning.address = `meaning://github.com/acme/chinook-hosting?ref=${w.publisher.commit}`; }))), /meaning\.address .* names this repository/);
  // Licences: the model's and the meaning's come from the registries; a repeated value must agree.
  const licensed = await sharedIndex(sharedWorld(hosterManifestEdit((manifest) => { manifest.licences.model = 'MIT'; })));
  assert.equal(licensed.databases.length, 2);
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest) => { manifest.licences.model = 'Apache-2.0'; }))), /licences\.model is Apache-2\.0, but the ModelSpec registry records "MIT" for modelspec:\/\/github\.com\/datatug\/chinookdb\/chinook/);
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest) => { manifest.licences.meaning = 'CC0-1.0'; }))), /licences\.meaning is CC0-1\.0, but the MeaningGraph registry records undefined for chinook/);
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest) => { delete manifest.licences.data; }))), /ovdb\.yaml: licences\.data is required/);
});

test('a shared model is read at its pin: the registered module, the model file, the models entry of the meaning file and its bindings must agree', async () => {
  // The model file at the pin is another module than the registry registers.
  const json = JSON.parse(fixtureChinook.get('model/chinook.modelspec.json'));
  json.module.name = 'other';
  expectProblem(await sharedProblems(sharedWorld({ chinook: { publisher: (files) => files.set('model/chinook.modelspec.json', JSON.stringify(json)) } })), /model\/chinook\.modelspec\.json of github\.com\/datatug\/chinookdb is module other, but the ModelSpec registry registers modelspec:\/\/github\.com\/datatug\/chinookdb\/chinook as module chinook/);
  expectProblem(await sharedProblems(sharedWorld({ chinook: { publisher: (files) => files.set('model/chinook.modelspec.json', '{') } })), /model\/chinook\.modelspec\.json of github\.com\/datatug\/chinookdb: is not JSON/);
  expectProblem(await sharedProblems(sharedWorld({ chinook: { publisher: (files) => files.delete('model/chinook.modelspec.json') } })), /the registered model model\/chinook\.modelspec\.json does not exist at commit/);
  expectProblem(await sharedProblems(sharedWorld({ chinook: { publisher: (files) => files.delete('model/chinook.modelspec.hcl') } })), /the model source model\/chinook\.modelspec\.hcl of github\.com\/datatug\/chinookdb does not exist at commit/);
  expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest) => { manifest.model.name = 'other'; }))), /model\.name is other, but the ModelSpec at model\/chinook\.modelspec\.json of github\.com\/datatug\/chinookdb is module chinook/);
  // The meaning file does not say which model it binds, or says another one.
  expectProblem(await sharedProblems(sharedWorld({ chinook: { publisher: meaningEdit((doc) => { delete doc.models; }) } })), /models must name the ModelSpec module chinook with a relative path that stays inside the repository .* or with its modelspec:\/\/ address, got undefined/);
  expectProblem(await sharedProblems(sharedWorld({ chinook: { publisher: meaningEdit((doc) => { doc.models.chinook = 'chinook.modelspec.json'; }) } })), /the chinook model model\/chinook\.modelspec\.json must be a \.modelspec\.hcl file/);
  // Same repository, but the path is not the source the registry lists.
  const other = sharedWorld({
    chinook: { publisher: (files) => { files.set('model/other.modelspec.hcl', files.get('model/chinook.modelspec.hcl')); meaningEdit((doc) => { doc.models.chinook = 'other.modelspec.hcl'; })(files); } },
  });
  expectProblem(await sharedProblems(other), /model\/chinook\.meaning\.yaml: the chinook model is model\/other\.modelspec\.hcl, but the ModelSpec registry lists model\/chinook\.modelspec\.hcl as the source of modelspec:\/\/github\.com\/datatug\/chinookdb\/chinook/);
  // Bindings: the shared model's module; no other model (a binding that spells out the model's address is for a meaning graph in another repository, below).
  const binding = (model, property, role = 'value') => ({ chinook: { publisher: meaningEdit((doc) => { doc.concepts.push({ id: 'extra', kind: 'attribute', labels: { en: 'Extra' }, description: 'x', bindings: [{ model, ...(property ? { property } : {}), role }] }); }) } });
  expectProblem(await sharedProblems(sharedWorld(binding('modelspec:///other.Customer', 'Country'))), /names module other, but the ModelSpec at model\/chinook\.modelspec\.json of github\.com\/datatug\/chinookdb is module chinook/);
  expectProblem(await sharedProblems(sharedWorld(binding('modelspec://github.com/x/y/chinook.Customer', 'Country'))), /binding modelspec:\/\/github\.com\/x\/y\/chinook\.Customer names a model other than the shared model modelspec:\/\/github\.com\/datatug\/chinookdb\/chinook/);
  expectProblem(await sharedProblems(sharedWorld(binding(`modelspec://github.com/datatug/chinookdb/chinook.Customer?ref=${'b'.repeat(40)}`, 'Country'))), /names a model other than the shared model/);
  expectProblem(await sharedProblems(sharedWorld(binding('modelspec:///chinook.Ghost', undefined, 'entity'))), /binding modelspec:\/\/\/chinook\.Ghost names an entity that is not in the ModelSpec/);
  expectProblem(await sharedProblems(sharedWorld(binding('modelspec:///chinook.Customer', 'Nope'))), /names property "Nope", which Customer does not have in the ModelSpec/);
});

test('a shared model\'s recordsets are exactly its entities, unless the manifest lists a subset and says recordsets_partial: true', async () => {
  const listing = (names, partial) => hosterManifestEdit((manifest) => { manifest.recordsets = names; if (partial !== undefined) manifest.recordsets_partial = partial; });
  expectProblem(await sharedProblems(sharedWorld(listing(chinookEntities.filter((name) => name !== 'Genre')))), /ovdb\.yaml: recordsets lacks ModelSpec entities: Genre \(to list a subset of a shared model, list it explicitly and set recordsets_partial: true\)/);
  expectProblem(await sharedProblems(sharedWorld(listing([...chinookEntities, 'Ghost']))), /ovdb\.yaml: recordsets names things that are not ModelSpec entities: Ghost/);
  expectProblem(await sharedProblems(sharedWorld(listing([...chinookEntities, 'Genre']))), /ovdb\.yaml: recordsets lists a name twice/);
  expectProblem(await sharedProblems(sharedWorld(listing(['Artist', 'Ghost'], true))), /recordsets names things that are not ModelSpec entities: Ghost/);
  expectProblem(await sharedProblems(sharedWorld(listing(chinookEntities, true))), /recordsets_partial is true, but recordsets lists every ModelSpec entity; remove recordsets_partial/);
  expectProblem(await sharedProblems(sharedWorld(listing(['Album'], true))), /recordsets lists Album, which references Artist, but a partial list must also list every entity a listed entity references/);
  expectProblem(await sharedProblems(sharedWorld(listing(['Artist'], 'yes'))), /recordsets_partial must be true or false/);
  expectProblem(await sharedProblems(sharedWorld(listing([], true))), /recordsets must be a non-empty list of names/);
  // recordsets_partial: false is the same as leaving it out.
  assert.deepEqual(await sharedProblems(sharedWorld(listing(chinookEntities, false))), []);
  // A partial list publishes only what it names; the bindings of the entities it leaves out are not an error.
  const partial = sharedWorld(listing(['Artist', 'Album'], true));
  assert.deepEqual(await sharedProblems(partial), []);
  const [chinook, acme] = (await sharedIndex(partial)).databases;
  assert.deepEqual(acme.recordsets.map((recordset) => recordset.name), ['Album', 'Artist']);
  assert.equal(acme.recordsets.find((recordset) => recordset.name === 'Album').url, 'https://cloud.acme.com/ovdb/dbs/chinook/collections/Album');
  const album = (database) => database.recordsets.find((recordset) => recordset.name === 'Album');
  assert.deepEqual({ ...album(acme), url: undefined }, { ...album(chinook), url: undefined }, 'a listed recordset is the model\'s, with the meanings of the graph');
  assert.equal(chinook.recordsets.length, 11, 'the other database lists every entity');
  assert.equal(acme.model.address, modelAddr);
});

test('a meaning graph in another repository than the model must say which model it binds, by address', async () => {
  const meaningText = (declared) => fixtureChinook.get('model/chinook.meaning.yaml').replaceAll(fixtureCorePin, 'PIN').replace('chinook: chinook.modelspec.hcl', `chinook: ${declared}`);
  const separate = (declared) => ({ meaningRepo: (w) => ({ files: new Map([['chinook.meaning.yaml', meaningText(declared).replaceAll('PIN', w.corePin)]]), file: 'chinook.meaning.yaml' }) });
  // A relative path can only name a file of the meaning graph's own repository: it does not say which model is bound.
  const ambiguous = await sharedProblems(sharedWorld(separate('chinook.modelspec.hcl')));
  expectProblem(ambiguous, /chinook\.meaning\.yaml: the meaning graph is in github\.com\/acme\/chinook-meaning and the model modelspec:\/\/github\.com\/datatug\/chinookdb\/chinook in github\.com\/datatug\/chinookdb, and the models entry for module chinook is the relative path chinook\.modelspec\.hcl, which can only name a file of the meaning graph's own repository; the meaning file does not say which model it binds\. Name the model in the meaning file by address/);
  await assert.rejects(() => buildIndex(sharedOptions(sharedWorld(separate('chinook.modelspec.hcl')))), /cannot build index\.json[\s\S]*does not say which model it binds/);
  // By address it does, and the database is listed under the shared model with the graph's own pin.
  const named = sharedWorld(separate(modelAddr));
  assert.deepEqual(await sharedProblems(named), []);
  const [chinook, acme] = (await sharedIndex(named)).databases;
  assert.equal(chinook.model.address, undefined, 'the fixture manifest of Chinook names no address; the hoster\'s is the normalised one');
  assert.deepEqual(acme.model, { name: 'chinook', path: 'model/chinook.modelspec.hcl', address: modelAddr, repository: chinookUrl, commit: named.publisher.commit });
  assert.deepEqual(acme.meaning_graph, { id: 'chinook-meaning', address: meaningOnlyAddress });
  const meaningPin = named.meaningRegistry.byId.get('chinook-meaning').commit;
  assert.equal(field(acme, 'Customer', 'Country').meanings[0].address, `${meaningOnlyAddress}/customer-country?ref=${meaningPin}`);
  assert.deepEqual(acme.recordsets.map((recordset) => recordset.name), chinookEntities);
  // A pin on the address is fine when it is the manifest's pin; another model, another pin, or no address at all is not.
  expectProblem(await sharedProblems(sharedWorld(separate('modelspec://github.com/acme/other/chinook'))), /the models entry for module chinook names modelspec:\/\/github\.com\/acme\/other\/chinook, but ovdb\.yaml pins the model modelspec:\/\/github\.com\/datatug\/chinookdb\/chinook/);
  expectProblem(await sharedProblems(sharedWorld(separate('modelspec://github.com/datatug/chinookdb/other'))), /the models entry for module chinook names modelspec:\/\/github\.com\/datatug\/chinookdb\/other, but ovdb\.yaml pins/);
  expectProblem(await sharedProblems(sharedWorld(separate(`${modelAddr}?ref=${'c'.repeat(40)}`))), /the models entry for module chinook pins commit c{40}, but ovdb\.yaml pins [0-9a-f]{40}/);
  expectProblem(await sharedProblems(sharedWorld(separate('modelspec://not-an-address'))), /the models entry "modelspec:\/\/not-an-address" for module chinook is not a modelspec:\/\/\{host\}\/\{org\}\/\{repo\}\/\{module\} address/);
  expectProblem(await sharedProblems(sharedWorld(separate('chinook.modelspec.json'))), /the chinook model chinook\.modelspec\.json must be a \.modelspec\.hcl file/);
  // Bindings may spell out the shared model's address, with the manifest's pin or without one, but not another model or pin.
  const binds = (spelling) => sharedWorld({
    meaningRepo: (w) => {
      const doc = parseYaml(meaningText(modelAddr).replaceAll('PIN', w.corePin));
      doc.concepts.push({ id: 'extra', kind: 'attribute', labels: { en: 'Extra' }, description: 'x', bindings: [{ model: spelling(w), property: 'State', role: 'value' }] });
      return { files: new Map([['chinook.meaning.yaml', stringifyYaml(doc)]]), file: 'chinook.meaning.yaml' };
    },
  });
  for (const spelling of [() => 'modelspec://github.com/datatug/chinookdb/chinook.Customer', (w) => `modelspec://github.com/datatug/chinookdb/chinook.Customer?ref=${w.publisher.commit}`]) {
    const bound = binds(spelling);
    assert.deepEqual(await sharedProblems(bound), []);
    assert.deepEqual(field((await sharedIndex(bound)).databases[1], 'Customer', 'State').meanings.map((meaning) => meaning.concept), ['extra']);
  }
  expectProblem(await sharedProblems(binds(() => 'modelspec://github.com/datatug/other/chinook.Customer')), /names a model other than the shared model/);
  expectProblem(await sharedProblems(binds(() => `modelspec://github.com/datatug/chinookdb/chinook.Customer?ref=${'d'.repeat(40)}`)), /names a model other than the shared model/);
  // The pin of the same address that the manifest gives is accepted.
  const samePin = sharedWorld({ ...separate(modelAddr), meaningRepo: (w) => ({ files: new Map([['chinook.meaning.yaml', meaningText(`${modelAddr}?ref=${w.publisher.commit}`).replaceAll('PIN', w.corePin)]]), file: 'chinook.meaning.yaml' }) });
  assert.deepEqual(await sharedProblems(samePin), []);
});

test('the ModelSpec registry index must be readable, in its format, match its checksum and register an address once, or the build fails loudly', async () => {
  const ok = (body, status = 200) => async () => ({ ok: status === 200, status, text: async () => body });
  const url = 'https://example.test/models.json';
  await assert.rejects(() => loadModelRegistry({ url, fetchImpl: ok('', 404) }), /cannot read https:\/\/example\.test\/models\.json: HTTP 404/);
  await assert.rejects(() => loadModelRegistry({ url, fetchImpl: async () => { throw new Error('offline'); } }), /cannot read https:\/\/example\.test\/models\.json: offline/);
  await assert.rejects(() => loadModelRegistry({ url, fetchImpl: ok('not json') }), /is not JSON/);
  await assert.rejects(() => loadModelRegistry({ url, fetchImpl: ok(JSON.stringify({ format: 'modelspec-registry/draft-1', checksum: 'sha256:00', models: [] })) }), /does not match its own checksum/);
  await assert.rejects(() => loadModelRegistry({ url, fetchImpl: ok(JSON.stringify({ format: 'meaning-registry/draft-1', models: [] })) }), /expected modelspec-registry\/draft-1/);
  await assert.rejects(() => loadModelRegistry({ url, fetchImpl: ok(JSON.stringify({ format: 'modelspec-registry/draft-1', checksum: 'x' })) }), /has no models list/);
  const twice = [{ address: modelAddr }, { address: modelAddr }];
  const checksum = (models) => `sha256:${createHash('sha256').update(JSON.stringify(models)).digest('hex')}`;
  await assert.rejects(() => loadModelRegistry({ url, fetchImpl: ok(JSON.stringify({ format: 'modelspec-registry/draft-1', checksum: checksum(twice), models: twice })) }), new RegExp(`registers ${modelAddr.replaceAll('/', '\\/')} twice`));
  const good = [{ address: modelAddr, module: 'chinook' }];
  assert.equal((await loadModelRegistry({ url, fetchImpl: ok(JSON.stringify({ format: 'modelspec-registry/draft-1', checksum: checksum(good), models: good })) })).byAddress.size, 1);
  // The URL is MODELSPEC_REGISTRY_INDEX_URL, else the default branch of modelspec-org/registry.
  const seen = [];
  const spy = async (requested) => { seen.push(requested); return { ok: true, status: 200, text: async () => JSON.stringify({ format: 'modelspec-registry/draft-1', checksum: checksum([]), models: [] }) }; };
  const saved = process.env.MODELSPEC_REGISTRY_INDEX_URL;
  try {
    delete process.env.MODELSPEC_REGISTRY_INDEX_URL;
    await loadModelRegistry({ fetchImpl: spy });
    process.env.MODELSPEC_REGISTRY_INDEX_URL = 'https://example.test/other-index.json';
    await loadModelRegistry({ fetchImpl: spy });
  } finally {
    if (saved === undefined) delete process.env.MODELSPEC_REGISTRY_INDEX_URL; else process.env.MODELSPEC_REGISTRY_INDEX_URL = saved;
  }
  assert.deepEqual(seen, [modelRegistryDefaultUrl, 'https://example.test/other-index.json']);
  assert.equal(modelRegistryDefaultUrl, 'https://raw.githubusercontent.com/modelspec-org/registry/main/index.json');
  // An unreadable registry is a problem of the database that needs it, never a fallback; databases of their own model are unaffected.
  const w = sharedWorld();
  const failing = async () => { throw new Error('cannot read https://example.test/models.json: HTTP 503'); };
  const { problems } = await checkDirectory(options(w, { loadModelRegistry: failing }));
  expectProblem(problems, new RegExp(`^${hosterFile.replace('$', '\\$')}: ModelSpec registry: cannot read https://example\\.test/models\\.json: HTTP 503`));
  assert.ok(!problems.some((problem) => problem.startsWith('databases/$records/chinook.yaml')));
  await assert.rejects(() => buildIndex(options(w, { loadModelRegistry: failing })), /cannot build index\.json:\n  databases\/\$records\/chinook-acme\.yaml: ModelSpec registry: cannot read/);
});

test('a shared-model database refuses the shapes that a shared form cannot have, before anything is fetched', async () => {
  const none = { loadModelRegistry: async () => { throw new Error('must not be read'); } };
  for (const [change, pattern] of [
    [(manifest) => { manifest.model.address = 42; }, /model\.address must be modelspec:\/\/\{host\}\/\{org\}\/\{repo\}\/\{module\}\?ref=<40 hex>/],
    [(manifest) => { manifest.meaning.address = ['x']; }, /meaning\.address must be meaning:\/\/\{host\}\/\{org\}\/\{repo\}\?ref=<40 hex>/],
    [(manifest) => { manifest.meaning.file = '../x.meaning.yaml'; }, /meaning\.file .* is required/],
    [(manifest) => { delete manifest.meaning.graph; }, /meaning\.graph\.id is required/],
    [(manifest) => { manifest.licences.model = 'not a licence!'; }, /licences\.model, when given, must be an SPDX-shaped licence id/],
  ]) {
    const problems = await sharedProblems(sharedWorld(hosterManifestEdit(change)), none);
    expectProblem(problems, pattern);
  }
});

// ---- shared-model follow-ups ----

test('a malformed meaning_files in a MeaningGraph registry record is a problem, never an exception: own form, shared form, and a graph that is only read', async () => {
  const notWellFormed = /the MeaningGraph registry's record for chinook is not well formed \(meaning_files must be a list of file paths\)/;
  for (const malformed of ['model/chinook.meaning.yaml', {}, [42], [null], [['x']], 7, true, null]) {
    const label = JSON.stringify(malformed);
    let problems;
    try { problems = await problemsOf(world({ registry: (graphs) => { graphs[0].meaning_files = malformed; } })); } catch (error) { assert.fail(`own form, ${label}: threw ${error.stack}`); }
    assert.ok(problems.some((problem) => notWellFormed.test(problem)), `own form, ${label}: ${problems.join('\n')}`);
    try { problems = await sharedProblems(sharedWorld({ chinook: { registry: (graphs) => { graphs[0].meaning_files = malformed; } } })); } catch (error) { assert.fail(`shared form, ${label}: threw ${error.stack}`); }
    assert.ok(problems.some((problem) => notWellFormed.test(problem)), `shared form, ${label}: ${problems.join('\n')}`);
    // core is reached through an address, not named by the record: its record is checked when it is read.
    try { problems = await problemsOf(world({ registry: (graphs) => { graphs[1].meaning_files = malformed; } })); } catch (error) { assert.fail(`read graph, ${label}: threw ${error.stack}`); }
    expectProblem(problems, /the MeaningGraph registry's record for core is not well formed \(meaning_files must be a list of file paths\), so it is not read/);
  }
});

test('with the model and the meaning graph in one repository, a relative models path needs both pins to be one commit', async () => {
  let newer;
  const differing = sharedWorld({
    chinook: chinookNamesModel,
    manifest: (manifest, w) => { newer = w.publisher.more(new Map([['NOTES.txt', 'newer\n']])); manifest.model.address = `${modelAddr}?ref=${newer}`; },
  });
  expectProblem(await sharedProblems(differing), new RegExp(`the models entry for module chinook is the relative path chinook\\.modelspec\\.hcl, which is the model file of the meaning graph's own commit \\(${differing.publisher.commit}\\), but ovdb\\.yaml pins the model at ${newer}; with the model and the meaning graph in one repository a relative path needs both pins to be the same commit`));
  await assert.rejects(() => buildIndex(sharedOptions(differing)), /cannot build index\.json/);
  // The same newer commit for both is fine (the registries' own pins differ, which is only a warning).
  const same = sharedWorld({
    chinook: chinookNamesModel,
    manifest: (manifest, w) => { const pin = w.publisher.more(new Map([['NOTES.txt', 'newer\n']])); manifest.model.address = `${modelAddr}?ref=${pin}`; manifest.meaning.address = `${chinookAddress}?ref=${pin}`; },
  });
  assert.deepEqual(await sharedProblems(same), []);
});

test('two databases cannot list the same deployment url or recordset pages: a hoster cannot present another publisher\'s deployment as its own', async () => {
  const deployment = 'https://cloud.openvaultdb.com/ovdb/dbs/chinook';
  const page = `${deployment}/collections/{name}`;
  const claimsOf = async (w) => (await checkDirectory(sharedOptions(w))).problems.filter((problem) => !problem.startsWith('index.json'));
  const edit = (change) => hosterManifestEdit((manifest) => { manifest.deployment.discovery = 'https://ovdb.acme.com/.well-known/openvaultdb'; change(manifest); });
  // Chinook's deployment url: as written, with a trailing slash, in another case.
  for (const copy of [deployment, `${deployment}/`, deployment.replace('/chinook', '/CHINOOK')]) {
    const problems = await claimsOf(sharedWorld(edit((manifest) => { manifest.deployment.url = copy; manifest.deployment.recordset_page = 'https://cloud.acme.com/other/{name}'; })));
    expectProblem(problems, /ovdb\.yaml: deployment\.url https:\/\/cloud\.openvaultdb\.com\/ovdb\/dbs\/chinook is claimed by 2 databases \(chinook-acme, chinook; compared ignoring case and a trailing slash\); a deployment is listed once, because a second listing of the same deployment is not a second hoster/);
  }
  // Chinook's recordset pages: the same origin and path before {name}, whatever follows, in any case.
  for (const template of [page, `${page}/rows`, page.replace('/collections/', '/COLLECTIONS/')]) {
    const problems = await claimsOf(sharedWorld(edit((manifest) => { manifest.deployment.url = 'https://cloud.acme.com/ovdb/dbs/chinook'; manifest.deployment.recordset_page = template; })));
    expectProblem(problems, /ovdb\.yaml: deployment\.recordset_page of 2 databases \(chinook-acme, chinook\) starts with https:\/\/cloud\.openvaultdb\.com\/ovdb\/dbs\/chinook\/collections\/ \(the origin and path before \{name\}, compared ignoring case\)/);
  }
  // Both at once is two problems, and the index is not written.
  const both = sharedWorld(edit((manifest) => { manifest.deployment.url = deployment; manifest.deployment.recordset_page = page; }));
  assert.equal((await claimsOf(both)).length, 2);
  await assert.rejects(() => buildIndex(sharedOptions(both)), /cannot build index\.json[\s\S]*deployment\.url[\s\S]*deployment\.recordset_page/);
  // A different deployment, and a recordset page under a different path, is a different database: the ordinary hoster passes.
  assert.deepEqual(await claimsOf(sharedWorld()), []);
  assert.deepEqual(await claimsOf(sharedWorld(edit((manifest) => { manifest.deployment.recordset_page = 'https://cloud.acme.com/ovdb/dbs/chinook/collections/x/{name}'; }))), []);
  // A database that does not give recordset_page claims no pages.
  const without = sharedWorld({ ...edit((manifest) => { delete manifest.deployment.recordset_page; }), chinook: { publisher: manifestEdit((manifest) => { delete manifest.deployment.recordset_page; }) } });
  assert.deepEqual(await claimsOf(without), []);
});

test('the registries\' paths hold at the registry\'s own commit: at another pin they must exist there, or the problem names both commits and nothing is guessed', async () => {
  const v2 = 'model/v2/chinook.modelspec.json';
  // The ModelSpec registry moved its files to v2 at a newer commit; the hoster still pins the older one.
  let newer;
  const modelMoved = sharedWorld({
    manifest: (manifest, w) => { newer = w.publisher.more(new Map([[v2, fixtureChinook.get('model/chinook.modelspec.json')], ['model/v2/chinook.modelspec.hcl', fixtureChinook.get('model/chinook.modelspec.hcl')]])); },
    models: (models) => { models[0].commit = newer; models[0].files = { source: 'model/v2/chinook.modelspec.hcl', json: v2 }; },
  });
  const pinned = modelMoved.publisher.commit;
  const problems = await sharedProblems(modelMoved);
  expectProblem(problems, new RegExp(`the registered model ${v2.replaceAll('.', '\\.')} does not exist at commit ${pinned} \\(the ModelSpec registry names this path for its own commit ${newer}; this manifest pins ${pinned}, where the path is not there, so the files may have moved between the two\\. Pin the registry's commit, or wait until the registry follows\\)`));
  // The same record at the registry's own commit has the path, and is read.
  const atRegistry = sharedWorld({
    manifest: (manifest, w) => { newer = w.publisher.more(new Map([[v2, fixtureChinook.get('model/chinook.modelspec.json')], ['model/v2/chinook.modelspec.hcl', fixtureChinook.get('model/chinook.modelspec.hcl')]])); manifest.model.address = `${modelAddr}?ref=${newer}`; manifest.meaning.address = `${chinookAddress}?ref=${newer}`; },
    models: (models) => { models[0].commit = newer; models[0].files = { source: 'model/v2/chinook.modelspec.hcl', json: v2 }; },
  });
  const read = await sharedProblems(atRegistry);
  assert.ok(!read.some((problem) => /registered model|model source/.test(problem)), read.join('\n'));
  // Pins equal and the path missing: the registry's record is what is wrong, and there is no "moved" note.
  const wrong = await sharedProblems(sharedWorld({ models: (models) => { models[0].files.json = 'model/nowhere.modelspec.json'; } }));
  expectProblem(wrong, /the registered model model\/nowhere\.modelspec\.json does not exist at commit [0-9a-f]{40}$/);
  // The model's source, and the graph's meaning_files, in the same way.
  const sourceMoved = sharedWorld({
    manifest: (manifest, w) => { newer = w.publisher.more(new Map([['model/v2/chinook.modelspec.hcl', fixtureChinook.get('model/chinook.modelspec.hcl')]])); },
    models: (models) => { models[0].commit = newer; models[0].files.source = 'model/v2/chinook.modelspec.hcl'; },
  });
  expectProblem(await sharedProblems(sourceMoved), /the model source model\/v2\/chinook\.modelspec\.hcl of github\.com\/datatug\/chinookdb does not exist at commit [0-9a-f]{40} \(the ModelSpec registry names this path for its own commit [0-9a-f]{40}; this manifest pins/);
  const meaningMoved = sharedWorld({
    manifest: (manifest, w) => { newer = w.publisher.more(new Map([['model/v2/chinook.meaning.yaml', fixtureChinook.get('model/chinook.meaning.yaml')]])); w.meaningRegistry = meaningIndex({ chinook: newer, core: w.core.commit, edit: (graphs) => { graphs[0].meaning_files = ['model/v2/chinook.meaning.yaml']; } }); },
  });
  expectProblem(await sharedProblems(meaningMoved), /meaning\.file model\/chinook\.meaning\.yaml is not one of the meaning files the MeaningGraph registry lists for chinook \(model\/v2\/chinook\.meaning\.yaml\) at commit [0-9a-f]{40} \(the MeaningGraph registry names this path for its own commit [0-9a-f]{40}; this manifest pins/);
});

test('a graph the MeaningGraph registry registers with capitals is found by its lower-case address; the manifest is still written in lower case', async () => {
  const capitals = 'https://github.com/DataTug/ChinookDB';
  const registered = (graphs) => { graphs[0].address = 'meaning://github.com/DataTug/ChinookDB'; graphs[0].repository = capitals; };
  const world_ = (extra = {}) => sharedWorld({ chinook: { registry: registered, publisher: manifestEdit((manifest) => { manifest.meaning.graph.address = 'meaning://github.com/DataTug/ChinookDB'; }) }, ...extra, manifest: (manifest, w) => { w.urls.set(capitals, w.publisher.url); extra.manifest?.(manifest, w); } });
  const found = world_();
  assert.deepEqual(await sharedProblems(found), []);
  const acme = (await sharedIndex(found)).databases.find((database) => database.id === 'chinook-acme');
  assert.deepEqual(acme.meaning_graph, { id: 'chinook', address: 'meaning://github.com/DataTug/ChinookDB' }, 'the index spells the graph as the registry does');
  assert.equal(field(acme, 'Customer', 'Country').meanings[0].address, `meaning://github.com/DataTug/ChinookDB/customer-country?ref=${found.publisher.commit}`);
  // One rule: the manifest writes host, organisation and repository in lower case, whatever the registry does.
  expectProblem(await sharedProblems(world_({ manifest: (manifest, w) => { manifest.meaning.address = `meaning://github.com/DataTug/ChinookDB?ref=${w.publisher.commit}`; } })), /meaning\.address meaning:\/\/github\.com\/DataTug\/ChinookDB\?ref=[0-9a-f]{40} must be written in lower case \(host, organisation and repository\)$/);
  // meaning.graph.address, when given, is the registry's spelling of the unpinned address.
  expectProblem(await sharedProblems(world_({ manifest: (manifest) => { manifest.meaning.graph.address = 'meaning://github.com/datatug/chinookdb'; } })), /meaning\.graph\.address is meaning:\/\/github\.com\/datatug\/chinookdb, but meaning\.address names meaning:\/\/github\.com\/DataTug\/ChinookDB; leave meaning\.graph\.address out or make it the unpinned address as the registry spells it/);
  assert.deepEqual(await sharedProblems(world_({ manifest: (manifest) => { manifest.meaning.graph.address = 'meaning://github.com/DataTug/ChinookDB'; } })), []);
  // A registry that lists one repository twice, in two cases, does not say which record is the graph's.
  expectProblem(await sharedProblems(sharedWorld({ chinook: { registry: (graphs) => graphs.push({ ...graphs[0], id: 'chinook-twice', address: 'meaning://github.com/DATATUG/chinookdb' }) } })), /meaning\.address meaning:\/\/github\.com\/datatug\/chinookdb matches 2 records of the MeaningGraph registry \(chinook, chinook-twice\), which differ only in case/);
  // The message about a meaning address no longer talks about module names.
  const messages = await sharedProblems(sharedWorld(hosterManifestEdit((manifest, w) => { manifest.meaning.address = `meaning://github.com/DataTug/ChinookDB?ref=${w.publisher.commit}`; })));
  assert.ok(messages.some((message) => /meaning\.address .* must be written in lower case \(host, organisation and repository\)$/.test(message)), messages.join('\n'));
  assert.ok(!messages.some((message) => /meaning\.address.*module name/.test(message)));
});

test('a hoster that keeps its meaning graph in its own repository is told what to do', async () => {
  const problems = await sharedProblems(sharedWorld(hosterManifestEdit((manifest, w) => { manifest.meaning.address = `meaning://github.com/acme/chinook-hosting?ref=${w.publisher.commit}`; })));
  expectProblem(problems, /meaning\.address meaning:\/\/github\.com\/acme\/chinook-hosting\?ref=[0-9a-f]{40} names this repository; a manifest that names a model published in another repository must name a meaning graph in a third repository, registered in the MeaningGraph registry \(a graph in the publisher's own repository goes with a model in that repository, named by local files: model\.modelspec and meaning\.file\)/);
});

test('an own model that names a registered address is the registered model: its file is compared with the registry\'s files.json at the registry\'s pin, else a warning', async () => {
  const named = () => world(chinookNamesModel);
  // The registry registers the model at this record's commit, with the same files.json: nothing to report.
  const same = named();
  assert.deepEqual((await checkDirectory(options(same, { modelRegistry: modelIndex({ commit: same.publisher.commit }) }))).warnings, []);
  assert.deepEqual(await problemsOf(same, { modelRegistry: modelIndex({ commit: same.publisher.commit }) }), []);
  // files.json is another file with another model: the two are not the same model.
  const other = world({ publisher: (files) => { const json = JSON.parse(files.get('model/chinook.modelspec.json')); delete json.entities.Genre; files.set('model/registered.modelspec.json', JSON.stringify(json)); manifestEdit((manifest) => { manifest.model.address = modelAddr; })(files); } });
  expectProblem(await problemsOf(other, { modelRegistry: modelIndex({ commit: other.publisher.commit, edit: (models) => { models[0].files.json = 'model/registered.modelspec.json'; } }) }), /ovdb\.yaml: model\/chinook\.modelspec\.json is not the model the ModelSpec registry registers as modelspec:\/\/github\.com\/datatug\/chinookdb\/chinook: it differs from model\/registered\.modelspec\.json, the registry's files\.json, at [0-9a-f]{40}; databases that share a model\.address are databases of the same model/);
  // Key order and white space do not matter: it is the JSON that is compared.
  const reordered = world({ publisher: (files) => { files.set('model/registered.modelspec.json', JSON.stringify(JSON.parse(files.get('model/chinook.modelspec.json')), null, 4)); manifestEdit((manifest) => { manifest.model.address = modelAddr; })(files); } });
  assert.deepEqual(await problemsOf(reordered, { modelRegistry: modelIndex({ commit: reordered.publisher.commit, edit: (models) => { models[0].files.json = 'model/registered.modelspec.json'; } }) }), []);
  // The registry's file is missing, or not JSON, or its record is not well formed.
  expectProblem(await problemsOf(same, { modelRegistry: modelIndex({ commit: same.publisher.commit, edit: (models) => { models[0].files.json = 'model/nowhere.json'; } }) }), /the model the ModelSpec registry registers as model\/nowhere\.json does not exist at commit [0-9a-f]{40} \(its files\.json for modelspec:\/\/github\.com\/datatug\/chinookdb\/chinook\)/);
  expectProblem(await problemsOf(same, { modelRegistry: modelIndex({ commit: same.publisher.commit, edit: (models) => { models[0].files.json = 'OVDB.md'; } }) }), /OVDB\.md, the files\.json of modelspec:\/\/github\.com\/datatug\/chinookdb\/chinook in the ModelSpec registry, is not JSON/);
  expectProblem(await problemsOf(same, { modelRegistry: modelIndex({ commit: same.publisher.commit, edit: (models) => { delete models[0].files; } }) }), /the ModelSpec registry's record for modelspec:\/\/github\.com\/datatug\/chinookdb\/chinook is not well formed \(files\.json must be a path inside the repository\)/);
  expectProblem(await problemsOf(same, { modelRegistry: modelIndex({ commit: same.publisher.commit, edit: (models) => { models[0].repository = 'https://github.com/someone/else'; } }) }), /is not well formed \(its repository and module must give that address\)/);
  // Another commit: not compared, and said so; the record is still listed.
  const behind = named();
  const registryCommit = 'a'.repeat(40);
  const result = await checkDirectory(options(behind, { modelRegistry: modelIndex({ commit: registryCommit, edit: (models) => { models[0].files.json = 'model/nowhere.json'; } }) }));
  assert.deepEqual(result.problems.filter((problem) => !problem.startsWith('index.json')), []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], new RegExp(`^databases/\\$records/chinook\\.yaml: model\\.address ${modelAddr.replaceAll('/', '\\/')} is registered in the ModelSpec registry at ${registryCommit}, but this record pins ${behind.publisher.commit}; model/chinook\\.modelspec\\.json was not compared with the registry's model/nowhere\\.json$`));
  // An address the registry does not know is not compared (the own form is not registered anywhere); an unreadable registry is a problem, never a fallback.
  assert.deepEqual(await problemsOf(named()), []);
  expectProblem(await problemsOf(named(), { loadModelRegistry: async () => { throw new Error('cannot read https://example.test/models.json: HTTP 503'); } }), /^databases\/\$records\/chinook\.yaml: ModelSpec registry: cannot read https:\/\/example\.test\/models\.json: HTTP 503/);
  // A manifest that names no address is never compared.
  assert.deepEqual(await problemsOf(world(), { loadModelRegistry: async () => { throw new Error('must not be read'); } }), []);
});

test('warnings: a refused pin is not "read", a registry commit that is not a string is shown as JSON, and both commands print them', async () => {
  // A pin that only a side branch has, and that differs from the registry's: refused, so no "the pinned commit is read".
  const chinook = { publisherOptions: { side: new Map([['extra.txt', 'only on a side branch\n']]) } };
  const side = sharedWorld({ chinook, manifest: (manifest, w) => { manifest.model.address = `${modelAddr}?ref=${w.publisher.sideCommit}`; manifest.meaning.address = `${chinookAddress}?ref=${w.publisher.sideCommit}`; } });
  const refused = await checkDirectory(sharedOptions(side));
  expectProblem(refused.problems, /model\.address pins commit [0-9a-f]{40}, which is not in the history of main/);
  assert.deepEqual(refused.warnings, [], 'nothing was read, so nothing says the pinned commit is read');
  // A malformed registry commit is shown as it is written, never as [object Object].
  for (const [commit, shown] of [[{ a: 1 }, '{"a":1}'], [42, '42'], [null, 'null'], [['x'], '["x"]'], ['not a commit\u001b[2J', '"not a commit\\u001b[2J"']]) {
    const w = sharedWorld({ models: (models) => { models[0].commit = commit; } });
    const { warnings } = await checkDirectory(sharedOptions(w));
    const warning = warnings.find((text) => text.includes('ModelSpec registry registers'));
    assert.ok(warning, JSON.stringify(warnings));
    assert.ok(warning.includes(`at ${shown};`), warning);
    assert.ok(!warning.includes('[object Object]') && !warning.includes('\u001b'), warning);
  }
  // `npm run check` and `npm run index` print every warning as a "warning:" line, and a failure as "error:" lines.
  const w = sharedWorld({ chinook: chinookNamesModel, manifest: (manifest, world_) => { const newer = world_.publisher.more(new Map([['NOTES.txt', 'newer\n']])); manifest.model.address = `${modelAddr}?ref=${newer}`; manifest.meaning.address = `${chinookAddress}?ref=${newer}`; } });
  const capture = () => { const lines = { out: [], err: [] }; return { lines, io: { out: (line) => lines.out.push(line), err: (line) => lines.err.push(line) } }; };
  const written = capture();
  assert.equal(await runIndex(sharedOptions(w), written.io), 0);
  assert.deepEqual(written.lines.out, ['wrote index.json']);
  assert.equal(written.lines.err.length, 2);
  assert.match(written.lines.err[0], /^warning: databases\/\$records\/chinook-acme\.yaml: model\.address pins [0-9a-f]{40}, but the ModelSpec registry registers modelspec:\/\/github\.com\/datatug\/chinookdb\/chinook at [0-9a-f]{40}; the pinned commit is read$/);
  assert.match(written.lines.err[1], /^warning: databases\/\$records\/chinook-acme\.yaml: meaning\.address pins [0-9a-f]{40}, but the MeaningGraph registry registers chinook at [0-9a-f]{40}; the pinned commit is read$/);
  assert.equal(readFileSync(join(w.dir, 'index.json'), 'utf8').includes('"chinook-acme"'), true);
  const checkedRun = capture();
  assert.equal(await runCheck(sharedOptions(w), checkedRun.io), 0);
  assert.deepEqual(checkedRun.lines.out, ['ok: 2 databases checked']);
  assert.deepEqual(checkedRun.lines.err, written.lines.err);
  // A failure: the warnings still come first, then each problem, then the count, and the exit code is 1; no index is written.
  const broken = sharedWorld({ chinook: chinookNamesModel, manifest: (manifest, world_) => { manifest.model.address = `${modelAddr}?ref=${world_.publisher.commit}`; manifest.recordsets = ['Album']; } });
  const failing = capture();
  assert.equal(await runCheck(sharedOptions(broken), failing.io), 1);
  assert.deepEqual(failing.lines.out, []);
  assert.ok(failing.lines.err.some((line) => /^error: databases\/\$records\/chinook-acme\.yaml: ovdb\.yaml: recordsets lacks ModelSpec entities/.test(line)), failing.lines.err.join('\n'));
  assert.match(failing.lines.err.at(-1), /^\d+ problems? in 2 databases$/);
  const noIndex = capture();
  assert.equal(await runIndex(sharedOptions(broken), noIndex.io), 1);
  assert.equal(existsSync(join(broken.dir, 'index.json')), false);
  assert.match(noIndex.lines.err.at(-1), /^error: cannot build index\.json:/);
  assert.deepEqual(noIndex.lines.out, []);
});

test('MODELSPEC_REGISTRY_INDEX_URL, and any index URL, must be https', async () => {
  let fetched = 0;
  const fetchImpl = async () => { fetched += 1; return { ok: true, status: 200, text: async () => JSON.stringify({ format: 'modelspec-registry/draft-1', checksum: `sha256:${createHash('sha256').update('[]').digest('hex')}`, models: [] }) }; };
  for (const url of ['data:application/json,{}', 'file:///etc/passwd', 'http://example.test/index.json', 'ftp://example.test/index.json', '/tmp/index.json', 'index.json', '', 'javascript:alert(1)', 'https:', 'HTTP://example.test/x']) {
    await assert.rejects(() => loadModelRegistry({ url, fetchImpl }), /must be read over https/, url);
  }
  assert.equal(fetched, 0, 'nothing is fetched for a URL that is refused');
  assert.equal((await loadModelRegistry({ url: 'https://example.test/index.json', fetchImpl })).byAddress.size, 0);
  assert.equal(fetched, 1);
  const saved = process.env.MODELSPEC_REGISTRY_INDEX_URL;
  try {
    process.env.MODELSPEC_REGISTRY_INDEX_URL = 'data:application/json,{}';
    await assert.rejects(() => loadModelRegistry({ fetchImpl }), /must be read over https; "data:application\/json,\{\}" is not an https URL \(check MODELSPEC_REGISTRY_INDEX_URL\)/);
    process.env.MODELSPEC_REGISTRY_INDEX_URL = 'https://example.test/other.json';
    await loadModelRegistry({ fetchImpl });
  } finally {
    if (saved === undefined) delete process.env.MODELSPEC_REGISTRY_INDEX_URL; else process.env.MODELSPEC_REGISTRY_INDEX_URL = saved;
  }
  assert.equal(fetched, 2);
  // A run with a bad variable reports the registry as unreadable, for the databases that need it.
  const w = sharedWorld();
  const { problems } = await checkDirectory(options(w, { loadModelRegistry: () => loadModelRegistry({ url: 'data:text/plain,x', fetchImpl }) }));
  expectProblem(problems, /^databases\/\$records\/chinook-acme\.yaml: ModelSpec registry: the ModelSpec registry index must be read over https/);
});

test('a binding to an entity or module whose name starts with _ says why it cannot be bound', async () => {
  const bind = (model) => meaningEdit((doc) => { doc.concepts.push({ id: 'hidden', kind: 'attribute', labels: { en: 'Hidden' }, description: 'x', bindings: [{ model, role: 'entity' }] }); });
  expectProblem(await problemsOf(world({ publisher: bind('modelspec:///chinook._Hidden') })), /binding model "modelspec:\/\/\/chinook\._Hidden" is not a modelspec:\/\/\/\{module\}\.\{Entity\} reference \(the module and the entity name in a reference start with a letter, so an entity or module whose name starts with _ cannot be bound\)/);
  expectProblem(await problemsOf(world({ publisher: bind('modelspec:///_chinook.Customer') })), /is not a modelspec:\/\/\/\{module\}\.\{Entity\} reference \(the module and the entity name in a reference start with a letter/);
  // An entity named with a leading underscore is still a ModelSpec entity: it can be listed as a recordset, just not bound.
  const underscore = world({ publisher: (files) => { modelEdit((doc) => { doc.entities._Audit = { properties: { Id: { type: 'int' } } }; })(files); manifestEdit((manifest) => { manifest.recordsets.push('_Audit'); })(files); } });
  assert.deepEqual(await problemsOf(underscore), []);
});

test('the list of two-label public suffixes is short, and a name under a suffix that is not on it counts as having a subdomain', () => {
  for (const url of ['https://ovdb.co.il/sales', 'https://ovdb.com.sg/sales', 'https://ovdb.github.io/sales', 'https://ovdb.pages.dev/sales']) {
    assert.equal(urlProblem(url), null, `${url} is accepted: its suffix is not on the list`);
  }
  for (const url of ['https://ovdb.co.uk/sales', 'https://ovdb.com.au/sales']) assert.notEqual(urlProblem(url), null, `${url}: the suffix is on the list, so ovdb is the registered name`);
  const readme = readFileSync(join(root, 'README.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(readme, /The list of two-label suffixes is short \(17 common ones, kept by hand in scripts\/lib\/urls\.mjs, not the public suffix list\)/);
  assert.match(readme, /a suffix is added by a reviewed change when a publisher needs it/);
  assert.match(readFileSync(join(root, 'scripts', 'lib', 'urls.mjs'), 'utf8'), /17\n\/\/ of the common ones/);
});

// ---- the git cache: what a planted repository can do ----

const lazyOrigin = () => {
  const source = origin(new Map([['a.txt', 'hello\n']]), { name: 'lazy' });
  gitIn(source.dir, 'config', 'uploadpack.allowFilter', 'true');
  gitIn(source.dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  return { ...source, blob: gitIn(source.dir, 'rev-parse', 'HEAD:a.txt') };
};
const plainGitEnv = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' };
const partialClone = (url) => {
  const dir = join(fresh('partial'), 'repo');
  execFileSync('git', ['clone', '-q', '--bare', '--filter=blob:none', '--end-of-options', url, dir], { stdio: 'pipe', env: plainGitEnv });
  return dir;
};

test('git never fetches a missing object on its own: GIT_NO_LAZY_FETCH, and a planted remote that is not the one the repository was cloned from is refused', async () => {
  assert.equal(gitEnv().GIT_NO_LAZY_FETCH, '1');
  const source = lazyOrigin();
  // Positive control: with plain git a partial clone fetches the blob it lacks from its remote, on its own.
  const control = partialClone(source.url);
  assert.equal(execFileSync('git', ['-C', control, 'cat-file', '-p', source.blob], { stdio: 'pipe', env: plainGitEnv }).toString(), 'hello\n');
  // With this module's git it does not.
  const clone = partialClone(source.url);
  assert.throws(() => git(['-C', clone, 'cat-file', '-p', source.blob]), /unable to read|fatal/);
  // The planted remote: the repository is a partial clone whose origin is somewhere else. It is not the repository cloned from the url.
  assert.equal(cacheRepoSound(clone, { url: source.url }), true, 'the clone of that url is sound');
  assert.equal(cacheRepoSound(clone, { url: 'file:///somewhere/else' }), false, 'another url');
  gitIn(clone, 'config', 'remote.origin.url', 'file:///planted');
  assert.equal(cacheRepoSound(clone, { url: source.url }), false, 'a planted remote.origin.url');
  gitIn(clone, 'config', '--add', 'remote.origin.url', source.url);
  assert.equal(cacheRepoSound(clone, { url: source.url }), false, 'two urls');
  // A one-commit repository was made by `init` and a fetch that names the url: it has no remote at all.
  const oneCommit = fresh('repo');
  gitIn(oneCommit, 'init', '-q', '--bare');
  assert.equal(cacheRepoSound(oneCommit, { commit: 'a'.repeat(40), url: source.url }), true);
  gitIn(oneCommit, 'config', 'remote.origin.url', 'file:///planted');
  assert.equal(cacheRepoSound(oneCommit, { commit: 'a'.repeat(40), url: source.url }), false, 'a remote in a one-commit repository');
  const promisor = fresh('repo');
  gitIn(promisor, 'init', '-q', '--bare');
  gitIn(promisor, 'config', 'extensions.partialclone', 'origin');
  assert.equal(cacheRepoSound(promisor, { commit: 'a'.repeat(40) }), false, 'a promisor in a one-commit repository');
  // End to end: a history clone in the cache whose remote was changed is thrown away and made again from the right url.
  const w = world();
  const url = w.urlFor(chinookUrl);
  const history = join(w.cacheDir, 'history');
  assert.equal(onBranch(url, 'main', w.publisher.commit, history, new Set()), true);
  const dir = historyPath(history, url, 'main');
  assert.equal(gitIn(dir, 'config', '--get', 'remote.origin.url'), url);
  gitIn(dir, 'config', 'remote.origin.url', 'file:///planted');
  assert.equal(onBranch(url, 'main', w.publisher.commit, history, new Set()), true);
  assert.equal(gitIn(dir, 'config', '--get', 'remote.origin.url'), url, 'made again');
});

test('a cached repository directory that is itself a symbolic link is never used, even to a sound repository; the link is replaced, its target left alone', async () => {
  const w = world();
  const cache = fresh('cache');
  openCommit(w.publisher.url, w.publisher.commit, cache);
  const repo = readdirSync(cache).map((name) => join(cache, name)).find((path) => existsSync(join(path, 'HEAD')));
  const elsewhere = join(fresh('elsewhere'), 'copy');
  cpSync(repo, elsewhere, { recursive: true });
  assert.equal(cacheRepoSound(elsewhere, { commit: w.publisher.commit }), true, 'the copy is a sound repository');
  rmSync(repo, { recursive: true });
  symlinkSync(elsewhere, repo);
  assert.equal(cacheRepoSound(repo, { commit: w.publisher.commit }), false, 'the link to it is not');
  writeFileSync(join(elsewhere, 'target-marker'), 'x');
  assert.match(openCommit(w.publisher.url, w.publisher.commit, cache).read('OVDB.md'), /ovdb: 1/);
  assert.equal(lstatSync(repo).isSymbolicLink(), false, 'the link was replaced by a real directory');
  assert.ok(cacheRepoSound(repo, { commit: w.publisher.commit }));
  assert.equal(existsSync(join(elsewhere, 'target-marker')), true, 'the target was not touched');
  // A dangling link at the repository\'s place does not stop the run either, and history clones are covered too.
  rmSync(repo, { recursive: true });
  symlinkSync(join(scratch, `nowhere-${count++}`), repo);
  assert.match(openCommit(w.publisher.url, w.publisher.commit, cache).read('OVDB.md'), /ovdb: 1/);
  assert.equal(lstatSync(repo).isSymbolicLink(), false);
  const url = w.urlFor(chinookUrl);
  const history = join(w.cacheDir, 'history');
  assert.equal(onBranch(url, 'main', w.publisher.commit, history, new Set()), true);
  const clone = historyPath(history, url, 'main');
  const copy = join(fresh('elsewhere'), 'copy');
  cpSync(clone, copy, { recursive: true });
  rmSync(clone, { recursive: true });
  symlinkSync(copy, clone);
  assert.equal(onBranch(url, 'main', w.publisher.commit, history, new Set()), true);
  assert.equal(lstatSync(clone).isSymbolicLink(), false);
  assert.equal(existsSync(join(copy, 'HEAD')), true);
});

const gitAtLeast = (major, minor) => {
  const [found, foundMinor] = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version']).toString()).slice(1).map(Number);
  return found > major || (found === major && foundMinor >= minor);
};

test('git 2.54 and later run hooks that a repository\'s configuration defines (hook.<name>.command), wherever core.hooksPath points; the configuration allow-list keeps them out', async () => {
  const marker = join(scratch, `config-hook-ran-${count++}`);
  const planted = (dir) => {
    mkdirSync(dir, { recursive: true });
    gitIn(dir, 'init', '-q', '--bare');
    writeFileSync(join(dir, 'config'), `${readFileSync(join(dir, 'config'), 'utf8')}[hook "plant"]\n\tevent = reference-transaction\n\tcommand = touch '${marker}'\n`);
  };
  const dir = fresh('repo');
  planted(dir);
  assert.equal(cacheRepoSound(dir), false, 'a configured hook is not in the allow-list');
  assert.equal(cacheRepoSound(dir, { commit: 'a'.repeat(40) }), false);
  if (gitAtLeast(2, 54)) {
    // Positive control: this git runs it, with core.hooksPath pointed at nothing as the module does.
    const tree = gitIn(dir, 'mktree');
    const commit = gitIn(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit-tree', tree, '-m', 'x');
    gitIn(dir, '-c', `core.hooksPath=${devNull}`, 'update-ref', 'refs/heads/control', commit);
    assert.equal(existsSync(marker), true, 'the configured hook runs although core.hooksPath is /dev/null');
    rmSync(marker, { force: true });
  }
  // A cache that holds such a repository where the history clone goes: it is thrown away, and the hook never runs.
  const w = world();
  const target = historyPath(join(w.cacheDir, 'history'), w.urlFor(chinookUrl), 'main');
  planted(target);
  const { problems } = await checkDirectory(options(w));
  assert.deepEqual(problems.filter((problem) => !problem.startsWith('index.json')), []);
  assert.equal(existsSync(marker), false, 'the configured hook did not run during the check');
  assert.equal(cacheRepoSound(target, { url: w.urlFor(chinookUrl) }), true, 'the repository there now is the one made here');
  // The same for every other key that makes git run something.
  for (const key of ['hook.x.command', 'hook.x.event', 'hook.x.enabled', 'core.fsmonitor', 'core.hooksPath', 'core.attributesFile', 'core.sshCommand', 'core.pager', 'core.editor', 'core.gitProxy', 'filter.x.clean', 'filter.x.smudge', 'diff.x.textconv', 'diff.external', 'merge.x.driver', 'credential.helper', 'gpg.program', 'uploadpack.packObjectsHook', 'remote.origin.uploadpack', 'remote.origin.receivepack', 'remote.origin.proxy', 'url.x.insteadOf', 'safe.directory', 'maintenance.auto', 'gc.auto', 'includeIf.gitdir:/.path']) {
    const probe = fresh('repo');
    gitIn(probe, 'init', '-q', '--bare');
    gitIn(probe, 'config', '--file', join(probe, 'config'), key, 'x');
    assert.equal(cacheRepoSound(probe), false, key);
  }
});

test('the cache keeps no checkout: bare repositories only, no index and no work tree, so there is no index to trust and no .gitattributes to obey', async () => {
  const w = world({ publisher: (files) => { files.set('.gitattributes', '* text eol=crlf\n*.yaml filter=evil\n* export-ignore\n'); } });
  const cache = fresh('cache');
  const files = openCommit(w.publisher.url, w.publisher.commit, cache);
  const body = files.read('OVDB.md');
  const url = w.urlFor(chinookUrl);
  assert.equal(onBranch(url, 'main', w.publisher.commit, join(cache, 'history'), new Set()), true);
  // Everything in the cache is a bare repository: git says so, there is no index, no work tree and no checked-out file.
  const repositories = [...readdirSync(cache).filter((name) => !name.startsWith('.') && name !== 'history').map((name) => join(cache, name)), ...readdirSync(join(cache, 'history')).filter((name) => !name.startsWith('.')).map((name) => join(cache, 'history', name))];
  assert.ok(repositories.length >= 2, repositories.join(', '));
  for (const repo of repositories) {
    assert.equal(gitIn(repo, 'rev-parse', '--is-bare-repository'), 'true', repo);
    assert.equal(existsSync(join(repo, 'index')), false, `${repo} has no index`);
    assert.deepEqual(readdirSync(repo).filter((name) => ['OVDB.md', 'ovdb.yaml', '.gitattributes', 'model'].includes(name)), [], `${repo} holds no checked-out file`);
  }
  // A tracked .gitattributes, and one planted in the repository's info/, change nothing: files are read from the object store, byte for byte.
  const repo = repositories.find((path) => existsSync(join(path, 'shallow')));
  mkdirSync(join(repo, 'info'), { recursive: true });
  writeFileSync(join(repo, 'info', 'attributes'), '* text eol=crlf\n* filter=evil\n* ident\n');
  const again = openCommit(w.publisher.url, w.publisher.commit, cache);
  assert.equal(again.read('OVDB.md'), body);
  assert.ok(!body.includes('\r'), 'no line ending was rewritten');
  assert.equal(again.read('OVDB.md'), fixtureChinook.get('OVDB.md'));
  // An index file is something a bare repository made here never has: a repository with one is not trusted.
  const withIndex = fresh('repo');
  gitIn(withIndex, 'init', '-q', '--bare');
  assert.equal(cacheRepoSound(withIndex), true);
  writeFileSync(join(withIndex, 'index'), 'DIRC');
  assert.equal(cacheRepoSound(withIndex), false);
  // The whole check passes with a tracked .gitattributes in the publisher's repository.
  assert.deepEqual(await problemsOf(w), []);
});

test('an optional homepage is accepted in both forms, held to the URL rules, and published only when the manifest has one', async () => {
  const site = 'https://chinookdb.com/';
  // Without it (the fixture, like the pinned Chinook): no key in the entry.
  const [plain] = (await index(world())).databases;
  assert.equal('homepage' in plain, false);
  // Own form, on the canonical origin or on any other.
  for (const homepage of [site, 'https://www.example.org/databases/chinook', 'https://acme.com/']) {
    const withHomepage = world({ publisher: manifestEdit((manifest) => { manifest.homepage = homepage; }) });
    assert.deepEqual(await problemsOf(withHomepage), [], homepage);
    const [entry] = (await index(withHomepage)).databases;
    assert.equal(entry.homepage, homepage);
  }
  // Shared form.
  const shared = sharedWorld(hosterManifestEdit((manifest) => { manifest.homepage = 'https://acme.com/chinook'; }));
  assert.deepEqual(await sharedProblems(shared), []);
  const [chinook, acme] = (await sharedIndex(shared)).databases;
  assert.equal(acme.homepage, 'https://acme.com/chinook');
  assert.equal('homepage' in chinook, false);
  // Refused like every other URL a manifest publishes.
  const refused = [
    ['http://chinookdb.com/', /homepage must be https, not http/],
    ['https://user:pw@chinookdb.com/', /homepage must not contain credentials/],
    ['https://chinookdb.com/?x=1', /homepage must not contain a query/],
    ['https://chinookdb.com/#top', /homepage must not contain a fragment/],
    ['https://127.0.0.1/', /homepage 127\.0\.0\.1 is an IP address/],
    ['https://[::1]/', /homepage \[::1\] is an IP address/],
    ['https://localhost/', /homepage localhost is a single-label name/],
    ['https://metadata.google.internal/', /homepage metadata\.google\.internal is a local, internal or reserved name/],
    ['https://CHINOOKDB.com/', /homepage is not written canonically/],
    ['https://acme.com', /homepage is not written canonically \(it would be https:\/\/acme\.com\/\)/],
    ['chinookdb.com', /homepage is not a URL/],
    ['', /homepage is required/],
    [null, /homepage is required/],
  ];
  for (const [homepage, pattern] of refused) {
    expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.homepage = homepage; }) })), new RegExp(`ovdb\\.yaml: ${pattern.source}`));
    expectProblem(await sharedProblems(sharedWorld(hosterManifestEdit((manifest) => { manifest.homepage = homepage; }))), new RegExp(`ovdb\\.yaml: ${pattern.source}`));
  }
  expectProblem(await problemsOf(world({ publisher: manifestEdit((manifest) => { manifest.homepage = ['https://chinookdb.com/']; }) })), /ovdb\.yaml: homepage is not a URL/);
});
