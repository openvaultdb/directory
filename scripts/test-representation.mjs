// Synthetic structural fixtures do not grant provider/source admission.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, after } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkRepresentation, verifySourceData, checkRepresentationEnvelope } from './lib/representation.mjs';
import { dependencyReaders, directoryArguments } from './lib/dependencies.mjs';
import { openDependency } from './lib/git.mjs';
import { parseStrictJson } from './lib/strict-json.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const revision = 'a'.repeat(40);
const sourceRepo = 'https://github.com/example/source';
const providerRepo = 'https://github.com/example/provider';
const ref = (path, bytes) => ({ path, sha256: sha(bytes) });
const external = (path) => ({ path, sha256: 'b'.repeat(64), repository: sourceRepo, revision });
const bytes = (value) => Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));

function fixture(format = 3, prefix = '') {
  const files = new Map();
  const put = (path, value) => { const data = bytes(value); const full = `${prefix}${path}`; files.set(full, data); return ref(full, data); };
  const targetModel = put('model/target.modelspec.json', {
    modelspec: '1.0-draft', module: { name: 'target' }, entities: {
      Entities: { key: ['id'], properties: { id: { type: 'string', required: true }, serving_id: { type: 'string' } } },
      Bridge: { properties: { raw_label: { type: 'string' }, target_key: { type: 'string' } } },
    },
  });
  const binding = put('model/target.meaning.yaml', `format: meaning/draft-1\nconcepts:\n  - id: target-entity\n    extends: meaning://github.com/example/meaning/concept?ref=${revision}\n    bindings:\n      - model: modelspec:///target.Entities\n        property: id\n        role: identifier\n`);
  const dataset = { path: `${prefix}native.sqlite`, sha256: 'c'.repeat(64) };
  const provenance = put('source/provenance.json', {
    native_key: { module: 'target', entity: 'Entities', property: 'id', namespace: 'TEST:ID', model: targetModel, binding, dataset, records: 2, duplicates: 0 },
    snapshot: { outputs: { [dataset.path]: { sha256: dataset.sha256 } }, counts: { Entities: 2 } },
  });
  const bridge = put('source/bridge.json', { table: 'Bridge', rows: [{ raw_label: 'x', target_key: 'id:1' }] });
  const keys = put('source/keys.json', { namespace: 'TEST:ID', keys: ['id:1'] });
  const snapshot = put('source/snapshot.json', {
    generator: { repository: providerRepo, revision },
    artifacts: [targetModel, binding, dataset, provenance, bridge, keys],
  });
  const source = { schema: external('source/schema.json'), module: 'source', entity: 'Rows', property: 'id', datatype: 'string', namespace: 'TEST:ID' };
  if (format === 3) source.data = external('source/input.json');
  const target = {
    snapshot, model: targetModel, module: 'target', entity: 'Entities', property: 'id', datatype: 'string', namespace: 'TEST:ID',
    binding: { document: binding, concept: 'target-entity', role: 'identifier', meaning: { document: { ...external('meaning/core.yaml'), repository: 'https://github.com/example/meaning' }, concept: 'concept' } },
  };
  const contract = {
    source, target, policy: { transform: 'identity', equality: 'utf8-byte-exact', cardinality: 'zero-or-one', unmatched: 'exception', collision: 'ineligible' },
    decision: { document: external(format === 1 ? 'decision.json' : '$records/decision.json'), scope: 'synthetic-fixture' },
  };
  if (format === 1) { target.keys = keys; contract.bridge = { artifact: bridge, table: 'Bridge', raw_label_column: 'raw_label', target_key_column: 'target_key' }; }
  if (format === 2) { target.keys = keys; contract.execution = 'label-bridge'; contract.bridge = { artifact: bridge, table: 'Bridge', raw_label_column: 'raw_label', target_key_column: 'target_key' }; }
  if (format === 3) { contract.execution = 'native-identifier'; contract.native = { dataset, provenance, serving_identity_column: 'serving_id' }; }
  const doc = { format: `ovdb-representation-contract/${format}`, contracts: [contract] };
  const attachment = put('source/contract.json', doc);
  const manifest = { model: { modelspec: targetModel.path }, meaning: { file: binding.path }, recordsets: ['Entities', 'Bridge'] };
  const touched = [];
  const reader = {
    status(path) { return files.has(path) ? 'file' : 'missing'; },
    readBytes(path, limit) { touched.push(path); const data = files.get(path); if (data.length > limit) throw new Error('oversize'); return data; },
  };
  reader.commit = revision;
  return { files, put, doc, attachment, manifest, reader, touched, contract };
}


