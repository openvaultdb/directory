// Two small mock sites for the journey test's self-test (CC0-1.0): a MeaningGraph
// site and a Directory site, generated from index.json, each in a good form and
// in forms with one deliberate defect. The self-test (../self-test.mjs) runs the
// journey spec against every form and expects the good one to pass and each
// broken one to fail, so a defect on this list is noticed. It does not show that
// no other defect is possible.
// The mocks use only the URLs and anchors the journey spec relies on; they are not the real sites.
import { createServer } from 'node:http';

// The defects, each named for the step it breaks.
export const defects = {
  'no-search-results': 'the search box returns nothing (step 1)',
  'not-registered': 'the search result is illustrative, not marked registered (step 1)',
  'wrong-field-link': 'the Country page links to a field anchor that does not exist (step 2/3)',
  'missing-recordset': 'the Directory page has no Customer recordset (step 4)',
  'missing-recordset-anchor': 'the Directory page has the Customer fields but no #recordset-Customer anchor (step 3/4)',
  'wrong-concept-link': 'the Directory page links its concepts to the wrong path (step 4/5)',
  'no-concepts-on-recordset': 'the Customer recordset shows no concept (step 4)',
  'no-live-deployment-link': 'the Directory page has no link to the live deployment (step 4)',
  'chinook-badged-example': 'the Chinook card is badged as an example (step 6)',
  'no-example-cards': 'the Directory home has no example cards (step 6)',
  'no-synonyms': 'the Country page shows no synonyms (step 2)',
  'synonyms-none-yet': 'the Country page says "Synonyms: none yet" (step 2)',
  'synonyms-no-synonyms-listed': 'the Country page says "No synonyms listed" (step 2)',
  'synonyms-na': 'the Country page says "Synonyms: n/a" (step 2)',
  'synonyms-dash': 'the Country page says "Synonyms: —" (step 2)',
  'synonyms-to-be-added': 'the Country page says "Synonyms: to be added" (step 2)',
  'synonyms-none-in-brackets': 'the Country page says "Synonyms: (none)" (step 2)',
  'synonyms-tag-only': 'the Country page has the Synonyms card with a language tag and no synonym, as the live page would without them (step 2)',
  'synonyms-undefined': 'the Country page lists "undefined" as its synonym (step 2)',
  'synonyms-null': 'the Country page lists "null" as its synonym (step 2)',
  'synonyms-unknown': 'the Country page lists "unknown" as its synonym (step 2)',
  'synonyms-empty-section': 'the Country page has an empty Synonyms card followed by the next heading (step 2)',
  'synonyms-runs-into-heading': 'the Country page has the Synonyms label directly followed by the next section\'s heading (step 2)',
  'example-cards-words-only': 'the Directory home says "example" three times in one paragraph and has no cards (step 6)',
  'example-cards-bare-labels': 'the Directory home has three list items that say only "Example" (step 6)',
  'example-cards-heading-only': 'the Directory home has an Examples heading and a paragraph about sample data, but no cards (step 6)',
  'example-cards-links-only': 'the Directory home has three links that use the word example or sample, and no cards (step 6)',
  'example-cards-none-yet': 'the Directory home has three list items that say there are no example databases yet (step 6)',
  'example-cards-same-title': 'the Directory home has three cards with the same title (step 6)',
  'concept-page-omits-recordset': 'the Chinook customer concept page does not list the Customer recordset (step 5)',
  'missing-graph': 'the graphs page omits the chinook graph (step 6)',
  'no-directory-card': 'the Directory home has no Chinook card (step 6)',
};

