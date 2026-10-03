// URL rules for what a manifest publishes (CC0-1.0).
//
// The engineering brief asks for two things. Section 5: a database's canonical
// URL is an https URL with `ovdb` as a complete path segment or as a
// subdomain. Section 15: public mappings are https-only and may not point at
// localhost, private-network, link-local or cloud-metadata endpoints; the
// Directory validates this while indexing (clients enforce it again).
//
// URLs are parsed with the WHATWG URL parser, which also normalises the odd
// spellings of an address (0x7f.1, 2130706433, 017700000001, [::ffff:7f00:1],
// percent-encoded host names), so the checks below see the host a client would
// connect to.

// Names that are never public: local and internal naming zones.
const privateSuffixes = ['localhost', 'local', 'internal', 'localdomain', 'lan', 'home.arpa', 'intranet', 'corp', 'private'];

// A problem with the host of `url` for a public mapping, or null.
export function hostProblem(url) {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || host.includes(':')) return `${url.hostname} is an IP address; a public mapping names a host`;
  if (/^\d+(\.\d+)*$/.test(host) || /^0x[0-9a-f]+$/.test(host)) return `${url.hostname} is an IP address; a public mapping names a host`;
  if (!host.includes('.')) return `${url.hostname} is a single-label name, not a public host`;
  for (const suffix of privateSuffixes) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return `${url.hostname} is a local or internal name (.${suffix}), not a public host`;
  }
  return null;
}

// A problem with `value` as a public https URL (the canonical url, the
// deployment's url, discovery document or recordset page, the publisher's
// url), or null. `template` allows `{name}` once, as in recordset_page.
// Refused: anything but https, userinfo, a port to a private host (see
// hostProblem), a query, a fragment, a malformed or non-canonical spelling.
export function publicHttpsProblem(value, { template = false } = {}) {
  if (typeof value !== 'string' || value.trim() === '') return 'is not a URL';
  if (value !== value.trim() || /[\u0000- \u007f\\]/.test(value)) return 'contains whitespace, control characters or a backslash';
  let probe = value;
  if (template) {
    if (value.split('{name}').length !== 2) return 'must contain {name} exactly once';
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
  // The literal text must be the URL's own spelling after the scheme and host, so that
  // what is checked is what is published (no %2e dot segments, no mixed-case host).
  if (url.href !== probe) return `is not written canonically (it would be ${url.href})`;
  return null;
}

// Whether the canonical url has `ovdb` as a complete path segment or as a
// subdomain (a label before the registered domain, so ovdb.com does not count).
export function hasOvdbMarker(value) {
  const url = new URL(value);
  if (url.pathname.split('/').includes('ovdb')) return true;
  const labels = url.hostname.toLowerCase().split('.');
  return labels.slice(0, -2).includes('ovdb');
}
