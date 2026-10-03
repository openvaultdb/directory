// The Directory's own checks and index writer, CC0-1.0 like everything else here.
//
// inGitDB validates the records against the collection definitions (types,
// required columns, enums, lengths, foreign keys). This module checks what a
// column definition cannot say and everything that needs the publisher's
// repository at the pinned commit: the opt-in OVDB.md, the manifest it lists,
// the ModelSpec and the meaning file, and how the database's meanings resolve
// through the MeaningGraph registry. The same pass that checks a database
// builds its index.json entry, so what is checked is what is published.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { addressOf, commitPattern, defaultBranch, isRepositoryPath, onBranch, openCommit, repositoryKey, repositoryHosts } from './git.mjs';
import { createMeaningResolver, entryOf, loadMeaningRegistry, parseConceptRef, labelOf } from './meaning.mjs';
import { parseModelSpec, parseModelRef } from './modelspec.mjs';

export { repositoryHosts };
export const directoryFormat = 'ovdb-directory/draft-1';
export const manifestFormat = 'ovdb-manifest/draft-1';
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const statuses = ['draft', 'published', 'deprecated'];
const lowerKey = (value) => value.toLowerCase();

const recordsDir = (root, collection) => join(root, collection, '$records');

// Reads one collection's records as [{ key, file, data }] sorted by key, with a
// problem for any file in $records that is not <key>.yaml.
export function readCollection(root, collection) {
  const dir = recordsDir(root, collection);
  const records = [];
  const problems = [];
  if (!existsSync(dir)) return { records, problems };
  for (const name of readdirSync(dir).sort()) {
    const file = `${collection}/$records/${name}`;
    if (!name.endsWith('.yaml')) { problems.push(`${file}: a record is a <key>.yaml file; remove or rename it`); continue; }
    let data;
    try { data = parseYaml(readFileSync(join(dir, name), 'utf8')); } catch (error) { problems.push(`${file}: not YAML: ${error.message}`); continue; }
    records.push({ key: name.slice(0, -'.yaml'.length), file, data: data ?? {} });
  }
  return { records, problems };
}

export function readDirectory(root) {
  const databases = readCollection(root, 'databases');
  const maintainers = readCollection(root, 'maintainers');
  return { databases: databases.records, maintainers: maintainers.records, problems: [...databases.problems, ...maintainers.problems] };
}

// A canonical https URL: no user, query or fragment, and spelled the way URL
// would write it (so https://chinookdb.com/x and https://CHINOOKDB.com/x are
// not two identities).
export function canonicalUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.href === value && !value.endsWith('/');
  } catch {
    return false;
  }
}

// A database record whose repository, commit and manifest path are well
// formed: the only kind whose values are ever handed to git.
export const wellFormed = (record) => Boolean(record) && repositoryKey(record.data.repository) !== null && commitPattern.test(record.data.commit ?? '')
  && isRepositoryPath(record.data.manifest);

// Rules on the records alone (no network): the parts of the format that the
// inGitDB collection definitions cannot express.
export function recordProblems({ databases, maintainers }) {
  const problems = [];
  const urls = new Map();
  const handles = new Set(maintainers.map((maintainer) => maintainer.key));
  for (const { key, file, data } of databases) {
    if (!idPattern.test(key) || key.length > 80) problems.push(`${file}: id "${key}" must be lower-case letters, digits and single hyphens, at most 80 characters`);
    if (data.format !== directoryFormat) problems.push(`${file}: format must be ${directoryFormat}`);
    if (!statuses.includes(data.status)) problems.push(`${file}: status must be one of ${statuses.join(', ')}`);
    if (!commitPattern.test(data.commit ?? '')) problems.push(`${file}: commit must be a full 40-character lower-case commit id`);
    if (!repositoryKey(data.repository)) problems.push(`${file}: repository must be an https URL of a repository on ${[...repositoryHosts.keys()].join(', ')}, such as https://github.com/{org}/{repo} (no trailing slash, .git, "." or ".." segments)`);
    if (!canonicalUrl(data.url)) problems.push(`${file}: url must be a canonical https URL without credentials, query, fragment or trailing slash`);
    else urls.set(data.url.toLowerCase(), [...(urls.get(data.url.toLowerCase()) ?? []), { key, file, value: data.url }]);
    if (!isRepositoryPath(data.manifest)) problems.push(`${file}: manifest must be a relative path inside the repository (no "..", no glob)`);
    if (typeof data.meaning_graph !== 'string' || !idPattern.test(data.meaning_graph)) problems.push(`${file}: meaning_graph must be a MeaningGraph registry id`);
    for (const handle of data.maintainers ?? []) {
      if (!handles.has(handle)) problems.push(`${file}: maintainer ${handle} has no record in maintainers/`);
    }
  }
  for (const owners of urls.values()) {
    if (owners.length > 1) problems.push(`${owners.at(-1).file}: url ${owners.at(-1).value} is registered under ${owners.length} ids (${owners.map((owner) => owner.key).join(', ')}, compared ignoring case); a database is registered once`);
  }
  return problems;
}

