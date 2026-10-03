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
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, posix, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { addressOf, commitPattern, defaultBranch, defaultCacheDir, ensurePlainDirectory, isRepositoryPath, onBranch, openCommit, repositoryKey, repositoryHosts } from './git.mjs';
import { createMeaningResolver, entryOf, graphsAtAddress, loadMeaningRegistry, meaningFilesOf, parseConceptRef, parseGraphAddress, labelOf, validateConcept } from './meaning.mjs';
import { loadModelRegistry, normalisedModelAddress, parseModelSpec, parseModelRef, parseModelAddress, registeredModelAddress } from './modelspec.mjs';
import { hasOvdbMarker, publicHttpsProblem } from './urls.mjs';

export { repositoryHosts };
export const directoryFormat = 'ovdb-directory/draft-1';
export const manifestFormat = 'ovdb-manifest/draft-1';
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const statuses = ['draft', 'published', 'deprecated'];
const lowerKey = (value) => value.toLowerCase();
// A registry's value in a message: a commit as it is, anything else (an object, a number, odd text) as JSON.
const shown = (value) => (typeof value === 'string' && commitPattern.test(value) ? value : JSON.stringify(value));

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

// A problem with `value` as a database's canonical url, or null: a public https
// URL (urls.mjs) without a trailing slash, with `ovdb` as a complete path segment
// or as a subdomain (see hasOvdbMarker).
export function urlProblem(value) {
  const problem = publicHttpsProblem(value);
  if (problem) return problem;
  if (value.endsWith('/')) return 'must not have a trailing slash';
  if (!hasOvdbMarker(value)) return 'must have ovdb as a complete path segment or as a subdomain (https://acme.com/ovdb/sales or https://ovdb.acme.com/sales)';
  return null;
}
export const canonicalUrl = (value) => urlProblem(value) === null;

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
    if (urlProblem(data.url)) problems.push(`${file}: url ${urlProblem(data.url)}`);
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

// What a manifest says about the deployment that serves the database, for comparing it with the other
// records': the deployment's url (ignoring case and a trailing slash) and the origin and path of the
// recordset page template up to {name}. Two databases on the same deployment are not two hosters: a
// hoster could otherwise list another publisher's live deployment as its own.
export const deploymentClaims = (manifest) => ({
  deploymentUrl: manifest.deployment.url.toLowerCase().replace(/\/+$/, ''),
  recordsetPrefix: typeof manifest.deployment.recordset_page === 'string' ? manifest.deployment.recordset_page.slice(0, manifest.deployment.recordset_page.indexOf('{name}')).toLowerCase() : undefined,
});

