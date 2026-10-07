// Offline source-discovery contracts only. No collection or database verdict.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { readCollection } from './directory.mjs';
import { commitPattern, git, openDependency } from './git.mjs';
import { indexMeaningRegistry } from './meaning.mjs';
import { indexModelRegistry } from './modelspec.mjs';
import { parseStrictJson } from './strict-json.mjs';
import { registryMetadataId, sourceEntries, sourceProblems, sourceRegistryProblems } from './source-discovery.mjs';

export const reportLimits = Object.freeze({ records: 1024, recordBytes: 256 * 1024, totalBytes: 16 * 1024 * 1024, indexBytes: 4 * 1024 * 1024, findings: 256 });
const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const safe = value => String(value).replace(/[^a-zA-Z0-9_.$/\-]/g, '_').slice(0, 160);
const unchecked = ['collection', 'maintainer-content', 'publisher', 'database-metadata', 'site-delivery', 'execution', 'semantics'];
const emptyReport = () => ({
  format: 'ovdb-source-contract-report/draft-1',
  inputs: {},
  inventory: { sources: 0, databases: 0, databasesScope: 'count-only' },
  layers: Object.fromEntries(unchecked.map(name => [name, { outcome: 'not-checked' }])),
  checks: {}, sources: [], findings: [], summary: { findings: 0, omitted: 0 },
});

// This has no fetch seam: only verified local Git objects are ever read.
// Binding HEAD avoids accidentally selecting a different checkout/revision.
function pinnedTree(path, commit) {
  const reader = openDependency(resolve(path), commit);
  const lines = git(['-C', resolve(path), 'ls-tree', '-r', '-z', '--end-of-options', commit], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }).split('\0').filter(Boolean);
  const paths = lines.map(line => line.slice(line.indexOf('\t') + 1));
  return { reader, paths };
}

