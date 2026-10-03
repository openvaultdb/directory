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
  if (typeof module !== 'string' || !module) problems.push('has no module.name');
  if (entitiesDoc === null || typeof entitiesDoc !== 'object' || Array.isArray(entitiesDoc) || Object.keys(entitiesDoc).length === 0) {
    problems.push('has no entities');
    return { problems };
  }
  const entities = new Map();
  for (const [name, entity] of Object.entries(entitiesDoc)) {
    const propertiesDoc = entity?.properties;
    if (propertiesDoc === null || typeof propertiesDoc !== 'object' || Array.isArray(propertiesDoc) || Object.keys(propertiesDoc).length === 0) { problems.push(`entity ${name} has no properties`); continue; }
    const properties = [];
    for (const [propertyName, property] of Object.entries(propertiesDoc)) {
      if (typeof property?.type !== 'string' && typeof property?.entity !== 'string') { problems.push(`${name}.${propertyName} has neither a type nor an entity`); continue; }
      if (typeof property.type !== 'string' && !(property.entity in entitiesDoc)) { problems.push(`${name}.${propertyName} references entity ${property.entity}, which the ModelSpec does not have`); continue; }
      properties.push(typeof property.type === 'string' ? { name: propertyName, type: property.type } : { name: propertyName, type: 'reference', references: property.entity });
    }
    entities.set(name, { properties });
  }
  return { module, entities, problems };
}
