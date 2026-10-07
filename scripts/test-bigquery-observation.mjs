import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readDirectory, indexText } from './lib/directory.mjs';
import { sourceEntries, sourceProblems } from './lib/source-discovery.mjs';
import { observationDigest, observationFormat, observationProblems, observationsProblems } from './lib/bigquery-observation.mjs';

const all = readDirectory(new URL('../', import.meta.url).pathname);
const candidates = all.sources.filter(s => s.data.access_mode === 'bigquery-native');
const golden = JSON.parse(readFileSync(new URL('./testdata/bigquery-public-observation.json', import.meta.url)));
const evidence = r => {
  const v = { ...structuredClone(golden), source_id: r.key, source_project: r.data.locator.source_project, dataset_id: r.data.locator.dataset_id };
  v.sha256 = observationDigest(v); return v;
};
const record = r => ({ ...structuredClone(r), data: { ...structuredClone(r.data), metadata_observations: [evidence(r)] } });
test('golden fixture hashes canonical sorted keys and covers every canonical BigQuery source automatically', () => {
  assert.equal(golden.format, observationFormat);
  assert.equal(observationDigest(golden), golden.sha256);
  assert.equal(observationDigest(Object.fromEntries(Object.entries(golden).reverse())), golden.sha256);
  assert.equal(candidates.length, 3);
  for (const r of candidates) {
    const synthetic = record(r);
    assert.deepEqual(sourceProblems([synthetic], all.maintainers, { allowSynthetic: true }), []);
    assert.ok(sourceProblems([synthetic], all.maintainers).length);
    assert.throws(() => sourceEntries([synthetic]), /synthetic evidence cannot enter/);
    if (r.key === 'bigquery-world-bank-wdi') {
      assert.equal(r.data.metadata_observations.length, 1);
      const observed = r.data.metadata_observations[0];
      assert.equal(observed.provenance.kind, 'provider-metadata');
      assert.equal(observed.table_id, 'country_summary');
      assert.equal(observationDigest(observed), observed.sha256);
    } else if (r.key === 'bigquery-google-trends') {
      assert.deepEqual(r.data.metadata_observations.map(v => v.table_id), ['top_terms', 'international_top_terms']);
      for (const observed of r.data.metadata_observations) {
        assert.equal(observed.provenance.kind, 'provider-metadata');
        assert.equal(observed.location, 'US');
        assert.equal(observationDigest(observed), observed.sha256);
      }
    } else assert.equal(r.data.metadata_observations, undefined);
    assert.equal(r.data.locator.existence_status, 'unverified');
    assert.equal(r.data.locator.location_status, 'unverified');
    // Validate generation with test-only provider-kind evidence; never write this index.
    const reviewed = record(r); reviewed.data.metadata_observations[0].provenance.kind = 'provider-metadata';
    reviewed.data.metadata_observations[0].sha256 = observationDigest(reviewed.data.metadata_observations[0]);
    assert.deepEqual(sourceProblems([reviewed], all.maintainers), []);
    const generated = JSON.parse(indexText([], sourceEntries([reviewed])));
    assert.deepEqual(generated.sources[0].metadata_observations, reviewed.data.metadata_observations);
    for (const mutate of [d => { d.status='active'; }, d => { d.query_activation='active'; }, d => { d.access_requirements.cost_admission='granted'; }, d => { d.access_requirements.execution_project='job-project'; }, d => { d.access_requirements.runtime_acceptance='accepted'; }, d => { d.provider_retention.authorization='granted'; }, d => { d.owned_retention.enforcement='verified'; }, d => { d.locator.existence_status='observed'; }, d => { d.modelspec_url='https://modelspec.org/registry/models/invented/'; }]) {
      const bad=structuredClone(reviewed); mutate(bad.data); assert.ok(sourceProblems([bad], all.maintainers).length);
    }
  }
});

test('strict recursive projection rejects sensitive and unknown fields, raw payloads and type descriptors', () => {
  const source = { id: candidates[0].key, locator: candidates[0].data.locator };
  const original = evidence(candidates[0]);
  for (const key of ['description','policyTags','dataPolicies','defaultValueExpression','generationExpression','precision','scale','maxLength','rangeElementType','collation','roundingMode','actor_id','project_id','tokens','access','rows','rawResponse','etag']) {
    for (const target of ['top','provenance','field','nested']) {
      const bad=structuredClone(original);
      const object=target === 'top' ? bad : target === 'provenance' ? bad.provenance : target === 'field' ? bad.schema[0] : bad.schema[1].fields[0];
      object[key]='hostile-fixture'; bad.sha256=observationDigest(bad);
      assert.ok(observationProblems(bad, source, {allowSynthetic:true}).length, `${target}.${key}`);
    }
  }
  for (const mutate of [v=>{v.source_id='other';},v=>{v.source_project='other-project';},v=>{v.dataset_id='other';},v=>{v.location='US?token=x';},v=>{v.table_id=['table'];},v=>{v.object_type='CLONE';},v=>{v.observed_at='2026-02-30T00:00:00Z';},v=>{v.sha256='sha256:'+'0'.repeat(64);},v=>{v.schema[0].mode=undefined;},v=>{v.schema[0].fields=[];},v=>{v.schema[1].fields=[];},v=>{v.schema.push({...v.schema[0], name:'FIXTURE_CODE'});},v=>{v.provenance.verifier='person@example.org';}]) {
    const bad=structuredClone(original); mutate(bad); assert.ok(observationProblems(bad,source,{allowSynthetic:true}).length);
  }
});

test('projection bounds fail closed before hashing hostile recursive input', () => {
  const r=candidates[0], source={id:r.key,locator:r.data.locator};
  const problems = v => observationProblems(v,source,{allowSynthetic:true});
  const deep=evidence(r); let fields=deep.schema; for(let n=0;n<9;n++){const field={name:'nested',type:'RECORD',mode:'NULLABLE',fields:[]};fields.splice(0,fields.length,field);fields=field.fields;} fields.push({name:'leaf',type:'STRING',mode:'NULLABLE'}); assert.ok(problems(deep).length);
  const wide=evidence(r);wide.schema=Array.from({length:501},(_,i)=>({name:`f${i}`,type:'STRING',mode:'NULLABLE'}));assert.ok(problems(wide).length);
  const large=evidence(r);large.schema=Array.from({length:300},(_,i)=>({name:`f${i}_`+'a'.repeat(290),type:'STRING',mode:'NULLABLE'}));large.sha256=observationDigest(large);assert.ok(problems(large).some(p=>p.includes('byte')));
  const cycle=evidence(r);cycle.schema[1].fields=cycle.schema;assert.ok(problems(cycle).length);
  const shaCycle=evidence(r);shaCycle.sha256=shaCycle;assert.ok(problems(shaCycle).length);
  assert.ok(observationsProblems(Array.from({length:17},()=>evidence(r)),source,{allowSynthetic:true}).length);
  assert.ok(observationsProblems([evidence(r),evidence(r)],source,{allowSynthetic:true}).length);
  assert.ok(observationsProblems([],source,{allowSynthetic:true}).length);
  const total=Array.from({length:8},(_,i)=>{
    const v=evidence(r);v.table_id=`synthetic_${i}`;
    v.schema=Array.from({length:100},(_,j)=>({name:`f${j}_`+'a'.repeat(290),type:'STRING',mode:'NULLABLE'}));v.sha256=observationDigest(v);assert.deepEqual(problems(v),[]);return v;
  });
  assert.ok(observationsProblems(total,source,{allowSynthetic:true}).some(p=>p.includes('total source observation byte')));
});
