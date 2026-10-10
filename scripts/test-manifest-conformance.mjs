// The conformance cases of the manifest mapping, run through the Directory checker (CC0-1.0). The cases are one
// file, scripts/fixtures/manifest-conformance.json; demo-db/chinook holds a byte-identical copy that its own
// pre-check runs, and the two checkers must agree on every case. Each case is run twice, against the model in
// ModelSpec's current vocabulary and against the same model in the earlier one.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { cleanup, conformance, directoryVerdict, manifestFor } from './conformance-world.mjs';
import { manifestProblems } from './lib/directory.mjs';
import { columnModelProblems } from './lib/manifest-mapping.mjs';

after(cleanup);

// The notice about recordset_entities is identified by its text: the Directory has other warnings.
const noticed = (warnings) => warnings.some((warning) => warning.includes('recordset_entities is the earlier form of the mapping'));
const spellingWarning = (warnings) => warnings.some((warning) => warning.includes('is in the earlier ModelSpec spelling'));
const mentions = (lines, texts) => {
  const joined = lines.join('\n');
  for (const text of texts) assert.ok(joined.includes(text), `expected the problems to contain ${JSON.stringify(text)}, got:\n${joined || '(none)'}`);
};

for (const vocabulary of ['current', 'earlier']) {
  describe(`manifest conformance cases, model in the ${vocabulary} vocabulary`, () => {
    for (const c of conformance.cases) {
      test(`${c.id}: ${c.verdict}${c.stage ? ` at the ${c.stage} stage` : c.notice ? ' with a notice' : ''}`, async () => {
        const result = await directoryVerdict(c.manifest, vocabulary);
        if (c.verdict === 'refuse') {
          assert.notDeepEqual(result.problems, [], 'the whole check refuses');
          mentions(result.problems, c.messageHas);
          if (c.stage === 'manifest') {
            // Refused from the manifest's text alone: the model is not read.
            assert.notDeepEqual(result.manifest, [], 'the manifest stage refuses');
            mentions(result.manifest, c.messageHas);
          } else {
            assert.deepEqual(result.manifest, [], 'the manifest stage accepts; the file stage refuses');
          }
          assert.equal(result.index, null);
        } else {
          assert.deepEqual(result.manifest, []);
          assert.deepEqual(result.problems, []);
          assert.equal(noticed(result.warnings), c.notice, `the notice about recordset_entities is ${c.notice ? '' : 'not '}reported`);
          assert.equal(spellingWarning(result.warnings), vocabulary === 'earlier', 'the Directory warns about the earlier model spelling, and only then');
          assert.deepEqual(result.warnings.filter((warning) => !noticed([warning]) && !spellingWarning([warning])), [], 'no other warning');
          assert.ok(result.index);
        }
      });
    }

    for (const pair of conformance.pairs) {
      test(`${pair.id}: ${pair.cases.join(' and ')} are both accepted and give the same index entry`, async () => {
        const [first, second] = await Promise.all(pair.cases.map((id) => directoryVerdict(conformance.cases.find((c) => c.id === id).manifest, vocabulary)));
        for (const result of [first, second]) assert.deepEqual(result.problems, []);
        assert.ok(first.index.recordsets.some((recordset) => recordset.name === 'Order Lines' && recordset.modelRecordType === 'OrderLine'));
        assert.deepEqual(first.index.recordsets, second.index.recordsets);
      });
    }
  });
}

test('the cases cover each identifier A1 to A8, B1 to B28 and C1 to C6 once, and the pair C7', () => {
  const ids = new Set(conformance.cases.map((c) => c.id.replace(/[a-d]$/, '')));
  for (let n = 1; n <= 8; n += 1) assert.ok(ids.has(`A${n}`), `A${n}`);
  for (let n = 1; n <= 28; n += 1) assert.ok(ids.has(`B${n}`), `B${n}`);
  for (let n = 1; n <= 6; n += 1) assert.ok(ids.has(`C${n}`), `C${n}`);
  assert.deepEqual(conformance.pairs.map((pair) => pair.id), ['C7']);
  assert.equal(new Set(conformance.cases.map((c) => c.id)).size, conformance.cases.length);
});