function full(version = 3) {
  const f = fixture(version);
  const externalFiles = new Map();
  const add = (reference, value) => {
    const data = bytes(value); reference.sha256 = sha(data); externalFiles.set(reference.path, data);
  };
  add(f.contract.source.schema, { modelspec: '1.0-draft', module: { name: 'source' }, entities: { Rows: { properties: { id: { type: 'string' } } } } });
  add(f.contract.decision.document, 'unchanged opaque provenance');
  add(f.contract.target.binding.meaning.document, { format: 'meaning/draft-1', concepts: [{ id: 'concept' }] });
  if (version === 3) add(f.contract.source.data, '[{"id":"id:1"},{"id":"id:2"}]');
  const reader = { commit: revision, status: (p) => externalFiles.has(p) ? 'file' : 'missing', readBytes: (p, limit) => {
    f.touched.push(p); const data = externalFiles.get(p); if (data.length > limit) throw new Error('oversize'); return data;
  } };
  f.dependencies = new Map([[`${sourceRepo}@${revision}`, reader], [`https://github.com/example/meaning@${revision}`, reader]]);
  f.externalFiles = externalFiles;
  f.repack = () => { f.attachment = f.put('source/contract.json', f.doc); };
  f.repack(); return f;
}
function check(f, registered = () => true) { return checkRepresentation(f.attachment, f.reader, f.manifest, providerRepo, f.dependencies, registered); }
const refused = (f, pattern = /./) => assert.match(check(f).problems.join('\n'), pattern);

test('all frozen formats prove structural closure; metadata never reads source/native data', () => {
  for (const version of [1, 2, 3]) {
    const f = full(version); const result = check(f);
    assert.deepEqual(result.problems, []);
    assert.equal(f.touched.includes('source/input.json'), false);
    assert.equal(f.touched.includes('native.sqlite'), false);
    const proofs = verifySourceData(result.document, f.dependencies);
    assert.equal(proofs.length, version === 3 ? 1 : 0);
  }
});

test('a second generic source works without fixture hash, namespace or research ID dispatch', () => {
  const f = full();
  const reference = f.contract.source.schema;
  f.contract.source.module = 'another'; f.contract.source.entity = 'Affiliations'; f.contract.source.property = 'exact_id';
  const data = bytes({ modelspec: '1.0-draft', module: { name: 'another' }, entities: { Affiliations: { properties: { exact_id: { type: 'string' } } } } });
  f.externalFiles.set(reference.path, data); reference.sha256 = sha(data); f.repack();
  assert.deepEqual(check(f).problems, []);
});

test('every immutable coordinate, canonical registration, exact source and namespace fail closed', () => {
  for (const refName of ['schema', 'data']) for (const key of ['repository', 'revision', 'path', 'sha256']) {
    const f = full(); f.contract.source[refName][key] = key === 'revision' ? 'd'.repeat(40) : key === 'sha256' ? 'd'.repeat(64) : key === 'repository' ? 'https://github.com/another/source' : 'changed.json'; f.repack();
    if (refName === 'data') assert.throws(() => verifySourceData(check(f).document, f.dependencies), /dependency|regular|SHA/);
    else refused(f);
  }
  for (const field of ['module', 'entity', 'property', 'datatype']) {
    const f = full(); f.contract.source[field] = field === 'datatype' ? 'integer' : 'changed'; f.repack(); refused(f);
  }
  const namespace = full(); namespace.contract.source.namespace += ' '; namespace.repack(); refused(namespace, /namespaces differ/);
  const unregistered = full(); assert.match(check(unregistered, () => false).problems.join('\n'), /registered canonical/);
  const absent = full(); absent.dependencies = new Map(); refused(absent, /dependency unavailable/);
});

