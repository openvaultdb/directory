// Self-test of the journey spec (CC0-1.0): it must pass against a good pair of
// mock sites and fail against each pair with one deliberate defect, so a defect
// on that list is noticed (no other defect is covered). It needs no real sites,
// only a browser (npx playwright install chromium, or PLAYWRIGHT_CHANNEL=chrome).
//
//   npm run test:journey:selftest
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { defects, startMockSites } from './fixtures/mock-sites.mjs';
import { synonymsOf } from './page-checks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(here));
const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
const cli = join(root, 'node_modules', '@playwright', 'test', 'cli.js');

// Runs the journey spec against a mock pair; resolves { status, output }.
async function journey(defect) {
  const sites = await startMockSites(index, { defect });
  try {
    return await new Promise((resolve) => {
      execFile(process.execPath, [cli, 'test', '--config', join(here, 'playwright.config.mjs')], {
        cwd: root,
        env: { ...process.env, MEANINGGRAPH_BASE_URL: sites.meaninggraphUrl, OVDB_DIRECTORY_BASE_URL: sites.directoryUrl, OVDB_DIRECTORY_INDEX_URL: '', CI: '', JOURNEY_EXPECT_TIMEOUT_MS: '2500' },
        maxBuffer: 64 * 1024 * 1024,
      }, (error, stdout, stderr) => resolve({ status: error ? (error.code ?? 1) : 0, output: `${stdout}${stderr}` }));
    });
  } finally {
    await sites.close();
  }
}

test('the journey passes against good mock sites, so a failure below is about the defect', async () => {
  const { status, output } = await journey(undefined);
  assert.equal(status, 0, output);
  assert.match(output, /3 passed/);
});

// Each defect fails the step it breaks (the message names what the step could not find).
const expected = {
  'no-search-results': /searching "country" offers the core Country concept/,
  'not-registered': /the search result for the concept is marked registered, not illustrative/,
  'wrong-field-link': /the page lists Customer\.Country of Chinook music store/,
  'missing-recordset': /the page has exactly one #field-Customer-Country/,
  'missing-recordset-anchor': /the page has the #recordset-Customer recordset anchor/,
  'no-concepts-on-recordset': /#recordset-Customer shows the chinook Customer concept, linking to meaninggraph\.io/,
  'no-live-deployment-link': /links to the live deployment/,
  'wrong-concept-link': /shows the .* concept, linking to meaninggraph\.io/,
  'concept-page-omits-recordset': /Customer lists the Customer recordset of Chinook music store/,
  'missing-graph': /\/graphs\/ lists the chinook graph/,
  'no-directory-card': /the Directory home links to Chinook music store/,
  'chinook-badged-example': /a real database is not labelled an example/,
  'no-example-cards': /the three example cards stay/,
  'no-synonyms': /the page lists the concept's synonyms/,
  'synonyms-none-yet': /the synonyms are real synonyms, not a statement that there are none/,
  'synonyms-no-synonyms-listed': /the page lists the concept's synonyms/,
  'synonyms-na': /the synonyms are real synonyms, not a statement that there are none/,
  'synonyms-dash': /the synonyms are real synonyms, not a statement that there are none/,
  'synonyms-to-be-added': /the synonyms are real synonyms, not a statement that there are none/,
  'synonyms-none-in-brackets': /the synonyms are real synonyms, not a statement that there are none/,
  'example-cards-words-only': /the three example cards stay/,
  'example-cards-bare-labels': /the three example cards stay/,
  'example-cards-heading-only': /the three example cards stay/,
};

for (const defect of Object.keys(defects)) {
  test(`the journey fails when ${defects[defect]}`, async () => {
    const { status, output } = await journey(defect);
    assert.notEqual(status, 0, `the journey passed with this defect:\n${output}`);
    assert.match(output, expected[defect], output);
  });
}

test('every defect has an expected failure', () => {
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(defects).sort());
});

// The synonyms check is a function of text, tested here without a browser.
test('synonymsOf accepts a list of synonyms and refuses every way of saying there are none', () => {
  for (const text of ['Synonyms: nation, countries', 'Synonyms\nnation; state', 'synonym: land', 'Alias\nSynonyms: nation | country | the state']) {
    const found = synonymsOf(text);
    assert.ok(found, text);
    assert.equal(found.problem, null, text);
  }
  assert.deepEqual(synonymsOf('Synonyms: nation, countries').items, ['nation', 'countries']);
  for (const text of ['Synonyms: none', 'Synonyms: none yet', 'Synonyms: n/a (not yet available)', 'Synonyms: \u2014', 'Synonyms: -', 'Synonyms: (none)', 'Synonyms: to be added', 'Synonyms: TBD', 'Synonyms: nothing', 'Synonyms:', 'Synonyms: no synonyms listed', 'Synonyms: not available', 'Synonyms: empty', 'Synonyms: <b>x</b>']) {
    const found = synonymsOf(text);
    assert.ok(found, text);
    assert.notEqual(found.problem, null, text);
  }
  // A page whose line starts with something else has no synonyms label at all.
  for (const text of ['No synonyms listed', 'There are no synonyms', 'nation, countries']) assert.equal(synonymsOf(text), null, text);
});

// Words that said something the journey no longer does, or claimed more than the self-test shows (this file is not scanned: it holds the words).
test('no file still states the removed rule about the search page, or claims the journey cannot go green', () => {
  const stale = [/must not be on the page before the search/i, /not already on the page/i, /cannot go green/i];
  for (const file of ['README.md', 'tests/journey/journey.spec.mjs', 'tests/journey/fixtures/mock-sites.mjs', 'tests/journey/page-checks.mjs']) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const pattern of stale) assert.doesNotMatch(text, pattern, `${file}: ${pattern}`);
  }
});
