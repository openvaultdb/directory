// The cross-browse journey (CC0-1.0): a visitor goes from meaninggraph.io to the
// OVDB Directory and back by clicking links only, and every name the test
// follows comes from this repository's index.json (or the file at
// OVDB_DIRECTORY_INDEX_URL), never from the test itself.
//
// Run against two sites that are already serving (local builds or production):
//
//   MEANINGGRAPH_BASE_URL=https://meaninggraph.io \
//   OVDB_DIRECTORY_BASE_URL=https://directory.openvaultdb.com \
//   npm run test:journey
//
// Local builds must be built with the same two variables: step 3 expects the
// link on meaninggraph.io to land on OVDB_DIRECTORY_BASE_URL, and the Directory's
// concept links to land on MEANINGGRAPH_BASE_URL.
//
// Without both base URLs every test is skipped, not failed, so CI can run it
// unconditionally. The test relies on the URLs and anchors of the plan's
// contract (/graphs/<graph>/concepts/<concept>/, /databases/<id>/ with
// #recordset-<Name> and #field-<Recordset>-<Field>) and on link text, never on
// CSS classes. Each step asserts the exact target of the link it follows, so a
// link that goes anywhere but the contract URL fails the step. self-test.mjs runs
// this file against mock sites with one deliberate defect each and expects it to fail.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const meaningGraphBase = (process.env.MEANINGGRAPH_BASE_URL ?? '').replace(/\/+$/, '');
const directoryBase = (process.env.OVDB_DIRECTORY_BASE_URL ?? '').replace(/\/+$/, '');
const indexUrl = process.env.OVDB_DIRECTORY_INDEX_URL;

test.skip(!meaningGraphBase || !directoryBase, 'MEANINGGRAPH_BASE_URL and OVDB_DIRECTORY_BASE_URL are not both set; the journey runs against two live sites');

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const refOf = (address) => /[?&]ref=([0-9a-f]{40})$/.exec(address)?.[1];

let directory;
test.beforeAll(async () => {
  const text = indexUrl
    ? await (async () => {
      const response = await fetch(indexUrl);
      if (!response.ok) throw new Error(`cannot read ${indexUrl}: HTTP ${response.status}`);
      return response.text();
    })()
    : readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.json'), 'utf8');
  directory = JSON.parse(text);
});

// Every meaning in the index, with where it sits: { database, recordset, field?, meaning }.
function meanings() {
  const found = [];
  for (const database of directory.databases) {
    for (const recordset of database.recordsets) {
      for (const meaning of recordset.meanings) found.push({ database, recordset, meaning });
      for (const field of recordset.fields) for (const meaning of field.meanings) found.push({ database, recordset, field, meaning });
    }
  }
  return found;
}
// The concepts a meaning names: itself, its extends chain, its values_of and that entry's own chain.
const named = (meaning) => [meaning, ...(meaning.extends ?? []), ...(meaning.values_of ? [meaning.values_of, ...(meaning.values_of.extends ?? [])] : [])];
const names = (meaning, graph, concept) => named(meaning).some((entry) => entry.graph === graph && entry.concept === concept);
// Where a concept is used: what a concept page's "In OVDB databases" section must list.
const usesOf = (graph, concept) => meanings().filter(({ meaning }) => names(meaning, graph, concept));

// The universal concept the journey starts from: a core concept that some field takes its values from (country, in Chinook).
function startingConcept() {
  const carriers = meanings().filter(({ field, meaning }) => field && meaning.values_of?.graph === 'core' && meaning.values_of.concept === 'country');
  expect(carriers.length, 'index.json has a field whose values are core country').toBeGreaterThan(0);
  return { core: carriers[0].meaning.values_of, carriers };
}

const conceptUrl = (graph, concept) => `${meaningGraphBase}/graphs/${graph}/concepts/${concept}/`;
const databaseUrl = (database, anchor) => `${directoryBase}/databases/${database.id}/${anchor ? `#${anchor}` : ''}`;
const fieldAnchor = (recordset, field) => `field-${recordset}-${field}`;
const recordsetAnchor = (recordset) => `recordset-${recordset}`;

// The visible link whose target is exactly `expected` (an absolute URL). A relative href counts only
// on a page of the same origin, where it means the same thing.
function linkTo(page, expected) {
  const url = new URL(expected);
  const forms = [expected];
  if (url.origin === new URL(page.url()).origin) forms.push(`${url.pathname}${url.search}${url.hash}`);
  return page.locator(forms.map((href) => `a:visible[href="${href}"]`).join(', ')).first();
}
const hasLink = async (page, expected, what) => {
  const link = linkTo(page, expected);
  await expect(link, what ?? `the page links to ${expected}`).toBeVisible();
  return link;
};

