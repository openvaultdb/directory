// Exact metadata fixtures from openvaultdb/ovdb v0.27.1; upstream Apache-2.0
// notices are retained in lib/representation-LICENSE.txt. These staged fixtures
// do not establish provider admission and never include/read a native corpus.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { checkRepresentation } from './lib/representation.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const capturedBytes = readFileSync(new URL('./testdata/representation-receipts.json', import.meta.url));
assert.equal(hash(capturedBytes), '68e69f1c12adde4d22e4869284d24b88141192f7f848c6ea7a27a7bd83a21293');
const frozen = JSON.parse(capturedBytes);
const commit = 'a'.repeat(40);
function captured(name) {
  const capture = frozen.fixtures[name];
  const doc = JSON.parse(capture.contract);
  const local = new Map([['contract.json', Buffer.from(capture.contract)]]);
  const pools = new Map();
  for (const { reference, bytes } of capture.references) {
    const b = Buffer.from(bytes);
    assert.equal(hash(b), reference.sha256, `${name}:${reference.path} frozen raw bytes`);
    let pool = local;
    if (reference.repository) {
      const key = `${reference.repository}@${reference.revision}`;
      if (!pools.has(key)) pools.set(key, new Map());
      pool = pools.get(key);
    }
    pool.set(reference.path, b);
  }
  const touched = [];
  const reader = (files, revision = commit) => ({
    commit: revision,
    status: (p) => files.has(p) ? 'file' : 'missing',
    kind: (p) => files.has(p) ? 'file' : 'missing',
    readBytes(p, limit) {
      touched.push({ path: p, limit });
      const b = files.get(p);
      assert.ok(b && b.length <= limit, `missing or oversized metadata ${p}`);
      return b;
    },
  });
  const contract = doc.contracts[0];
  const manifest = {
    model: { modelspec: contract.target.model.path },
    meaning: { file: contract.target.binding.document.path },
    recordsets: [...new Set(doc.contracts.flatMap(c => [c.target.entity, c.bridge?.table].filter(Boolean)))],
  };
  const dependencies = new Map([...pools].map(([key, files]) => [key, reader(files, key.split('@')[1])]));
  const f = { doc, contract, local, touched, manifest, dependencies, reader: reader(local),
    repository: `https://github.com/ingitdb/${name === 'real-ror' ? 'ror' : 'geo'}-ingitdb` };
  repack(f);
  return f;
}
function repack(f) {
  const b = Buffer.from(JSON.stringify(f.doc));
  f.local.set('contract.json', b);
  f.envelope = { path: 'contract.json', sha256: hash(b) };
}
function replace(f, ref, value) {
  const b = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  f.local.set(ref.path, b); ref.sha256 = hash(b);
  if (ref !== f.contract.target.snapshot) {
    const snapshot = JSON.parse(f.local.get(f.contract.target.snapshot.path));
    const entry = snapshot.artifacts.find(a => a.path === ref.path);
    if (entry) entry.sha256 = ref.sha256;
    replace(f, f.contract.target.snapshot, snapshot);
  }
  repack(f);
}
// Core entry matches meaninggraph/registry@94a64fb4c4458c02de7413c3b40761e09a02c011.
// A fixture registry uses the same exact repository/revision/path membership
// rule as Directory's record context. Hash and concepts remain checked by the
// explicit frozen dependency reader. It never grants arbitrary references.
const registry = [{ repository: 'https://github.com/meaninggraph/core',
  address: 'meaning://github.com/meaninggraph/core',
  commit: '982916d73f0a35ff2558b0062f58aa3ac4f24d97', meaning_files: ['*.meaning.yaml'] }];
