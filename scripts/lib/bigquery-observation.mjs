// Public metadata projection, never a provider response or query entitlement.
import { createHash } from 'node:crypto';

export const observationFormat = 'ovdb-bigquery-observation/draft-1';
export const observationLimits = Object.freeze({ depth: 8, fields: 500, bytes: 65536, tables: 16, sourceBytes: 262144 });
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, required, optional = []) => object(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const match = (v, re) => typeof v === 'string' && re.test(v);
const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;
const fieldName = /^[A-Za-z_][A-Za-z0-9_]{0,299}$/;
const types = new Set(['STRING', 'BYTES', 'INTEGER', 'INT64', 'FLOAT', 'FLOAT64', 'BOOLEAN', 'BOOL', 'TIMESTAMP', 'DATE', 'TIME', 'DATETIME', 'GEOGRAPHY', 'NUMERIC', 'BIGNUMERIC', 'JSON', 'RECORD', 'STRUCT', 'RANGE']);
const keys = ['format', 'source_id', 'source_project', 'dataset_id', 'table_id', 'location', 'object_type', 'observed_at', 'projection', 'provenance', 'schema', 'sha256'];
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

// Call only after bounded structural validation, or on locally authored fixtures.
export function observationDigest(value) {
  const { sha256, ...projection } = value;
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(projection))).digest('hex')}`;
}

/** Closed public evidence: unknown properties are rejected at every depth. */
export function observationProblems(value, source, { allowSynthetic = false } = {}) {
  const errors = [];
  const check = (condition, message) => { if (!condition) errors.push(message); };
  if (!exact(value, keys)) return ['observation must have exactly the versioned public projection keys'];
  check(value.format === observationFormat && value.projection === 'partial-public-schema', 'unsupported observation format or projection');
  check(value.source_id === source.id && value.source_project === source.locator?.source_project && value.dataset_id === source.locator?.dataset_id, 'observation source/dataset must match the candidate exactly');
  check(match(value.source_id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/) && value.source_id.length <= 80 && match(value.source_project, /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/) && match(value.dataset_id, identifier) && match(value.table_id, identifier), 'invalid observation native identity');
  check(match(value.location, /^(?:US|EU|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)$/) && value.location.length <= 64, 'invalid exact observation location');
  check(['TABLE', 'VIEW', 'EXTERNAL', 'MATERIALIZED_VIEW', 'SNAPSHOT'].includes(value.object_type), 'unsupported object type');
  check(match(value.sha256, /^sha256:[a-f0-9]{64}$/), 'invalid public projection digest');
  check(match(value.observed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/) && Number.isFinite(Date.parse(value.observed_at)) && new Date(value.observed_at).toISOString() === value.observed_at.replace('Z', '.000Z'), 'observation time must be an exact UTC second');
  const p = value.provenance;
  check(exact(p, ['kind', 'method', 'verifier']) && (p.kind === 'provider-metadata' || allowSynthetic && p.kind === 'synthetic-fixture') && p.method === 'datasets.get+tables.get' && p.verifier === 'public-projection-review-v1', 'provenance must be a reviewed metadata-only projection; synthetic evidence is fixture-only');
  let count = 0;
  const fields = (list, depth) => {
    if (!Array.isArray(list) || !list.length || list.length > observationLimits.fields || depth > observationLimits.depth) { errors.push('schema field/depth bounds exceeded or empty schema'); return; }
    const names = new Set();
    for (const f of list) {
      if (++count > observationLimits.fields) { errors.push('total schema field bound exceeded'); return; }
      if (!exact(f, ['name', 'type', 'mode'], ['fields'])) { errors.push('unknown or missing public schema property'); continue; }
      check(match(f.name, fieldName) && !names.has(f.name.toLowerCase()), 'invalid or duplicate schema field name');
      if (typeof f.name === 'string') names.add(f.name.toLowerCase());
      check(types.has(f.type) && ['NULLABLE', 'REQUIRED', 'REPEATED'].includes(f.mode), 'invalid native type or explicit mode');
      if (f.type === 'RECORD' || f.type === 'STRUCT') fields(f.fields, depth + 1);
      else check(!Object.hasOwn(f, 'fields'), 'only RECORD/STRUCT may have nested fields');
    }
  };
  fields(value.schema, 1);
  if (errors.length) return errors; // No recursive hashing/serialization of hostile input.
  check(Buffer.byteLength(JSON.stringify(value)) <= observationLimits.bytes, 'public observation byte bound exceeded');
  check(observationDigest(value) === value.sha256, 'public projection digest mismatch');
  return errors;
}

export function observationsProblems(values, source, options) {
  if (!Array.isArray(values) || !values.length || values.length > observationLimits.tables) return ['observations require 1..16 exact tables'];
  const errors = values.flatMap(v => observationProblems(v, source, options));
  if (errors.length) return errors;
  const names = new Set();
  for (const v of values) {
    const name = `${v.source_project}.${v.dataset_id}.${v.table_id}`;
    if (names.has(name)) errors.push('duplicate observed table identity');
    names.add(name);
  }
  if (Buffer.byteLength(JSON.stringify(values)) > observationLimits.sourceBytes) errors.push('total source observation byte bound exceeded');
  return errors;
}