// The smallest region around a search result that holds that result and no other concept: the result's own
// item, never the page. Climbing stops at a list, table, section, form, nav, main or the body.
const resultItemText = (link) => link.evaluate((anchor) => {
  const boundary = /^(UL|OL|TABLE|TBODY|SECTION|FORM|NAV|MAIN|BODY|HTML)$/;
  let item = anchor;
  for (let node = anchor.parentElement; node && !boundary.test(node.tagName); node = node.parentElement) {
    if (node.querySelectorAll('a[href*="/concepts/"]').length > 1) break;
    item = node;
  }
  return item.innerText;
});

test('journey 1 to 5: search "country" on MeaningGraph, follow Customer.Country to the Directory and a concept back', async ({ page }) => {
  const { core, carriers } = startingConcept();
  const first = carriers[0];
  const term = core.label.toLowerCase();
  const countryUrl = conceptUrl(core.graph, core.concept);

  // 1. The visitor opens meaninggraph.io and searches. The concept is offered by the search, not already on the page, marked registered.
  await page.goto(`${meaningGraphBase}/`);
  await expect(linkTo(page, countryUrl), 'the home page does not already link to the concept: only the search may offer it').toHaveCount(0);
  const search = page.getByRole('searchbox').or(page.locator('input[type="search"]')).or(page.getByPlaceholder(/search/i)).first();
  await expect(search, 'the home page has a search box').toBeVisible();
  await search.fill(term);
  let result = linkTo(page, countryUrl);
  await result.waitFor({ timeout: 3000 }).catch(() => {});
  if (!(await result.isVisible())) await search.press('Enter');
  result = linkTo(page, countryUrl);
  await expect(result, `searching "${term}" offers the ${core.graph} ${core.label} concept`).toBeVisible();
  const item = await resultItemText(result);
  expect(item, 'the result is marked registered').toMatch(/registered/i);
  expect(item, 'the result is not illustrative').not.toMatch(/illustrative/i);
  await result.click();

  // 2. The Country concept page: pinned commit, synonyms, and "In OVDB databases" lists every use, linking to the Directory.
  await expect(page).toHaveURL(countryUrl);
  await expect(page.getByRole('heading', { name: core.label, level: 1 })).toBeVisible();
  await expect(page.locator('body')).toContainText(refOf(core.address).slice(0, 7));
  await expect(page.locator('body')).toContainText(/synonym/i);
  await expect(page.getByRole('heading', { name: /In OVDB databases/i })).toBeVisible();
  for (const { database, recordset, field } of usesOf(core.graph, core.concept)) {
    const anchor = field ? fieldAnchor(recordset.name, field.name) : recordsetAnchor(recordset.name);
    const row = await hasLink(page, databaseUrl(database, anchor), `the page lists ${field ? `${recordset.name}.${field.name}` : recordset.name} of ${database.title}`);
    await expect(row).toHaveText(new RegExp(field ? `${escape(recordset.name)}\\W+${escape(field.name)}` : escape(recordset.name)));
  }

  // 3. They follow the first carrier to the Directory: the database page, with that field in view.
  const { database, recordset, field } = first;
  const anchor = fieldAnchor(recordset.name, field.name);
  await (await hasLink(page, databaseUrl(database, anchor), `${recordset.name}.${field.name} links to its Directory anchor`)).click();
  await expect(page).toHaveURL(databaseUrl(database, anchor));
  await expect(page.locator(`[id="${anchor}"]`), `the page has exactly one #${anchor}`).toHaveCount(1);
  await expect(page.locator(`[id="${anchor}"]`), 'the field is in view').toBeInViewport();
  await expect(page.locator(`[id="${recordsetAnchor(recordset.name)}"]`), `the page has the #${recordsetAnchor(recordset.name)} recordset anchor`).toHaveCount(1);

  // 4. The Directory page stands on its own: identity, deployment, publisher, pin, meaning graph, every recordset and field, concepts that link back.
  const body = page.locator('body');
  await expect(body).toContainText(database.url);
  await expect(page.locator(`a:visible[href^="${database.deployment.url}"]`).first(), 'links to the live deployment').toBeVisible();
  const repositoryPath = database.repository.replace(/^https:\/\//, '');
  await expect(page.locator(`a:visible[href^="${database.repository}"]`).or(page.getByText(repositoryPath)).first(), 'names the publisher repository').toBeVisible();
  await expect(body).toContainText(database.commit.slice(0, 7));
  await expect(body).toContainText(database.meaning_graph.id);
  const ids = new Set(await page.evaluate(() => [...document.querySelectorAll('[id]')].map((element) => element.id)));
  for (const each of database.recordsets) {
    expect(ids.has(recordsetAnchor(each.name)), `the page has #${recordsetAnchor(each.name)}`).toBe(true);
    await expect(page.locator(`[id="${recordsetAnchor(each.name)}"]`), `#${recordsetAnchor(each.name)} shows the recordset name`).toContainText(each.name);
    for (const eachField of each.fields) expect(ids.has(fieldAnchor(each.name, eachField.name)), `the page has #${fieldAnchor(each.name, eachField.name)}`).toBe(true);
  }
  const own = first.meaning;
  await hasLink(page, conceptUrl(own.graph, own.concept), `${recordset.name}.${field.name} links to its ${own.label} concept on meaninggraph.io`);
  // A dataset concept that extends a core concept shows both.
  const entity = recordset.meanings.find((meaning) => meaning.role === 'entity' && meaning.extends?.length);
  expect(entity, `index.json has an entity concept of ${recordset.name} that extends another`).toBeTruthy();
  await hasLink(page, conceptUrl(entity.graph, entity.concept), `${recordset.name} links to its ${entity.label} concept`);
  await hasLink(page, conceptUrl(entity.extends[0].graph, entity.extends[0].concept), `${recordset.name} shows the ${entity.extends[0].graph} ${entity.extends[0].label} concept it extends`);

  // 5. They return to meaninggraph.io through the recordset's concept link: what it extends, and every recordset and field that uses it.
  await (await hasLink(page, conceptUrl(entity.graph, entity.concept))).click();
  await expect(page).toHaveURL(conceptUrl(entity.graph, entity.concept));
  await expect(page.getByRole('heading', { name: entity.label, level: 1 })).toBeVisible();
  await hasLink(page, conceptUrl(entity.extends[0].graph, entity.extends[0].concept), `it extends ${entity.extends[0].graph} ${entity.extends[0].label}`);
  await expect(page.getByRole('heading', { name: /In OVDB databases/i })).toBeVisible();
  const uses = usesOf(entity.graph, entity.concept);
  expect(uses.some((use) => !use.field && use.recordset.name === recordset.name), `index.json has the ${recordset.name} recordset using ${entity.label}`).toBe(true);
  for (const use of uses) {
    const useAnchor = use.field ? fieldAnchor(use.recordset.name, use.field.name) : recordsetAnchor(use.recordset.name);
    const row = await hasLink(page, databaseUrl(use.database, useAnchor), `${entity.label} lists ${use.field ? `${use.recordset.name}.${use.field.name}` : `the ${use.recordset.name} recordset`} of ${use.database.title}`);
    await expect(row).toContainText(use.recordset.name);
  }
});

test('journey 6a: the Directory lists every database in index.json as a real database, beside the examples', async ({ page }) => {
  await page.goto(`${directoryBase}/`);
  for (const database of directory.databases) {
    const card = await hasLink(page, databaseUrl(database), `the Directory home links to ${database.title}`);
    await expect(card).toContainText(new RegExp(escape(database.title), 'i'));
    expect(await card.innerText(), 'a real database is not labelled an example').not.toMatch(/example/i);
  }
  await expect(page.locator('body'), 'the example cards stay, labelled as examples').toContainText(/example/i);
});

test('journey 6b: MeaningGraph lists, on /graphs/, every graph that index.json names', async ({ page }) => {
  const graphs = new Set();
  for (const { meaning } of meanings()) for (const entry of named(meaning)) graphs.add(entry.graph);
  expect([...graphs], 'index.json names the core and chinook graphs').toEqual(expect.arrayContaining(['core', 'chinook']));
  await page.goto(`${meaningGraphBase}/`);
  const toGraphs = linkTo(page, `${meaningGraphBase}/graphs/`);
  if (await toGraphs.count()) await toGraphs.click();
  else await page.goto(`${meaningGraphBase}/graphs/`);
  await expect(page).toHaveURL(`${meaningGraphBase}/graphs/`);
  for (const graph of graphs) await hasLink(page, `${meaningGraphBase}/graphs/${graph}/`, `/graphs/ lists the ${graph} graph`);
});