function registered(ref) {
  const address = `meaning://${ref.repository.slice(8)}`;
  const matches = registry.filter(g => g.address === address);
  return matches.length === 1 && matches[0].commit === ref.revision && matches[0].repository === ref.repository
    && `meaning://${matches[0].repository.slice(8)}` === matches[0].address
    && matches[0].meaning_files.some(pattern => new RegExp('^' + pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$').test(ref.path));
}
function check(f) { return checkRepresentation(f.envelope, f.reader, f.manifest, f.repository, f.dependencies, registered); }
function refusal(f, pattern) { assert.match(check(f).problems.join('\n'), pattern); }

test('frozen real ROR, Geo label bridge and hypothetical native Geo metadata stay byte exact', () => {
  assert.equal(frozen.upstream.revision, '27f2664782e01feb4fb5938f28b8f8eae0a868a8');
  for (const name of Object.keys(frozen.fixtures)) {
    const f = captured(name);
    assert.deepEqual(check(f).problems, [], name);
    for (const c of f.doc.contracts) {
      assert.equal(f.touched.some(x => x.path === c.native?.dataset.path || x.path === c.source.data?.path), false);
    }
    assert.ok(f.touched.every(x => x.limit <= 4 * 1024 * 1024));
    if (f.contract.native) assert.ok(f.touched.some(x => x.path === f.contract.native.provenance.path && x.limit === 2 * 1024 * 1024));
  }
});

test('retained receipt and snapshot evidence fields are open but protocol aliases are refused', () => {
  for (const change of [
    s => { s.artifacts[0].bytes = 1; s.artifacts[0].kind = 'metadata'; s.artifacts[0].evidence = { retained: true }; },
    s => { s.evidence = { retained: true }; s.generator.tool = 'pinned'; },
  ]) {
    const f = captured('real-ror'); const s = JSON.parse(f.local.get(f.contract.target.snapshot.path));
    change(s); replace(f, f.contract.target.snapshot, s); assert.deepEqual(check(f).problems, []);
  }
  const aliasCases = [
    ['real-ror', 'provenance', p => { p.NATIVE_KEY = p.native_key; }],
    ['real-ror', 'provenance', p => { p.SNAPSHOT = p.snapshot; }],
    ['real-ror', 'provenance', p => { p.ſnapshot = p.snapshot; }],
    ['real-ror', 'provenance', p => { p.snapshot.OUTPUTS = p.snapshot.outputs; }],
    ['real-ror', 'provenance', p => { const output = Object.values(p.snapshot.outputs)[0]; output.SHA256 = output.sha256; }],
    ['real-ror', 'provenance', p => { p.SNAPSHOT_ASSOCIATION = null; }],
    ['real-ror', 'snapshot', s => { s.GENERATOR = s.generator; }],
    ['real-ror', 'snapshot', s => { s.generator.Repository = s.generator.repository; }],
    ['real-ror', 'snapshot', s => { s.artifacts[0].PATH = s.artifacts[0].path; }],
    ['native-geonames', 'snapshot', s => { s.artifacts[0].SHA256 = s.artifacts[0].sha256; }],
  ];
  for (const [name, type, mutate] of aliasCases) {
    const f = captured(name); const ref = type === 'snapshot' ? f.contract.target.snapshot : f.contract.native.provenance;
    const value = JSON.parse(f.local.get(ref.path)); mutate(value); replace(f, ref, value);
    refusal(f, /non-exact JSON field|root fields invalid|invalid.*artifact/);
  }
});

test('open evidence does not admit malformed typed core, duplicate keys or invalid associations', () => {
  for (const mutate of [
    p => { p.native_key.extra = true; }, p => { p.native_key.records = null; },
    p => { p.native_key.duplicates = 1; }, p => { p.native_key.model.extra = true; },
    p => { p.native_key.entity = 'other'; }, p => { delete p.native_key; },
  ]) {
    const f = captured('real-ror'), ref = f.contract.native.provenance;
    const p = JSON.parse(f.local.get(ref.path)); mutate(p); replace(f, ref, p); refusal(f, /native/);
  }
  for (const mutate of [
    s => { s.artifacts[0].path = '../escape'; }, s => { s.artifacts[0].sha256 = 'x'; },
    s => { s.artifacts.push(s.artifacts[0]); }, s => { s.artifacts[0].path = 1; },
    s => { s.artifacts[0].sha256 = []; }, s => { s.artifacts[0].sha256 = [s.artifacts[0].sha256]; },
    s => { s.generator.revision = [s.generator.revision]; }, s => { s.artifacts[0] = null; },
  ]) {
    const f = captured('real-ror'), ref = f.contract.target.snapshot;
    const s = JSON.parse(f.local.get(ref.path)); mutate(s); replace(f, ref, s); refusal(f, /snapshot|artifact/);
  }
  const duplicate = captured('real-ror'), ref = duplicate.contract.native.provenance;
  const raw = duplicate.local.get(ref.path).toString();
  replace(duplicate, ref, raw.replace('{', '{"native_key":{},')); refusal(duplicate, /duplicate JSON key/);
  const wrongHash = captured('real-ror'); wrongHash.local.set(wrongHash.contract.native.provenance.path, Buffer.from('{}')); refusal(wrongHash, /SHA-256 mismatch/);
  for (const mutate of [p => { p.snapshot_association.output_key = 'missing'; }, p => { p.snapshot_association.extra = true; }, p => { p.snapshot.outputs.sqlite.sha256 = 'f'.repeat(64); }]) {
    const f = captured('native-geonames'), ref = f.contract.native.provenance;
    const p = JSON.parse(f.local.get(ref.path)); mutate(p); replace(f, ref, p); refusal(f, /snapshot|association/);
  }
});