test('envelope/schema/format/downgrade/hash/modes/duplicate/scalar/depth refuse', () => {
  for (const envelope of [null, [], 'file.json', {path:'../x.json',sha256:'a'.repeat(64)}, {path:'x.json',sha256:'a'.repeat(64),notes:'accept'}]) assert.throws(() => checkRepresentationEnvelope(envelope));
  for (const mutate of [
    (f) => { delete f.contract.source.data; },
    (f) => { f.doc.format = 'ovdb-representation-contract/2'; },
    (f) => { f.doc.accepted = true; },
    (f) => { f.contract.target.keys = {path:'keys.json',sha256:'a'.repeat(64)}; },
    (f) => { f.doc.contracts.push(structuredClone(f.contract)); },
    (f) => { f.contract.target.binding.document.path = 'other.yaml'; },
  ]) { const f = full(); mutate(f); f.repack(); refused(f); }
  const mode = full(); mode.reader.status = () => 'link'; refused(mode, /regular file/);
  const duplicate = full(); duplicate.attachment = duplicate.put('source/contract.json', '{"format":1,"format":3}'); refused(duplicate, /duplicate JSON/);
  for (const data of [Buffer.from([255]), Buffer.from(String.raw`"\ud800"`), Buffer.from(String.raw`{"a":1,"\u0061":2}`), Buffer.from('\ufeff{}')]) assert.throws(() => parseStrictJson(data, 1024));
  const wrongHash = full(); wrongHash.attachment.sha256 = '0'.repeat(64); refused(wrongHash, /SHA-256/);
});

test('native keys/grain and snapshot/provenance counts reject malformed associations', () => {
  for (const mutate of [
    (model) => { model.entities.Entities.key = ['id','serving_id']; },
    (model) => { delete model.entities.Entities.properties.id.required; },
    (model) => { model.entities.Entities.properties.id.required = 'true'; },
    (model) => { model.Module = model.module; },
  ]) {
    const f = full(); const model = JSON.parse(f.files.get(f.contract.target.model.path)); mutate(model);
    const ref = f.contract.target.model; Object.assign(ref, f.put(ref.path, model)); f.repack(); refused(f);
  }
  const binding = full(); const ref = binding.contract.target.binding.document; Object.assign(ref,binding.put(ref.path,'format: meaning/draft-1\nconcepts: []\n---\nformat: meaning/draft-1\n')); binding.repack(); refused(binding, /multiple|documents|binding/);
});

test('separate data budget accepts exact 5MiB including raw non-UTF8 and refuses an extra byte', () => {
  const f = full(); const data = Buffer.alloc(5 * 1024 * 1024, 0xff); const ref = f.contract.source.data;
  ref.sha256 = sha(data); f.externalFiles.set(ref.path, data); f.repack();
  const doc = check(f).document; assert.ok(doc); assert.equal(verifySourceData(doc, f.dependencies).length, 1);
  f.externalFiles.set(ref.path, Buffer.concat([data,Buffer.from([0])]));
  assert.throws(() => verifySourceData(doc, f.dependencies), /oversize|size/);
});

test('data stage deduplicates only exact full references within one check and rechecks next call', () => {
  const f = full(); const c = structuredClone(f.contract); c.source.property = 'other'; f.doc.contracts.push(c);
  // Byte stage alone consumes already structurally checked documents.
  assert.equal(verifySourceData(f.doc, f.dependencies).length, 1);
  assert.equal(verifySourceData(f.doc, f.dependencies).length, 1);
  assert.equal(f.touched.filter((p) => p === 'source/input.json').length, 2);
});