export function sourceReportArguments(args) {
  const options = {};
  const flags = new Map([['--commit', 'commit'], ['--meaning-index', 'meaningPath'], ['--meaning-commit', 'meaningCommit'], ['--model-index', 'modelPath'], ['--model-commit', 'modelCommit']]);
  for (let i = 0; i < args.length; i++) {
    const key = flags.get(args[i]);
    if (key) {
      if (options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('usage');
      options[key] = args[++i];
    } else if (args[i] === '--check-index' && !options.checkIndex) options.checkIndex = true;
    else if (!args[i].startsWith('-') && options.root === undefined) options.root = args[i];
    else throw new Error('usage');
  }
  if (!options.root || !commitPattern.test(options.commit ?? '')) throw new Error('usage');
  for (const prefix of ['meaning', 'model']) {
    if (Boolean(options[`${prefix}Path`]) !== Boolean(options[`${prefix}Commit`]) || options[`${prefix}Commit`] && !commitPattern.test(options[`${prefix}Commit`])) throw new Error('usage');
  }
  return options;
}

export function reportExitCode(report) {
  if (Object.values(report.checks).some(check => check.outcome === 'unrunnable')) return 2;
  return Object.values(report.checks).some(check => check.outcome === 'invalid') || report.findings.some(finding => finding.outcome === 'invalid') ? 1 : 0;
}

export function sourceContractReport(options) {
  const report = emptyReport();
  const findings = [];
  const add = ({ code, file = 'input', field = '', outcome = 'invalid', check = 'source-contract', source }) => {
    findings.push({ code, severity: outcome === 'unverified' ? 'notice' : 'error', path: safe(file), field: safe(field), outcome, check, ...(source === undefined ? {} : { source: safe(source) }) });
  };
  const finish = () => {
    report.findings = findings.slice(0, reportLimits.findings);
    report.summary = { findings: findings.length, omitted: Math.max(0, findings.length - reportLimits.findings) };
    return report;
  };
  let tree;
  try {
    tree = pinnedTree(options.root, options.commit);
    report.inputs.directory = { commit: tree.reader.commit };
  } catch {
    report.checks['directory-input'] = { outcome: 'unrunnable' };
    add({ code: 'directory-input-unrunnable', check: 'directory-input', outcome: 'unrunnable' });
    return finish();
  }
  const pathsFor = collection => tree.paths.filter(path => path.startsWith(`${collection}/$records/`));
  const recordPaths = [...pathsFor('sources'), ...pathsFor('maintainers')].sort();
  report.inventory.databases = pathsFor('databases').length;
  if (recordPaths.length > reportLimits.records) {
    report.checks['directory-input'] = { outcome: 'invalid' };
    add({ code: 'record-count-limit', check: 'directory-input' });
    return finish();
  }
  const texts = new Map();
  const digest = createHash('sha256');
  let size = 0;
  try {
    for (const path of recordPaths) {
      // The existing reader refuses links before any bytes are read.
      const bytes = tree.reader.readBytes(path, reportLimits.recordBytes);
      size += bytes.length;
      if (size > reportLimits.totalBytes) throw new Error('limit');
      digest.update(JSON.stringify([path, sha256(bytes)]));
      texts.set(path, bytes);
    }
  } catch {
    report.checks['directory-input'] = { outcome: 'unrunnable' };
    add({ code: 'record-input-unrunnable', check: 'directory-input', outcome: 'unrunnable' });
    return finish();
  }
  report.inputs.directory.recordsDigest = `sha256:${digest.digest('hex')}`;
  report.checks['directory-input'] = { outcome: 'valid' };
  const io = {
    names: collection => pathsFor(collection).map(path => path.slice(`${collection}/$records/`.length)),
    read: path => new TextDecoder('utf-8', { fatal: true }).decode(texts.get(path)),
    onProblem: (file, code) => add({ code, file, check: 'record-parse' }),
  };
  const sources = readCollection(options.root, 'sources', io).records;
  const maintainers = readCollection(options.root, 'maintainers', io).records;
  report.inventory.sources = pathsFor('sources').length;
  report.checks['record-parse'] = { outcome: findings.length ? 'invalid' : 'valid' };
  sourceProblems(sources, maintainers, undefined, finding => add({ ...finding, check: finding.code === 'source-maintainer-reference' ? 'maintainer-reference' : 'source-contract' }));
  for (const check of ['source-contract', 'maintainer-reference']) report.checks[check] = { outcome: findings.some(f => f.check === check) ? 'invalid' : 'valid' };
  report.sources = sources.map(({ key, file, data }) => ({
    id: safe(key), path: safe(file),
    kind: data?.access_mode === 'bigquery-native' ? 'bigquery-native' : data?.access_mode === 'live-http-via-ovdb' ? 'live-http-via-ovdb' : null,
    declaredStatus: ['inactive', 'published', 'draft', 'deprecated'].includes(data?.status) ? data.status : null,
    ...(data?.access_mode === 'bigquery-native' ? { declaredQueryActivation: data.query_activation === 'blocked' ? 'blocked' : null } : {}),
    contractOutcome: findings.some(f => f.path === safe(file) && f.outcome === 'invalid') ? 'invalid' : 'valid',
  }));

  const registries = {};
  for (const [name, indexer] of [['meaning', indexMeaningRegistry], ['model', indexModelRegistry]]) {
    const prefix = name;
    const check = `${name}-registry-input`;
    if (!options[`${prefix}Path`]) { report.checks[check] = { outcome: 'not-checked' }; continue; }
    let bytes;
    try {
      const input = pinnedTree(options[`${prefix}Path`], options[`${prefix}Commit`]);
      bytes = input.reader.readBytes('index.json', reportLimits.indexBytes);
      report.inputs[name] = { commit: input.reader.commit, digest: sha256(bytes) };
    } catch {
      report.checks[check] = { outcome: 'unrunnable' };
      add({ code: 'registry-input-unrunnable', file: name, check, outcome: 'unrunnable' });
      continue;
    }
    try {
      registries[name] = indexer(parseStrictJson(bytes, reportLimits.indexBytes), name);
      report.checks[check] = { outcome: 'valid' };
    } catch {
      report.checks[check] = { outcome: 'invalid' };
      add({ code: 'registry-index-invalid', file: name, check });
    }
    // Only target existence is checked. Registry content/semantics is not certified.
  }
  const emptyMeaning = { byId: new Map() };
  const emptyModel = { byAddress: new Map() };
  for (const record of sources) {
    for (const [name, field] of [['meaning', 'meaninggraph_url'], ['model', 'modelspec_url']]) {
      if (!registryMetadataId(field, record.data?.[field])) continue;
      if (!registries[name]) add({ code: 'registry-target-unverified', file: record.file, field, source: record.key, check: 'related-targets', outcome: 'unverified' });
      else {
        // Use the existing helper with just this declared link; unavailable unrelated
        // registry inputs must not create false missing-target findings.
        const selected = { ...record, data: { [field]: record.data[field] } };
        sourceRegistryProblems([selected], registries.meaning ?? emptyMeaning, registries.model ?? emptyModel, finding => add({ ...finding, source: record.key, check: 'related-targets' }));
      }
    }
  }
  report.checks['related-targets'] = { outcome: findings.some(f => f.check === 'related-targets' && f.outcome === 'invalid') ? 'invalid' : findings.some(f => f.check === 'related-targets') ? 'unverified' : 'valid' };
  report.checks['index-source-projection'] = { outcome: 'not-checked' };
  if (options.checkIndex) {
    let bytes;
    try { bytes = tree.reader.readBytes('index.json', reportLimits.indexBytes); }
    catch {
      report.checks['index-source-projection'] = { outcome: 'unrunnable' };
      add({ code: 'directory-index-unrunnable', check: 'index-source-projection', outcome: 'unrunnable', file: 'index.json' });
    }
    if (bytes) {
      report.inputs.index = { commit: options.commit, digest: sha256(bytes) };
      try {
        const index = parseStrictJson(bytes, reportLimits.indexBytes);
        if (report.checks['source-contract'].outcome !== 'valid' || report.checks['record-parse'].outcome !== 'valid') throw new Error('contracts');
        const entries = sourceEntries(sources);
        const projected = JSON.stringify(entries);
        const projectionMatches = entries.length
          ? JSON.stringify(index.sources) === projected && index.sourcesChecksum === sha256(projected)
          : !Object.hasOwn(index, 'sources') && !Object.hasOwn(index, 'sourcesChecksum');
        if (index.format !== 'ovdb-directory/draft-1' || !projectionMatches || Object.hasOwn(index, '_fixture')) throw new Error('projection');
        report.checks['index-source-projection'] = { outcome: 'valid' };
      } catch {
        report.checks['index-source-projection'] = { outcome: 'invalid' };
        add({ code: 'directory-source-projection-invalid', check: 'index-source-projection', file: 'index.json' });
      }
    }
  }
  return finish();
}

export function sourceReportUsage() {
  const report = emptyReport();
  report.checks.arguments = { outcome: 'unrunnable' };
  report.findings = [{ code: 'report-usage', severity: 'error', path: 'arguments', field: '', outcome: 'unrunnable', check: 'arguments' }];
  report.summary.findings = 1;
  return report;
}