test('a case that leaves a key out leaves it out of the manifest', () => {
  assert.ok(!Object.hasOwn(manifestFor({ recordsets: ['Customer'] }), 'format'));
  assert.ok(!Object.hasOwn(manifestFor({ format: 'ovdb-manifest/draft-2', recordsets: ['Customer'] }), 'recordset_entities'));
  assert.equal(manifestFor({ format: 'ovdb-manifest/draft-1', recordsets: ['Customer'], recordset_entities: null }).recordset_entities, null);
});

test('a column that holds a path into a component says that no reader reads components yet, and nothing about what the field holds', () => {
  const problems = columnModelProblems({ name: 'payments', recordType: 'Payment', columns: new Map([['amount_minor', 'Amount.Minor']]) }, new Set(['Amount']));
  assert.deepEqual(problems, ['recordsets "payments": column "amount_minor" holds "Amount.Minor": no reader of the model reads a component yet, so "Minor" cannot be read in Amount']);
});

test('a value that refers to itself is reported as a problem and does not throw', () => {
  const list = ['Customer', 'OrderLine'];
  list.push(list);
  const item = { name: 'Customer' };
  item.record_type = item;
  const columns = { name: 'Customer', columns: {} };
  columns.columns.self = columns.columns;
  for (const format of ['ovdb-manifest/draft-1', 'ovdb-manifest/draft-2']) {
    for (const recordsets of [list, ['OrderLine', item], ['OrderLine', columns]]) {
      let problems;
      assert.doesNotThrow(() => { problems = manifestProblems(manifestFor({ format, recordsets })); }, `${format}`);
      assert.ok(problems.length > 0, `${format}: the manifest is refused`);
    }
  }
});

test('a map that refers to itself under its own key toString is reported as a problem and does not throw', () => {
  // `record_type: &a {toString: *a}` and `format: &f {toString: *f}` in YAML: turning the value into text calls the map's toString, which is the map.
  const loop = {};
  loop.toString = loop;
  const asRecordType = manifestFor({ format: 'ovdb-manifest/draft-2', recordsets: ['OrderLine', { name: 'Customer', record_type: loop }] });
  let problems;
  assert.doesNotThrow(() => { problems = manifestProblems(asRecordType); }, 'record_type');
  assert.ok(problems.some((problem) => problem.includes('recordsets "Customer": record_type must be a ModelSpec record type name')), problems.join('\n'));
  assert.ok(problems.some((problem) => problem.includes('got a value that refers to itself')), problems.join('\n'));
  for (const recordsets of [['Customer', 'OrderLine'], [{ name: 'Customer' }, 'OrderLine']]) {
    assert.doesNotThrow(() => { problems = manifestProblems(manifestFor({ format: loop, recordsets })); }, 'format');
    assert.ok(problems.some((problem) => problem.includes('format must be ovdb-manifest/draft-1 or ovdb-manifest/draft-2, got a value that refers to itself')), problems.join('\n'));
  }
});

test('an item with a record type but no name is told once that it needs a name, and its record type is reported against its position', () => {
  const problems = manifestProblems(manifestFor({ format: 'ovdb-manifest/draft-2', recordsets: [{ record_type: '9x' }, 'OrderLine'] }));
  assert.deepEqual(problems.filter((problem) => problem.includes('recordsets')).map((problem) => problem.replace(/^.*?ovdb\.yaml: /, '')), [
    'recordsets item 1 needs name: the recordset\'s own name',
    'recordsets item 1: record_type must be a ModelSpec record type name (letters, digits and _, not starting with a digit), got "9x"',
  ]);
  assert.ok(!problems.some((problem) => problem.includes('recordsets undefined')), problems.join('\n'));
});