const scratch = mkdtempSync(join(tmpdir(), 'directory-dependency-'));
after(() => rmSync(scratch, { recursive:true, force:true }));
test('literal bindings split first equals, preserve punctuation and coalesce without opening unused readers', () => {
  const dir = join(scratch, 'spaces, @and=equals'); mkdirSync(dir);
  const key = `${sourceRepo}@${revision}`; let opens = 0;
  const pool = dependencyReaders([`${key}=${dir}`,`${key}=${dir}`], () => { opens++; return {commit:revision}; });
  assert.equal(pool.size,1); assert.equal(dependencyReaders([`${key}=${dir}`,`${sourceRepo}@${'d'.repeat(40)}=${scratch}`],()=>({commit:revision})).size,2); assert.equal(opens,0); assert.equal(pool.get(key).commit,revision); assert.equal(opens,1);
  for (const value of [`${key}=relative`,`${key}=~/x`,`${key}=${dir}
`, `${sourceRepo}@MAIN=${dir}`,`https://github.com/../source@${revision}=${dir}`]) assert.throws(() => dependencyReaders([value]));
  assert.throws(() => dependencyReaders([`${key}=${dir}`,`${key}=${scratch}`]), /conflicting/);
  assert.throws(() => directoryArguments(['--dependency'], scratch));
  assert.equal(directoryArguments([scratch], scratch).representationDependencies.size,0);
});

test('committed dependency reader pins HEAD, ignores dirty bytes, rejects links, subdirectory and oversize', () => {
  const dir = join(scratch,'git'); mkdirSync(dir);
  const git = (...args) => execFileSync('git', ['-C',dir,...args], {encoding:'utf8', env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_CONFIG_GLOBAL:devNull,GIT_CONFIG_NOSYSTEM:'1'}}).trim();
  git('init','-q','-b','main'); writeFileSync(join(dir,'data'),'original'); symlinkSync('data',join(dir,'link'));
  git('add','data','link'); git('update-index','--add','--cacheinfo',`160000,${'a'.repeat(40)},module`); git('-c','user.name=test','-c','user.email=test@example.com','commit','-qm','fixture');
  const commit = git('rev-parse','HEAD'); const reader = openDependency(dir,commit);
  writeFileSync(join(dir,'data'),'dirty'); assert.equal(reader.readBytes('data',8).toString(),'original');
  assert.equal(reader.status('link'),'link'); assert.equal(reader.status('module'),'link'); assert.equal(reader.status('missing'),'missing'); assert.throws(() => reader.readBytes('link',8)); assert.throws(() => reader.readBytes('data',7),/exceeds/);
  assert.throws(() => openDependency(dir,'d'.repeat(40)), /HEAD/);
  mkdirSync(join(dir,'sub')); assert.throws(() => openDependency(join(dir,'sub'),commit),/root/);
});


test('required data stage keeps closed contract count and metadata stage propagates unrunnable dependencies', () => {
  for (const doc of [null, {}, {format:'ovdb-representation-contract/3',contracts:[]}, {format:'ovdb-representation-contract/3',contracts:Array(33).fill({})}]) assert.throws(()=>verifySourceData(doc,new Map()));
  const f=full(); const failed={get commit(){const e=new Error('Git unavailable');e.code='DEPENDENCY_UNRUNNABLE';throw e;}};
  f.dependencies.set(`${sourceRepo}@${revision}`,failed);
  assert.throws(()=>check(f),(e)=>e.code==='DEPENDENCY_UNRUNNABLE');
});

