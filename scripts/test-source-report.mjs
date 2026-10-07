import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stringify, parse } from 'yaml';
import { sourceContractReport, sourceReportArguments, reportExitCode, reportLimits } from './lib/source-report.mjs';
import { sourceProblems } from './lib/source-discovery.mjs';

const source = () => ({ format: 'ovdb-source/draft-1', title: 'Synthetic reference', description: 'Metadata fixture only', status: 'inactive', publisher: 'Fixture', homepage: 'https://example.org/', resource_url: 'https://example.org/reference', terms_url: 'https://example.org/terms', access_mode: 'live-http-via-ovdb', retention: 'none', activation_blockers: ['fixture is not activated'], notices: ['no provider call occurred'], maintainers: ['owner'], recordsets: [{ name: 'Reference', description: 'Proposed native subset', fields: [{ name: 'code', type: 'string', description: 'Native code' }] }] });
const hash = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
function repository(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'source-report-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = args => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.org', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.org' } });
  run(['init', '-q', '--template=']);
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), typeof data === 'string' ? data : stringify(data));
  }
  run(['add', '.']); run(['commit', '-qm', 'Synthetic metadata fixture']);
  return { root: dir, commit: run(['rev-parse', 'HEAD']).trim() };
}
function directory(t, entries = { candidate: source() }, more = {}) {
  return repository(t, { ...Object.fromEntries(Object.entries(entries).map(([id, value]) => [`sources/$records/${id}.yaml`, value])), 'maintainers/$records/owner.yaml': { name: 'Fixture owner' }, 'databases/$records/example.yaml': 'title: inventory only\n', ...more });
}
const codes = report => report.findings.map(f => f.code);

// Detect any accidental use of the fetch-based registry or provider path.
const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = () => { fetchCalls++; throw new Error('network access forbidden'); };
after(() => assert.equal(fetchCalls, 0, 'offline report made a network request'));
process.on('exit', () => { globalThis.fetch = originalFetch; });

test('pinned records auto-enumerate new sources deterministically, ignoring uncommitted payloads', t => {
  const second = source(); second.resource_url = 'https://example.org/second';
  const opts = directory(t, { candidate: source(), 'new-candidate': second });
  const before = sourceContractReport(opts);
  writeFileSync(join(opts.root, 'sources/$records/candidate.yaml'), 'data: secret-row\n');
  writeFileSync(join(opts.root, 'sources/$records/untracked.yaml'), 'data: ignored\n');
  const after = sourceContractReport(opts);
  assert.deepEqual(after, before);
  assert.equal(JSON.stringify(after), JSON.stringify(sourceContractReport(opts)));
  assert.equal(after.inventory.sources, 2);
  assert.equal(after.inventory.databases, 1);
  assert.equal(after.inventory.databasesScope, 'count-only');
  assert.deepEqual(after.sources.map(s => s.declaredStatus), ['inactive', 'inactive']);
  assert.equal(after.checks['source-contract'].outcome, 'valid');
  for (const layer of ['collection', 'maintainer-content', 'publisher', 'database-metadata', 'site-delivery', 'execution', 'semantics']) assert.equal(after.layers[layer].outcome, 'not-checked');
  assert.equal(reportExitCode(after), 0);
  assert.doesNotMatch(JSON.stringify(after), /secret-row|ignored|resource_url|global.*valid/);
});

test('malformed and unknown fields fail with stable codes without disclosing values', t => {
  const unknown = source(); unknown.token = 'secret-unknown-payload';
  const malformed = source(); malformed.recordsets[0].fields = [null];
  const report = sourceContractReport(directory(t, { unknown, malformed, yaml: 'field: [\n' }));
  assert.ok(codes(report).includes('source-fields'));
  assert.ok(codes(report).includes('source-native-field'));
  assert.ok(codes(report).includes('record-yaml'));
  assert.equal(report.checks['record-parse'].outcome, 'invalid');
  assert.equal(reportExitCode(report), 1);
  assert.doesNotMatch(JSON.stringify(report), /secret-unknown-payload/);
});

