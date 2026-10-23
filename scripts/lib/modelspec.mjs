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

// The legacy address/binding identifier grammar. Source declaration names are broader.
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
// Go strings.TrimSpace uses Unicode White_Space (NEL is blank; FEFF is not).
export const sourceName = (name) => typeof name === 'string' && !/^\p{White_Space}*$/u.test(name);
export const conceptName = (name) => sourceName(name) && !name.includes('.') && !reservedNames.includes(name);
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
  for (const [group, fieldsKey] of [[vocabulary.records, vocabulary.fields], ['components', 'fields']]) {
    for (const [name, declaration] of Object.entries(isObject(doc[group]) ? doc[group] : {})) {
      if (!isObject(declaration)) continue;
      if (group === vocabulary.records && Object.hasOwn(declaration, foreign.fields)) problems.push(wrong(`${vocabulary.record} ${name}: `, foreign.fields, vocabulary.fields));
      if (group === 'components' && Object.hasOwn(declaration, 'properties')) problems.push(`component ${name}: members are always spelled "fields", not "properties"`);
      for (const [memberName, member] of Object.entries(isObject(declaration[fieldsKey]) ? declaration[fieldsKey] : {})) {
        if (isObject(member) && Object.hasOwn(member, foreign.record)) problems.push(wrong(`${name}.${memberName}: `, foreign.record, vocabulary.record));
      }
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

// A finite dataset field view beside the source, not a replacement AST. Keep the
// original JSON text and declarations: JSON.parse alone cannot preserve source bytes.
// Only top-level record uses contribute fields; a component-valued field stays one
// field. Own fields override inherited fields before conflicts are considered.
export function parseModelSpec(text) {
  const problems = [];
  const diagnostics = [];
  let doc;
  try { doc = JSON.parse(text); } catch (error) { return { problems: [`is not JSON: ${error.message}`] }; }
  if (!isObject(doc)) return { problems: ['a ModelSpec JSON document must be an object'] };
  const vocabulary = readingVocabulary(doc);
  problems.push(...modelWordProblems(doc, vocabulary));
  if (typeof doc.modelspec !== 'string') problems.push('has no "modelspec" version');
  const module = doc.module?.name;
  if (module !== undefined && !sourceName(module)) problems.push('module.name must be a nonblank string');
  const declarations = { records: new Map(), components: new Map(), enums: new Map() };
  const allNames = new Set();
  for (const [group, key, kind] of [['records', vocabulary.records, vocabulary.record], ['components', 'components', 'component'], ['enums', 'enums', 'enum']]) {
    if (doc[key] !== undefined && !isObject(doc[key])) { problems.push(`${key} must be an object`); continue; }
    for (const [name, declaration] of Object.entries(doc[key] ?? {})) {
      if (!conceptName(name)) problems.push(reservedNames.includes(name)
        ? `${kind} name ${JSON.stringify(name)} is a reserved word and cannot name a concept`
        : `${kind} name ${JSON.stringify(name)} must be nonblank and contain no dot`);
      if (allNames.has(name)) problems.push(`concept name ${JSON.stringify(name)} is declared more than once`);
      allNames.add(name);
      if (!isObject(declaration)) { problems.push(`${kind} ${name} must be an object`); continue; }
      const fields = new Map();
      const references = [];
      const use = declaration.use ?? [];
      if (group === 'records' && (!Array.isArray(use) || use.some((ref) => typeof ref !== 'string'))) problems.push(`${kind} ${name} use must be a list of strings`);
      const entry = { name, kind: group, source: declaration, fields, use: Array.isArray(use) ? use : [], references };
      declarations[group].set(name, entry);
      if (group === 'enums') continue;
      const fieldsKey = group === 'records' ? vocabulary.fields : 'fields';
      const fieldDocs = declaration[fieldsKey];
      if (fieldDocs !== undefined && !isObject(fieldDocs)) { problems.push(`${kind} ${name} ${fieldsKey} must be an object`); continue; }
      for (const [fieldName, field] of Object.entries(fieldDocs ?? {})) {
        const where = `${name}.${fieldName}`;
        if (!sourceName(fieldName)) problems.push(`${vocabulary.field} name ${JSON.stringify(where)} must be nonblank`);
        if (!isObject(field)) { problems.push(`${where} must be an object`); continue; }
        const kinds = ['type', vocabulary.record, 'component'].filter((key) => Object.hasOwn(field, key));
        if (kinds.length !== 1) { problems.push(`${where} has neither a type nor ${/^[aeiou]/.test(vocabulary.record) ? 'an' : 'a'} ${vocabulary.record}, or does not have exactly one of type, ${vocabulary.record} and component`); continue; }
        const key = kinds[0];
        if (typeof field[key] !== 'string') { problems.push(`${where} ${key} must be a string`); continue; }
        if (key === 'type' && !typePattern.test(field.type)) problems.push(`${where} has type ${JSON.stringify(field.type)}, which is not a type name`);
        const property = key === 'type' ? { name: fieldName, type: field.type }
          : { name: fieldName, type: key === 'component' ? 'component' : 'reference', references: field[key] };
        const member = { name: fieldName, source: field, property, references: [] };
        fields.set(fieldName, member);
        for (const [refKey, targetKind] of [[vocabulary.record, 'records'], ['component', 'components'], ['enum', 'enums']]) {
          if (typeof field[refKey] === 'string') {
            const ref = { reference: field[refKey], kind: targetKind, where, member: fieldName };
            member.references.push(ref); references.push(ref);
          }
        }
      }
      if (group === 'records') for (const reference of entry.use) if (typeof reference === 'string') references.push({ reference, kind: 'components', where: `${kind} ${name} use`, use: true });
    }
  }
  // Validate every reference independently of dataset traversal, including unused
  // components. A known self qualifier never downgrades a missing local target.
  for (const declarationsOfKind of Object.values(declarations)) for (const declaration of declarationsOfKind.values()) {
    for (const ref of declaration.references) {
      const parts = ref.reference.split('.');
      if (parts.length > 2 || parts.some((part) => part === '')) {
        problems.push(`${ref.where} reference ${JSON.stringify(ref.reference)} is not a bare name or a <module>.<Name> reference`);
        continue;
      }
      const local = parts.length === 1 || module !== undefined && parts[0] === module;
      if (local) {
        ref.localTarget = parts.at(-1);
        if (!declarations[ref.kind].has(ref.localTarget)) problems.push(`${ref.where} references ${ref.kind === 'records' ? vocabulary.record : ref.kind.slice(0, -1)} ${ref.reference}, which the ModelSpec does not have`);
      } else {
        diagnostics.push({ code: 'qualified-reference-unavailable', declaration: declaration.name, reference: ref.reference, kind: ref.kind });
      }
    }
  }
  const entities = new Map();
  for (const record of declarations.records.values()) {
    const inherited = new Map();
    const own = new Set(record.fields.keys());
    const usedComponents = new Set();
    const recordDiagnostics = [];
    let fieldSetComplete = true;
    for (const ref of record.references.filter((ref) => ref.use)) {
      const component = declarations.components.get(ref.localTarget);
      if (!component) {
        fieldSetComplete = false;
        recordDiagnostics.push({ code: 'field-set-unavailable', record: record.name, reference: ref.reference });
        continue;
      }
      if (usedComponents.has(component)) continue;
      usedComponents.add(component);
      for (const [name, field] of component.fields) {
        if (own.has(name)) continue;
        if (!inherited.has(name)) inherited.set(name, new Map());
        inherited.get(name).set(component.name, field);
      }
    }
    const effectiveFields = new Map(record.fields);
    for (const [name, origins] of inherited) {
      if (origins.size > 1) {
        fieldSetComplete = false;
        recordDiagnostics.push({ code: 'ambiguous-inherited-field', record: record.name, field: name, origins: [...origins.keys()] });
      } else effectiveFields.set(name, origins.values().next().value);
    }
    diagnostics.push(...recordDiagnostics);
    entities.set(record.name, { properties: [...effectiveFields.values()].map((field) => field.property), effectiveFields, fieldSetComplete, diagnostics: recordDiagnostics });
  }
  return { module, entities, problems, diagnostics, source: { text, document: doc, declarations }, earlierSpelling: vocabularyOf(doc) === earlier };
}

// Reference closure for a dataset proof. Walk component values and top-level uses
// by local declaration identity; nested cycles terminate. Record edges are returned
// to the caller, which requires a mapped recordset for every known local target.
export function recordReferenceClosure(model, name) {
  const targets = new Set();
  const unavailable = new Set();
  const seen = new Set();
  const record = model.entities.get(name);
  for (const diagnostic of record?.diagnostics ?? []) if (diagnostic.code === 'field-set-unavailable') unavailable.add(diagnostic.reference);
  const pending = record ? [{ references: [...record.effectiveFields.values()].flatMap((field) => field.references) }] : [];
  while (pending.length) {
    const declaration = pending.pop();
    if (seen.has(declaration)) continue;
    seen.add(declaration);
    for (const ref of declaration.references) {
      if (ref.kind === 'enums') continue;
      if (ref.localTarget === undefined) { unavailable.add(ref.reference); continue; }
      if (ref.kind === 'records') targets.add(ref.localTarget);
      else {
        const component = model.source.declarations.components.get(ref.localTarget);
        if (component) pending.push(component);
      }
    }
  }
  return { targets, unavailable, complete: unavailable.size === 0 };
}

export const earlierSpellingNotice = (label) => `${label} is in the earlier ModelSpec spelling (format ${earlier.identifier}: entities, properties); it is still read. Run modelspec rewrite --write <folder> on the folder that holds it to move it to ${current.identifier}`;
