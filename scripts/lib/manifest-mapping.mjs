// How a publisher manifest says which ModelSpec record type each recordset has and which field each
// column holds (CC0-1.0). Two forms are read:
//
//   ovdb-manifest/draft-1  recordsets is a list of names; the optional map `recordset_entities` pairs a
//                          name with a record type; nothing says anything about a column.
//   ovdb-manifest/draft-2  an item of recordsets is a name, or a map with `name`, `record_type` and
//                          `columns` (a map from a column's name to { field: <field or path> }).
//
// The identifier decides the form, and a manifest that mixes the two is refused. Whatever the form, a reader
// that has passed the manifest stage holds one normalised mapping, normalisedMapping(): for each recordset,
// in the order written, its name, its record type, and for each listed column the field it holds. Nothing
// after that step looks at `recordsets` or `recordset_entities` again.
//
// This file has no imports and is the same, byte for byte, in openvaultdb/directory (the Directory checker)
// and in demo-db/chinook (the offline pre-check the Go publisher check is proved against). A test of each
// repository runs the same conformance cases through it.

export const oldFormat = 'ovdb-manifest/draft-1';
export const newFormat = 'ovdb-manifest/draft-2';

const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const fieldPath = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const itemKeys = ['name', 'record_type', 'columns'];
const quoted = (value) => JSON.stringify(value);

// A problem with `value` as a recordset's or a column's own name, or null: the name the database uses, at
// most 256 UTF-16 code units, not a dot path segment, no slash, backslash or control character.
export const nameProblem = (value) => !isText(value) ? 'must be a non-empty name'
  : value.length > 256 || value === '.' || value === '..' || /[\/\\\u0000-\u001f\u007f]/.test(value)
    ? 'must be at most 256 characters and contain no slash, backslash or control character, and cannot be a dot path segment'
    : null;

// 'old' for ovdb-manifest/draft-1, 'new' for ovdb-manifest/draft-2, null for anything else.
export const formatOf = (manifest) => (manifest?.format === oldFormat ? 'old' : manifest?.format === newFormat ? 'new' : null);

// The problem with the manifest's `format`, or null.
export const formatProblem = (manifest) => (formatOf(manifest) === null ? `format must be ${oldFormat} or ${newFormat}, got ${quoted(manifest?.format)}` : null);

// Under the old identifier an item of recordsets is a name. A map item is the new form under the old
// identifier: the one problem it is reported as, or null when no item is a map.
export function mapItemUnderOldFormat(manifest) {
  if (formatOf(manifest) !== 'old' || !Array.isArray(manifest.recordsets)) return null;
  const position = manifest.recordsets.findIndex(isMap);
  return position < 0 ? null : `recordsets item ${position + 1} is a map, but ${oldFormat} lists recordsets by name only; record_type: and columns: are read under format: ${newFormat}`;
}

// The notice for a manifest in the old form that writes `recordset_entities` (empty or not), or null.
export const earlierKeyNotice = (manifest) => (formatOf(manifest) === 'old' && manifest.recordset_entities !== undefined
  ? `recordset_entities is the earlier form of the mapping and is still read; under format: ${newFormat} the same is one record_type: line under each recordset (- name: Order Details, record_type: OrderDetails), and recordset_entities is removed`
  : null);

// The problems of a manifest in the new form (formatOf(manifest) === 'new') that need no model: the shape of
// recordsets, of each item, of `columns` and of each column; names, duplicates, one record type per recordset,
// and the key recordset_entities, which this form does not read.
export function newFormProblems(manifest) {
  const problems = [];
  const { recordsets } = manifest;
  if (manifest.recordset_entities !== undefined) {
    problems.push(Array.isArray(recordsets) && recordsets.some(isMap)
      ? `recordset_entities and record_type both state the mapping, and a manifest states it once: move each pair of recordset_entities under its recordset as record_type: and remove recordset_entities (it is refused even where the two agree)`
      : `recordset_entities is not read under format: ${newFormat}: remove it, and write each pair as an item of recordsets, "Old Name: Type" becoming "- name: Old Name" with "record_type: Type" under it (an empty recordset_entities is refused too)`);
  }
  if (!Array.isArray(recordsets) || recordsets.length === 0) {
    problems.push('recordsets must be a non-empty list of names or of items with a name');
    return problems;
  }
  const names = new Set();
  const typeOwner = new Map();
  recordsets.forEach((item, index) => {
    const position = index + 1;
    let name;
    let recordType;
    let columns;
    if (typeof item === 'string') {
      if (!isText(item)) { problems.push(`recordsets item ${position} must be a name or a map with a name, got ${quoted(item)}`); return; }
      name = item;
      recordType = item;
    } else if (isMap(item)) {
      for (const key of Object.keys(item)) if (!itemKeys.includes(key)) problems.push(`recordsets item ${position} has the key ${quoted(key)}; an item reads only name, record_type and columns`);
      if (!isText(item.name)) problems.push(`recordsets item ${position} needs name: the recordset's own name`);
      else name = item.name;
      if (Object.hasOwn(item, 'record_type')) {
        if (typeof item.record_type === 'string' && identifier.test(item.record_type)) recordType = item.record_type;
        else problems.push(`recordsets ${quoted(item.name)}: record_type must be a ModelSpec record type name (letters, digits and _, not starting with a digit), got ${quoted(item.record_type)}`);
      } else recordType = name;
      if (Object.hasOwn(item, 'columns')) columns = item.columns;
    } else {
      problems.push(`recordsets item ${position} must be a name or a map with a name, got ${quoted(item)}`);
      return;
    }
    if (name !== undefined) {
      const problem = nameProblem(name);
      if (problem) problems.push(`recordsets name ${quoted(name)} ${problem}`);
      if (names.has(name)) problems.push(`recordsets lists a name twice: ${quoted(name)}`);
      names.add(name);
      if (recordType !== undefined) {
        if (typeOwner.has(recordType)) problems.push(`recordsets ${quoted(typeOwner.get(recordType))} and ${quoted(name)} both have the record type ${recordType}; mappings must be one-to-one`);
        else typeOwner.set(recordType, name);
      }
    }
    if (columns !== undefined) problems.push(...columnProblems(name ?? `item ${position}`, columns));
  });
  return problems;
}

