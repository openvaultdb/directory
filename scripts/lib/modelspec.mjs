// Reads a ModelSpec JSON file (CC0-1.0): the entities and properties that
// recordsets and fields are named after.

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

// modelspec://{host}/{org}/{repo}/{module}, with ?ref={40 hex} only for a model in
// another repository. Returns { repository: 'host/org/repo', module, ref? } or null;
// the host must be one the Directory reads (see repositoryKey in git.mjs).
const modelAddressPattern = /^modelspec:\/\/([A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/([A-Za-z_][A-Za-z0-9_]*)(?:\?ref=([0-9a-f]{40}))?$/;
export function parseModelAddress(address) {
  const match = typeof address === 'string' ? modelAddressPattern.exec(address) : null;
  return match ? { repository: match[1], module: match[2], ref: match[3] } : null;
}

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
