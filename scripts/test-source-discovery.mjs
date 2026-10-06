import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { indexText, readDirectory } from './lib/directory.mjs';
import { sourceEntries, sourceProblems } from './lib/source-discovery.mjs';
const root = new URL('../', import.meta.url);
const record = () => ({ key: 'ecb-daily', file: 'sources/$records/ecb-daily.yaml', data: parse(readFileSync(new URL('sources/$records/ecb-daily.yaml', root), 'utf8')) });
const maintainers = [{ key: 'trakhimenok' }];
const digest = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
test('canonical source metadata checks without source fetches and has one ID', () => {
  const r = record();
  assert.deepEqual(sourceProblems([r], maintainers), []);
  assert.equal(readDirectory(root.pathname).sources.length, 2);
  assert.equal(sourceEntries([r])[0].id, 'ecb-daily');
  assert.equal(r.data.resource_url, 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
  assert.deepEqual(r.data.recordsets[0].fields.map(f => [f.name, f.type]), [['time','string'],['currency','string'],['rate','string']]);
});
test('inactive metadata refuses activation, retained payloads and fabricated deployment/license claims', () => {
  for (const change of [d => { d.status='published'; }, d => { d.retention='snapshot'; }, d => { d.access_mode='query'; }, d => { d.deployment={url:'https://fake.example/'}; }, d => { d.licence='CC0-1.0'; }, d => { d.data=[]; }, d => { d.recordsets[0].fields[0].meanings=[]; }, d => { delete d.resource_url; }, d => { d.resource_url='http://www.ecb.europa.eu/rates'; }, d => { d.activation_blockers=[]; }, d => { d.maintainers=['nobody']; }, d => { d.recordsets[0].fields[2].type='float'; }, d => { d.recordsets[0].fields.push({...d.recordsets[0].fields[0]}); }]) {
    const r=record(); change(r.data); assert.ok(sourceProblems([r],maintainers).length, JSON.stringify(r.data));
  }
  assert.ok(sourceProblems([record(),record()],maintainers).length);
});
test('source index is sorted, separately checksummed, and preserves old database bytes/checksum', () => {
  const before=JSON.parse(indexText([{id:'b'}, {id:'a'}]));
  const sources=sourceEntries([record()]);
  const after=JSON.parse(indexText([{id:'b'},{id:'a'}],sources));
  assert.deepEqual(after.databases,before.databases);
  assert.equal(after.checksum,before.checksum);
  assert.equal(after.sourcesChecksum,digest(sources));
  assert.deepEqual(after.sources,sources);
  const changed=structuredClone(sources);changed[0].description+=' Updated readiness.';
  assert.notEqual(JSON.parse(indexText(after.databases,changed)).sourcesChecksum,after.sourcesChecksum);
  assert.equal(before.sources,undefined);
});

const bigqueryRecord = () => ({ key: 'bigquery-world-bank-wdi', file: 'sources/$records/bigquery-world-bank-wdi.yaml', data: parse(readFileSync(new URL('sources/$records/bigquery-world-bank-wdi.yaml', root), 'utf8')) });
test('dataset discovery is native and does not invent tables, HTTP endpoints or rights admission', () => {
  const r=bigqueryRecord(); assert.deepEqual(sourceProblems([record(),r],maintainers),[]);
  assert.equal(r.data.locator.dataset_id,'world_bank_wdi');
  assert.equal(r.data.resource_url,undefined); assert.equal(r.data.recordsets,undefined);
  assert.equal(r.data.publisher,'World Bank'); assert.equal(r.data.hosting_provider,'Google BigQuery');
  for(const mutate of [d=>{d.query_activation='active';}, d=>{d.retention='none';}, d=>{d.locator.location_status='verified';}, d=>{d.locator.table_ids=['indicators_data'];}, d=>{d.documentation.kind='observed';}, d=>{d.documentation.commit='f'.repeat(40);}, d=>{d.access_requirements.execution_project='paid-project';}, d=>{d.access_requirements.cost_admission='granted';}, d=>{d.owned_retention.enforcement='verified';}, d=>{d.provider_retention.result_storage='none';}, d=>{d.provider_retention.authorization='granted';}, d=>{d.provider_retention.rows=[];}, d=>{d.documentation=null;}, d=>{d.locator.source_project=['bigquery-public-data'];}, d=>{d.locator.dataset_id=['world_bank_wdi'];}, d=>{d.documentation.commit=[d.documentation.commit];}, d=>{d.locator=null;}, d=>{d.recordsets=[];}]) {
    const bad=bigqueryRecord(); mutate(bad.data); assert.ok(sourceProblems([bad],maintainers).length,JSON.stringify(bad.data));
  }
});

test('every BigQuery nested requirement is required and closed',()=>{
  const original=bigqueryRecord();
  for(const name of ['locator','documentation','access_requirements','owned_retention','provider_retention']) {
    for(const key of Object.keys(original.data[name])) {
      const r=bigqueryRecord(); delete r.data[name][key]; assert.ok(sourceProblems([r],maintainers).length,`${name}.${key}`);
    }
    const r=bigqueryRecord(); r.data[name].credential='fake'; assert.ok(sourceProblems([r],maintainers).length,name);
  }
});

test('optional HTTP source registry links are exact source-qualified canonical metadata routes',()=>{
  const r=record(); assert.deepEqual(sourceProblems([r],maintainers),[]);
  assert.equal(r.data.modelspec_url,'https://modelspec.org/registry/models/ecb-daily/');
  assert.equal(r.data.meaninggraph_url,'https://meaninggraph.io/graphs/ecb-daily/');
  delete r.data.modelspec_url;delete r.data.meaninggraph_url;assert.deepEqual(sourceProblems([r],maintainers),[]);
  for(const field of ['modelspec_url','meaninggraph_url']) {
    const original=record().data[field];
    for(const value of [null,[],[original],42,'',original.replace('https:','http:'),original+'?query=x',original+'#field',original+'extra/',original.replace('ecb-daily','other-source'),original.replace('https://','https://user:pass@'),original.replace('ecb-daily','%65cb-daily'),original.replace('modelspec.org','modelspec.org.evil.example').replace('meaninggraph.io','meaninggraph.io.evil.example'),original.slice(0,-1)]) {
      const bad=record();bad.data[field]=value;assert.ok(sourceProblems([bad],maintainers).length,`${field} ${JSON.stringify(value)}`);
    }
  }
  const bq=bigqueryRecord();bq.data.modelspec_url='https://modelspec.org/registry/models/bigquery-world-bank-wdi/';assert.ok(sourceProblems([bq],maintainers).length);
});