// The shape of one recordset's `columns` and of each column.
function columnProblems(recordset, columns) {
  const problems = [];
  const where = `recordsets ${quoted(recordset)}`;
  if (!isMap(columns)) return [`${where}: columns must be a map from a column's name to { field: ... }, got ${quoted(columns)}`];
  const holders = new Map();
  for (const [column, value] of Object.entries(columns)) {
    const problem = nameProblem(column);
    if (problem) problems.push(`${where}: column ${quoted(column)} ${problem}`);
    if (!isMap(value)) { problems.push(`${where}: column ${quoted(column)} must be a map with field: (a column is written as a map, "${column}: { field: ... }", not as text or a list), got ${quoted(value)}`); continue; }
    for (const key of Object.keys(value)) if (key !== 'field') problems.push(`${where}: column ${quoted(column)} has the key ${quoted(key)}; a column reads only field`);
    if (typeof value.field !== 'string') { problems.push(`${where}: column ${quoted(column)} needs field: the name of the field it holds`); continue; }
    if (!fieldPath.test(value.field)) { problems.push(`${where}: column ${quoted(column)}: field ${quoted(value.field)} must be a field name, or names joined by single dots (letters, digits and _, each not starting with a digit)`); continue; }
    if (holders.has(value.field)) problems.push(`${where}: columns ${quoted(holders.get(value.field))} and ${quoted(column)} both hold the field ${value.field}`);
    else holders.set(value.field, column);
  }
  return problems;
}

// The normalised mapping of a manifest that has passed the manifest stage: [{ name, recordType, columns }]
// in the order written, `columns` a Map from a column's name to the field (or dotted path) it holds, empty
// when none is listed. In the old form the record type is the key's value in recordset_entities when the
// key is written for the name, else the name itself.
export function normalisedMapping(manifest) {
  const items = Array.isArray(manifest.recordsets) ? manifest.recordsets : [];
  if (formatOf(manifest) === 'new') {
    return items.map((item) => (typeof item === 'string'
      ? { name: item, recordType: item, columns: new Map() }
      : { name: item.name, recordType: item.record_type ?? item.name, columns: new Map(Object.entries(item.columns ?? {}).map(([column, value]) => [column, value.field])) }));
  }
  const entities = isMap(manifest.recordset_entities) ? manifest.recordset_entities : {};
  return items.map((name) => ({ name, recordType: Object.hasOwn(entities, name) ? entities[name] : name, columns: new Map() }));
}

// The recordsets' own names, in the order written, for a reader that needs the names alone (a representation
// contract names a recordset by its own name; so does the data-rights profile). Reads either form and is
// safe on a manifest that has not been checked.
export const recordsetNames = (manifest) => (Array.isArray(manifest?.recordsets)
  ? manifest.recordsets.map((item) => (typeof item === 'string' ? item : isMap(item) ? item.name : undefined)).filter((name) => typeof name === 'string')
  : []);

// Whether the manifest lists at least one column under the recordset of this own name.
export const hasColumns = (manifest, name) => (Array.isArray(manifest?.recordsets)
  && manifest.recordsets.some((item) => isMap(item) && item.name === name && isMap(item.columns) && Object.keys(item.columns).length > 0));

// The problems of one recordset's columns against its record type's field names (a Set), once the model is read.
// A column holds a field of the record type, or a path into a component; no reader of the model reads a
// component yet, so a path of more than one name is refused as a field that holds no component. A column
// that is named like a field no other column holds would make two fields claim the one column name.
export function columnModelProblems({ name, recordType, columns }, fieldNames) {
  const problems = [];
  const held = new Set(columns.values());
  for (const [column, path] of columns) {
    const where = `recordsets ${quoted(name)}: column ${quoted(column)}`;
    const [first, second] = path.split('.');
    if (!fieldNames.has(first)) problems.push(`${where} holds ${quoted(path)}, but ${recordType} has no field ${quoted(first)}`);
    else if (second !== undefined) problems.push(`${where} holds ${quoted(path)}: ${first} is a field that holds no component, so ${quoted(second)} cannot be read in it`);
    if (column !== path && fieldNames.has(column) && !held.has(column)) problems.push(`${where} is also the name of the field ${column} of ${recordType}, which has no column of its own listed, so two fields would claim the column ${column}`);
  }
  return problems;
}
