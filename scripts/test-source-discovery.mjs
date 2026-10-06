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
  assert.equal(readDirectory(root.pathname).sources.length, 1);
  assert.equal(sourceEntries([r])[0].id, 'ecb-daily');
  assert.equal(r.data.resource_url, 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
  assert.deepEqual(r.data.recordsets[0].fields.map(f => [f.name, f.type]), [['time','string'],['currency','string'],['rate','string']]);
});
test('inactive metadata refuses activation, retained payloads and fabricated deployment/license claims', () => {
  for (const change of [d => { d.status='published'; }, d => { d.retention='snapshot'; }, d => { d.access_mode='query'; }, d => { d.deployment={url:'https://fake.example/'}; }, d => { d.licence='CC0-1.0'; }, d => { d.data=[]; }, d => { d.recordsets[0].fields[0].meanings=[]; }, d => { d.resource_url='http://www.ecb.europa.eu/rates'; }, d => { d.activation_blockers=[]; }, d => { d.maintainers=['nobody']; }, d => { d.recordsets[0].fields[2].type='float'; }, d => { d.recordsets[0].fields.push({...d.recordsets[0].fields[0]}); }]) {
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