// ---- OVDB.md and the manifest ----

export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { error: 'has no YAML frontmatter between --- lines' };
  try {
    const data = parseYaml(match[1]);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return { error: 'frontmatter is not a mapping' };
    return { data };
  } catch (error) {
    return { error: `frontmatter is not valid YAML: ${error.message}` };
  }
}

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isHttps = (value) => { try { return new URL(value).protocol === 'https:'; } catch { return false; } };

// The manifest's required fields (format ovdb-manifest/draft-1).
export function manifestProblems(manifest) {
  const problems = [];
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return ['is not a mapping'];
  if (manifest.format !== manifestFormat) problems.push(`format must be ${manifestFormat}, got ${JSON.stringify(manifest.format)}`);
  for (const field of ['id', 'title', 'description']) if (!isText(manifest[field])) problems.push(`${field} is required`);
  const need = (object, field, label, check = isText) => { if (!check(object?.[field])) problems.push(`${label} is required`); };
  need(manifest, 'url', 'url', isHttps);
  need(manifest.deployment, 'url', 'deployment.url', isHttps);
  need(manifest.deployment, 'engine', 'deployment.engine');
  need(manifest.deployment, 'discovery', 'deployment.discovery', isHttps);
  // The discovery document is the canonical host's: same origin as the canonical url.
  if (isHttps(manifest.deployment?.discovery) && isHttps(manifest.url) && new URL(manifest.deployment.discovery).origin !== new URL(manifest.url).origin) {
    problems.push(`deployment.discovery must be on the same origin as url (${new URL(manifest.url).origin}), not ${new URL(manifest.deployment.discovery).origin}`);
  }
  // Optional: where a recordset is browsed, with {name} for the recordset name.
  const page = manifest.deployment?.recordset_page;
  if (page !== undefined && !(isHttps(page) && page.split('{name}').length === 2)) problems.push('deployment.recordset_page must be an https URL template with {name} once');
  need(manifest.model, 'modelspec', 'model.modelspec', isRepositoryPath);
  need(manifest.meaning, 'file', 'meaning.file', isRepositoryPath);
  need(manifest.meaning?.graph, 'id', 'meaning.graph.id');
  need(manifest.meaning?.graph, 'address', 'meaning.graph.address', (value) => isText(value) && value.startsWith('meaning://'));
  need(manifest.publisher, 'name', 'publisher.name');
  need(manifest.publisher, 'url', 'publisher.url', isHttps);
  need(manifest.licences, 'data', 'licences.data');
  need(manifest.licences, 'model', 'licences.model');
  need(manifest.licences, 'meaning', 'licences.meaning');
  if (!Array.isArray(manifest.recordsets) || manifest.recordsets.length === 0 || !manifest.recordsets.every(isText)) problems.push('recordsets must be a non-empty list of names');
  return problems;
}

// ---- one database ----

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const by = (...keys) => (a, b) => {
  for (const key of keys) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  return 0;
};

