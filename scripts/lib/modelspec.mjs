// Reads a ModelSpec JSON file (CC0-1.0): the record types and members that
// recordsets and fields are named after, and the ModelSpec registry's index, which
// says where a model that lives in another repository is published.
//
// A model is read in either spelling of ModelSpec's vocabulary (decisions 0018, 0019
// and 0020 of specscore/modelspec): format `1.0-draft`, the earlier spelling, with
// `entities`, `properties` and `entity`; format `1.0-draft-2`, the current one, with
// `records`, `fields` and `record`. What this module returns keeps the earlier words
// (`entities`, `properties`, `references`) whichever spelling was read: the index the
// Directory writes does not change with this reader. The tables below are the registry
// module's (modelspec-org/registry, scripts/lib/modelspec.mjs); this copy has only
// what a reader of JSON models needs, and checks what it always checked.
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
// The two vocabularies, the whole of what differs between them. The JSON identifier decides which one a
// document is in. `record` is the key of a member that names a record type; `records` and `fields` are the
// keys of a document's record types and of a record type's members.
export const vocabularies = {
  earlier: { identifier: '1.0-draft', record: 'entity', field: 'property', records: 'entities', fields: 'properties' },
  current: { identifier: '1.0-draft-2', record: 'record', field: 'field', records: 'records', fields: 'fields' },
};
const { earlier, current } = vocabularies;
// The vocabulary an identifier names, or undefined.
export const vocabularyOf = (doc) => [current, earlier].find((words) => words.identifier === doc?.modelspec);
const otherThan = (vocabulary) => (vocabulary === earlier ? current : earlier);
// A reader that has always accepted any string as the version reads one it does not know in the earlier
// spelling, as it did.
const readingVocabulary = (doc) => vocabularyOf(doc) ?? earlier;

// Names that no concept may have (the kind words of the format; `records` joined them with the rename).
export const reservedNames = ['records', 'entities', 'components', 'enums', 'collections', 'recordsets'];
// Constructs of earlier drafts that a reader refuses, by the top-level JSON field that holds them: removed
// ones were part of the language, reserved ones are kept free for a later version (decision 0019).
const refusedFields = [
  { field: 'collections', status: 'removed' },
  { field: 'recordsets', status: 'removed' },
  { field: 'projections', status: 'reserved' },
  { field: 'migrations', status: 'reserved' },
];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// What is wrong with the words of a document, whichever vocabulary it is in: a removed or reserved
// top-level field, and a key of the other vocabulary (the identifier decides, so a document that mixes the
// two is an error). Only objects are looked into; the shape of the rest is the reader's to report.
export function modelWordProblems(doc, vocabulary) {
  const problems = [];
  for (const { field, status } of refusedFields) {
    if (Object.hasOwn(doc, field)) {
      problems.push(status === 'removed' ? `the ${field} field was removed from ModelSpec (decision 0019)` : `the ${field} field is reserved by ModelSpec and has no content (decision 0019); remove it`);
    }
  }
  const foreign = otherThan(vocabulary);
  const wrong = (where, key, own) => `${where}"${key}" is a key of format ${foreign.identifier}; this document says "${vocabulary.identifier}", where it is "${own}"`;
  if (Object.hasOwn(doc, foreign.records)) problems.push(wrong('', foreign.records, vocabulary.records));
  for (const [name, record] of Object.entries(isObject(doc[vocabulary.records]) ? doc[vocabulary.records] : {})) {
    if (!isObject(record)) continue;
    if (Object.hasOwn(record, foreign.fields)) problems.push(wrong(`${vocabulary.record} ${name}: `, foreign.fields, vocabulary.fields));
    for (const [memberName, member] of Object.entries(isObject(record[vocabulary.fields]) ? record[vocabulary.fields] : {})) {
      if (isObject(member) && Object.hasOwn(member, foreign.record)) problems.push(wrong(`${name}.${memberName}: `, foreign.record, vocabulary.record));
    }
  }
  return problems;
}

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

// { module, entities: Map(name -> { properties: [{ name, type, references? }] }), problems, earlierSpelling }.
// A property is either a scalar (`type`) or a reference to another entity (`entity` in the earlier spelling,
// `record` in the current one, no `type`). A reference has type "reference" and `references` names the entity
// it points at. The result keeps the earlier words whichever spelling was read; `earlierSpelling` is true when
// the document is in format 1.0-draft, so that the caller can say so.
export function parseModelSpec(text) {
  const problems = [];
  let doc;
  try { doc = JSON.parse(text); } catch (error) { return { problems: [`is not JSON: ${error.message}`] }; }
  const vocabulary = readingVocabulary(doc);
  const entitiesDoc = doc?.[vocabulary.records];
  if (isObject(doc)) problems.push(...modelWordProblems(doc, vocabulary));
  if (typeof doc?.modelspec !== 'string') problems.push('has no "modelspec" version');
  const module = doc?.module?.name;
  if (typeof module !== 'string' || !identifierPattern.test(module)) problems.push('has no module.name that is an identifier');
  if (entitiesDoc === null || typeof entitiesDoc !== 'object' || Array.isArray(entitiesDoc) || Object.keys(entitiesDoc).length === 0) {
    problems.push(`has no ${vocabulary.records}`);
    return { problems };
  }
  const entities = new Map();
  for (const [name, entity] of Object.entries(entitiesDoc)) {
    if (!identifierPattern.test(name)) { problems.push(`${vocabulary.record} name ${JSON.stringify(name)} must be an identifier (letters, digits and _, not starting with a digit)`); continue; }
    if (reservedNames.includes(name)) { problems.push(`${vocabulary.record} name ${JSON.stringify(name)} is a reserved word and cannot name a concept`); continue; }
    const propertiesDoc = entity?.[vocabulary.fields];
    if (propertiesDoc === null || typeof propertiesDoc !== 'object' || Array.isArray(propertiesDoc) || Object.keys(propertiesDoc).length === 0) { problems.push(`${vocabulary.record} ${name} has no ${vocabulary.fields}`); continue; }
    const properties = [];
    for (const [propertyName, property] of Object.entries(propertiesDoc)) {
      if (!identifierPattern.test(propertyName)) { problems.push(`${vocabulary.field} name ${JSON.stringify(`${name}.${propertyName}`)} must be an identifier (letters, digits and _, not starting with a digit)`); continue; }
      if (typeof property?.type === 'string' && !typePattern.test(property.type)) { problems.push(`${name}.${propertyName} has type ${JSON.stringify(property.type)}, which is not a type name`); continue; }
      const reference = property?.[vocabulary.record];
      if (typeof property?.type !== 'string' && typeof reference !== 'string') { problems.push(`${name}.${propertyName} has neither a type nor ${/^[aeiou]/.test(vocabulary.record) ? 'an' : 'a'} ${vocabulary.record}`); continue; }
      if (typeof property.type !== 'string' && !Object.hasOwn(entitiesDoc, reference)) { problems.push(`${name}.${propertyName} references ${vocabulary.record} ${reference}, which the ModelSpec does not have`); continue; }
      properties.push(typeof property.type === 'string' ? { name: propertyName, type: property.type } : { name: propertyName, type: 'reference', references: reference });
    }
    entities.set(name, { properties });
  }
  return { module, entities, problems, earlierSpelling: vocabularyOf(doc) === earlier };
}

// The line a notice about a model file in the earlier spelling says (a warning, never an error).
export const earlierSpellingNotice = (label) => `${label} is in the earlier ModelSpec spelling (format ${earlier.identifier}: entities, properties); it is still read. Run modelspec rewrite --write <folder> on the folder that holds it to move it to ${current.identifier}`;
