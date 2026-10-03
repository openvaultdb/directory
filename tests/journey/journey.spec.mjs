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
// unconditionally. The test relies on these URLs and anchors
// (/graphs/<graph>/concepts/<concept>/ on meaninggraph.io; /databases/<id>/ on the
// Directory, with #recordset-<Name> and #field-<Recordset>-<Field>) and on link
// text, never on CSS classes. Each step asserts the exact target of the link it follows, so a
// link that goes anywhere but the URL above fails the step. self-test.mjs runs
// this file against mock sites with one deliberate defect each and expects it to fail.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { exampleCardTexts, synonymsOf } from './page-checks.mjs';

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
const itemText = (link, others) => link.evaluate((anchor, marker) => {
  const boundary = /^(UL|OL|TABLE|TBODY|SECTION|FORM|NAV|MAIN|BODY|HTML)$/;
  let item = anchor;
  for (let node = anchor.parentElement; node && !boundary.test(node.tagName); node = node.parentElement) {
    if (node.querySelectorAll(`a[href*="${marker}"]`).length > 1) break;
    item = node;
  }
  return item.innerText;
}, others);

// For every recordset and field anchor on the page, the links that sit between it and the next such anchor
// (a recordset's own concepts come before its first field; a field's concepts before the next field), as absolute URLs.
const linksByAnchor = (page) => page.evaluate(() => {
  const anchors = [...document.querySelectorAll('[id^="recordset-"], [id^="field-"]')];
  const links = [...document.querySelectorAll('a[href]')];
  const found = {};
  anchors.forEach((anchor, position) => {
    const next = anchors[position + 1];
    found[anchor.id] = links.filter((link) => {
      const from = anchor.contains(link) || Boolean(anchor.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (!from) return false;
      return !next || (Boolean(next.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_PRECEDING) && !next.contains(link));
    }).map((link) => link.href);
  });
  return found;
});

test('journey 1 to 5: search "country" on MeaningGraph, follow Customer.Country to the Directory and a concept back', async ({ page }) => {
  const { core, carriers } = startingConcept();
  const first = carriers[0];
  const term = core.label.toLowerCase();
  const countryUrl = conceptUrl(core.graph, core.concept);

  // 1. The visitor opens meaninggraph.io and searches. The search offers the concept, marked registered.
  await page.goto(`${meaningGraphBase}/`);
  const search = page.getByRole('searchbox').or(page.locator('input[type="search"]')).or(page.getByPlaceholder(/search/i)).first();
  await expect(search, 'the home page has a search box').toBeVisible();
  await search.fill(term);
  const offered = () => linkTo(page, countryUrl);
  await offered().waitFor({ timeout: 3000 }).catch(() => {});
  if (!(await offered().isVisible())) await search.press('Enter');
  await expect(offered(), `searching "${term}" offers the ${core.graph} ${core.label} concept`).toBeVisible();
  // The result is the one marked registered, not illustrative: read from the result's own item.
  const candidates = await page.locator(`a:visible[href="${countryUrl}"], a:visible[href="${new URL(countryUrl).pathname}"]`).all();
  let result;
  for (const candidate of candidates) {
    const item = await itemText(candidate, '/concepts/');
    if (/registered/i.test(item) && !/illustrative/i.test(item)) { result = candidate; break; }
  }
  expect(result, 'the search result for the concept is marked registered, not illustrative').toBeTruthy();
  await result.click();

  // 2. The Country concept page: pinned commit, synonyms, and "In OVDB databases" lists every use, linking to the Directory.
  await expect(page).toHaveURL(countryUrl);
  await expect(page.getByRole('heading', { name: core.label, level: 1 })).toBeVisible();
  await expect(page.locator('body')).toContainText(refOf(core.address).slice(0, 7));
  const synonyms = synonymsOf(await page.locator('body').innerText());
  expect(synonyms, 'the page lists the concept\'s synonyms').not.toBeNull();
  expect(synonyms.problem, `the synonyms are real synonyms, not a statement that there are none (the page says "${synonyms?.text}")`).toBeNull();
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
  await hasLink(page, database.deployment.url, `links to the live deployment ${database.deployment.url}`);
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
  // Each recordset shows the concepts of its meanings, and each field the concepts of its own, between its anchor and the next:
  // a dataset concept that extends another shows both.
  const between = await linksByAnchor(page);
  for (const each of database.recordsets) {
    for (const [anchorId, list] of [[recordsetAnchor(each.name), each.meanings], ...each.fields.map((eachField) => [fieldAnchor(each.name, eachField.name), eachField.meanings])]) {
      for (const meaning of list) {
        for (const entry of [meaning, ...(meaning.extends.length ? [meaning.extends[0]] : [])]) {
          expect(between[anchorId] ?? [], `#${anchorId} shows the ${entry.graph} ${entry.label} concept, linking to meaninggraph.io`).toContain(conceptUrl(entry.graph, entry.concept));
        }
      }
    }
  }
  const entity = recordset.meanings.find((meaning) => meaning.role === 'entity' && meaning.extends?.length);
  expect(entity, `index.json has an entity concept of ${recordset.name} that extends another`).toBeTruthy();

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
    expect(await itemText(card, '/databases/'), 'a real database is not labelled an example').not.toMatch(/example/i);
  }
  // The existing cards stay, still labelled as examples (a site may say "sample"): at least three cards, each with something to say
  // beyond the label, not three uses of the word.
  const cards = await page.evaluate(exampleCardTexts);
  expect(cards.length, `the three example cards stay, each labelled as an example or sample and with a title or text of its own (found: ${JSON.stringify(cards)})`).toBeGreaterThanOrEqual(3);
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