test('a name listed twice is reported as that, and not also as two recordsets of one record type', () => {
  const problems = manifestProblems(manifestFor({ format: 'ovdb-manifest/draft-2', recordsets: ['Customer', { name: 'Customer' }, 'OrderLine'] }));
  assert.deepEqual(problems.map((problem) => problem.replace(/^.*?ovdb\.yaml: /, '')), ['recordsets lists a name twice: "Customer"']);
  // Two different names with one record type are still reported.
  const clash = manifestProblems(manifestFor({ format: 'ovdb-manifest/draft-2', recordsets: ['Customer', { name: 'clients', record_type: 'Customer' }, 'OrderLine'] }));
  assert.deepEqual(clash.map((problem) => problem.replace(/^.*?ovdb\.yaml: /, '')), ['recordsets "Customer" and "clients" both have the record type Customer; mappings must be one-to-one']);
});

test('B4: the index entry names the recordsets as the manifest does, and a reference points at the recordset that holds the record type', async () => {
  const b4 = conformance.cases.find((c) => c.id === 'B4');
  for (const vocabulary of ['current', 'earlier']) {
    const { index } = await directoryVerdict(b4.manifest, vocabulary);
    const byName = new Map(index.recordsets.map((recordset) => [recordset.name, recordset]));
    assert.deepEqual([...byName.keys()].sort(), ['OrderLine', 'customers'], vocabulary);
    assert.equal(byName.get('customers').modelRecordType, 'Customer', vocabulary);
    assert.equal(byName.get('OrderLine').modelRecordType, 'OrderLine', vocabulary);
    // CustomerId references the record type Customer, which this manifest calls "customers".
    assert.deepEqual(byName.get('OrderLine').fields.find((field) => field.name === 'CustomerId'), { name: 'CustomerId', type: 'reference', references: 'customers', meanings: [] }, vocabulary);
  }
});

// openvaultdb/ovdb copies the refusals it walks out of this file by their text (its directory-stage generator, at the commit
// it pins), and stops when a text is not found in the source. The refusal for an old-form manifest therefore stays one
// contiguous piece of text in the source, whatever the message is built from.
test('the refusal of recordsets that lack ModelSpec entities is written out in the source, and is what an old-form manifest gets', async () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib', 'directory.mjs'), 'utf8');
  assert.ok(source.includes('recordsets lacks ModelSpec entities'), 'the text is in scripts/lib/directory.mjs');
  const a4 = conformance.cases.find((c) => c.id === 'A4');
  for (const vocabulary of ['current', 'earlier']) {
    const { problems } = await directoryVerdict(a4.manifest, vocabulary);
    assert.ok(problems.some((problem) => problem.endsWith('ovdb.yaml: recordsets lacks ModelSpec entities: OrderLine')), problems.join('\n'));
  }
});

// The mapping and the conformance cases are held byte for byte in two repositories: here, and in demo-db/chinook
// (scripts/lib/manifest-mapping.mjs and scripts/testdata/manifest-conformance.json). This repository cannot read the
// other one offline, so it records the SHA-256 of each file as it stands in both; the test of demo-db/chinook is to record the
// same two values (openvaultdb/directory#49, item m13). A change to either file here fails this test until the two values are changed with it, which is the
// moment to carry the file to demo-db/chinook (and to carry it back, in the other direction). To update: shasum -a 256 <file>.
const sharedWithChinook = {
  'lib/manifest-mapping.mjs': 'eadd6b8869b72caea8df8ad416e8696781a857dc60b180510aa4c75b3f8b9a8e',
  'fixtures/manifest-conformance.json': '5a7b576cf5682c19e0d09f7f59843d78b59f0ae4d3beefc899db5570bb2602af',
};
test('the mapping and the conformance cases are the files that demo-db/chinook holds a copy of', () => {
  for (const [path, digest] of Object.entries(sharedWithChinook)) {
    const actual = createHash('sha256').update(readFileSync(join(dirname(fileURLToPath(import.meta.url)), path))).digest('hex');
    assert.equal(actual, digest, `scripts/${path} is not the file recorded as shared with demo-db/chinook: carry the change to the copy there, then record sha256:${actual} in both tests`);
  }
});