const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body>${body}</body>`;
const databasePath = (database) => database.directoryPath ?? `/databases/${database.recordId ?? database.id}/`;

export async function startMockSites(index, { defect } = {}) {
  if (defect !== undefined && !(defect in defects)) throw new Error(`unknown defect ${defect}`);
  const sites = { meaninggraph: null, directory: null };
  const base = () => ({ mg: `http://localhost:${sites.meaninggraph.address().port}`, dir: `http://localhost:${sites.directory.address().port}` });

  // Every meaning with where it sits.
  const entries = [];
  for (const database of index.databases) {
    for (const recordset of database.recordsets) {
      for (const meaning of recordset.meanings) entries.push({ database, recordset, meaning });
      for (const field of recordset.fields) for (const meaning of field.meanings) entries.push({ database, recordset, field, meaning });
    }
  }
  const concepts = new Map(); // "graph/concept" -> { graph, concept, label, address, extends, uses }
  const touch = (entry) => {
    const key = `${entry.graph}/${entry.concept}`;
    if (!concepts.has(key)) concepts.set(key, { graph: entry.graph, concept: entry.concept, label: entry.label, address: entry.address, extends: entry.extends ?? [], uses: [] });
    return concepts.get(key);
  };
  const names = (meaning) => [meaning, ...meaning.extends, ...(meaning.values_of ? [meaning.values_of, ...meaning.values_of.extends] : [])];
  for (const { database, recordset, field, meaning } of entries) {
    for (const named of names(meaning)) {
      const concept = touch(named);
      if (!concept.uses.some((use) => use.database === database && use.recordset === recordset && use.field === field)) concept.uses.push({ database, recordset, field });
    }
  }
  const graphs = [...new Set([...concepts.values()].map((concept) => concept.graph))].sort();

  const conceptHref = (mg, graph, concept) => `${mg}/graphs/${graph}/concepts/${concept}/`;
  const countryKey = 'core/country';
  const meaninggraphPages = () => {
    const { dir, mg } = base();
    const pages = {};
    const searchable = [...concepts.values()].map((concept) => ({ href: `/graphs/${concept.graph}/concepts/${concept.concept}/`, label: concept.label, graph: concept.graph }));
    const tag = defect === 'not-registered' ? 'illustrative' : 'registered';
    pages['/'] = page('MeaningGraph', `<nav><a href="/graphs/">Graphs</a></nav><input type="search" id="q" placeholder="Search concepts"><ul id="results"></ul>
      <script>const items = ${JSON.stringify(searchable)}; const q = document.getElementById('q'); const results = document.getElementById('results');
      q.addEventListener('input', () => { ${defect === 'no-search-results' ? 'return;' : ''}
        results.innerHTML = items.filter((item) => q.value && item.label.toLowerCase().includes(q.value.toLowerCase())).map((item) => '<li><a href="' + item.href + '">' + item.label + '</a> <span>${tag} (' + item.graph + ')</span></li>').join(''); });</script>`);
    pages['/graphs/'] = page('Graphs', graphs.filter((graph) => !(defect === 'missing-graph' && graph === 'chinook')).map((graph) => `<p><a href="/graphs/${graph}/">${graph}</a></p>`).join(''));
    for (const graph of graphs) pages[`/graphs/${graph}/`] = page(graph, `<h1>${graph}</h1>`);
    for (const [key, concept] of concepts) {
      const uses = concept.uses.filter((use) => !(defect === 'concept-page-omits-recordset' && key === 'chinook/customer' && !use.field));
      const rows = uses.map(({ database, recordset, field }) => {
        const anchor = field ? `field-${recordset.name}-${field.name}` : `recordset-${recordset.name}`;
        const broken = defect === 'wrong-field-link' && key === countryKey && database.recordId === 'chinook' && recordset.name === 'Customer' && field?.name === 'Country' ? `${anchor}-x` : anchor;
        return `<li><a href="${dir}${databasePath(database)}#${broken}">${field ? `${recordset.name}.${field.name}` : recordset.name}</a></li>`;
      }).join('');
      // The Synonyms card as the live page marks it up: a label, then one group per language (the tag, then the synonyms).
      const card = (groups) => `<div class="card"><span>Synonyms</span>${groups}</div>`;
      const group = (...parts) => `<div class="provenance">${parts.join('')}</div>`;
      const tag = (code) => `<small>${code}</small>`;
      const word = (text) => `<span>${text}</span>`;
      const synonymsLine = {
        'no-synonyms': '',
        'synonyms-none-yet': '<p>Synonyms: none yet</p>',
        'synonyms-no-synonyms-listed': '<p>No synonyms listed</p>',
        'synonyms-na': '<p>Synonyms: n/a</p>',
        'synonyms-dash': '<p>Synonyms: \u2014</p>',
        'synonyms-to-be-added': '<p>Synonyms: to be added</p>',
        'synonyms-none-in-brackets': '<p>Synonyms: (none)</p>',
        'synonyms-tag-only': card(group(tag('en')) + group(tag('ru'))),
        'synonyms-undefined': card(group(tag('en'), word('undefined'))),
        'synonyms-null': card(group(tag('en'), word('null'))),
        'synonyms-unknown': card(group(tag('en'), word('unknown'))),
        'synonyms-empty-section': card(''),
        'synonyms-runs-into-heading': '<div><span>Synonyms</span><h2>In OVDB databases</h2><p>Databases, recordsets and fields that carry the concept.</p></div>',
      }[defect] ?? card(group(tag('en'), word('nation'), word('countries')) + group(tag('ru'), word('\u0433\u043e\u0441\u0443\u0434\u0430\u0440\u0441\u0442\u0432\u043e')));
      const pinned = /ref=([0-9a-f]{40})/.exec(concept.address)?.[1].slice(0, 7);
      pages[`/graphs/${concept.graph}/concepts/${concept.concept}/`] = page(concept.label,
        `<h1>${concept.label}</h1><p>Pinned at ${pinned}</p>${synonymsLine}${concept.extends.map((parent) => `<p>Extends <a href="/graphs/${parent.graph}/concepts/${parent.concept}/">${parent.label}</a></p>`).join('')}<h2>In OVDB databases</h2><ul>${rows}</ul>`);
    }
    void mg;
    return pages;
  };
  const directoryPages = () => {
    const { mg } = base();
    const pages = {};
    // The example cards as the live home page marks them up: a label, then a grid of articles, each with a heading
    // of its own, a description and a "Sample recordset" line; a "Browse sample databases" link; and the real databases apart.
    const exampleCard = (title, link = 'https://www.example.org/') => `<article><div><h3><a href="${link}">${title}</a></h3></div><p>Open data about ${title.toLowerCase()}.</p><div><span>Sample recordset</span></div></article>`;
    const exampleCards = {
      'no-example-cards': '',
      'example-cards-words-only': '<h2>Databases to explore</h2><p>Example, example, example: see the sample data.</p>',
      'example-cards-bare-labels': '<h2>Examples</h2><ul><li>Example</li><li>Example</li><li>Example</li></ul>',
      'example-cards-heading-only': '<h2>Examples</h2><p>Sample data is below. See the example guide, the sample guide and the example FAQ.</p>',
      'example-cards-links-only': '<nav><a href="https://www.example.org/manifest">Example manifest</a> <a href="https://www.example.org/queries">Sample queries</a> <a href="#explore">Browse sample databases</a></nav>',
      'example-cards-none-yet': '<h2>Examples</h2><ul><li>No example databases yet</li><li>Sample databases are coming soon</li><li>Examples were removed</li></ul>',
      'example-cards-same-title': `<p>Sample catalogue content</p><div>${[1, 2, 3].map(() => exampleCard('Retail orders')).join('')}</div>`,
    }[defect] ?? `<p>Sample catalogue content</p><div>${[exampleCard('NASA Earthdata'), exampleCard('Global Health Observatory'), exampleCard('OpenStreetMap')].join('')}</div><a href="#explore">Browse sample databases \u2192</a>`;
    pages['/'] = page('OVDB Directory', `${exampleCards}<h2>Databases</h2><ul>${index.databases.filter((database) => !(defect === 'no-directory-card' && database.recordId === 'chinook')).map((database) => `<li><a href="${databasePath(database)}">${database.title}</a>${defect === 'chinook-badged-example' ? ' <span>Example</span>' : ''}</li>`).join('')}</ul>`);
    const link = (graph, concept, label) => `<a href="${defect === 'wrong-concept-link' ? `${mg}/graphs/${graph}/concept/${concept}/` : conceptHref(mg, graph, concept)}">${label}</a>`;
    for (const database of index.databases) {
      pages[databasePath(database)] = page(database.title, `<h1>${database.title}</h1><p>${database.url}</p>${defect === 'no-live-deployment-link' ? '' : `<p><a href="${database.deployment.url}">Live deployment</a></p>`}<p>${database.repository} at ${database.commit.slice(0, 7)}; meaning graph ${database.meaning_graph.id}</p>${
        database.recordsets.filter((recordset) => !(defect === 'missing-recordset' && recordset.name === 'Customer')).map((recordset) => `<section><h3 ${defect === 'missing-recordset-anchor' && recordset.name === 'Customer' ? '' : `id="recordset-${recordset.name}"`}>${recordset.name}</h3><p><a href="${recordset.url}">Browse ${recordset.name}</a></p><p>${(defect === 'no-concepts-on-recordset' && recordset.name === 'Customer' ? [] : recordset.meanings).map((meaning) => [meaning, ...meaning.extends].map((entry) => link(entry.graph, entry.concept, entry.label)).join(' ')).join(' ')}</p><ul>${
          recordset.fields.map((field) => `<li id="field-${recordset.name}-${field.name}" style="margin-top:400px">${field.name} ${field.meanings.map((meaning) => [meaning, ...meaning.extends.slice(0, 1)].map((entry) => link(entry.graph, entry.concept, entry.label)).join(' ')).join(' ')}</li>`).join('')}</ul></section>`).join('')}`);
    }
    return pages;
  };

  const serve = (name, pagesFor) => new Promise((resolve) => {
    const server = createServer((request, response) => {
      const pages = pagesFor();
      const requestPath = request.url.split('#')[0];
      const legacy = index.databases.find((database) => requestPath === `/databases/${database.recordId ?? database.id}/` && requestPath !== databasePath(database));
      if (legacy) {
        response.writeHead(308, { location: databasePath(legacy) });
        response.end();
        return;
      }
      const found = pages[requestPath];
      response.writeHead(found ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      response.end(found ?? 'not found');
    }).listen(0, 'localhost', () => { sites[name] = server; resolve(); });
  });
  await Promise.all([serve('meaninggraph', meaninggraphPages), serve('directory', directoryPages)]);
  const { mg, dir } = base();
  return {
    meaninggraphUrl: mg,
    directoryUrl: dir,
    close: () => Promise.all(Object.values(sites).map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }))),
  };
}
