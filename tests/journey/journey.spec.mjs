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
// Without both base URLs every test is skipped, not failed, so CI can run it
// unconditionally. The test relies on the URLs and anchors of the plan's
// contract (/graphs/<graph>/concepts/<concept>/, /databases/<id>/ with
// #recordset-<Name> and #field-<Recordset>-<Field>) and on link text, never on
// CSS classes.
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
const named = (entry) => [entry.values_of, ...(entry.extends ?? [])].filter(Boolean);

// The universal concept the journey starts from: a core concept that some field
// takes its values from (country, in Chinook), and every field that carries it.
function startingConcept() {
  const carriers = meanings().filter(({ field, meaning }) => field && named(meaning).some((entry) => entry.graph === 'core' && entry.concept === 'country'));
  expect(carriers.length, 'index.json has a field that carries the core country concept').toBeGreaterThan(0);
  const core = named(carriers[0].meaning).find((entry) => entry.graph === 'core' && entry.concept === 'country');
  return { core, carriers };
}

const conceptPath = (graph, concept) => `/graphs/${graph}/concepts/${concept}/`;
const fieldAnchor = (recordset, field) => `field-${recordset}-${field}`;
const visibleLink = (page, hrefPart) => page.locator(`a:visible[href*="${hrefPart}"]`).first();

// Opens `path` on a site by the link the home page offers, or, when the home
// page has none, by the contract URL (an entry point, not a step of the journey).
async function openFromHome(page, base, path) {
  await page.goto(`${base}/`);
  const link = page.locator(`a:visible[href$="${path}"]`).first();
  if (await link.count()) await link.click();
  else await page.goto(`${base}${path}`);
  await expect(page).toHaveURL(new RegExp(`${escape(base + path)}$`));
}