// Fetches a record's repository at its commit and checks it. Returns
// { problems, entry } where `entry` is the database's index.json entry, or null
// when a problem stopped the analysis before it could be built.
// `context` carries what is shared by the run: urlFor, cacheDir, historyDir,
// fetched, branches, and `meaningRegistry` (the MeaningGraph registry's index).
export function analyseDatabase(record, context) {
  const { key, file, data } = record;
  const problems = [];
  const stop = () => ({ problems, entry: null });
  const bad = (message) => problems.push(`${file}: ${message}`);
  if (!wellFormed(record)) return stop(); // reported by recordProblems; never handed to git
  const { urlFor = (url) => url, cacheDir, historyDir, fetched, branches } = context;
  const url = urlFor(data.repository);

  // The commit must be in the history of the default branch, not one that only a fork has.
  try {
    if (!branches.has(url)) branches.set(url, defaultBranch(url));
    const branch = branches.get(url);
    if (!onBranch(url, branch, data.commit, historyDir, fetched)) {
      bad(`commit ${data.commit} is not in the history of ${branch}, the default branch of ${data.repository} (a commit only a fork or another branch has); register a commit from ${branch}`);
      return stop();
    }
  } catch (error) { bad(error.message); return stop(); }
  let files;
  try { files = openCommit(url, data.commit, cacheDir); } catch (error) { bad(error.message); return stop(); }

  const text = (path, label) => {
    const status = files.status(path);
    if (status === 'missing') { bad(`${label} ${path} does not exist at commit ${data.commit}`); return null; }
    if (status === 'link') { bad(`${label} ${path} is not a regular file at commit ${data.commit} (a symbolic link or submodule); it must be a file of the repository`); return null; }
    return files.read(path);
  };

  // OVDB.md opts the repository in and lists, by explicit path, the manifests that may be read.
  const optIn = text('OVDB.md', 'OVDB.md:');
  if (optIn === null) return stop();
  const { data: frontmatter, error } = parseFrontmatter(optIn);
  if (error) { bad(`OVDB.md ${error}`); return stop(); }
  if (frontmatter.ovdb !== 1) bad(`OVDB.md: ovdb must be 1, got ${JSON.stringify(frontmatter.ovdb)}`);
  if (!Array.isArray(frontmatter.publish) || frontmatter.publish.length === 0) { bad('OVDB.md: publish must list at least one manifest path'); return stop(); }
  const published = new Set();
  for (const entry of frontmatter.publish) {
    if (!isText(entry) || !entry.startsWith('./') || !isRepositoryPath(entry.slice(2))) bad(`OVDB.md: publish entry ${JSON.stringify(entry)} must be an explicit path starting with ./ inside the repository (no glob, no ..)`);
    else published.add(entry.slice(2));
  }
  if (!published.has(data.manifest)) { bad(`OVDB.md does not list ./${data.manifest} in publish (it lists ${[...published].map((path) => `./${path}`).join(', ') || 'nothing'}); the publisher has not opted this manifest in`); return stop(); }

  // The manifest.
  const manifestText = text(data.manifest, 'manifest');
  if (manifestText === null) return stop();
  let manifest;
  try { manifest = parseYaml(manifestText); } catch (parseError) { bad(`${data.manifest} is not valid YAML: ${parseError.message}`); return stop(); }
  const missing = manifestProblems(manifest);
  for (const problem of missing) bad(`${data.manifest}: ${problem}`);
  if (missing.length) return stop();
  if (manifest.url !== data.url) bad(`${data.manifest}: url is ${manifest.url}, but the record's url is ${data.url}; the manifest and the record name one canonical identity`);
  if (manifest.id !== key) bad(`${data.manifest}: id is ${manifest.id}, but the record is ${key}`);
  if (manifest.meaning.graph.id !== data.meaning_graph) bad(`${data.manifest}: meaning.graph.id is ${manifest.meaning.graph.id}, but the record's meaning_graph is ${data.meaning_graph}`);
  if (manifest.publisher.repository !== undefined && repositoryKey(manifest.publisher.repository) !== repositoryKey(data.repository)) {
    bad(`${data.manifest}: publisher.repository is ${manifest.publisher.repository}, but the record's repository is ${data.repository}`);
  }

  // The MeaningGraph registry: the graph is registered, and it is this repository's.
  const graph = context.meaningRegistry.byId.get(data.meaning_graph);
  if (!graph) bad(`meaning_graph ${data.meaning_graph} is not registered in the MeaningGraph registry (${context.meaningRegistry.source})`);
  else {
    if (repositoryKey(graph.repository) === null || lowerKey(repositoryKey(graph.repository)) !== lowerKey(repositoryKey(data.repository))) {
      bad(`meaning_graph ${data.meaning_graph} is registered for ${graph.repository}, not for ${data.repository}`);
    }
    if (manifest.meaning.graph.address !== graph.address) bad(`${data.manifest}: meaning.graph.address is ${manifest.meaning.graph.address}, but the MeaningGraph registry registers ${graph.id} as ${graph.address}`);
    const listed = (graph.meaning_files ?? []).some((pattern) => files.match(pattern).includes(manifest.meaning.file));
    if (!listed) bad(`${data.manifest}: meaning.file ${manifest.meaning.file} is not one of the meaning files the MeaningGraph registry lists for ${graph.id} (${(graph.meaning_files ?? []).join(', ')})`);
  }

  // The ModelSpec: recordsets are exactly its entities.
  const modelText = text(manifest.model.modelspec, 'model.modelspec');
  const meaningText = text(manifest.meaning.file, 'meaning.file');
  if (modelText === null || meaningText === null) return stop();
  const model = parseModelSpec(modelText);
  for (const problem of model.problems) bad(`${manifest.model.modelspec}: ${problem}`);
  if (model.problems.length) return stop();
  const listedRecordsets = manifest.recordsets;
  if (new Set(listedRecordsets).size !== listedRecordsets.length) bad(`${data.manifest}: recordsets lists a name twice`);
  const entityNames = [...model.entities.keys()];
  const lacking = entityNames.filter((name) => !listedRecordsets.includes(name));
  const extra = listedRecordsets.filter((name) => !model.entities.has(name));
  if (lacking.length) bad(`${data.manifest}: recordsets lacks ModelSpec entities: ${lacking.join(', ')}`);
  if (extra.length) bad(`${data.manifest}: recordsets names things that are not ModelSpec entities: ${extra.join(', ')}`);

  // The meaning file.
  let doc;
  try { doc = parseYaml(meaningText); } catch (parseError) { bad(`${manifest.meaning.file} is not valid YAML: ${parseError.message.split('\n')[0]}`); return stop(); }
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.concepts)) { bad(`${manifest.meaning.file}: has no concepts list`); return stop(); }
  if (typeof doc.license === 'string' && doc.license !== manifest.licences.meaning) bad(`${data.manifest}: licences.meaning is ${manifest.licences.meaning}, but ${manifest.meaning.file} declares ${doc.license}`);
  if (manifest.model.name !== undefined && manifest.model.name !== model.module) bad(`${data.manifest}: model.name is ${manifest.model.name}, but the ModelSpec at ${manifest.model.modelspec} is module ${model.module}`);
  if (manifest.model.hcl !== undefined) {
    const declared = doc.models?.[model.module];
    if (typeof declared !== 'string') bad(`${manifest.meaning.file}: models does not name the ModelSpec module ${model.module}`);
    else if (posix.join(posix.dirname(manifest.meaning.file), declared) !== manifest.model.hcl) bad(`${manifest.meaning.file}: the ${model.module} model is ${posix.join(posix.dirname(manifest.meaning.file), declared)}, but ${data.manifest} says model.hcl is ${manifest.model.hcl}`);
  }
  if (!graph) return stop();

  const own = { id: graph.id, address: repositoryKey(data.repository), ref: data.commit, concepts: new Map() };
  for (const concept of doc.concepts) {
    if (own.concepts.has(concept?.id)) bad(`${manifest.meaning.file}: concept ${concept.id} is declared twice`);
    else if (isText(concept?.id)) own.concepts.set(concept.id, concept);
  }
  const resolver = createMeaningResolver({ own, registry: context.meaningRegistry, urlFor, cacheDir, historyDir, fetched, branches });

  // Bindings tie concepts to recordsets and fields; each must name a real entity and property.
  const recordsets = new Map(entityNames.map((name) => [name, { name, meanings: [], fields: new Map(model.entities.get(name).properties.map((property) => [property.name, { ...property, meanings: [] }])) }]));
  const resolved = new Map();
  const chainsOf = (concept) => {
    if (!resolved.has(concept.id)) resolved.set(concept.id, resolver.chains(concept, own));
    return resolved.get(concept.id);
  };
  for (const concept of own.concepts.values()) {
    for (const binding of concept.bindings ?? []) {
      const where = `${manifest.meaning.file}: concept ${concept.id}`;
      const ref = typeof binding?.model === 'string' ? parseModelRef(binding.model) : null;
      if (!ref) { bad(`${where}: binding model ${JSON.stringify(binding?.model)} is not a modelspec:///{module}.{Entity} reference`); continue; }
      if (ref.repo !== undefined) { bad(`${where}: binding ${binding.model} names a model outside this database; bindings name this repository's own ModelSpec`); continue; }
      if (ref.module !== model.module) { bad(`${where}: binding ${binding.model} names module ${ref.module}, but the ModelSpec at ${manifest.model.modelspec} is module ${model.module}`); continue; }
      const recordset = recordsets.get(ref.name);
      if (!recordset) { bad(`${where}: binding ${binding.model} names an entity that is not in the ModelSpec`); continue; }
      if (typeof binding.role !== 'string' || !binding.role) { bad(`${where}: binding ${binding.model} has no role`); continue; }
      let target;
      if (binding.property === undefined) {
        if (binding.role !== 'entity') { bad(`${where}: binding ${binding.model} with role ${binding.role} must name a property`); continue; }
        target = recordset;
      } else {
        target = recordset.fields.get(binding.property);
        if (!target) { bad(`${where}: binding ${binding.model} names property ${binding.property}, which ${ref.name} does not have in the ModelSpec`); continue; }
      }
      const chains = chainsOf(concept);
      if (chains.problems.length) continue;
      const meaning = {
        graph: own.id,
        concept: concept.id,
        label: labelOf(concept),
        role: binding.role,
        address: `meaning://${own.address}/${concept.id}?ref=${own.ref}`,
        extends: chains.extends,
        ...(chains.valuesOf ? { values_of: chains.valuesOf } : {}),
      };
      if (!target.meanings.some((seen) => seen.concept === meaning.concept && seen.role === meaning.role)) target.meanings.push(meaning);
    }
  }
  for (const concept of own.concepts.values()) {
    const chains = chainsOf(concept);
    for (const problem of chains.problems) bad(`${manifest.meaning.file}: concept ${concept.id}: ${problem}`);
  }
  if (problems.length) return stop();

  const sorted = (meanings) => [...meanings].sort(by('concept', 'role'));
  const entry = {
    id: key,
    title: data.title,
    description: data.description,
    status: data.status,
    url: data.url,
    deployment: { url: manifest.deployment.url, engine: manifest.deployment.engine },
    repository: data.repository,
    commit: data.commit,
    manifest: data.manifest,
    licence: manifest.licences.data,
    model: { name: manifest.model.name ?? model.module, path: manifest.model.hcl ?? manifest.model.modelspec },
    meaning_graph: { id: graph.id, address: graph.address },
    recordsets: [...recordsets.values()].sort(byName).map((recordset) => ({
      name: recordset.name,
      ...(manifest.deployment.recordset_page ? { url: manifest.deployment.recordset_page.replace('{name}', encodeURIComponent(recordset.name)) } : {}),
      meanings: sorted(recordset.meanings),
      fields: [...recordset.fields.values()].map(({ name, type, references, meanings }) => ({ name, type, ...(references ? { references } : {}), meanings: sorted(meanings) })),
    })),
  };
  return { problems, entry };
}

