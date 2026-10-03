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

export const meaningRegistryUrl = 'https://raw.githubusercontent.com/meaninggraph/registry/main/index.json';
export const meaningRegistryFormat = 'meaning-registry/draft-1';

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

// The English label, else the first label, else the id.
export const labelOf = (concept) => concept.labels?.en ?? Object.values(concept.labels ?? {})[0] ?? concept.id;

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

// Fetches and indexes meaninggraph/registry's index.json. Fails loudly: a build
// never falls back to stale or hand-written data.
export async function loadMeaningRegistry({ url = meaningRegistryUrl, fetchImpl = fetch } = {}) {
  let response;
  try { response = await fetchImpl(url, { redirect: 'error' }); } catch (error) { throw new Error(`cannot read ${url}: ${error.message}`); }
  if (!response.ok) throw new Error(`cannot read ${url}: HTTP ${response.status}`);
  let index;
  try { index = JSON.parse(await response.text()); } catch (error) { throw new Error(`${url} is not JSON: ${error.message}`); }
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
    if (addressOf(graph.repository) !== graph.address) return { error: `${ref0}: the MeaningGraph registry's record for ${graph.id} is not well formed (its repository must be the https URL whose meaning:// form is its address), so it is not read` };
    let files;
    try {
      const off = offBranch(graph.repository, ref);
      if (off) return { error: `${ref0}: ${off}` };
      files = openCommit(urlFor(graph.repository), ref, cacheDir);
    } catch (error) { return { error: `${ref0}: ${error.message}` }; }
    const concepts = new Map();
    const paths = new Set();
    for (const pattern of graph.meaning_files ?? []) {
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
        if (concept === null || typeof concept !== 'object' || typeof concept.id !== 'string') return { error: `${ref0}: ${path}: concept #${position + 1} has no id` };
        if (!conceptIdPattern.test(concept.id)) return { error: `${ref0}: ${path}: concept id ${JSON.stringify(concept.id)} must be lower-case words joined by single hyphens` };
        if (concepts.has(concept.id)) return { error: `${ref0}: concept ${concept.id} is declared twice` };
        concepts.set(concept.id, concept);
      }
    }
    return { id: graph.id, address: graph.address.slice('meaning://'.length), ref, concepts };
  };

  // meaning://{repo}?ref={commit} resolves through the MeaningGraph registry.
  const resolveGraph = (repo, ref) => {
    const graph = registry.byAddress.get(`meaning://${repo}`);
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
    const inside = !parsed.repo || (parsed.ref === undefined && parsed.repo === node.address);
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
