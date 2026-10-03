// Self-test of the journey spec (CC0-1.0): it must pass against a good pair of
// mock sites and fail against each pair with one deliberate defect, so the
// journey cannot go green while a step is broken. It needs no real sites, only a
// browser (npx playwright install chromium, or PLAYWRIGHT_CHANNEL=chrome).
//
//   npm run test:journey:selftest
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { defects, startMockSites } from './fixtures/mock-sites.mjs';

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