// Problems across records, from what analyseDatabase reports as `claims`: a deployment url, or the origin
// and path a recordset page template starts with, that more than one database claims. Reported once per
// value, on the last record (by file name) that claims it, naming every database that does.
export function claimProblems(claimed) {
  const problems = [];
  const report = (field, describe) => {
    const owners = new Map();
    for (const claim of claimed) if (claim[field] !== undefined) owners.set(claim[field], [...(owners.get(claim[field]) ?? []), claim]);
    for (const [value, list] of owners) {
      if (list.length < 2) continue;
      problems.push(`${list.at(-1).file}: ${list.at(-1).manifest}: ${describe(value, list.length, list.map((claim) => claim.key).join(', '))}; a deployment is listed once, because a second listing of the same deployment is not a second hoster`);
    }
  };
  report('deploymentUrl', (value, count, ids) => `deployment.url ${value} is claimed by ${count} databases (${ids}; compared ignoring case and a trailing slash)`);
  report('recordsetPrefix', (value, count, ids) => `deployment.recordset_page of ${count} databases (${ids}) starts with ${value} (the origin and path before {name}, compared ignoring case)`);
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
const modelSourcePattern = /\.modelspec\.hcl$/;
const spdxLike = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/.test(value);

// A manifest names its model one of two ways. With local files (`model.modelspec`, optionally
// `model.hcl`) it is an own model: the model and the meaning file are in the publisher's own
// repository. Without them it is a shared model: `model.address` and `meaning.address`, each pinned
// with ?ref=, name a model and a meaning graph published in other repositories.
export const manifestForm = (manifest) => (manifest?.model?.modelspec !== undefined || manifest?.model?.hcl !== undefined ? 'own' : 'shared');

// The manifest's required fields (format ovdb-manifest/draft-1), by form.
export function manifestProblems(manifest) {
  const problems = [];
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return ['is not a mapping'];
  const shared = manifestForm(manifest) === 'shared';
  if (manifest.format !== manifestFormat) problems.push(`format must be ${manifestFormat}, got ${JSON.stringify(manifest.format)}`);
  for (const field of ['id', 'title', 'description']) if (!isText(manifest[field])) problems.push(`${field} is required`);
  const need = (object, field, label, check = isText) => { if (!check(object?.[field])) problems.push(`${label} is required`); };
  // A URL the manifest publishes: public https only (see publicHttpsProblem).
  const needUrl = (value, label, check = publicHttpsProblem, options) => {
    if (value === undefined || value === null || value === '') problems.push(`${label} is required`);
    else { const problem = check(value, options); if (problem) problems.push(`${label} ${problem}`); }
  };
  needUrl(manifest.url, 'url', urlProblem);
  needUrl(manifest.deployment?.url, 'deployment.url');
  need(manifest.deployment, 'engine', 'deployment.engine', (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.+-]{0,39}$/.test(value));
  needUrl(manifest.deployment?.discovery, 'deployment.discovery');
  // The discovery document is the canonical host's: same origin as the canonical url.
  if (!urlProblem(manifest.url) && !publicHttpsProblem(manifest.deployment?.discovery) && new URL(manifest.deployment.discovery).origin !== new URL(manifest.url).origin) {
    problems.push(`deployment.discovery must be on the same origin as url (${new URL(manifest.url).origin}), not ${new URL(manifest.deployment.discovery).origin}`);
  }
  // Optional: where a recordset is browsed, with {name} for the recordset name.
  if (manifest.deployment?.recordset_page !== undefined) needUrl(manifest.deployment.recordset_page, 'deployment.recordset_page', publicHttpsProblem, { template: true });
  if (manifest.model?.hcl !== undefined && !(isRepositoryPath(manifest.model.hcl) && modelSourcePattern.test(manifest.model.hcl))) problems.push('model.hcl must be a relative path inside the repository (no "..", no leading /, no "." or empty segments, no glob) ending in .modelspec.hcl');
  if (shared) {
    // A shared model: no local model files, no local meaning file; both are named by pinned addresses.
    const model = parseModelAddress(manifest.model?.address);
    if (manifest.model?.address === undefined) problems.push('model must name the model by local files (model.modelspec) or, for a model published in another repository, by model.address with ?ref=<40 hex>');
    else if (!model) problems.push('model.address must be modelspec://{host}/{org}/{repo}/{module}?ref=<40 hex> for a model in another repository');
    else if (model.ref === undefined) problems.push('model.address must carry ?ref=<40 hex> when the model is in another repository (the pin says which commit is read)');
    const graph = parseGraphAddress(manifest.meaning?.address);
    if (manifest.meaning?.address === undefined) problems.push('meaning.address is required when model.address names a model in another repository (the meaning graph is then shared too): meaning://{host}/{org}/{repo}?ref=<40 hex>');
    else if (!graph) problems.push('meaning.address must be meaning://{host}/{org}/{repo}?ref=<40 hex>');
    else if (graph.ref === undefined) problems.push('meaning.address must carry ?ref=<40 hex> (the pin says which commit of the meaning graph is read)');
    need(manifest.meaning, 'file', 'meaning.file (the file of the graph, in the graph\'s repository, that binds the model)', isRepositoryPath);
    need(manifest.meaning?.graph, 'id', 'meaning.graph.id');
    if (manifest.meaning?.graph?.address !== undefined && !(isText(manifest.meaning.graph.address) && manifest.meaning.graph.address.startsWith('meaning://'))) problems.push('meaning.graph.address, when given, must be the graph\'s meaning:// address without a pin');
    // The registries say what the model and the meaning are licensed under; a manifest that repeats them must agree (checked against the records).
    for (const field of ['model', 'meaning']) if (manifest.licences?.[field] !== undefined && !spdxLike(manifest.licences[field])) problems.push(`licences.${field}, when given, must be an SPDX-shaped licence id`);
    if (manifest.recordsets_partial !== undefined && typeof manifest.recordsets_partial !== 'boolean') problems.push('recordsets_partial must be true or false');
  } else {
    need(manifest.model, 'modelspec', 'model.modelspec', isRepositoryPath);
    if (manifest.model?.address !== undefined && !parseModelAddress(manifest.model.address)) problems.push('model.address must be modelspec://{host}/{org}/{repo}/{module}, this repository and the module name, without ?ref= (a model in another repository is named by model.address alone, with ?ref= and no local model files)');
    if (manifest.meaning?.address !== undefined) problems.push('meaning.address is only for a shared model (model.address with ?ref= and no local model files); a manifest with its own model files has its own meaning file and names its graph by meaning.graph.address');
    if (manifest.recordsets_partial !== undefined) problems.push('recordsets_partial is only for a shared model; a manifest with its own model files lists every ModelSpec entity');
    need(manifest.meaning, 'file', 'meaning.file', isRepositoryPath);
    need(manifest.meaning?.graph, 'id', 'meaning.graph.id');
    need(manifest.meaning?.graph, 'address', 'meaning.graph.address', (value) => isText(value) && value.startsWith('meaning://'));
    need(manifest.licences, 'model', 'licences.model', spdxLike);
    need(manifest.licences, 'meaning', 'licences.meaning', spdxLike);
  }
  need(manifest.publisher, 'name', 'publisher.name');
  needUrl(manifest.publisher?.url, 'publisher.url');
  // Optional: the publisher's own page for the database (a website for people). Any public https URL, on any origin.
  if (manifest.homepage !== undefined) needUrl(manifest.homepage, 'homepage');
  need(manifest.licences, 'data', 'licences.data', spdxLike);
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
// { problems, warnings, entry } where `entry` is the database's index.json entry, or null
// when a problem stopped the analysis before it could be built.
// `context` carries what is shared by the run: urlFor, cacheDir, historyDir,
// fetched, branches, `meaningRegistry` (the MeaningGraph registry's index) and
// `modelRegistry()` (resolves to the ModelSpec registry's index; asked only by a
// database whose manifest names its model by address).
export async function analyseDatabase(record, context) {
  const { key, file, data } = record;
  const problems = [];
  const warnings = [];
  let claims = null; // set once the manifest is read: what it claims of the deployment, for the checks across records
  const stop = () => ({ problems, warnings, entry: null, claims });
  const bad = (message) => problems.push(`${file}: ${message}`);
  const warn = (message) => warnings.push(`${file}: ${message}`);
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

  // A file of a repository opened at a commit (this record's, unless a shared model or graph says otherwise).
  const text = (path, label, source = files, commit = data.commit, note = '') => {
    const status = source.status(path);
    if (status === 'missing') { bad(`${label} ${path} does not exist at commit ${commit}${note}`); return null; }
    if (status === 'link') { bad(`${label} ${path} is not a regular file at commit ${commit} (a symbolic link or submodule); it must be a file of the repository${note}`); return null; }
    return source.read(path);
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
  claims = { key, file, manifest: data.manifest, ...deploymentClaims(manifest) };
  if (manifest.url !== data.url) bad(`${data.manifest}: url is ${manifest.url}, but the record's url is ${data.url}; the manifest and the record name one canonical identity`);
  if (manifest.id !== key) bad(`${data.manifest}: id is ${manifest.id}, but the record is ${key}`);
  if (manifest.meaning.graph.id !== data.meaning_graph) bad(`${data.manifest}: meaning.graph.id is ${manifest.meaning.graph.id}, but the record's meaning_graph is ${data.meaning_graph}`);
  if (manifest.publisher.repository !== undefined && lowerKey(repositoryKey(manifest.publisher.repository) ?? '') !== lowerKey(repositoryKey(data.repository))) {
    bad(`${data.manifest}: publisher.repository is ${manifest.publisher.repository}, but the record's repository is ${data.repository}`);
  }

  const shared = manifestForm(manifest) === 'shared';
  const ownKey = lowerKey(repositoryKey(data.repository));
  // What the two forms resolve, for the checks they share: the registry's record of the graph, the model
  // (module, entities) and where it is, the meaning file (parsed) and the commit of its graph that is read.
  let graph;
  let model;
  let modelLabel;
  let modelPath;
  let modelAddress;
  let modelHome; // { repository, commit }: only for a model in another repository
  let doc;
  let meaningFile;
  let meaningRef;

  // The names the database lists as recordsets: the ModelSpec's entities, exactly, unless a shared model's
  // manifest lists a subset and says so with recordsets_partial: true. A partial list is closed under
  // references, so no listed field points at a recordset that is not there.
  const checkRecordsets = () => {
    const listed = manifest.recordsets;
    if (new Set(listed).size !== listed.length) bad(`${data.manifest}: recordsets lists a name twice`);
    const entityNames = [...model.entities.keys()];
    const lacking = entityNames.filter((name) => !listed.includes(name));
    const extra = listed.filter((name) => !model.entities.has(name));
    if (shared && manifest.recordsets_partial === true) {
      if (lacking.length === 0 && extra.length === 0) bad(`${data.manifest}: recordsets_partial is true, but recordsets lists every ModelSpec entity; remove recordsets_partial`);
      for (const name of listed) {
        for (const property of model.entities.get(name)?.properties ?? []) {
          if (property.references && !listed.includes(property.references)) bad(`${data.manifest}: recordsets lists ${name}, which references ${property.references}, but a partial list must also list every entity a listed entity references`);
        }
      }
    } else if (lacking.length) bad(`${data.manifest}: recordsets lacks ModelSpec entities: ${lacking.join(', ')}${shared ? ' (to list a subset of a shared model, list it explicitly and set recordsets_partial: true)' : ''}`);
    if (extra.length) bad(`${data.manifest}: recordsets names things that are not ModelSpec entities: ${extra.join(', ')}`);
    return shared && manifest.recordsets_partial === true ? [...new Set(listed)].filter((name) => model.entities.has(name)) : entityNames;
  };
  let publishedNames;

  // The model's source file as the meaning file's `models:` entry for the module names it: a path relative to
  // the meaning file's directory (so ../x.hcl from model/sub/ is fine), which after joining must stay inside the
  // repository and end in .modelspec.hcl. Returns { declared, joined } with joined null unless it is that.
  const modelsEntry = () => {
    const modelsOf = doc.models !== null && typeof doc.models === 'object' && !Array.isArray(doc.models) ? doc.models : {};
    const declared = Object.hasOwn(modelsOf, model.module) ? modelsOf[model.module] : undefined;
    const joined = typeof declared === 'string' && /^[A-Za-z0-9_.\/-]+$/.test(declared) && !declared.startsWith('/') && !declared.includes('//') ? posix.join(posix.dirname(meaningFile), declared) : null;
    return { declared, joined: joined === null || joined.startsWith('../') || joined === '..' || !isRepositoryPath(joined) ? null : joined };
  };
  const parseMeaningFile = (source) => {
    try { doc = parseYaml(source); } catch (parseError) { bad(`${meaningFile} is not valid YAML: ${parseError.message.split('\n')[0]}`); return false; }
    if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.concepts)) { bad(`${meaningFile}: has no concepts list`); return false; }
    return true;
  };

  if (!shared) {
    // ---- own model: the model and the meaning file are in this repository ----
    meaningFile = manifest.meaning.file;
    meaningRef = data.commit;
    // The MeaningGraph registry: the graph is registered, and it is this repository's.
    graph = context.meaningRegistry.byId.get(data.meaning_graph);
    if (!graph) bad(`meaning_graph ${data.meaning_graph} is not registered in the MeaningGraph registry (${context.meaningRegistry.source})`);
    else {
      if (repositoryKey(graph.repository) === null || lowerKey(repositoryKey(graph.repository)) !== ownKey) {
        bad(`meaning_graph ${data.meaning_graph} is registered for ${graph.repository}, not for ${data.repository}`);
      }
      if (addressOf(graph.repository) !== graph.address) bad(`the MeaningGraph registry's record for ${graph.id} is not well formed (its repository ${graph.repository} must be the https URL whose meaning:// form is its address ${graph.address})`);
      if (manifest.meaning.graph.address !== graph.address) bad(`${data.manifest}: meaning.graph.address is ${manifest.meaning.graph.address}, but the MeaningGraph registry registers ${graph.id} as ${graph.address}`);
      const patterns = meaningFilesOf(graph);
      if (patterns === null) bad(`the MeaningGraph registry's record for ${graph.id} is not well formed (meaning_files must be a list of file paths)`);
      else if (!patterns.some((pattern) => files.match(pattern).includes(manifest.meaning.file))) bad(`${data.manifest}: meaning.file ${manifest.meaning.file} is not one of the meaning files the MeaningGraph registry lists for ${graph.id} (${patterns.join(', ')})`);
    }

    // The ModelSpec: recordsets are exactly its entities.
    modelLabel = manifest.model.modelspec;
    const modelText = text(manifest.model.modelspec, 'model.modelspec');
    const meaningText = text(manifest.meaning.file, 'meaning.file');
    if (modelText === null || meaningText === null) return stop();
    model = parseModelSpec(modelText);
    for (const problem of model.problems) bad(`${manifest.model.modelspec}: ${problem}`);
    if (model.problems.length) return stop();
    publishedNames = checkRecordsets();

    // The meaning file.
    if (!parseMeaningFile(meaningText)) return stop();
    if (typeof doc.license === 'string' && doc.license !== manifest.licences.meaning) bad(`${data.manifest}: licences.meaning is ${manifest.licences.meaning}, but ${manifest.meaning.file} declares ${doc.license}`);
    if (manifest.model.name !== undefined && manifest.model.name !== model.module) bad(`${data.manifest}: model.name is ${manifest.model.name}, but the ModelSpec at ${manifest.model.modelspec} is module ${model.module}`);
    // The model's source file is the meaning file's `models:` entry for the module; it must be a tracked
    // regular file at the pinned commit.
    const { declared, joined } = modelsEntry();
    if (joined === null) {
      bad(`${manifest.meaning.file}: models must name the ModelSpec module ${model.module} with a relative path that stays inside the repository (no leading /, no empty segment, no glob, no escaping with ..), got ${JSON.stringify(declared)}`);
    } else if (!modelSourcePattern.test(joined)) {
      bad(`${manifest.meaning.file}: the ${model.module} model ${joined} must be a .modelspec.hcl file (the model's source)`);
    } else {
      const status = files.status(joined);
      if (status === 'file') modelPath = joined;
      else bad(`${manifest.meaning.file}: the ${model.module} model ${joined} ${status === 'link' ? 'is not a regular file' : 'does not exist'} at commit ${data.commit}`);
    }
    if (manifest.model.hcl !== undefined && modelPath !== undefined && manifest.model.hcl !== modelPath) bad(`${manifest.meaning.file}: the ${model.module} model is ${modelPath}, but ${data.manifest} says model.hcl is ${manifest.model.hcl}`);
    // The model's address in the ModelSpec registry, when the manifest gives one. With the model's files in this
    // repository it is this repository plus the module name, and carries no ?ref=.
    if (manifest.model.address !== undefined) {
      const parsed = parseModelAddress(manifest.model.address);
      if (parsed) {
        if (repositoryKey(`https://${parsed.repository}`) === null) bad(`${data.manifest}: model.address ${manifest.model.address} must name a repository on ${[...repositoryHosts.keys()].join(', ')}, as {host}/{org}/{repo}`);
        else if (parsed.repository !== parsed.repository.toLowerCase()) bad(`${data.manifest}: model.address ${manifest.model.address} must be written in lower case (host, organisation and repository; the module name is case-sensitive)`);
        else if (parsed.repository !== ownKey) bad(`${data.manifest}: model.address names ${parsed.repository}, but the model's files are in ${repositoryKey(data.repository)}; a manifest with its own model files addresses its own repository. To use a model published in another repository, remove the local model files and the local meaning file and pin model.address and meaning.address instead (see the README)`);
        else if (parsed.module !== model.module) bad(`${data.manifest}: model.address names module ${parsed.module}, but the ModelSpec at ${manifest.model.modelspec} is module ${model.module}`);
        else if (parsed.ref !== undefined) bad(`${data.manifest}: model.address must not carry ?ref= when the model's files are in the same repository`);
        else modelAddress = manifest.model.address;
      }
    }
    // An own model whose address the ModelSpec registry knows is the same model as the registry's: databases that
    // share a model.address are databases of the same model. The registry's files.json is read at the registry's pin,
    // which is this record's commit when the two are equal; when they are not, the model is not compared.
    if (modelAddress !== undefined) {
      let modelRegistry;
      try { modelRegistry = await context.modelRegistry(); } catch (registryError) { bad(`ModelSpec registry: ${registryError.message}`); return stop(); }
      const registered = modelRegistry.byAddress.get(modelAddress);
      if (registered) {
        if (registeredModelAddress(registered) !== registered.address) bad(`the ModelSpec registry's record for ${registered.address} is not well formed (its repository and module must give that address)`);
        else if (!isRepositoryPath(registered.files?.json)) bad(`the ModelSpec registry's record for ${registered.address} is not well formed (files.json must be a path inside the repository)`);
        else if (registered.commit !== data.commit) warn(`model.address ${modelAddress} is registered in the ModelSpec registry at ${shown(registered.commit)}, but this record pins ${data.commit}; ${manifest.model.modelspec} was not compared with the registry's ${registered.files.json}`);
        else {
          const registeredText = text(registered.files.json, 'the model the ModelSpec registry registers as', files, data.commit, ` (its files.json for ${registered.address})`);
          if (registeredText !== null) {
            let theirs;
            try { theirs = JSON.parse(registeredText); } catch (parseError) { bad(`${registered.files.json}, the files.json of ${registered.address} in the ModelSpec registry, is not JSON: ${parseError.message}`); }
            if (theirs !== undefined && !isDeepStrictEqual(theirs, JSON.parse(modelText))) bad(`${data.manifest}: ${manifest.model.modelspec} is not the model the ModelSpec registry registers as ${registered.address}: it differs from ${registered.files.json}, the registry's files.json, at ${data.commit}; databases that share a model.address are databases of the same model`);
          }
        }
      }
    }
    if (!graph) return stop();
  } else {
    // ---- shared model: the model and the meaning graph are published in other repositories ----
    const modelPin = parseModelAddress(manifest.model.address);
    const graphPin = parseGraphAddress(manifest.meaning.address);
    meaningFile = manifest.meaning.file;
    meaningRef = graphPin.ref;
    // One rule for both addresses: host, organisation and repository are written in lower case, and neither is this
    // repository. The registries are searched ignoring case (a graph registered as meaning://github.com/DataTug/ChinookDB
    // is found by its lower-case spelling), so the rule is about how a manifest is written, not about what is found.
    const spelled = (label, address, parsed, kind) => {
      if (repositoryKey(`https://${parsed.repository}`) === null) bad(`${data.manifest}: ${label} ${address} must name a repository on ${[...repositoryHosts.keys()].join(', ')}, as {host}/{org}/{repo}`);
      else if (parsed.repository !== parsed.repository.toLowerCase()) bad(`${data.manifest}: ${label} ${address} must be written in lower case (host, organisation and repository${kind === 'model' ? '; the module name is case-sensitive' : ''})`);
      else if (parsed.repository === ownKey) {
        bad(kind === 'model'
          ? `${data.manifest}: ${label} ${address} names this repository; a model or meaning file in the publisher's own repository is named by local files (model.modelspec and meaning.file), not by a pinned address`
          : `${data.manifest}: ${label} ${address} names this repository; a manifest that names a model published in another repository must name a meaning graph in a third repository, registered in the MeaningGraph registry (a graph in the publisher's own repository goes with a model in that repository, named by local files: model.modelspec and meaning.file)`);
      } else return true;
      return false;
    };
    const modelSpelled = spelled('model.address', manifest.model.address, modelPin, 'model');
    const graphSpelled = spelled('meaning.address', manifest.meaning.address, graphPin, 'meaning');
    if (!modelSpelled || !graphSpelled) return stop();
    modelAddress = normalisedModelAddress(modelPin);

    // The ModelSpec registry: the address (without its pin) is registered. Loaded when a shared model needs it.
    let modelRegistry;
    try { modelRegistry = await context.modelRegistry(); } catch (registryError) { bad(`ModelSpec registry: ${registryError.message}`); return stop(); }
    const registered = modelRegistry.byAddress.get(modelAddress);
    if (!registered) bad(`${data.manifest}: model.address ${modelAddress} is not registered in the ModelSpec registry (${modelRegistry.source}); register the model there first`);
    else {
      if (registeredModelAddress(registered) !== registered.address) bad(`the ModelSpec registry's record for ${registered.address} is not well formed (its repository and module must give that address)`);
      if (!(isRepositoryPath(registered.files?.source) && modelSourcePattern.test(registered.files.source) && isRepositoryPath(registered.files?.json))) bad(`the ModelSpec registry's record for ${registered.address} is not well formed (files.source must be a .modelspec.hcl path and files.json a path inside the repository)`);
      if (manifest.licences.model !== undefined && manifest.licences.model !== registered.licence) bad(`${data.manifest}: licences.model is ${manifest.licences.model}, but the ModelSpec registry records ${JSON.stringify(registered.licence)} for ${registered.address}; the model's licence comes from the registry, so leave licences.model out`);
    }

    // The MeaningGraph registry: the graph's address (without its pin) is registered, under the record's graph id.
    const graphMatches = graphsAtAddress(context.meaningRegistry, `meaning://${graphPin.repository}`);
    graph = graphMatches[0];
    if (graphMatches.length > 1) bad(`${data.manifest}: meaning.address meaning://${graphPin.repository} matches ${graphMatches.length} records of the MeaningGraph registry (${graphMatches.map((match) => match.id).join(', ')}), which differ only in case; the registry must list a repository once`);
    else if (!graph) bad(`${data.manifest}: meaning.address meaning://${graphPin.repository} is not registered in the MeaningGraph registry (${context.meaningRegistry.source}); register the graph there first`);
    else {
      if (graph.id !== data.meaning_graph) bad(`${data.manifest}: meaning.address names ${graph.address}, which the MeaningGraph registry registers as ${graph.id}, but the record's meaning_graph is ${data.meaning_graph}`);
      if (addressOf(graph.repository) !== graph.address) bad(`the MeaningGraph registry's record for ${graph.id} is not well formed (its repository ${graph.repository} must be the https URL whose meaning:// form is its address ${graph.address})`);
      if (manifest.meaning.graph.address !== undefined && manifest.meaning.graph.address !== graph.address) bad(`${data.manifest}: meaning.graph.address is ${manifest.meaning.graph.address}, but meaning.address names ${graph.address}; leave meaning.graph.address out or make it the unpinned address as the registry spells it`);
      if (manifest.licences.meaning !== undefined && manifest.licences.meaning !== graph.meaning_licence) bad(`${data.manifest}: licences.meaning is ${manifest.licences.meaning}, but the MeaningGraph registry records ${JSON.stringify(graph.meaning_licence)} for ${graph.id}; the meaning's licence comes from the registry, so leave licences.meaning out`);
    }
    if (problems.length) return stop();

    // Both repositories are read at the commits the manifest pins, which must be on their default branches. A pin
    // that differs from the registry's own is a warning, given once the pin is accepted (a refused pin is not read).
    const openPinned = (repository, commit, label) => {
      const repositoryUrl = urlFor(repository);
      try {
        if (!branches.has(repositoryUrl)) branches.set(repositoryUrl, defaultBranch(repositoryUrl));
        const branch = branches.get(repositoryUrl);
        if (!onBranch(repositoryUrl, branch, commit, historyDir, fetched)) {
          bad(`${data.manifest}: ${label} pins commit ${commit}, which is not in the history of ${branch}, the default branch of ${repository} (a commit only a fork or another branch has); pin a commit from ${branch}`);
          return null;
        }
        return openCommit(repositoryUrl, commit, cacheDir);
      } catch (openError) { bad(`${data.manifest}: ${label} ${commit}: ${openError.message}`); return null; }
    };
    const modelFiles = openPinned(registered.repository, modelPin.ref, 'model.address');
    const graphFiles = openPinned(graph.repository, graphPin.ref, 'meaning.address');
    if (modelFiles !== null && registered.commit !== modelPin.ref) warn(`model.address pins ${modelPin.ref}, but the ModelSpec registry registers ${registered.address} at ${shown(registered.commit)}; the pinned commit is read`);
    if (graphFiles !== null && graph.commit !== graphPin.ref) warn(`meaning.address pins ${graphPin.ref}, but the MeaningGraph registry registers ${graph.id} at ${shown(graph.commit)}; the pinned commit is read`);
    if (modelFiles === null || graphFiles === null) return stop();

    // The registries' paths (files.json, files.source, meaning_files) are the ones that hold at the registry's own
    // commit. At the same commit they are read as they are; at another pin they must exist there, and when they do not
    // the Directory does not guess where they moved: the problem names both commits.
    const moved = (what, registryCommit, pin) => (registryCommit === pin ? '' : ` (the ${what} names this path for its own commit ${shown(registryCommit)}; this manifest pins ${pin}, where the path is not there, so the files may have moved between the two. Pin the registry's commit, or wait until the registry follows)`);
    const modelMoved = moved('ModelSpec registry', registered.commit, modelPin.ref);
    const graphMoved = moved('MeaningGraph registry', graph.commit, graphPin.ref);
    const patterns = meaningFilesOf(graph);
    if (patterns === null) { bad(`the MeaningGraph registry's record for ${graph.id} is not well formed (meaning_files must be a list of file paths)`); return stop(); }
    if (!patterns.some((pattern) => graphFiles.match(pattern).includes(manifest.meaning.file))) { bad(`${data.manifest}: meaning.file ${manifest.meaning.file} is not one of the meaning files the MeaningGraph registry lists for ${graph.id} (${patterns.join(', ')}) at commit ${graphPin.ref}${graphMoved}`); return stop(); }

    // The ModelSpec JSON, at the model's pin; its module is the registered one.
    modelLabel = `${registered.files.json} of ${repositoryKey(registered.repository)}`;
    const modelText = text(registered.files.json, 'the registered model', modelFiles, modelPin.ref, modelMoved);
    const meaningText = text(manifest.meaning.file, 'meaning.file', graphFiles, graphPin.ref);
    if (modelText === null || meaningText === null) return stop();
    model = parseModelSpec(modelText);
    for (const problem of model.problems) bad(`${modelLabel}: ${problem}`);
    if (model.problems.length) return stop();
    if (model.module !== registered.module) { bad(`${modelLabel} is module ${model.module}, but the ModelSpec registry registers ${registered.address} as module ${registered.module}`); return stop(); }
    if (manifest.model.name !== undefined && manifest.model.name !== model.module) bad(`${data.manifest}: model.name is ${manifest.model.name}, but the ModelSpec at ${modelLabel} is module ${model.module}`);
    if (modelFiles.status(registered.files.source) !== 'file') bad(`the model source ${registered.files.source} of ${repositoryKey(registered.repository)} ${modelFiles.status(registered.files.source) === 'link' ? 'is not a regular file' : 'does not exist'} at commit ${modelPin.ref}${modelMoved}`);
    else modelPath = registered.files.source;
    publishedNames = checkRecordsets();

    // The meaning file, and which model it binds.
    if (!parseMeaningFile(meaningText)) return stop();
    const { declared, joined } = modelsEntry();
    const modelHomeKey = lowerKey(repositoryKey(registered.repository));
    const graphHomeKey = lowerKey(repositoryKey(graph.repository));
    if (typeof declared === 'string' && declared.startsWith('modelspec://')) {
      // A meaning file may name the model it binds by address, whichever repository it lives in.
      const named = parseModelAddress(declared);
      if (!named) bad(`${meaningFile}: the models entry ${JSON.stringify(declared)} for module ${model.module} is not a modelspec://{host}/{org}/{repo}/{module} address`);
      else if (normalisedModelAddress(named) !== modelAddress) bad(`${meaningFile}: the models entry for module ${model.module} names ${normalisedModelAddress(named)}, but ${data.manifest} pins the model ${modelAddress}`);
      else if (named.ref !== undefined && named.ref !== modelPin.ref) bad(`${meaningFile}: the models entry for module ${model.module} pins commit ${named.ref}, but ${data.manifest} pins ${modelPin.ref}`);
    } else if (joined === null) {
      bad(`${meaningFile}: models must name the ModelSpec module ${model.module} with a relative path that stays inside the repository (no leading /, no empty segment, no glob, no escaping with ..) or with its modelspec:// address, got ${JSON.stringify(declared)}`);
    } else if (!modelSourcePattern.test(joined)) {
      bad(`${meaningFile}: the ${model.module} model ${joined} must be a .modelspec.hcl file (the model's source)`);
    } else if (graphHomeKey !== modelHomeKey) {
      bad(`${meaningFile}: the meaning graph is in ${repositoryKey(graph.repository)} and the model ${modelAddress} in ${repositoryKey(registered.repository)}, and the models entry for module ${model.module} is the relative path ${declared}, which can only name a file of the meaning graph's own repository; the meaning file does not say which model it binds. Name the model in the meaning file by address (${modelAddress})`);
    } else if (graphPin.ref !== modelPin.ref) {
      // The graph and the model are in one repository and the entry is a relative path: that is the model file of the
      // graph's own commit, an implicit pin. It names the pinned model only when the two pins are one commit.
      bad(`${meaningFile}: the models entry for module ${model.module} is the relative path ${declared}, which is the model file of the meaning graph's own commit (${graphPin.ref}), but ${data.manifest} pins the model at ${modelPin.ref}; with the model and the meaning graph in one repository a relative path needs both pins to be the same commit. Pin one commit for both, or name the model in the meaning file by address (${modelAddress})`);
    } else if (joined !== registered.files.source) {
      bad(`${meaningFile}: the ${model.module} model is ${joined}, but the ModelSpec registry lists ${registered.files.source} as the source of ${modelAddress}`);
    }
    modelHome = { repository: registered.repository, commit: modelPin.ref };
  }

  // Addresses are spelled the way the MeaningGraph registry registers the graph (checked above
  // to be the canonical form of the same repository), whatever case the record uses.
  const own = { id: graph.id, address: graph.address.slice('meaning://'.length), ref: meaningRef, concepts: new Map() };
  for (const [position, concept] of doc.concepts.entries()) {
    const shape = validateConcept(concept, position, { bindings: true });
    if (shape.length) for (const problem of shape) bad(`${meaningFile}: ${problem}`);
    else if (own.concepts.has(concept.id)) bad(`${meaningFile}: concept ${concept.id} is declared twice`);
    else own.concepts.set(concept.id, concept);
  }
  const resolver = createMeaningResolver({ own, registry: context.meaningRegistry, urlFor, cacheDir, historyDir, fetched, branches });

  // Bindings tie concepts to recordsets and fields; each must name a real entity and property.
  const recordsets = new Map(publishedNames.map((name) => [name, { name, meanings: [], fields: new Map(model.entities.get(name).properties.map((property) => [property.name, { ...property, meanings: [] }])) }]));
  const modelHomeKey = modelHome && lowerKey(repositoryKey(modelHome.repository));
  const resolved = new Map();
  const chainsOf = (concept) => {
    if (!resolved.has(concept.id)) resolved.set(concept.id, resolver.chains(concept, own));
    return resolved.get(concept.id);
  };
  for (const concept of own.concepts.values()) {
    for (const binding of Array.isArray(concept.bindings) ? concept.bindings : []) {
      const where = `${meaningFile}: concept ${concept.id}`;
      const ref = typeof binding?.model === 'string' ? parseModelRef(binding.model) : null;
      if (!ref) { bad(`${where}: binding model ${JSON.stringify(binding?.model)} is not a modelspec:///{module}.{Entity} reference (the module and the entity name in a reference start with a letter, so an entity or module whose name starts with _ cannot be bound)`); continue; }
      if (ref.repo !== undefined) {
        // A binding may spell out the shared model's own address (and pin); any other model is not this database's.
        if (!(modelHome && lowerKey(ref.repo) === modelHomeKey && (ref.ref === undefined || ref.ref === modelHome.commit))) {
          bad(modelHome ? `${where}: binding ${binding.model} names a model other than the shared model ${modelAddress}` : `${where}: binding ${binding.model} names a model outside this database; bindings name this repository's own ModelSpec`);
          continue;
        }
      }
      if (ref.module !== model.module) { bad(`${where}: binding ${binding.model} names module ${ref.module}, but the ModelSpec at ${modelLabel} is module ${model.module}`); continue; }
      const recordset = recordsets.get(ref.name);
      if (!recordset) {
        if (model.entities.has(ref.name)) continue; // an entity of the shared model that this database does not list (recordsets_partial)
        bad(`${where}: binding ${binding.model} names an entity that is not in the ModelSpec`);
        continue;
      }
      let target;
      if (binding.property === undefined) {
        if (binding.role !== 'entity') { bad(`${where}: binding ${binding.model} with role ${binding.role} must name a property`); continue; }
        target = recordset;
      } else {
        if (typeof binding.property !== 'string' || !(target = recordset.fields.get(binding.property))) { bad(`${where}: binding ${binding.model} names property ${JSON.stringify(binding.property)}, which ${ref.name} does not have in the ModelSpec`); continue; }
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
    for (const problem of chains.problems) bad(`${meaningFile}: concept ${concept.id}: ${problem}`);
  }
  if (problems.length) return stop();

  // Every recordset url that is written is checked again with the full URL rules: the template was checked
  // with a stand-in name, and the real names must not change what it points at.
  const recordsetUrl = (name) => (manifest.deployment.recordset_page ? manifest.deployment.recordset_page.replace('{name}', name) : undefined);
  for (const name of publishedNames) {
    const url = recordsetUrl(name);
    const problem = url === undefined ? null : publicHttpsProblem(url);
    if (problem) bad(`${data.manifest}: the recordset page of ${name}, ${url}, ${problem}`);
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
    ...(manifest.homepage !== undefined ? { homepage: manifest.homepage } : {}),
    repository: data.repository,
    commit: data.commit,
    manifest: data.manifest,
    licence: manifest.licences.data,
    model: { name: model.module, path: modelPath, ...(modelAddress ? { address: modelAddress } : {}), ...(modelHome ? { repository: modelHome.repository, commit: modelHome.commit } : {}) },
    meaning_graph: { id: graph.id, address: graph.address },
    recordsets: [...recordsets.values()].sort(byName).map((recordset) => ({
      name: recordset.name,
      ...(manifest.deployment.recordset_page ? { url: recordsetUrl(recordset.name) } : {}),
      meanings: sorted(recordset.meanings),
      fields: [...recordset.fields.values()].map(({ name, type, references, meanings }) => ({ name, type, ...(references ? { references } : {}), meanings: sorted(meanings) })),
    })),
  };
  return { problems, warnings, entry, claims };
}

// ---- index.json ----

// Code-unit order, the same in every locale.
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// index.json: every database sorted by id, and a sha256 of the compact JSON.stringify
// of the databases array. The file itself is indented, so the checksum is a change
// token (compare it as a string); to verify a file, hash the compact serialisation
// of the parsed array.
export function indexText(entries) {
  const databases = [...entries].sort(byId);
  const checksum = `sha256:${createHash('sha256').update(JSON.stringify(databases)).digest('hex')}`;
  return `${JSON.stringify({ format: directoryFormat, checksum, databases }, null, 2)}\n`;
}

function sharedContext({ urlFor, cacheDir, meaningRegistry, modelRegistry, fetched = new Set(), branches = new Map() }) {
  const repositories = join(cacheDir, 'repositories');
  const history = join(cacheDir, 'history');
  // The two directories are plain directories, never links to somewhere else.
  ensurePlainDirectory(repositories);
  ensurePlainDirectory(history);
  return { urlFor, cacheDir: repositories, historyDir: history, meaningRegistry, modelRegistry, fetched, branches };
}

// Reads the MeaningGraph registry (a fetched index, or `meaningRegistry` as given) and
// analyses every database. The ModelSpec registry (`modelRegistry` as given, else fetched with
// `loadModelRegistry`) is read once, and only when a database names its model by address.
// { problems, warnings, entries }.
export async function analyseDirectory({ root, urlFor, cacheDir, meaningRegistry, loadRegistry = loadMeaningRegistry, modelRegistry, loadModelRegistry: loadModels = loadModelRegistry, ...rest } = {}) {
  const directory = readDirectory(root);
  const problems = [...directory.problems, ...recordProblems(directory)];
  const entries = [];
  const warnings = [];
  // The git cache is the user's, outside the checkout: nothing a pull request commits is ever read as cache.
  cacheDir ??= defaultCacheDir();
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const inside = relative(realpathSync(root), realpathSync(cacheDir));
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    problems.push(`the git cache ${cacheDir} is inside the checkout ${root}; it must live outside it (default: $XDG_CACHE_HOME/ovdb-directory)`);
    return { problems, warnings, entries, directory };
  }
  let registryIndex = meaningRegistry;
  try { registryIndex ??= await loadRegistry(); } catch (error) {
    problems.push(`MeaningGraph registry: ${error.message}`);
    return { problems, warnings, entries, directory };
  }
  // One read of the ModelSpec registry for the run, shared by every database that needs it.
  let loading;
  const modelIndex = () => (modelRegistry ? Promise.resolve(modelRegistry) : (loading ??= loadModels()));
  const context = sharedContext({ urlFor, cacheDir, meaningRegistry: registryIndex, modelRegistry: modelIndex, ...rest });
  const claimed = [];
  for (const record of directory.databases) {
    const result = await analyseDatabase(record, context);
    problems.push(...result.problems);
    warnings.push(...result.warnings);
    if (result.entry) entries.push(result.entry);
    if (result.claims) claimed.push(result.claims);
  }
  // Rules across records that need what each manifest says (see claimProblems).
  problems.push(...claimProblems(claimed));
  return { problems, warnings, entries, directory };
}

// What `npm run index` writes. Throws, naming every problem, when anything is wrong;
// `onWarning` is called with each warning (a pin that differs from a registry's).
export async function buildIndex({ onWarning, ...options } = {}) {
  const { problems, warnings, entries } = await analyseDirectory(options);
  for (const warning of warnings) onWarning?.(warning);
  if (problems.length) throw new Error(`cannot build index.json:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
  return indexText(entries);
}

// Every check: records, then each database at its commit, then index.json.
export async function checkDirectory(options = {}) {
  const { problems, warnings, entries, directory } = await analyseDirectory(options);
  const path = join(options.root, 'index.json');
  if (!existsSync(path)) problems.push('index.json is missing; run npm run index and commit it');
  else if (problems.length === 0 && readFileSync(path, 'utf8') !== indexText(entries)) problems.push('index.json differs from what npm run index writes; run it and commit the result');
  return { problems, warnings, databases: directory.databases.length };
}

export { addressOf, entryOf, parseConceptRef };
