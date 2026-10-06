// Inactive discovery metadata only. Admission belongs to the database/manifest path.
import { publicHttpsProblem } from './urls.mjs';
export const sourceFormat = 'ovdb-source/draft-1';
const httpKeys = ['format', 'title', 'description', 'status', 'publisher', 'homepage', 'resource_url', 'terms_url', 'access_mode', 'retention', 'activation_blockers', 'notices', 'recordsets', 'maintainers', 'modelspec_url', 'meaninggraph_url'];
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
    const bigquery = data?.access_mode === 'bigquery-native';
    const keys = bigquery ? bigQueryKeys : httpKeys;
    if (!only(data, keys)) { bad('unknown source fields; source records contain metadata only'); continue; }
    for (const field of ['format', 'title', 'description', 'status', 'publisher', 'homepage', 'terms_url', 'access_mode']) if (!str(data[field])) bad(`${field} must be a non-empty string`);
    if (!bigquery && (data.format !== sourceFormat || data.status !== 'inactive' || data.access_mode !== 'live-http-via-ovdb' || data.retention !== 'none')) bad('only inactive live-http-via-ovdb discovery with proposed retention none is supported');
    for (const field of bigquery ? ['homepage', 'terms_url'] : ['homepage', 'resource_url', 'terms_url']) if (publicHttpsProblem(data[field])) bad(`${field} must be a public https URL`);
    const resource = bigquery ? `${data.locator?.source_project}.${data.locator?.dataset_id}` : data.resource_url;
    if (resources.has(resource)) bad('duplicate original resource URL');
    resources.add(resource);
    for (const field of ['activation_blockers', 'notices', 'maintainers']) if (!Array.isArray(data[field]) || !data[field].length || !data[field].every(str)) bad(`${field} must be a non-empty string array`);
    if (Array.isArray(data.maintainers)) for (const handle of data.maintainers) if (!handles.has(handle)) bad(`maintainer ${handle} has no record`);
    if (bigquery) { bigQueryProblems(data).forEach(bad); continue; }
    for (const [field, expected] of Object.entries({
      modelspec_url: `https://modelspec.org/registry/models/${key}/`,
      meaninggraph_url: `https://meaninggraph.io/graphs/${key}/`,
    })) {
      if (Object.hasOwn(data, field) && data[field] !== expected) bad(`${field} must be the canonical registry metadata route for this source id`);
    }
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

// Dataset-level only: table/field shapes and observed metadata require a later contract.
const bigQueryKeys = ['format', 'title', 'description', 'status', 'publisher', 'hosting_provider', 'homepage', 'terms_url', 'access_mode', 'query_activation', 'locator', 'documentation', 'access_requirements', 'owned_retention', 'provider_retention', 'activation_blockers', 'notices', 'maintainers'];
export function bigQueryProblems(data) {
  const errors = [];
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
  const check = (condition, message) => { if (!condition) errors.push(message); };
  check(data.format === 'ovdb-source/draft-2' && data.status === 'inactive' && data.query_activation === 'blocked' && data.hosting_provider === 'Google BigQuery', 'BigQuery discovery must be inactive draft-2 with blocked queries and a separate hosting provider');
  const l = data.locator;
  check(exact(l, ['source_project', 'dataset_id', 'existence_status', 'location_status']) && typeof l.source_project === 'string' && typeof l.dataset_id === 'string' && /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(l.source_project) && /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/.test(l.dataset_id) && l.existence_status === 'unverified' && l.location_status === 'unverified', 'requires an unverified dataset-level native locator; no table or location claim');
  const d = data.documentation;
  check(exact(d, ['kind', 'url', 'commit']) && d.kind === 'documented-definition' && typeof d.commit === 'string' && /^[a-f0-9]{40}$/.test(d.commit) && typeof d.url === 'string' && !publicHttpsProblem(d.url) && d.url.includes(`/blob/${d.commit}/`), 'requires a public pinned definition; documentation is not an original HTTP resource');
  const a = data.access_requirements;
  check(exact(a, ['authentication', 'execution_project', 'cost_admission', 'runtime_acceptance', 'documentation_url']) && a.authentication === 'required' && a.execution_project === 'unconfigured' && a.cost_admission === 'not-granted' && a.runtime_acceptance === 'pending' && !publicHttpsProblem(a.documentation_url), 'BigQuery authentication, project, cost and runtime requirements must remain unaccepted');
  const o = data.owned_retention;
  check(exact(o, ['intent', 'enforcement']) && o.intent === 'none' && o.enforcement === 'unverified', 'owned retention is an unverified no-retention intent');
  const r = data.provider_retention;
  check(exact(r, ['result_storage', 'authorization', 'documentation_url']) && r.result_storage === 'materialized-results' && r.authorization === 'pending-review' && !publicHttpsProblem(r.documentation_url), 'provider result materialization requires separate pending retention authorization');
  return errors;
}
