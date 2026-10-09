// The conformance cases of the manifest mapping, run through the Directory checker (CC0-1.0). The cases are one
// file, scripts/fixtures/manifest-conformance.json; demo-db/chinook holds a byte-identical copy that its own
// pre-check runs, and the two checkers must agree on every case. Each case is run twice, against the model in
// ModelSpec's current vocabulary and against the same model in the earlier one.
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { cleanup, conformance, directoryVerdict, manifestFor } from './conformance-world.mjs';

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

test('the cases cover every identifier of section 6.3, 6.4 and 6.5 of the contract once', () => {
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
