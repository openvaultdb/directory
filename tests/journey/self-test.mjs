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
import { chromium } from '@playwright/test';
import { exampleCardTitles, synonymBlocks, synonymsFrom } from './page-checks.mjs';

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

// Each defect fails the step it breaks. The message is the one the failing expect() prints on its `Error:` line:
// Playwright also prints the source lines around the failure, and a message that only appears in those lines
// (the assertion next to the one that failed) does not count. Exactly one test fails and the other two pass.
const synonymsNone = /the synonyms are real synonyms, not a statement that there are none/;
const synonymsMissing = /the page lists the concept's synonyms/;
const cardsMissing = /the three example cards stay/;
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
  'no-example-cards': cardsMissing,
  'no-synonyms': synonymsMissing,
  'synonyms-none-yet': synonymsNone,
  'synonyms-no-synonyms-listed': synonymsMissing,
  'synonyms-na': synonymsNone,
  'synonyms-dash': synonymsNone,
  'synonyms-to-be-added': synonymsNone,
  'synonyms-none-in-brackets': synonymsNone,
  'synonyms-tag-only': synonymsNone,
  'synonyms-undefined': synonymsNone,
  'synonyms-null': synonymsNone,
  'synonyms-unknown': synonymsNone,
  'synonyms-empty-section': synonymsNone,
  'synonyms-runs-into-heading': synonymsNone,
  'example-cards-words-only': cardsMissing,
  'example-cards-bare-labels': cardsMissing,
  'example-cards-heading-only': cardsMissing,
  'example-cards-links-only': cardsMissing,
  'example-cards-none-yet': cardsMissing,
  'example-cards-same-title': cardsMissing,
};

for (const defect of Object.keys(defects)) {
  test(`the journey fails when ${defects[defect]}`, async () => {
    const { status, output } = await journey(defect);
    assert.notEqual(status, 0, `the journey passed with this defect:\n${output}`);
    assert.match(output, new RegExp(`^\\s*Error: [^\\n]*${expected[defect].source}`, 'm'), `the Error line is not the expected one:\n${output}`);
    assert.match(output, /\b1 failed\b/, output);
    assert.match(output, /\b2 passed\b/, output);
  });
}

test('every defect has an expected failure', () => {
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(defects).sort());
});

// ---- the checks that run in the page, and the judging of what they collect ----

const blocks = (...groups) => ({ text: groups.flat().join(' | '), groups });

test('synonymsFrom reads the synonyms, not the language tags, and refuses an empty section and every placeholder', () => {
  // The live layout: a tag, then the synonyms, per language.
  const live = synonymsFrom(blocks(['en', 'nation', 'countries'], ['ru', 'государство', 'страны']));
  assert.equal(live.problem, null);
  assert.deepEqual(live.items, ['nation', 'countries', 'государство', 'страны']);
  // Real phrases that a word list would have refused.
  for (const phrase of ['value added tax', 'listed company', "no man's land", 'U.S. state', 'country (political)', 'nation state', 'land']) {
    assert.equal(synonymsFrom(blocks(['en', phrase])).problem, null, phrase);
  }
  // A synonym that looks like a language code is one when it is not the first of its group, or not a language.
  assert.deepEqual(synonymsFrom(blocks(['en', 'usa'])).items, ['usa']);
  assert.deepEqual(synonymsFrom(blocks(['usa', 'america'])).items, ['usa', 'america']);
  // Only a tag, an empty section, nothing at all.
  for (const empty of [blocks(['en']), blocks(['EN'], ['RU']), blocks([]), blocks([], []), blocks(['en', ''])]) {
    const found = synonymsFrom(empty);
    assert.notEqual(found.problem, null, JSON.stringify(empty));
    assert.deepEqual(found.items.filter(Boolean), []);
  }
  // Placeholders, in any case, with or without a tag.
  for (const text of ['undefined', 'null', 'NaN', 'unknown', 'Unknown', 'none', 'None yet', 'none listed', 'n/a', 'N/A', 'na', 'TBD', 'TBA', 'TODO', 'Loading', 'Loading...', 'under review', 'Synonyms will appear here', 'will appear here', 'no synonyms', 'No synonyms listed', 'not available', 'Not yet available', 'to be added', 'coming soon', 'empty', 'nothing', 'pending', 'missing', 'no data']) {
    assert.notEqual(synonymsFrom(blocks(['en', text])).problem, null, text);
    assert.notEqual(synonymsFrom(blocks([text])).problem, null, text);
  }
  // Items that are not words or short phrases.
  for (const text of ['\u2014', '-', '(none)', '<b>x</b>', 'x'.repeat(61), '']) assert.notEqual(synonymsFrom(blocks(['en', text])).problem, null, JSON.stringify(text));
  // One good synonym among placeholders is still a placeholder on the page.
  assert.notEqual(synonymsFrom(blocks(['en', 'nation', 'undefined'])).problem, null);
  assert.equal(synonymsFrom(null), null);
});

