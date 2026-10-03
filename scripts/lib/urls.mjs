// URL rules for what a manifest publishes (CC0-1.0).
//
// Two rules of the OVDB Directory's conventions:
//
// - A database's canonical URL is an https URL with `ovdb` as a complete path
//   segment or as a subdomain.
// - Public mappings are https-only and may not point at localhost,
//   private-network, link-local or cloud-metadata endpoints. The Directory
//   checks this while indexing; clients must check it again, and must check the
//   address a name resolves to (a public-looking name such as 127.0.0.1.nip.io
//   can resolve to a private address, which no check of the text can see).
//
// URLs are parsed with the WHATWG URL parser, which also normalises the odd
// spellings of an address (0x7f.1, 2130706433, 017700000001, [::ffff:7f00:1],
// percent-encoded host names), so the checks below see the host a client would
// connect to. Each URL must also be written the way that parser would write it,
// so there is exactly one spelling of every URL that is checked and published:
// no trailing dot or empty label in the host, no empty path segment, no
// percent-encoded character that stands for an unreserved one, no dot segment.

// Names that are never public: local, internal and reserved naming zones.
const privateSuffixes = [
  'localhost', 'local', 'internal', 'localdomain', 'lan', 'home.arpa', 'arpa', 'intranet', 'corp', 'private',
  'svc', 'home', 'test', 'example', 'invalid', 'onion',
];

// Two-label public suffixes where the registered name sits one label further left
// (ovdb.co.uk is a registered name under co.uk, not a subdomain). The list is short: 17
// of the common ones, kept by hand, not the public suffix list. How it is decided: a
// suffix is added by a reviewed change to this list when a real publisher needs it. Until
// then a name under a suffix that is not listed counts as having `ovdb` as a subdomain
// (ovdb.co.il, ovdb.com.sg, ovdb.github.io and ovdb.pages.dev pass although `ovdb` is
// the registered name, or a publisher's own site, there). That is acceptable because
// the marker is a naming convention, not proof that the publisher owns the origin (see
// the README).
const twoLabelSuffixes = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.in', 'co.za', 'com.br', 'com.cn', 'com.mx', 'com.tr', 'com.ar',
]);

// A problem with the host of `url` for a public mapping, or null.
export function hostProblem(url) {
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || host.includes(':')) return `${url.hostname} is an IP address; a public mapping names a host`;
  if (host.endsWith('.')) return `${url.hostname} ends with a dot; write the host without it`;
  if (host.split('.').some((label) => label === '')) return `${url.hostname} has an empty label`;
  if (/^\d+(\.\d+)*$/.test(host) || /^0x[0-9a-f]+$/.test(host)) return `${url.hostname} is an IP address; a public mapping names a host`;
  if (!host.includes('.')) return `${url.hostname} is a single-label name, not a public host`;
  for (const suffix of privateSuffixes) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return `${url.hostname} is a local, internal or reserved name (.${suffix}), not a public host`;
  }
  return null;
}

// A problem with `value` as a public https URL (the canonical url, the
// deployment's url, discovery document or recordset page, the publisher's
// url), or null. `template` allows `{name}` exactly once, and only in the path
// (never in the host, userinfo or port), as in recordset_page.
// Refused: anything but https, userinfo, a query, a fragment, a host that is
// not public (see hostProblem), a malformed or non-canonical spelling.
export function publicHttpsProblem(value, { template = false } = {}) {
  if (typeof value !== 'string' || value.trim() === '') return 'is not a URL';
  if (value !== value.trim() || /[\u0000- \u007f\\]/.test(value)) return 'contains whitespace, control characters or a backslash';
  let probe = value;
  if (template) {
    if (value.split('{name}').length !== 2) return 'must contain {name} exactly once';
    const authorityEnd = value.indexOf('/', value.indexOf('//') + 2);
    if (authorityEnd === -1 || value.indexOf('{name}') < authorityEnd) return 'must have {name} in the path only, never in the host, userinfo or port';
    probe = value.replace('{name}', 'name');
  }
  let url;
  try { url = new URL(probe); } catch { return 'is not a URL'; }
  if (url.protocol !== 'https:') return `must be https, not ${url.protocol.slice(0, -1)}`;
  if (url.username || url.password) return 'must not contain credentials (userinfo)';
  if (url.search || probe.includes('?')) return 'must not contain a query';
  if (url.hash || probe.includes('#')) return 'must not contain a fragment';
  const problem = hostProblem(url);
  if (problem) return problem;
  if (url.pathname.includes('//')) return 'has an empty path segment (//)';
  for (const match of url.pathname.matchAll(/%([0-9a-fA-F]{2})/g)) {
    const character = String.fromCharCode(Number.parseInt(match[1], 16));
    if (/[A-Za-z0-9\-._~]/.test(character)) return `writes ${match[0]} for ${character}; write the character itself (one spelling per URL)`;
  }
  // The literal text must be the URL's own spelling, so that what is checked is
  // what is published (no %2e dot segments, no mixed-case host, no decoded host).
  if (url.href !== probe) return `is not written canonically (it would be ${url.href})`;
  return null;
}

// Whether the canonical url has `ovdb` as a complete path segment or as a
// subdomain. A subdomain is a host label that is left of the registered name:
// the registered name is the last two labels, or the last three under a two-label
// suffix such as co.uk. So ovdb.acme.com and x.ovdb.acme.co.uk count; ovdb.com and
// ovdb.co.uk (where ovdb is the registered name itself) do not. In the path,
// acme.com/ovdb/x counts and acme.com/ovdbx/x does not.
export function hasOvdbMarker(value) {
  const url = new URL(value);
  if (url.pathname.split('/').includes('ovdb')) return true;
  const labels = url.hostname.toLowerCase().split('.');
  const suffixLabels = twoLabelSuffixes.has(labels.slice(-2).join('.')) ? 2 : 1;
  return labels.slice(0, labels.length - suffixLabels - 1).includes('ovdb');
}