test('duplicate resources and maintainer reference failures reuse existing source rules', t => {
  const one = source(); one.maintainers = ['missing-sensitive-handle'];
  const report = sourceContractReport(directory(t, { one, two: source() }));
  assert.ok(codes(report).includes('source-duplicate-resource'));
  assert.ok(codes(report).includes('source-maintainer-reference'));
  assert.equal(report.checks['maintainer-reference'].outcome, 'invalid');
  assert.doesNotMatch(JSON.stringify(report), /missing-sensitive-handle/);
  // Duplicate IDs cannot exist in one Git tree; exercise the same diagnostic
  // origin directly with two synthetic reader records.
  const findings = [];
  sourceProblems([{ key: 'one', file: 'one.yaml', data: source() }, { key: 'one', file: 'two.yaml', data: source() }], [{ key: 'owner' }], undefined, f => findings.push(f));
  assert.ok(findings.some(f => f.code === 'source-id' && f.file === 'two.yaml'));
});

test('maintainer content is explicitly unchecked while key existence is checked', t => {
  const report = sourceContractReport(directory(t, undefined, { 'maintainers/$records/owner.yaml': {} }));
  assert.equal(report.checks['maintainer-reference'].outcome, 'valid');
  assert.equal(report.layers['maintainer-content'].outcome, 'not-checked');
  assert.equal(report.inventory.databases, 1);
  assert.equal(report.layers['database-metadata'].outcome, 'not-checked');
});

test('optional links need no index; declared links without evidence remain unverified', t => {
  const noLinks = sourceContractReport(directory(t));
  assert.equal(noLinks.checks['related-targets'].outcome, 'valid');
  const linked = source(); linked.modelspec_url = 'https://modelspec.org/registry/models/related/'; linked.meaninggraph_url = 'https://meaninggraph.io/graphs/related/';
  const opts = directory(t, { linked });
  const report = sourceContractReport(opts);
  assert.equal(report.checks['related-targets'].outcome, 'unverified');
  assert.equal(report.sources[0].declaredStatus, 'inactive');
  assert.equal(reportExitCode(report), 0);
  const models = [{ id: 'related', address: 'modelspec://github.com/example/repo/Related' }];
  const model = repository(t, { 'index.json': JSON.stringify({ format: 'modelspec-registry/draft-1', models, checksum: hash(JSON.stringify(models)) }) });
  const withModel = sourceContractReport({ ...opts, modelPath: model.root, modelCommit: model.commit });
  assert.equal(withModel.checks['model-registry-input'].outcome, 'valid');
  assert.equal(withModel.findings.filter(f => f.code === 'registry-target-unverified').length, 1);
  assert.equal(withModel.findings.find(f => f.code === 'registry-target-unverified').field, 'meaninggraph_url');
  const graphs = [{ id: 'different', address: 'meaning://github.com/example/other' }];
  const meaning = repository(t, { 'index.json': JSON.stringify({ format: 'meaning-registry/draft-1', graphs, checksum: hash(JSON.stringify(graphs)) }) });
  const missing = sourceContractReport({ ...opts, meaningPath: meaning.root, meaningCommit: meaning.commit, modelPath: model.root, modelCommit: model.commit });
  assert.ok(codes(missing).includes('source-registry-target'));
  assert.equal(missing.checks['related-targets'].outcome, 'invalid');
});

test('requested local index missing is unrunnable; malformed provided bytes are invalid', t => {
  const opts = directory(t);
  const malformed = repository(t, { 'index.json': '{"token":"do-not-leak",' });
  const report = sourceContractReport({ ...opts, modelPath: malformed.root, modelCommit: malformed.commit });
  assert.equal(report.checks['model-registry-input'].outcome, 'invalid');
  assert.equal(reportExitCode(report), 1);
  assert.doesNotMatch(JSON.stringify(report), /do-not-leak/);
  const absent = sourceContractReport({ ...opts, modelPath: '/definitely/missing', modelCommit: malformed.commit });
  assert.equal(absent.checks['model-registry-input'].outcome, 'unrunnable');
  assert.equal(reportExitCode(absent), 2);
  const wrongPin = sourceContractReport({ ...opts, commit: '0'.repeat(40) });
  assert.equal(wrongPin.checks['directory-input'].outcome, 'unrunnable');
});

