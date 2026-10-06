import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { indexText, readDirectory } from './lib/directory.mjs';
import { sourceEntries, sourceProblems, sourceRegistryProblems } from './lib/source-discovery.mjs';
const root = new URL('../', import.meta.url);
const record = () => ({ key: 'ecb-daily', file: 'sources/$records/ecb-daily.yaml', data: parse(readFileSync(new URL('sources/$records/ecb-daily.yaml', root), 'utf8')) });
const maintainers = [{ key: 'trakhimenok' }];
const digest = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const w1Resources = {
  'geonames-countries': 'https://download.geonames.org/export/dump/countryInfo.txt',
  'geonames-places': 'https://download.geonames.org/export/dump/allCountries.zip',
  'geonames-admin1': 'https://download.geonames.org/export/dump/admin1CodesASCII.txt',
  'geonames-alternates': 'https://download.geonames.org/export/dump/alternateNamesV2.zip',
  'ror-organisations': 'https://api.ror.org/v2/organizations',
};
test('W1 discoveries preserve original resources, inactive gates and explicit related projection links', () => {
  const all = readDirectory(root.pathname);
  assert.deepEqual(sourceProblems(all.sources, all.maintainers), []);
  for (const [id, resource] of Object.entries(w1Resources)) {
    const r = all.sources.find(record => record.key === id);
    assert.ok(r, id);
    assert.equal(r.data.resource_url, resource);
    assert.equal(r.data.status, 'inactive');
    assert.equal(r.data.retention, 'none');
    const registryId = id.startsWith('geonames-') ? 'geonames' : 'ror';
    assert.equal(r.data.modelspec_url, `https://modelspec.org/registry/models/${registryId}/`);
    assert.equal(r.data.meaninggraph_url, `https://meaninggraph.io/graphs/${registryId}/`);
    assert.match(r.data.activation_blockers.join(' '), /activation is frozen/);
    assert.match(r.data.activation_blockers.join(' '), /proposed OVDB Go proxy route only/);
    assert.match(r.data.activation_blockers.join(' '), /remain unverified/);
    assert.match(r.data.activation_blockers.join(' '), /no-store enforcement/);
    assert.match(r.data.activation_blockers.join(' '), /no accepted original-resource mappings/);
    assert.doesNotMatch(r.data.activation_blockers.join(' '), /No registry links/);
    for (const mutate of [
      d => { d.status = 'published'; }, d => { d.retention = 'snapshot'; },
      d => { d.resource_url = 'https://localhost/data'; },
      d => { d.deployment = { url: 'https://fake.example/' }; },
      d => { d.rows = []; }, d => { d.recordsets[0].fields[0].meanings = []; },
    ]) {
      const bad = structuredClone(r); mutate(bad.data);
      assert.ok(sourceProblems([bad], maintainers).length, id);
    }
  }
  const ror = all.sources.find(record => record.key === 'ror-organisations').data;
  assert.deepEqual(ror.recordsets[0].fields.map(field => field.name), ['id', 'status']);
  assert.match(ror.activation_blockers.join(' '), /CC BY 3.0.*CC BY 4.0/);
  assert.match(ror.notices.join(' '), /all_status/);
});
test('canonical source metadata checks without source fetches and has one ID', () => {
  const r = record();
  assert.deepEqual(sourceProblems([r], maintainers), []);
  assert.equal(readDirectory(root.pathname).sources.length, 19);
  assert.equal(sourceEntries([r])[0].id, 'ecb-daily');
  assert.equal(r.data.resource_url, 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
  assert.deepEqual(r.data.recordsets[0].fields.map(f => [f.name, f.type]), [['time','string'],['currency','string'],['rate','string']]);
});
test('inactive metadata refuses activation, retained payloads and fabricated deployment/license claims', () => {
  for (const change of [d => { d.status='published'; }, d => { d.retention='snapshot'; }, d => { d.access_mode='query'; }, d => { d.deployment={url:'https://fake.example/'}; }, d => { d.licence='CC0-1.0'; }, d => { d.data=[]; }, d => { d.recordsets[0].fields[0].meanings=[]; }, d => { delete d.resource_url; }, d => { d.resource_url='http://www.ecb.europa.eu/rates'; }, d => { d.activation_blockers=[]; }, d => { d.maintainers=['nobody']; }, d => { d.recordsets[0].fields[2].type='float'; }, d => { d.recordsets[0].fields.push({...d.recordsets[0].fields[0]}); }]) {
    const r=record(); change(r.data); assert.ok(sourceProblems([r],maintainers).length, JSON.stringify(r.data));
  }
  assert.ok(sourceProblems([record(),record()],maintainers).length);
});
test('source index is sorted, separately checksummed, and preserves old database bytes/checksum', () => {
  const before=JSON.parse(indexText([{id:'b'}, {id:'a'}]));
  const sources=sourceEntries([record()]);
  const after=JSON.parse(indexText([{id:'b'},{id:'a'}],sources));
  assert.deepEqual(after.databases,before.databases);
  assert.equal(after.checksum,before.checksum);
  assert.equal(after.sourcesChecksum,digest(sources));
  assert.deepEqual(after.sources,sources);
  const changed=structuredClone(sources);changed[0].description+=' Updated readiness.';
  assert.notEqual(JSON.parse(indexText(after.databases,changed)).sourcesChecksum,after.sourcesChecksum);
  assert.equal(before.sources,undefined);
});

const bigqueryRecord = () => ({ key: 'bigquery-world-bank-wdi', file: 'sources/$records/bigquery-world-bank-wdi.yaml', data: parse(readFileSync(new URL('sources/$records/bigquery-world-bank-wdi.yaml', root), 'utf8')) });
test('dataset discovery is native and does not invent tables, HTTP endpoints or rights admission', () => {
  const r=bigqueryRecord(); assert.deepEqual(sourceProblems([record(),r],maintainers),[]);
  assert.equal(r.data.locator.dataset_id,'world_bank_wdi');
  assert.equal(r.data.resource_url,undefined); assert.equal(r.data.recordsets,undefined);
  assert.equal(r.data.publisher,'World Bank'); assert.equal(r.data.hosting_provider,'Google BigQuery');
  for(const mutate of [d=>{d.query_activation='active';}, d=>{d.retention='none';}, d=>{d.locator.location_status='verified';}, d=>{d.locator.table_ids=['indicators_data'];}, d=>{d.documentation.kind='observed';}, d=>{d.documentation.commit='f'.repeat(40);}, d=>{d.access_requirements.execution_project='paid-project';}, d=>{d.access_requirements.cost_admission='granted';}, d=>{d.owned_retention.enforcement='verified';}, d=>{d.provider_retention.result_storage='none';}, d=>{d.provider_retention.authorization='granted';}, d=>{d.provider_retention.rows=[];}, d=>{d.documentation=null;}, d=>{d.locator.source_project=['bigquery-public-data'];}, d=>{d.locator.dataset_id=['world_bank_wdi'];}, d=>{d.documentation.commit=[d.documentation.commit];}, d=>{d.locator=null;}, d=>{d.recordsets=[];}]) {
    const bad=bigqueryRecord(); mutate(bad.data); assert.ok(sourceProblems([bad],maintainers).length,JSON.stringify(bad.data));
  }
});

test('every BigQuery nested requirement is required and closed',()=>{
  const original=bigqueryRecord();
  for(const name of ['locator','documentation','access_requirements','owned_retention','provider_retention']) {
    for(const key of Object.keys(original.data[name])) {
      const r=bigqueryRecord(); delete r.data[name][key]; assert.ok(sourceProblems([r],maintainers).length,`${name}.${key}`);
    }
    const r=bigqueryRecord(); r.data[name].credential='fake'; assert.ok(sourceProblems([r],maintainers).length,name);
  }
});

test('optional HTTP source registry links are canonical metadata detail routes with independent IDs',()=>{
  const r=record(); assert.deepEqual(sourceProblems([r],maintainers),[]);
  assert.equal(r.data.modelspec_url,'https://modelspec.org/registry/models/ecb-daily/');
  assert.equal(r.data.meaninggraph_url,'https://meaninggraph.io/graphs/ecb-daily/');
  delete r.data.modelspec_url;delete r.data.meaninggraph_url;assert.deepEqual(sourceProblems([r],maintainers),[]);
  for(const field of ['modelspec_url','meaninggraph_url']) {
    const original=record().data[field];
    for(const value of [null,[],[original],42,'',original.replace('https:','http:'),original+'?query=x',original+'#field',original+'extra/',original.replace('ecb-daily','bad--id'),original.replace('ecb-daily','foo%2Fbar'),original.replace('ecb-daily','../other'),original.replace('ecb-daily','foo\\bar'),original.replace('https://','https://user:pass@'),original.replace('ecb-daily','%65cb-daily'),original.replace('modelspec.org','modelspec.org.evil.example').replace('meaninggraph.io','meaninggraph.io.evil.example'),original.slice(0,-1)]) {
      const bad=record();bad.data[field]=value;assert.ok(sourceProblems([bad],maintainers).length,`${field} ${JSON.stringify(value)}`);
    }
  }
  const bq=bigqueryRecord();bq.data.modelspec_url='https://modelspec.org/registry/models/bigquery-world-bank-wdi/';assert.ok(sourceProblems([bq],maintainers).length);
});

const w2Subsets = {
  'gleif-lei-entities': ['LeiEntity', ['lei']],
  'cldr48-territory-codes': ['TerritoryCode', ['type', 'numeric', 'alpha3']],
};
test('W2 discoveries retain documented native subsets without admission or unverified registry links', () => {
  const all = readDirectory(root.pathname);
  assert.deepEqual(sourceProblems(all.sources, all.maintainers), []);
  for (const [id, [name, fields]] of Object.entries(w2Subsets)) {
    const r = all.sources.find(record => record.key === id);
    assert.ok(r, id);
    assert.equal(r.data.status, 'inactive');
    assert.equal(r.data.retention, 'none');
    assert.ok(r.data.recordsets.length >= 1);
    assert.equal(r.data.recordsets[0].name, name);
    assert.deepEqual(r.data.recordsets[0].fields.map(field => field.name), fields);
    assert.equal(r.data.modelspec_url, undefined);
    assert.equal(r.data.meaninggraph_url, undefined);
    assert.match(r.data.activation_blockers.join(' '), /proposed OVDB Go proxy/);
    assert.match(r.data.activation_blockers.join(' '), /no-store enforcement/);
    for (const url of ['http://api.gleif.org/data', 'https://localhost/data', 'https://127.0.0.1/data', 'https://user:pass@example.org/data', 'https://example.org/data#rows', 'https://api.gleif.org/api/v1/lei-records?page%5Bsize%5D=1']) {
      const bad = structuredClone(r); bad.data.resource_url = url;
      assert.ok(sourceProblems([bad], maintainers).length, `${id}: ${url}`);
    }
    for (const mutate of [d => { d.status = 'published'; }, d => { d.retention = 'snapshot'; }, d => { d.rows = []; }, d => { d.recordsets[0].fields[0].meanings = []; }]) {
      const bad = structuredClone(r); mutate(bad.data);
      assert.ok(sourceProblems([bad], maintainers).length, id);
    }
  }
  const gleif = all.sources.find(r => r.key === 'gleif-lei-entities').data;
  assert.equal(gleif.recordsets.length, 1);
  assert.equal(gleif.resource_url, 'https://api.gleif.org/api/v1/lei-records');
  assert.equal(gleif.terms_url, 'https://www.gleif.org/en/meta/lei-data-terms-of-use');
  assert.equal(gleif.publisher, 'Global Legal Entity Identifier Foundation (GLEIF)');
  assert.match(gleif.recordsets[0].fields[0].description, /data\[\]\.attributes\.lei/);
  assert.match(gleif.notices.join(' '), /CC0 1.0.*Technical restrictions/s);
  const cldr = all.sources.find(r => r.key === 'cldr48-territory-codes').data;
  assert.equal(cldr.resource_url, 'https://raw.githubusercontent.com/unicode-org/cldr/acd6d88ae493633240e19a87a721076a8a75c310/common/supplemental/supplementalData.xml');
  assert.equal(cldr.terms_url, 'https://www.unicode.org/license.txt');
  assert.equal(cldr.publisher, 'Unicode Consortium');
  assert.deepEqual(cldr.recordsets.map(rs => [rs.name, rs.fields.map(field => field.name)]), [
    ['TerritoryCode', ['type', 'numeric', 'alpha3']],
    ['RegionCurrency', ['iso3166', 'iso4217', 'from', 'to', 'tender']],
    ['CurrencyFraction', ['iso4217', 'digits', 'rounding', 'cashDigits', 'cashRounding']],
  ]);
  assert.match(cldr.recordsets[0].description, /\/supplementalData\/codeMappings\/territoryCodes/);
  assert.match(cldr.recordsets[1].description, /\/supplementalData\/currencyData\/region\/currency/);
  assert.match(cldr.recordsets[2].description, /\/supplementalData\/currencyData\/fractions\/info/);
  assert.match(cldr.activation_blockers.join(' '), /before any lookup, comparison or FX join/);
  assert.match(cldr.activation_blockers.join(' '), /not a read/);
  assert.match(cldr.notices.join(' '), /Unicode License V3/);
});

test('related projection IDs can differ and unknown registry targets are rejected without reading provider data', () => {
  const records = readDirectory(root.pathname).sources;
  const ids = ['ecb-daily', 'geonames', 'ror'];
  const meanings = { byId: new Map(ids.map(id => [id, { id }])) };
  const models = { byAddress: new Map(ids.map(id => [id, { id }])) };
  assert.deepEqual(sourceRegistryProblems(records, meanings, models), []);
  for (const field of ['modelspec_url', 'meaninggraph_url']) {
    const r = record();
    r.data[field] = r.data[field].replace('ecb-daily', 'not-registered');
    assert.deepEqual(sourceProblems([r], maintainers), []);
    assert.match(sourceRegistryProblems([r], meanings, models).join(' '), /unregistered metadata ID not-registered/);
  }
});

const w3 = {
  'cisa-kev': ['https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', 'https://www.cisa.gov/sites/default/files/licenses/kev/license.txt', { KevVulnerability: ['cveID', 'dateAdded', 'vulnerabilityName', 'knownRansomwareCampaignUse'] }],
  'govuk-bank-holidays': ['https://www.gov.uk/bank-holidays.json', 'https://www.gov.uk/help/reuse-govuk-content', { HolidayDivision: ['division'], HolidayEvent: ['title', 'date', 'notes'] }],
  'cldr48-windows-zones': ['https://raw.githubusercontent.com/unicode-org/cldr/acd6d88ae493633240e19a87a721076a8a75c310/common/supplemental/windowsZones.xml', 'https://www.unicode.org/license.txt', { WindowsZoneMap: ['other', 'territory', 'type'] }],
  'iana-http-status-codes': ['https://www.iana.org/assignments/http-status-codes/http-status-codes-1.csv', 'https://www.iana.org/help/licensing-terms', { HttpStatusRegistryRow: ['Value', 'Description', 'Reference'] }],
  'iana-application-media-types': ['https://www.iana.org/assignments/media-types/application.csv', 'https://www.iana.org/help/licensing-terms', { ApplicationMediaRegistryRow: ['Name', 'Template', 'Reference'] }],
};

test('W3 listings preserve original resources, rights links and native partial extraction scopes', () => {
  const { sources } = readDirectory(root.pathname);
  for (const [id, [resource, terms, shape]] of Object.entries(w3)) {
    const r = sources.find(x => x.key === id);
    assert.ok(r, id);
    assert.equal(r.data.resource_url, resource);
    assert.equal(r.data.terms_url, terms);
    assert.deepEqual(Object.fromEntries(r.data.recordsets.map(rs => [rs.name, rs.fields.map(f => f.name)])), shape);
    assert.ok(r.data.recordsets.every(rs => rs.fields.every(f => f.type === 'string')));
    assert.equal(r.data.modelspec_url, undefined);
    assert.equal(r.data.meaninggraph_url, undefined);
  }
  const data = id => sources.find(x => x.key === id).data;
  const govuk = data('govuk-bank-holidays');
  assert.match(govuk.recordsets[0].description, /not a native scalar field within its events\[\] children/);
  assert.match(govuk.recordsets[1].description, /no flattened division field/);
  assert.match(govuk.notices.join(' '), /Proposed parent\/event field inventory reflects dated evidence/);
  assert.match(govuk.notices.join(' '), /exact current returned structure has not been read or accepted/);
  const cldr = data('cldr48-windows-zones');
  assert.match(cldr.notices.join(' '), /https:\/\/www\.unicode\.org\/reports\/tr35\/tr35-76\/tr35-dates\.html#Windows_Zones/);
  assert.doesNotMatch(cldr.notices.join(' '), /unicode-org\.github\.io\/cldr\/ldml/);
  assert.match(cldr.recordsets[0].fields.find(f => f.name === 'type').description, /space-delimited.*list/);
  for (const [id, candidate] of [['iana-http-status-codes', 'd2-rs-iana-http'], ['iana-application-media-types', 'd2-rs-iana-media']]) {
    assert.ok(data(id).notices.some(notice => notice.includes(`dated candidate ${candidate}, supported by evidence d2-e-iana`)));
    assert.match(data(id).notices.join(' '), /not current headers\/rows or browser GET access/);
    assert.match(data(id).notices.join(' '), /excludes linked RFC text/);
  }
  assert.match(data('iana-http-status-codes').recordsets[0].fields[0].description, /range\/reserved\/unassigned/);
  assert.match(data('iana-application-media-types').activation_blockers.join(' '), /registration is not proof of actual file content/);
  assert.match(data('cisa-kev').recordsets[0].fields[3].description, /Unknown does not mean false/);
  assert.match(data('cisa-kev').notices.join(' '), /Third-party|third-party/);
});

test('W3 remains inactive, refuses retained data and invents no source capabilities', () => {
  const sources = readDirectory(root.pathname).sources.filter(x => Object.hasOwn(w3, x.key));
  assert.equal(sources.length, 5);
  assert.deepEqual(sourceProblems(sources, maintainers), []);
  for (const r of sources) {
    assert.equal(r.data.status, 'inactive');
    assert.equal(r.data.retention, 'none');
    assert.equal(r.data.access_mode, 'live-http-via-ovdb');
    const blockers = r.data.activation_blockers.join(' ');
    assert.match(blockers, /No admitted execution route/);
    assert.match(blockers, /no-store enforcement/);
    assert.match(blockers, /Retained paging\/history\/export\/download\/fixtures\/replay/);
    assert.match(r.data.notices.join(' '), /NVD remains deferred/);
    for (const mutate of [
      d => { d.status = 'active'; }, d => { d.retention = 'snapshot'; },
      d => { d.activation_blockers = []; }, d => { d.rows = [{ id: 'synthetic' }]; },
      d => { d.deployment = { url: 'https://query.example.org/' }; },
      d => { d.recordsets[0].fields[0].type = 'number'; },
      d => { d.recordsets[0].fields[0].meanings = ['invented']; },
    ]) {
      const bad = structuredClone(r); mutate(bad.data);
      assert.ok(sourceProblems([bad], maintainers).length, r.key);
    }
  }
});

const bqWave = {
  'bigquery-google-trends': ['google_trends', 'Google', 'https://support.google.com/trends/answer/4365538'],
  'bigquery-new-york-citibike': ['new_york', 'Lyft Bikes and Scooters, LLC (Citi Bike candidates only)', 'https://citibikenyc.com/data-sharing-policy'],
};
test('BigQuery wave keeps source-specific scope and unresolved native/rights gates', () => {
  const all = readDirectory(root.pathname);
  for (const [id, [dataset, publisher, terms]] of Object.entries(bqWave)) {
    const r = all.sources.find(x => x.key === id); assert.ok(r, id);
    assert.deepEqual(sourceProblems([r], all.maintainers), []);
    assert.equal(r.data.format, 'ovdb-source/draft-2');
    assert.equal(r.data.status, 'inactive'); assert.equal(r.data.query_activation, 'blocked');
    assert.equal(r.data.publisher, publisher); assert.equal(r.data.terms_url, terms);
    assert.deepEqual(r.data.locator, { source_project: 'bigquery-public-data', dataset_id: dataset, existence_status: 'unverified', location_status: 'unverified' });
    assert.equal(r.data.documentation.commit, '14735c60589ab22361dc0d54ad7491ba7ae96a04');
    assert.equal(r.data.documentation.url, `https://github.com/GoogleCloudPlatform/public-datasets-pipelines/blob/${r.data.documentation.commit}/datasets/${dataset}/pipelines/dataset.yaml`);
    assert.equal(r.data.access_requirements.cost_admission, 'not-granted');
    assert.equal(r.data.access_requirements.runtime_acceptance, 'pending');
    assert.equal(r.data.provider_retention.authorization, 'pending-review');
    for (const field of ['recordsets','resource_url','retention','modelspec_url','meaninggraph_url']) assert.equal(r.data[field], undefined);
    assert.match(r.data.activation_blockers.join(' '), /separately authorized metadata-only evidence/);
    assert.match(r.data.notices.join(' '), /not a guaranteed maximum deletion period/);
  }
  const trends = all.sources.find(x => x.key === 'bigquery-google-trends').data;
  assert.match(trends.notices.join(' '), /top_terms.*candidate only/);
  assert.match(trends.notices.join(' '), /requires attribution.*no independent data licence/);
  const bike = all.sources.find(x => x.key === 'bigquery-new-york-citibike').data;
  assert.match(bike.title, /Citi Bike candidates within BigQuery new_york/);
  assert.match(bike.description, /apply only to the Citi Bike candidates; unrelated New York data is outside/);
  assert.match(bike.notices.join(' '), /new_york_citibike.*different native dataset/);
  assert.match(bike.notices.join(' '), /unaccepted documentation-backed candidates only/);
  assert.match(bike.activation_blockers.join(' '), /authorized interfaces, extraction and redistribution restrictions/);
});

test('both BigQuery wave records reject activation, invented scope/binding and unsafe external URLs', () => {
  const sources = readDirectory(root.pathname).sources.filter(x => Object.hasOwn(bqWave, x.key));
  for (const r of sources) {
    for (const mutate of [
      d => { d.status='active'; }, d => { d.query_activation='active'; },
      d => { d.locator.location='US'; }, d => { d.locator.table_id='invented'; },
      d => { d.recordsets=[]; }, d => { d.schema={}; }, d => { d.rows=[]; },
      d => { d.modelspec_url='https://modelspec.org/registry/models/invented/'; },
      d => { d.access_requirements.authentication='anonymous'; },
      d => { d.provider_retention.authorization='granted'; },
      d => { d.owned_retention.enforcement='verified'; },
    ]) { const bad=structuredClone(r); mutate(bad.data); assert.ok(sourceProblems([bad], maintainers).length, r.key); }
    for (const field of ['homepage','terms_url']) for (const url of ['http://example.org/', 'https://localhost/', 'https://127.0.0.1/', 'https://user:pass@example.org/', 'https://example.org/?token=x', 'https://example.org/#data']) {
      const bad=structuredClone(r); bad.data[field]=url; assert.ok(sourceProblems([bad], maintainers).length, `${r.key} ${field} ${url}`);
    }
    for (const field of ['documentation','access_requirements','provider_retention']) {
      const bad=structuredClone(r); bad.data[field][field === 'documentation' ? 'url' : 'documentation_url']='https://localhost/'; assert.ok(sourceProblems([bad], maintainers).length);
    }
    assert.ok(sourceProblems([r, {...structuredClone(r), key: r.key+'-duplicate'}], maintainers).length);
  }
});

const w4 = {
  'ea-monitoring-stations': ['https://environment.data.gov.uk/flood-monitoring/id/stations', ['notation','stationReference']],
  'ea-monitoring-measures': ['https://environment.data.gov.uk/flood-monitoring/id/measures', ['notation','parameter','qualifier']],
  'fsa-establishment-metadata': ['https://api.ratings.food.gov.uk/Establishments', ['BusinessName','PostCode','LocalAuthorityBusinessID','LocalAuthorityCode']],
};
test('W4 keeps partial native inventories, independent attribution and unresolved execution gates', () => {
  const all=readDirectory(root.pathname);
  for (const [id,[url,fields]] of Object.entries(w4)) {
    const r=all.sources.find(x=>x.key===id); assert.ok(r,id);
    assert.deepEqual(sourceProblems([r],all.maintainers),[]);
    assert.equal(r.data.resource_url,url); assert.equal(r.data.format,'ovdb-source/draft-1');
    assert.equal(r.data.status,'inactive'); assert.equal(r.data.retention,'none');
    assert.deepEqual(r.data.recordsets[0].fields.map(x=>[x.name,x.type]),fields.map(x=>[x,'string']));
    assert.match(r.data.recordsets[0].description,/partial.*current response shape is unverified/);
    for(const key of ['modelspec_url','meaninggraph_url','schema','rows','deployment','licence']) assert.equal(r.data[key],undefined);
    assert.match(r.data.activation_blockers.join(' '),/provider licence grant does not grant this workflow authorization/);
    assert.match(r.data.activation_blockers.join(' '),/actual GET\/CORS.*remain unverified/);
    if(id.startsWith('ea-')) {
      assert.equal(r.data.terms_url,'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/');
      assert.match(r.data.notices.join(' '),/this uses Environment Agency flood and river level data from the real-time data API \(Beta\)/);
    } else {
      assert.equal(r.data.terms_url,'https://ratings.food.gov.uk/terms-and-conditions');
      assert.match(r.data.notices.join(' '),/x-api-version: 2.*Header cannot be encoded/);
      assert.match(r.data.notices.join(' '),/Request body formats.*not an observed response/);
      assert.match(r.data.notices.join(' '),/FHRSID is numeric.*All rating fields and imagery/);
      assert.match(r.data.notices.join(' '),/current or explicitly dated rating information/);
      assert.doesNotMatch(fields.join(' '),/FHRSID|Rating/);
    }
  }
});
test('W4 refuses activation, retained payloads, invented types and unsafe resource/rights URLs', () => {
  for(const r of readDirectory(root.pathname).sources.filter(x=>Object.hasOwn(w4,x.key))) {
    for(const mutate of [d=>{d.status='active';},d=>{d.retention='snapshot';},d=>{d.rows=[];},d=>{d.headers={'x-api-version':'2'};},d=>{d.licence='CC0-1.0';},d=>{d.schema={};},d=>{d.recordsets[0].fields[0].type='number';},d=>{d.recordsets[0].fields[0].meanings=[];}]) {
      const bad=structuredClone(r); mutate(bad.data); assert.ok(sourceProblems([bad],maintainers).length,r.key);
    }
    for(const field of ['homepage','resource_url','terms_url']) for(const url of ['http://example.org/', 'https://localhost/', 'https://127.0.0.1/', 'https://user:pass@example.org/', 'https://example.org/?query=payload','https://example.org/#rows']) {
      const bad=structuredClone(r);bad.data[field]=url;assert.ok(sourceProblems([bad],maintainers).length,`${r.key} ${field} ${url}`);
    }
  }
});