async function inPage(html, evaluate) {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><body>${html}</body>`);
    return await page.evaluate(evaluate);
  } finally {
    await browser.close();
  }
}

test('synonymBlocks reads the live Country page\'s markup and the plain forms, and stops at the next heading', async () => {
  const live = '<div class="definition-card"><span>Labels</span><strong><small>en</small> Country</strong></div><div class="definition-card registry-card"><span>Synonyms</span><div class="provenance"><small>en</small><span>nation</span><span>countries</span></div><div class="provenance"><small>ru</small><span>государство</span><span>страны</span></div></div><div class="definition-card"><span>Kind</span><strong>entity</strong></div><h2>In OVDB databases</h2>';
  const found = synonymsFrom(await inPage(live, synonymBlocks));
  assert.deepEqual(found.items, ['nation', 'countries', 'государство', 'страны']);
  assert.equal(found.problem, null);
  // The same page with every synonym removed: the tags stay, the check fails.
  const stripped = live.replace(/<span>(nation|countries|государство|страны)<\/span>/g, '');
  assert.notEqual(synonymsFrom(await inPage(stripped, synonymBlocks)).problem, null);
  // The inline form, with a count in the label, a list, a heading label.
  assert.deepEqual(synonymsFrom(await inPage('<p>Synonyms (2): nation, land</p>', synonymBlocks)).items, ['nation', 'land']);
  assert.deepEqual(synonymsFrom(await inPage('<h3>Synonyms</h3><ul><li>nation</li><li>land</li></ul><h2>Next</h2><p>other words</p>', synonymBlocks)).items, ['nation', 'land']);
  assert.notEqual(synonymsFrom(await inPage('<h3>Synonyms</h3><h2>Next</h2><ul><li>nation</li></ul>', synonymBlocks)).problem, null, 'the next heading ends the section');
  assert.notEqual(synonymsFrom(await inPage('<div><span>Synonyms</span><section><h2>In OVDB databases</h2><p>Rows</p></section></div>', synonymBlocks)).problem, null);
  assert.equal(await inPage('<p>No synonyms listed</p><p>Labels</p>', synonymBlocks), null);
});

test('exampleCardTitles counts cards with a heading of their own, not links or list items that use the word', async () => {
  const card = (title, extra = '') => `<article><h3>${title}</h3><p>Open data</p><span>Sample recordset</span>${extra}</article>`;
  const titles = (html) => inPage(html, exampleCardTitles);
  // Pass: article cards, div cards, "Example: Cars" style titles, a label before the grid, the live layout with its link and real database.
  assert.equal((await titles(`<p>Sample catalogue content</p><div>${card('Cars')}${card('Bees')}${card('Maps')}</div>`)).length, 3);
  assert.equal((await titles('<div><div><h4>Cars</h4><p>An example database</p></div><div><h4>Bees</h4><p>An example database</p></div><div><h4>Maps</h4><p>A sample database</p></div></div>')).length, 3);
  assert.equal((await titles('<ul><li><h4>Example: Cars</h4></li><li><h4>Example: Bees</h4></li><li><h4>Example: Maps</h4></li></ul>')).length, 3);
  const live = `<section><div><span>3</span><span>Sample databases</span></div></section><section><div><h2>Explore by domain</h2></div></section><section><div><h2>Featured databases</h2><a href="#explore">Browse sample databases</a></div><div><article><h3><a href="/databases/chinook/">Chinook music store</a></h3><p>The Chinook sample database</p></article></div><p>Sample catalogue content</p><div>${card('NASA Earthdata')}${card('Global Health Observatory')}${card('OpenStreetMap')}</div></section>`;
  assert.deepEqual(await titles(live), ['NASA Earthdata', 'Global Health Observatory', 'OpenStreetMap']);
  // Fail: links that use the word, list items that say there are none, table rows, bare labels, one title three times, real database cards.
  assert.equal((await titles('<nav><a href="/x">Example manifest</a> <a href="/y">Sample queries</a> <a href="#e">Browse sample databases</a></nav>')).length, 0);
  assert.equal((await titles('<ul><li>No example databases yet</li><li>Sample databases are coming soon</li><li>Examples were removed</li></ul>')).length, 0);
  assert.equal((await titles('<table><tr><td>Example one</td></tr><tr><td>Example two</td></tr><tr><td>Sample three</td></tr></table>')).length, 0);
  assert.equal((await titles('<ul><li>Example</li><li>Example</li><li>Example</li></ul>')).length, 0);
  assert.equal((await titles(`<div>${card('Cars')}${card('Cars')}${card('Cars')}</div>`)).length, 1);
  assert.equal((await titles('<div><article><h3><a href="/databases/a/">Alpha</a></h3><p>sample</p></article><article><h3><a href="/databases/b/">Beta</a></h3><p>sample</p></article><article><h3><a href="/databases/c/">Gamma</a></h3><p>sample</p></article></div>')).length, 0);
  assert.equal((await titles('<h2>Examples</h2><p>Sample data is below. See the example guide.</p>')).length, 0);
  assert.equal((await titles('<h2>Databases to explore</h2><p>Example, example, example: see the sample data.</p>')).length, 0);
});

// Words that said something the journey no longer does, or claimed more than the self-test shows (this file is not scanned: it holds the words).
test('no file still states the removed rule about the search page, or claims the journey cannot go green', () => {
  const stale = [/must not be on the page before the search/i, /not already on the page/i, /cannot go green/i];
  for (const file of ['README.md', 'tests/journey/journey.spec.mjs', 'tests/journey/fixtures/mock-sites.mjs', 'tests/journey/page-checks.mjs']) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const pattern of stale) assert.doesNotMatch(text, pattern, `${file}: ${pattern}`);
  }
});