test('requested index projection verifies exact source bytes/checksum, never database metadata', t => {
  const entries = [{ id: 'candidate', ...source() }];
  const index = { format: 'ovdb-directory/draft-1', databases: [{ invalid: true }], sources: entries, sourcesChecksum: hash(JSON.stringify(entries)) };
  const good = sourceContractReport({ ...directory(t, undefined, { 'index.json': JSON.stringify(index) }), checkIndex: true });
  assert.equal(good.checks['index-source-projection'].outcome, 'valid');
  assert.equal(good.layers['database-metadata'].outcome, 'not-checked');
  index.sourcesChecksum = 'sha256:' + '0'.repeat(64);
  const bad = sourceContractReport({ ...directory(t, undefined, { 'index.json': JSON.stringify(index) }), checkIndex: true });
  assert.ok(codes(bad).includes('directory-source-projection-invalid'));
  index.sourcesChecksum = hash(JSON.stringify(entries)); index.sources[0].title = 'different projection';
  const drift = sourceContractReport({ ...directory(t, undefined, { 'index.json': JSON.stringify(index) }), checkIndex: true });
  assert.equal(drift.checks['index-source-projection'].outcome, 'invalid');
  const empty = sourceContractReport({ ...directory(t, {}, { 'index.json': JSON.stringify({ format: 'ovdb-directory/draft-1', databases: [] }) }), checkIndex: true });
  assert.equal(empty.inventory.sources, 0);
  assert.equal(empty.checks['index-source-projection'].outcome, 'valid');
});

test('synthetic BigQuery evidence stays refused and query gates remain declared blocked', t => {
  const bigquery = parse(readFileSync(join(import.meta.dirname, '../sources/$records/bigquery-world-bank-wdi.yaml'), 'utf8'));
  bigquery.metadata_observations = [JSON.parse(readFileSync(join(import.meta.dirname, 'testdata/bigquery-public-observation.json'), 'utf8'))];
  const report = sourceContractReport(directory(t, { 'bigquery-world-bank-wdi': bigquery }, { 'maintainers/$records/trakhimenok.yaml': { name: 'Fixture' } }));
  assert.ok(codes(report).includes('source-observation-contract'));
  assert.equal(report.sources[0].declaredStatus, 'inactive');
  assert.equal(report.sources[0].declaredQueryActivation, 'blocked');
  assert.equal(report.sources[0].contractOutcome, 'invalid');
  assert.doesNotMatch(JSON.stringify(report), /synthetic_metadata_fixture|bigquery-public-data|fixture_details/);
});

test('output bounds omit findings without hiding an invalid outcome', t => {
  const many = Object.fromEntries(Array.from({ length: reportLimits.findings + 1 }, (_, i) => [`source-${i}`, { bad: 'private payload' }]));
  const report = sourceContractReport(directory(t, many));
  assert.equal(report.findings.length, reportLimits.findings);
  assert.equal(report.summary.omitted, 1);
  assert.equal(reportExitCode(report), 1);
  assert.doesNotMatch(JSON.stringify(report), /private payload/);
});

test('CLI requires a local pinned tree and rejects ambiguous flags', t => {
  const opts = directory(t);
  assert.deepEqual(sourceReportArguments([opts.root, '--commit', opts.commit]), opts);
  for (const args of [[], [opts.root], [opts.root, '--commit', 'main'], [opts.root, '--commit', opts.commit, '--meaning-index', '/tmp/index'], [opts.root, '--commit', opts.commit, '--commit', opts.commit]]) assert.throws(() => sourceReportArguments(args));
  const script = join(import.meta.dirname, 'source-report.mjs');
  const stdout = execFileSync(process.execPath, [script, opts.root, '--commit', opts.commit], { encoding: 'utf8' });
  assert.equal(JSON.parse(stdout).checks['source-contract'].outcome, 'valid');
});
