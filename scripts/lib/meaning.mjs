// Reads meaning graphs through the MeaningGraph registry (CC0-1.0).
//
// A database's meaning file reaches other graphs by address:
// meaning://{host}/{org}/{repo}/{concept}?ref={commit}. The address names a
// graph registered in meaninggraph/registry (this module reads that
// registry's index.json), and the ref pins one commit of it. Each pin must be a
// full commit id in the history of the graph's default branch, and the
// graph's meaning files are read at exactly that commit, so a rebuild never
// reads something the publisher has not pinned.
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { addressOf, commitPattern, defaultBranch, onBranch, openCommit } from './git.mjs';
import { readRegistryText } from './registry-fetch.mjs';

export const meaningRegistryUrl = 'https://raw.githubusercontent.com/meaninggraph/registry/main/index.json';
export const meaningRegistryFormat = 'meaning-registry/draft-1';

// The shape of every id this repository publishes for a graph or a database: lower-case letters and digits in words
// joined by single hyphens. A graph id that comes from the MeaningGraph registry's index is held to it before it is
// used or published (it reaches index.json as `graph` in each meaning).
export const registryIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const graphIdProblem = (graph) => (typeof graph?.id === 'string' && registryIdPattern.test(graph.id)
  ? null
  : `the MeaningGraph registry's record for ${JSON.stringify(graph?.id)} is not well formed (its id must be lower-case letters and digits in words joined by single hyphens)`);

const conceptId = '[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*';
export const conceptIdPattern = new RegExp(`^${conceptId}$`);
const bareRefPattern = new RegExp(`^${conceptId}$`);
const conceptRefPattern = new RegExp(`^meaning://([A-Za-z0-9.-]+(?:/[A-Za-z0-9._-]+)+)/(${conceptId})(?:\\?ref=([A-Za-z0-9._/-]+))?$`);

// A bare id is a concept in the same graph; meaning://{host}/{org}/{repo}/{id}
// is a concept in another one (or the same one, pinned). Returns { id, repo?, ref? } or null.
export function parseConceptRef(ref) {
  if (typeof ref !== 'string') return null;
  if (bareRefPattern.test(ref)) return { id: ref };
  const match = conceptRefPattern.exec(ref);
  return match ? { repo: match[1], id: match[2], ref: match[3] } : null;
}

