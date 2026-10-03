// Two small mock sites for the journey test's self-test (CC0-1.0): a MeaningGraph
// site and a Directory site, generated from index.json, each in a good form and
// in forms with one deliberate defect. The self-test (../self-test.mjs) runs the
// journey spec against every form and expects the good one to pass and each
// broken one to fail, so the journey cannot go green while a step is broken.
// The mocks use only the contract's URLs and anchors; they are not the real sites.
import { createServer } from 'node:http';

// The defects, each named for the step it breaks.
export const defects = {
  'no-search-results': 'the search box returns nothing (step 1)',
  'search-not-needed': 'the home page already links to the concept, so search proves nothing (step 1)',
  'not-registered': 'the search result is illustrative, not marked registered (step 1)',
  'wrong-field-link': 'the Country page links to a field anchor that does not exist (step 2/3)',
  'missing-recordset': 'the Directory page has no Customer recordset (step 4)',
  'missing-recordset-anchor': 'the Directory page has the Customer fields but no #recordset-Customer anchor (step 3/4)',
  'wrong-concept-link': 'the Directory page links its concepts to the wrong path (step 4/5)',
  'concept-page-omits-recordset': 'the Chinook customer concept page does not list the Customer recordset (step 5)',
  'missing-graph': 'the graphs page lists core only (step 6)',
  'no-directory-card': 'the Directory home has no Chinook card (step 6)',
};

const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body>${body}</body>`;

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
      ${defect === 'search-not-needed' ? `<p><a href="/graphs/core/concepts/country/">Country</a></p>` : ''}
      <script>const items = ${JSON.stringify(searchable)}; const q = document.getElementById('q'); const results = document.getElementById('results');
      q.addEventListener('input', () => { ${defect === 'no-search-results' ? 'return;' : ''}
        results.innerHTML = items.filter((item) => q.value && item.label.toLowerCase().includes(q.value.toLowerCase())).map((item) => '<li><a href="' + item.href + '">' + item.label + '</a> <span>${tag} (' + item.graph + ')</span></li>').join(''); });</script>`);
    pages['/graphs/'] = page('Graphs', graphs.filter((graph) => !(defect === 'missing-graph' && graph !== 'core')).map((graph) => `<p><a href="/graphs/${graph}/">${graph}</a></p>`).join(''));
    for (const graph of graphs) pages[`/graphs/${graph}/`] = page(graph, `<h1>${graph}</h1>`);
    for (const [key, concept] of concepts) {
      const uses = concept.uses.filter((use) => !(defect === 'concept-page-omits-recordset' && key === 'chinook/customer' && !use.field));
      const rows = uses.map(({ database, recordset, field }) => {
        const anchor = field ? `field-${recordset.name}-${field.name}` : `recordset-${recordset.name}`;
        const broken = defect === 'wrong-field-link' && key === countryKey && field ? `${anchor}-x` : anchor;
        return `<li><a href="${dir}/databases/${database.id}/#${broken}">${field ? `${recordset.name}.${field.name}` : recordset.name}</a></li>`;
      }).join('');
      const pinned = /ref=([0-9a-f]{40})/.exec(concept.address)?.[1].slice(0, 7);
      pages[`/graphs/${concept.graph}/concepts/${concept.concept}/`] = page(concept.label,
        `<h1>${concept.label}</h1><p>Pinned at ${pinned}</p><p>Synonyms: none listed</p>${concept.extends.map((parent) => `<p>Extends <a href="/graphs/${parent.graph}/concepts/${parent.concept}/">${parent.label}</a></p>`).join('')}<h2>In OVDB databases</h2><ul>${rows}</ul>`);
    }
    void mg;
    return pages;
  };
  const directoryPages = () => {
    const { mg } = base();
    const pages = {};
    const database0 = index.databases[0];
    pages['/'] = page('OVDB Directory', `<h2>Examples</h2><p>Example one</p><p>Example two</p><p>Example three</p><h2>Databases</h2>${defect === 'no-directory-card' ? '' : index.databases.map((database) => `<p><a href="/databases/${database.id}/">${database.title}</a></p>`).join('')}`);
    const link = (graph, concept, label) => `<a href="${defect === 'wrong-concept-link' ? `${mg}/graphs/${graph}/concept/${concept}/` : conceptHref(mg, graph, concept)}">${label}</a>`;
    for (const database of index.databases) {
      pages[`/databases/${database.id}/`] = page(database.title, `<h1>${database.title}</h1><p>${database.url}</p><p><a href="${database.deployment.url}">Live deployment</a></p><p>${database.repository} at ${database.commit.slice(0, 7)}; meaning graph ${database.meaning_graph.id}</p>${
        database.recordsets.filter((recordset) => !(defect === 'missing-recordset' && recordset.name === 'Customer')).map((recordset) => `<section><h3 ${defect === 'missing-recordset-anchor' && recordset.name === 'Customer' ? '' : `id="recordset-${recordset.name}"`}>${recordset.name}</h3><p>${recordset.meanings.map((meaning) => [meaning, ...meaning.extends].map((entry) => link(entry.graph, entry.concept, entry.label)).join(' ')).join(' ')}</p><ul>${
          recordset.fields.map((field) => `<li id="field-${recordset.name}-${field.name}" style="margin-top:400px">${field.name} ${field.meanings.map((meaning) => link(meaning.graph, meaning.concept, meaning.label)).join(' ')}</li>`).join('')}</ul></section>`).join('')}`);
    }
    void database0;
    return pages;
  };

  const serve = (name, pagesFor) => new Promise((resolve) => {
    const server = createServer((request, response) => {
      const pages = pagesFor();
      const found = pages[request.url.split('#')[0]];
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
