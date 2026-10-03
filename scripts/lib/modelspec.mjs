// Reads a ModelSpec JSON file (CC0-1.0): the entities and properties that
// recordsets and fields are named after, and the ModelSpec registry's index, which
// says where a model that lives in another repository is published.
import { createHash } from 'node:crypto';
import { repositoryKey } from './git.mjs';
import { readRegistryText } from './registry-fetch.mjs';

export const modelRegistryDefaultUrl = 'https://raw.githubusercontent.com/modelspec-org/registry/main/index.json';
export const modelRegistryFormat = 'modelspec-registry/draft-1';

// modelspec:///{module}.{Entity} (this repository's own model), or
// modelspec://{host}/{org}/{repo}/{module}.{Entity} (another repository's, with `repo` set).
const modelRefPattern = /^modelspec:\/\/((?:[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._-]+)+)?)\/([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)(?:\?ref=([A-Za-z0-9._/-]+))?$/;
export function parseModelRef(ref) {
  const match = modelRefPattern.exec(ref);
  if (!match) return null;
  return { repo: match[1] || undefined, module: match[2], name: match[3], ref: match[4] };
}

// A name that is safe to publish and to put in a URL path and an HTML anchor:
// an identifier. ModelSpec entity and property names, and module names, are these.
export const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A property type: a word, optionally a list (`string`, `int`, `decimal`, `datetime[]`).
const typePattern = /^[A-Za-z][A-Za-z0-9_]*(?:\[\])?$/;

// modelspec://{host}/{org}/{repo}/{module}, with ?ref={40 hex} for a model in another
// repository (a shared model: the pin says which commit of it is read). Returns
// { repository: 'host/org/repo', module, ref? } or null; whether the host is one the
// Directory reads (see repositoryKey in git.mjs) is the caller's check.
const modelAddressPattern = /^modelspec:\/\/([A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/([A-Za-z_][A-Za-z0-9_]*)(?:\?ref=([0-9a-f]{40}))?$/;
export function parseModelAddress(address) {
  const match = typeof address === 'string' ? modelAddressPattern.exec(address) : null;
  return match ? { repository: match[1], module: match[2], ref: match[3] } : null;
}

// The model's address without its pin, as the ModelSpec registry spells it: the host,
// organisation and repository in lower case (GitHub does not tell them apart by case),
// the module as written (a module name is case-sensitive).
export const normalisedModelAddress = ({ repository, module }) => `modelspec://${repository.toLowerCase()}/${module}`;

// Validates a ModelSpec registry index (its format and its checksum, the sha256 of the
// `models` array as compact JSON, the same definition as the MeaningGraph registry's)
// and indexes it by normalised address. A repeated address is refused: which record is
// the model's would be a guess.
export function indexModelRegistry(index, source = 'the ModelSpec registry') {
  if (index?.format !== modelRegistryFormat) throw new Error(`${source} has format ${JSON.stringify(index?.format)}, expected ${modelRegistryFormat}`);
  if (!Array.isArray(index.models)) throw new Error(`${source} has no models list`);
  const checksum = `sha256:${createHash('sha256').update(JSON.stringify(index.models)).digest('hex')}`;
  if (index.checksum !== checksum) throw new Error(`${source} does not match its own checksum (${index.checksum} is not ${checksum}); the fetch is incomplete or the file was edited`);
  const byAddress = new Map();
  for (const model of index.models) {
    if (typeof model?.address !== 'string') continue;
    if (byAddress.has(model.address)) throw new Error(`${source} registers ${model.address} twice`);
    byAddress.set(model.address, model);
  }
  return { source, byAddress };
}

// Fetches and indexes the ModelSpec registry's index.json: MODELSPEC_REGISTRY_INDEX_URL, else
// the default branch of modelspec-org/registry. The URL must be https on raw.githubusercontent.com or
// github.com (checked in readRegistryText, so no caller can pass a data:, file: or http: URL, or another host).
// Tests that must not touch the network pass `fetchImpl`, which stands in for the fetch. Fails loudly: a build never falls back
// to stale or hand-written data. Each read has a timeout and one retry (registry-fetch.mjs); `fetchImpl`,
// `timeoutMs` and `retryDelayMs` are for tests.
export async function loadModelRegistry({ url = process.env.MODELSPEC_REGISTRY_INDEX_URL || modelRegistryDefaultUrl, ...fetching } = {}) {
  const text = await readRegistryText({ name: 'ModelSpec registry', url, envName: 'MODELSPEC_REGISTRY_INDEX_URL', ...fetching });
  let index;
  try { index = JSON.parse(text); } catch (error) { throw new Error(`the ModelSpec registry (${url}) is not JSON: ${error.message}`); }
  return indexModelRegistry(index, url);
}

// The registry's records at `address` (normalised, no pin), compared the way a manifest's address is
// normalised: host, organisation and repository ignoring case, the module as written. Normally one;
// more than one means the registry lists the same model twice.
export const modelsAtAddress = (registry, address) => [...registry.byAddress.values()].filter((record) => {
  const parsed = parseModelAddress(record?.address);
  return parsed !== null && parsed.ref === undefined && normalisedModelAddress(parsed) === address;
});

// Whether a record's repository and module give the address it is registered under (ignoring the case of the
// host, organisation and repository, as the lookup does).
export const addressMatchesRecord = (record) => registeredModelAddress(record) === normalisedModelAddress(parseModelAddress(record.address));

// The address a registry record must have: its repository and module.
export const registeredModelAddress = (record) => (repositoryKey(record?.repository) && typeof record.module === 'string' ? normalisedModelAddress({ repository: repositoryKey(record.repository), module: record.module }) : null);

// { module, entities: Map(name -> { properties: [{ name, type, references? }] }), problems }.
// A property is either a scalar (`type`) or a reference to another entity
// (`entity`, no `type`). A reference has type "reference" and `references`
// names the entity it points at.
export function parseModelSpec(text) {
  const problems = [];
  let doc;
  try { doc = JSON.parse(text); } catch (error) { return { problems: [`is not JSON: ${error.message}`] }; }
  const entitiesDoc = doc?.entities;
  if (typeof doc?.modelspec !== 'string') problems.push('has no "modelspec" version');
  const module = doc?.module?.name;
  if (typeof module !== 'string' || !identifierPattern.test(module)) problems.push('has no module.name that is an identifier');
  if (entitiesDoc === null || typeof entitiesDoc !== 'object' || Array.isArray(entitiesDoc) || Object.keys(entitiesDoc).length === 0) {
    problems.push('has no entities');
    return { problems };
  }
  const entities = new Map();
  for (const [name, entity] of Object.entries(entitiesDoc)) {
    if (!identifierPattern.test(name)) { problems.push(`entity name ${JSON.stringify(name)} must be an identifier (letters, digits and _, not starting with a digit)`); continue; }
    const propertiesDoc = entity?.properties;
    if (propertiesDoc === null || typeof propertiesDoc !== 'object' || Array.isArray(propertiesDoc) || Object.keys(propertiesDoc).length === 0) { problems.push(`entity ${name} has no properties`); continue; }
    const properties = [];
    for (const [propertyName, property] of Object.entries(propertiesDoc)) {
      if (!identifierPattern.test(propertyName)) { problems.push(`property name ${JSON.stringify(`${name}.${propertyName}`)} must be an identifier (letters, digits and _, not starting with a digit)`); continue; }
      if (typeof property?.type === 'string' && !typePattern.test(property.type)) { problems.push(`${name}.${propertyName} has type ${JSON.stringify(property.type)}, which is not a type name`); continue; }
      if (typeof property?.type !== 'string' && typeof property?.entity !== 'string') { problems.push(`${name}.${propertyName} has neither a type nor an entity`); continue; }
      if (typeof property.type !== 'string' && !Object.hasOwn(entitiesDoc, property.entity)) { problems.push(`${name}.${propertyName} references entity ${property.entity}, which the ModelSpec does not have`); continue; }
      properties.push(typeof property.type === 'string' ? { name: propertyName, type: property.type } : { name: propertyName, type: 'reference', references: property.entity });
    }
    entities.set(name, { properties });
  }
  return { module, entities, problems };
}