// meaning://{host}/{org}/{repo}, with ?ref={40 hex} for a graph read at a pin (a manifest that
// names its graph by address). Returns { repository: 'host/org/repo', ref? } or null.
const graphAddressPattern = /^meaning:\/\/([A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)(?:\?ref=([0-9a-f]{40}))?$/;
export function parseGraphAddress(address) {
  const match = typeof address === 'string' ? graphAddressPattern.exec(address) : null;
  return match ? { repository: match[1], ref: match[2] } : null;
}

// The English label, else the first label, else the id. (validateConcept has
// already refused labels that are not short plain strings.)
export const labelOf = (concept) => concept.labels?.en ?? Object.values(concept.labels ?? {})[0] ?? concept.id;

// The roles a binding can have. meaning/draft-1 has entity, identifier, display-name, foreign-key and value;
// meaning/draft-2 names two of them instances (earlier entity) and reference (earlier foreign-key) and accepts
// the earlier names. The builder reads a file's roles and keys the same way whatever its `format:` line says
// (it never reads that line), so both names are accepted in a file of either format.
const earlierRole = { instances: 'entity', reference: 'foreign-key' };
export const bindingRoles = ['entity', 'instances', 'identifier', 'display-name', 'foreign-key', 'reference', 'value'];

// The role as index.json has always spelled it: the earlier name of a role that draft-2 renamed. index.json
// keeps writing the earlier names until the builder's writer step (a later change) writes the current ones.
export const indexRole = (role) => earlierRole[role] ?? role;

// The key of a binding that names a field of the ModelSpec record type: `field` in meaning/draft-2, `property`
// in meaning/draft-1. Returns { key, name } for the key a binding writes (name is undefined when it writes
// neither), or null when it writes both: one binding line names its field once.
export const bindingField = (binding) => {
  if (binding.field !== undefined && binding.property !== undefined) return null;
  const key = binding.field !== undefined ? 'field' : 'property';
  return { key, name: binding[key] };
};

// Problems with the shape of a concept, before any of it is published: the id,
// the labels (short plain strings), extends and values-of (strings), and, when
// `bindings` is asked for, the bindings list and each role. Never throws, whatever the file holds.
export function validateConcept(concept, position, { bindings = false } = {}) {
  const problems = [];
  if (concept === null || typeof concept !== 'object' || Array.isArray(concept) || typeof concept.id !== 'string') return [`concept #${position + 1} has no id`];
  if (!conceptIdPattern.test(concept.id)) return [`concept id ${JSON.stringify(concept.id)} must be lower-case words joined by single hyphens`];
  const at = `concept ${concept.id}`;
  if (concept.labels !== undefined) {
    if (concept.labels === null || typeof concept.labels !== 'object' || Array.isArray(concept.labels)) problems.push(`${at}: labels must map language codes to labels`);
    else {
      for (const [language, label] of Object.entries(concept.labels)) {
        if (typeof label !== 'string' || label.trim() === '' || label.length > 200 || /[\u0000-\u001f\u007f<>]/.test(label)) problems.push(`${at}: the ${language} label must be a plain string of at most 200 characters (no control characters, < or >)`);
      }
    }
  }
  for (const key of ['extends', 'values-of']) {
    if (concept[key] !== undefined && typeof concept[key] !== 'string') problems.push(`${at}: ${key} must be a concept reference (a string)`);
  }
  if (bindings && concept.bindings !== undefined) {
    if (!Array.isArray(concept.bindings)) problems.push(`${at}: bindings must be a list`);
    else if (concept.bindings.some((binding) => binding === null || typeof binding !== 'object' || Array.isArray(binding))) problems.push(`${at}: every binding must be a mapping with model, role and property (field in meaning/draft-2)`);
    else {
      for (const binding of concept.bindings) {
        if (!bindingRoles.includes(binding.role)) problems.push(`${at}: binding role ${JSON.stringify(binding.role)} must be one of ${bindingRoles.join(', ')}`);
        if (bindingField(binding) === null) problems.push(`${at}: binding ${JSON.stringify(binding.model)} names its field with both field and property; write one of them (field in meaning/draft-2, property in meaning/draft-1)`);
      }
    }
  }
  return problems;
}

// The reference to a concept in a graph at a pinned commit.
export const entryOf = (node, concept) => ({ graph: node.id, concept: concept.id, label: labelOf(concept), address: `meaning://${node.address}/${concept.id}?ref=${node.ref}` });

// Validates a MeaningGraph registry index (its format and its checksum, the
// sha256 of the `graphs` array as compact JSON) and indexes it by id and address.
export function indexMeaningRegistry(index, source = 'the MeaningGraph registry') {
  if (index?.format !== meaningRegistryFormat) throw new Error(`${source} has format ${JSON.stringify(index?.format)}, expected ${meaningRegistryFormat}`);
  if (!Array.isArray(index.graphs)) throw new Error(`${source} has no graphs list`);
  const checksum = `sha256:${createHash('sha256').update(JSON.stringify(index.graphs)).digest('hex')}`;
  if (index.checksum !== checksum) throw new Error(`${source} does not match its own checksum (${index.checksum} is not ${checksum}); the fetch is incomplete or the file was edited`);
  return { source, byId: new Map(index.graphs.map((graph) => [graph.id, graph])), byAddress: new Map(index.graphs.map((graph) => [graph.address, graph])) };
}

// The path patterns of a registry record's `meaning_files`: a list of strings (none when the record
// has no such list), or null when it is anything else (a string, an object, a list that holds a
// non-string). A malformed registry record is a problem to report, never an exception.
export const meaningFilesOf = (graph) => {
  if (graph?.meaning_files === undefined) return [];
  return Array.isArray(graph.meaning_files) && graph.meaning_files.every((pattern) => typeof pattern === 'string') ? graph.meaning_files : null;
};

// The registered graphs at `address` (meaning://{host}/{org}/{repo}, no pin), compared ignoring case: GitHub does
// not tell host, organisation and repository apart by case, and the registry spells the address as the repository
// is written. Normally one graph; more than one means the registry lists the same repository twice.
export const graphsAtAddress = (registry, address) => [...registry.byAddress.values()].filter((graph) => typeof graph?.address === 'string' && graph.address.toLowerCase() === address.toLowerCase());

// Fetches and indexes meaninggraph/registry's index.json. Fails loudly: a build
// never falls back to stale or hand-written data.
export async function loadMeaningRegistry({ url = meaningRegistryUrl, ...fetching } = {}) {
  const text = await readRegistryText({ name: 'MeaningGraph registry', url, ...fetching });
  let index;
  try { index = JSON.parse(text); } catch (error) { throw new Error(`the MeaningGraph registry (${url}) is not JSON: ${error.message}`); }
  return indexMeaningRegistry(index, url);
}

const maxChain = 50;

// Resolves concepts across graphs. `own` is the database's own graph as a node
// { id, address, ref, concepts: Map(id -> concept) }; every other graph is read
// through `registry` at the commit its reference pins.
export function createMeaningResolver({ own, registry, urlFor = (url) => url, cacheDir, historyDir, fetched, branches }) {
  const nodes = new Map();

  const offBranch = (repository, commit) => {
    const url = urlFor(repository);
    if (!branches.has(url)) branches.set(url, defaultBranch(url));
    const branch = branches.get(url);
    return onBranch(url, branch, commit, historyDir, fetched) ? null : `commit ${commit} is not in the history of ${branch}, the default branch of ${repository} (a commit only a fork or another branch has)`;
  };

  const loadNode = (graph, ref) => {
    const ref0 = `${graph.address}?ref=${ref}`;
    const idProblem = graphIdProblem(graph);
    if (idProblem) return { error: `${ref0}: ${idProblem}, so it is not read` };
    if (addressOf(graph.repository) !== graph.address) return { error: `${ref0}: the MeaningGraph registry's record for ${graph.id} is not well formed (its repository must be the https URL whose meaning:// form is its address), so it is not read` };
    let files;
    try {
      const off = offBranch(graph.repository, ref);
      if (off) return { error: `${ref0}: ${off}` };
      files = openCommit(urlFor(graph.repository), ref, cacheDir);
    } catch (error) { return { error: `${ref0}: ${error.message}` }; }
    const concepts = new Map();
    const paths = new Set();
    const patterns = meaningFilesOf(graph);
    if (patterns === null) return { error: `${ref0}: the MeaningGraph registry's record for ${graph.id} is not well formed (meaning_files must be a list of file paths), so it is not read` };
    for (const pattern of patterns) {
      const matched = files.match(pattern);
      if (matched.length === 0) return { error: `${ref0}: ${pattern} not found at ${ref}` };
      matched.forEach((path) => paths.add(path));
    }
    for (const path of [...paths].sort()) {
      if (files.status(path) !== 'file') return { error: `${ref0}: ${path} is not a regular file at ${ref}` };
      let doc;
      try { doc = parseYaml(files.read(path)); } catch (error) { return { error: `${ref0}: ${path} is not YAML: ${error.message.split('\n')[0]}` }; }
      if (doc?.concepts !== undefined && !Array.isArray(doc.concepts)) return { error: `${ref0}: ${path}: concepts must be a list` };
      for (const [position, concept] of (doc?.concepts ?? []).entries()) {
        const shape = validateConcept(concept, position);
        if (shape.length) return { error: `${ref0}: ${path}: ${shape[0]}` };
        if (concepts.has(concept.id)) return { error: `${ref0}: concept ${concept.id} is declared twice` };
        concepts.set(concept.id, concept);
      }
    }
    return { id: graph.id, address: graph.address.slice('meaning://'.length), ref, concepts };
  };

  // meaning://{repo}?ref={commit} resolves through the MeaningGraph registry.
  const resolveGraph = (repo, ref) => {
    const matches = graphsAtAddress(registry, `meaning://${repo}`);
    const graph = matches[0];
    if (matches.length > 1) return { error: `meaning://${repo} matches ${matches.length} records of the MeaningGraph registry (${matches.map((match) => match.id).join(', ')}), which differ only in case` };
    if (!graph) return { error: `meaning://${repo} is not registered in the MeaningGraph registry` };
    if (ref === undefined) return { error: `meaning://${repo} needs a ?ref= pin` };
    if (!commitPattern.test(ref)) return { error: `meaning://${repo}?ref=${ref}: a pin is a full 40-character commit id` };
    const key = `${graph.id}@${ref}`;
    if (!nodes.has(key)) nodes.set(key, loadNode(graph, ref));
    return nodes.get(key);
  };

  // Resolves `ref` as written inside `node`: bare ids and the node's own
  // unpinned address are in the node; the rest go through the registry.
  const resolveConcept = (ref, node) => {
    const parsed = parseConceptRef(ref);
    if (!parsed) return { error: `"${ref}" is not a concept reference` };
    const inside = !parsed.repo || (parsed.ref === undefined && parsed.repo.toLowerCase() === node.address.toLowerCase());
    const target = inside ? node : resolveGraph(parsed.repo, parsed.ref);
    if (target.error) return { error: target.error };
    const concept = target.concepts.get(parsed.id);
    return concept ? { concept, node: target } : { error: `${ref} names concept ${parsed.id}, which ${target.id} does not have at ${target.ref}` };
  };

  // The concepts a concept is a kind of, nearest first (not the concept itself),
  // as entries. A chain that loops or is longer than maxChain is a problem, never
  // silently cut.
  const lineage = (concept, node) => {
    const problems = [];
    const chain = [];
    const seen = new Set();
    for (let current = { concept, node }; current;) {
      const id = `${current.node.address}@${current.node.ref}/${current.concept.id}`;
      if (seen.has(id)) { problems.push(`extends returns to ${current.concept.id}`); break; }
      seen.add(id);
      chain.push(current);
      if (current.concept.extends === undefined) break;
      if (chain.length > maxChain) { problems.push(`extends chain is longer than ${maxChain} concepts`); break; }
      const next = resolveConcept(current.concept.extends, current.node);
      if (next.error) { problems.push(`extends: ${next.error}`); break; }
      current = next;
    }
    return { entries: chain.slice(1).map((entry) => entryOf(entry.node, entry.concept)), problems };
  };

  // The `extends` chain of a concept, nearest first, and the concept its values
  // are those of: its own `values-of` only (a concept that extends one with a
  // `values-of` does not carry it). The values_of entry carries its own `extends`
  // chain, so a page for a broader concept still finds the field.
  const chains = (concept, node) => {
    const own = lineage(concept, node);
    const problems = [...own.problems];
    let valuesOf;
    if (concept['values-of'] !== undefined) {
      const target = resolveConcept(concept['values-of'], node);
      if (target.error) problems.push(`values-of: ${target.error}`);
      else {
        const targetChain = lineage(target.concept, target.node);
        problems.push(...targetChain.problems.map((problem) => `values-of ${target.concept.id}: ${problem}`));
        valuesOf = { ...entryOf(target.node, target.concept), extends: targetChain.entries };
      }
    }
    return { extends: own.entries, valuesOf, problems };
  };

  return { chains, resolveConcept };
}
