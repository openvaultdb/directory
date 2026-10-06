// Inactive discovery metadata only. Admission belongs to the database/manifest path.
import { publicHttpsProblem } from './urls.mjs';
export const sourceFormat = 'ovdb-source/draft-1';
const keys = ['format', 'title', 'description', 'status', 'publisher', 'homepage', 'resource_url', 'terms_url', 'access_mode', 'retention', 'activation_blockers', 'notices', 'recordsets', 'maintainers'];
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function sourceProblems(records, maintainers) {
  const problems = [];
  const ids = new Set();
  const resources = new Set();
  const handles = new Set(maintainers.map(x => x.key));
  for (const { key, file, data } of records) {
    const bad = message => problems.push(`${file}: ${message}`);
    const str = value => typeof value === 'string' && value.trim().length > 0;
    const only = (object, allowed) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(k => allowed.includes(k));
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) || key.length > 80 || ids.has(key)) bad('invalid or duplicate source id');
    ids.add(key);
    if (!only(data, keys)) { bad('unknown source fields; source records contain metadata only'); continue; }
    for (const field of keys.slice(0, 10)) if (!str(data[field])) bad(`${field} must be a non-empty string`);
    if (data.format !== sourceFormat || data.status !== 'inactive' || data.access_mode !== 'live-http-via-ovdb' || data.retention !== 'none') bad('only inactive live-http-via-ovdb discovery with proposed retention none is supported');
    for (const field of ['homepage', 'resource_url', 'terms_url']) if (publicHttpsProblem(data[field])) bad(`${field} must be a public https URL`);
    if (resources.has(data.resource_url)) bad('duplicate original resource URL');
    resources.add(data.resource_url);
    for (const field of ['activation_blockers', 'notices', 'maintainers']) if (!Array.isArray(data[field]) || !data[field].length || !data[field].every(str)) bad(`${field} must be a non-empty string array`);
    if (Array.isArray(data.maintainers)) for (const handle of data.maintainers) if (!handles.has(handle)) bad(`maintainer ${handle} has no record`);
    const names = new Set();
    if (!Array.isArray(data.recordsets) || !data.recordsets.length) { bad('recordsets must be a non-empty array'); continue; }
    for (const rs of data.recordsets) {
      if (!only(rs, ['name', 'description', 'fields']) || !identifier.test(rs.name ?? '') || names.has(rs.name) || !str(rs.description)) { bad('invalid or duplicate proposed recordset'); continue; }
      names.add(rs.name);
      const fields = new Set();
      if (!Array.isArray(rs.fields) || !rs.fields.length) { bad('fields must be a non-empty array'); continue; }
      for (const field of rs.fields) {
        if (!only(field, ['name', 'type', 'description']) || !identifier.test(field.name ?? '') || fields.has(field.name) || field.type !== 'string' || !str(field.description)) bad('invalid or duplicate proposed native string field');
        fields.add(field.name);
      }
    }
  }
  return problems;
}
export const sourceEntries = records => records.map(({ key, data }) => ({ id: key, ...data })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