function replaceArtifact(f, reference, value) {
  Object.assign(reference, f.put(reference.path, value));
  if (reference !== f.contract.target.snapshot) {
    const snapshot = JSON.parse(f.files.get(f.contract.target.snapshot.path));
    const artifact = snapshot.artifacts.find((a) => a.path === reference.path);
    if (artifact) artifact.sha256 = reference.sha256;
    else snapshot.artifacts.push({ ...reference });
    Object.assign(f.contract.target.snapshot, f.put(f.contract.target.snapshot.path, snapshot));
  }
  f.repack();
}

test('bridge dictionaries reject repeated exact labels and absent native keys', () => {
  for (const version of [1, 2]) for (const rows of [[{raw_label:'x',target_key:'id:1'},{raw_label:'x',target_key:'id:1'}], [{raw_label:'x',target_key:'missing'}]]) {
    const f=full(version); replaceArtifact(f,f.contract.bridge.artifact,{table:'Bridge',rows}); refused(f,/collision|absent/);
  }
});

test('unchanged original snapshot association preserves all values and number tokens', () => {
  for (const mode of ['valid', 'changed', 'number', 'count', 'unknown_selector']) {
    const f=full();
    const original={outputs:{sqlite:{file:f.contract.native.dataset.path,sha256:f.contract.native.dataset.sha256},chunks:[{file:'chunk'}]},counts:{Entities:2},unrelated:{value:1}};
    let originalText=JSON.stringify(original);
    if(mode==='number') originalText=originalText.replace('"value":1','"value":1.0');
    if(mode==='count') originalText=originalText.replace('"Entities":2','"Entities":2.0');
    const originalRef=f.put('source/original.json',originalText);
    replaceArtifact(f,originalRef,originalText);
    const provenance=JSON.parse(f.files.get(f.contract.native.provenance.path));
    provenance.snapshot=original;
    if(mode==='changed') provenance.snapshot.unrelated.value=2;
    provenance.snapshot_association={source:originalRef,output_key:mode==='unknown_selector'?'unknown':'sqlite'};
    replaceArtifact(f,f.contract.native.provenance,provenance);
    if(mode==='valid') assert.deepEqual(check(f).problems,[]);
    else refused(f,/snapshot|count/);
  }
});

test('both label formats refuse external bridge/key copies before opening their reader', () => {
  for (const version of [1, 2]) for (const field of ['bridge.artifact', 'target.keys']) {
    const local = full(version);
    assert.deepEqual(check(local).problems, []);
    const f = full(version);
    const reference = field === 'bridge.artifact' ? f.contract.bridge.artifact : f.contract.target.keys;
    f.externalFiles.set(reference.path, f.files.get(reference.path));
    f.files.delete(reference.path);
    Object.assign(reference, { repository: sourceRepo, revision });
    f.repack();
    refused(f, new RegExp(`${field.replace('.', '\\.')} must be provider-local`));
    assert.equal(f.touched.includes(reference.path), false, `${version}/${field} must not resolve its external copy`);
  }
});

test('every implicit snapshot count preserves signed integer tokens without rounding', () => {
  const countFixture = (token, selected = false) => {
    const f = full();
    let provenance = f.files.get(f.contract.native.provenance.path).toString();
    provenance = selected ? provenance.replace('"Entities":2', `"Entities":${token}`) : provenance.replace('"Entities":2', `"Entities":2,"Unrelated":${token}`);
    replaceArtifact(f, f.contract.native.provenance, provenance);
    return f;
  };
  for (const token of ['0', '-0', '3', '-3', '9007199254740991', '-9007199254740991']) assert.deepEqual(check(countFixture(token)).problems, [], token);
  for (const token of ['1.5', '1.0', '1e0', '-1e0', '"1"', 'null', 'true', '[]', '{}', '9223372036854775807', '-9223372036854775808', '9223372036854775808', '-9223372036854775809', '9007199254740992', '9007199254740993', '-9007199254740992', '-9007199254740993']) refused(countFixture(token), /implicit snapshot count/, token);
  for (const token of ['2.0', '2e0', '9007199254740993', '-2']) refused(countFixture(token, true), /count/);
});