// ---- index.json ----

// Code-unit order, the same in every locale.
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// index.json: every database sorted by id, and a sha256 of the databases array
// as written (compact JSON) so a consumer can verify one fetch.
export function indexText(entries) {
  const databases = [...entries].sort(byId);
  const checksum = `sha256:${createHash('sha256').update(JSON.stringify(databases)).digest('hex')}`;
  return `${JSON.stringify({ format: directoryFormat, checksum, databases }, null, 2)}\n`;
}

function sharedContext({ urlFor, cacheDir, meaningRegistry, fetched = new Set(), branches = new Map() }) {
  return { urlFor, cacheDir: join(cacheDir, 'repositories'), historyDir: join(cacheDir, 'history'), meaningRegistry, fetched, branches };
}

// Reads the MeaningGraph registry (a fetched index, or `meaningRegistry` as
// given) and analyses every database. { problems, entries }.
export async function analyseDirectory({ root, urlFor, cacheDir = join(root, '.cache'), meaningRegistry, loadRegistry = loadMeaningRegistry, ...rest } = {}) {
  const directory = readDirectory(root);
  const problems = [...directory.problems, ...recordProblems(directory)];
  const entries = [];
  let registryIndex = meaningRegistry;
  try { registryIndex ??= await loadRegistry(); } catch (error) {
    problems.push(`MeaningGraph registry: ${error.message}`);
    return { problems, entries, directory };
  }
  const context = sharedContext({ urlFor, cacheDir, meaningRegistry: registryIndex, ...rest });
  for (const record of directory.databases) {
    const result = analyseDatabase(record, context);
    problems.push(...result.problems);
    if (result.entry) entries.push(result.entry);
  }
  return { problems, entries, directory };
}

// What `npm run index` writes. Throws, naming every problem, when anything is wrong.
export async function buildIndex(options) {
  const { problems, entries } = await analyseDirectory(options);
  if (problems.length) throw new Error(`cannot build index.json:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
  return indexText(entries);
}

// Every check: records, then each database at its commit, then index.json.
export async function checkDirectory(options = {}) {
  const { problems, entries, directory } = await analyseDirectory(options);
  const path = join(options.root, 'index.json');
  if (!existsSync(path)) problems.push('index.json is missing; run npm run index and commit it');
  else if (problems.length === 0 && readFileSync(path, 'utf8') !== indexText(entries)) problems.push('index.json differs from what npm run index writes; run it and commit the result');
  return { problems, databases: directory.databases.length };
}

export { addressOf, entryOf, parseConceptRef };