test('journey 1 to 5: search "country" on MeaningGraph, follow Customer.Country to the Directory and a concept back', async ({ page }) => {
  const { core, carriers } = startingConcept();
  const first = carriers[0];
  const term = core.label.toLowerCase();

  // 1. The visitor opens meaninggraph.io and searches for the term. The real core concept is offered, marked registered.
  await page.goto(`${meaningGraphBase}/`);
  const search = page.getByRole('searchbox').or(page.locator('input[type="search"]')).or(page.getByPlaceholder(/search/i)).first();
  await search.fill(term);
  const result = visibleLink(page, conceptPath(core.graph, core.concept));
  if (!(await result.isVisible().catch(() => false))) await search.press('Enter');
  await expect(result, `search offers the ${core.graph} ${core.label} concept`).toBeVisible();
  await expect(result.locator('xpath=ancestor::*[self::li or self::article or self::tr or self::section or self::div][1]'), 'the result says it is registered').toContainText(/registered/i);
  await result.click();

  // 2. The Country concept page: pinned commit, and "In OVDB databases" lists every field that carries it, linking to the Directory.
  await expect(page).toHaveURL(new RegExp(`${escape(meaningGraphBase + conceptPath(core.graph, core.concept))}$`));
  await expect(page.getByRole('heading', { name: core.label, level: 1 })).toBeVisible();
  await expect(page.locator('body')).toContainText(refOf(core.address).slice(0, 7));
  const section = page.getByRole('heading', { name: /In OVDB databases/i });
  await expect(section).toBeVisible();
  for (const { database, recordset, field } of carriers.filter(({ meaning }) => named(meaning).some((entry) => entry.graph === core.graph && entry.concept === core.concept))) {
    const row = visibleLink(page, `/databases/${database.id}/#${fieldAnchor(recordset.name, field.name)}`);
    await expect(row, `the page lists ${recordset.name}.${field.name} of ${database.title}`).toBeVisible();
    await expect(row).toHaveText(new RegExp(`${escape(recordset.name)}\\W+${escape(field.name)}`));
  }

  // 3. They follow the first one to the Directory: the Chinook page, with that field in view.
  const { database, recordset, field } = first;
  const anchor = fieldAnchor(recordset.name, field.name);
  await visibleLink(page, `/databases/${database.id}/#${anchor}`).click();
  await expect(page).toHaveURL(new RegExp(`^${escape(directoryBase)}/databases/${escape(database.id)}/#${escape(anchor)}$`));
  await expect(page.locator(`[id="${anchor}"], a[name="${anchor}"]`).first(), 'the field is in view').toBeInViewport();

  // 4. The Directory page stands on its own: identity, deployment, publisher, pin, meaning graph, recordsets, concepts that link back.
  const body = page.locator('body');
  await expect(body).toContainText(database.url);
  await expect(page.locator(`a[href^="${database.deployment.url}"]`).first(), 'links to the live deployment').toBeVisible();
  const repositoryPath = database.repository.replace(/^https:\/\//, '');
  await expect(page.locator(`a[href^="${database.repository}"]`).or(page.getByText(repositoryPath, { exact: false })).first(), 'names the publisher repository').toBeVisible();
  await expect(body).toContainText(database.commit.slice(0, 7));
  await expect(body).toContainText(database.meaning_graph.id);
  for (const each of database.recordsets) await expect(body, `lists the ${each.name} recordset`).toContainText(each.name);
  // The field's own concept, and the core concept it takes its values from, both link to meaninggraph.io.
  const own = first.meaning;
  await expect(visibleLink(page, conceptPath(own.graph, own.concept)), `${recordset.name}.${field.name} links to its ${own.label} concept`).toBeVisible();
  // A dataset concept that extends a core concept shows both.
  const entity = recordset.meanings.find((meaning) => meaning.role === 'entity' && meaning.extends?.length);
  expect(entity, `index.json has an entity concept of ${recordset.name} that extends another`).toBeTruthy();
  await expect(visibleLink(page, conceptPath(entity.graph, entity.concept))).toBeVisible();
  await expect(visibleLink(page, conceptPath(entity.extends[0].graph, entity.extends[0].concept))).toBeVisible();

  // 5. They return to meaninggraph.io through the recordset's concept link and see what it extends and where it is used.
  await visibleLink(page, conceptPath(entity.graph, entity.concept)).click();
  await expect(page).toHaveURL(new RegExp(`^${escape(meaningGraphBase + conceptPath(entity.graph, entity.concept))}$`));
  await expect(page.getByRole('heading', { name: entity.label, level: 1 })).toBeVisible();
  await expect(visibleLink(page, conceptPath(entity.extends[0].graph, entity.extends[0].concept)), `it extends ${entity.extends[0].graph} ${entity.extends[0].label}`).toBeVisible();
  await expect(page.getByRole('heading', { name: /In OVDB databases/i })).toBeVisible();
  await expect(visibleLink(page, `/databases/${database.id}/`), `it is used by the ${database.title} database`).toBeVisible();
  await expect(page.locator('body')).toContainText(recordset.name);
});

test('journey 6a: the Directory lists every database in index.json as a real database', async ({ page }) => {
  await page.goto(`${directoryBase}/`);
  for (const database of directory.databases) {
    const card = visibleLink(page, `/databases/${database.id}/`);
    await expect(card, `the Directory home links to ${database.title}`).toBeVisible();
    await expect(card).toContainText(new RegExp(escape(database.title), 'i'));
  }
});

test('journey 6b: MeaningGraph lists, on /graphs/, every graph that index.json names', async ({ page }) => {
  const graphs = new Set();
  for (const { meaning } of meanings()) {
    graphs.add(meaning.graph);
    for (const entry of named(meaning)) graphs.add(entry.graph);
  }
  expect([...graphs], 'index.json names the core and chinook graphs').toEqual(expect.arrayContaining(['core', 'chinook']));
  await openFromHome(page, meaningGraphBase, '/graphs/');
  for (const graph of graphs) await expect(visibleLink(page, `/graphs/${graph}/`), `/graphs/ lists the ${graph} graph`).toBeVisible();
});
