// URL rules for what a manifest publishes (CC0-1.0).
//
// Database identities are canonical, public https URLs. Their path is independent
// of the publisher's server route and may be empty or contain safe segments.
// Older Directory identities that put `ovdb` in the host or path remain accepted during migration. Public mappings
// are https-only and may not point at localhost,
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
// no trailing dot or empty label in the host, no empty path segment, no dot
// segment. There is also no port (not even :443). Identity paths may contain
// canonical percent-encoded segments; each is validated independently so an
// encoded separator cannot alter the route. A generated recordset URL may
// encode its one native name component.

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

const hostLabel = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
export const encodePathSegment = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.codePointAt(0).toString(16).toUpperCase()}`);

// A global database identity is a canonical public URL. Preserve its encoded
// spelling when mapping it into the Directory route; never decode and re-encode.
export function globalDatabaseIdProblem(value) {
  if (typeof value !== 'string' || value.trim() === '') return 'is not a URL';
  let url;
  try { url = new URL(value); } catch { return 'is not a URL'; }
  const encodedPathSegments = url.pathname.split('/').filter((segment) => segment.includes('%'));
  const problem = publicHttpsProblem(value, { encodedPathSegments, allowReservedExampleHost: true });
  if (problem) return problem;
  return null;
}

// The route is shared by Directory pages and cross-registry links. Global IDs
// map to /ovdb/{host}{path}; the identity's encoded spelling is carried over
// byte-for-byte from the canonical URL.
export function directoryPagePath(globalId) {
  const problem = globalDatabaseIdProblem(globalId);
  if (problem) throw new TypeError(`invalid global database id ${JSON.stringify(globalId)}: ${problem}`);
  const url = new URL(globalId);
  const normalizedPath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return `/ovdb/${url.host}${normalizedPath}`;
}

// A problem with the host of `url` for a public mapping, or null.
export function hostProblem(url, { allowReservedExampleHost = false } = {}) {
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || host.includes(':')) return `${url.hostname} is an IP address; a public mapping names a host`;
  if (host.endsWith('.')) return `${url.hostname} ends with a dot; write the host without it`;
  if (host.split('.').some((label) => label === '')) return `${url.hostname} has an empty label`;
  if (/^\d+(\.\d+)*$/.test(host) || /^0x[0-9a-f]+$/.test(host)) return `${url.hostname} is an IP address; a public mapping names a host`;
  if (!host.includes('.')) return `${url.hostname} is a single-label name, not a public host`;
  for (const suffix of privateSuffixes) {
    if (suffix === 'example' && allowReservedExampleHost) continue;
    if (host === suffix || host.endsWith(`.${suffix}`)) return `${url.hostname} is a local, internal or reserved name (.${suffix}), not a public host`;
  }
  return null;
}

// A problem with `value` as a public https URL (the canonical url, the deployment's url,
// discovery document or recordset page, the publisher's url, the homepage), or null.
// `template` allows `{name}` exactly once, and only in the path (never in the host,
// userinfo or port), as in recordset_page.
// Refused: anything but https, userinfo, a port, a query, a fragment, a host that is
// not public (see hostProblem), a malformed or non-canonical spelling, and, judged on the
// text as written (never on what the parser makes of it), anything but a plain host and
// path: the host is lower-case letters, digits and hyphen in dot-separated labels (1 to 63
// characters each, none starting or ending with a hyphen), at least two labels, at most 253
// characters in all; the path is only A-Z a-z 0-9 . _ ~ / and - (and `{name}` in a
// template), with no percent escape, no `//` and no `.` or `..` segment. A generated
// recordset URL may contain one percent-encoded native name component. So nothing that
// could leave an HTML attribute or a URL (quote, apostrophe, ampersand, backtick, angle
// bracket, brace, parenthesis, semicolon, comma, equals sign, space) is ever published.
// A site that shows the value must still HTML-escape it.
export function publicHttpsProblem(value, { template = false, encodedPathSegment, encodedPathSegments, allowReservedExampleHost = false } = {}) {
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
  const problem = hostProblem(url, { allowReservedExampleHost });
  if (problem) return problem;
  // The parser drops the default port, so look at the text: any ":" in the authority is a port.
  if (probe.slice('https://'.length).split('/')[0].includes(':')) return 'must not name a port (not even :443): a published URL is reached on the default https port';
  const authorityEnd = probe.indexOf('/', probe.indexOf('//') + 2);
  const writtenPath = authorityEnd === -1 ? '' : probe.slice(authorityEnd);
  if (writtenPath.includes('//')) return 'has an empty path segment (//)';
  if (writtenPath.includes('%')) {
    const escaped = writtenPath.split('/').filter((segment) => segment.includes('%'));
    const allowedEscapes = encodedPathSegments ?? (typeof encodedPathSegment === 'string' ? [encodedPathSegment] : []);
    if (escaped.length !== allowedEscapes.length || escaped.some((segment, index) => segment !== allowedEscapes[index])) {
      return 'must not contain a percent escape in the path (write the character itself, or leave it out)';
    }
    for (const encoded of escaped) {
      let decoded;
      try { decoded = decodeURIComponent(encoded); } catch { return 'has an invalid percent escape in the path'; }
      if (encodePathSegment(decoded) !== encoded || decoded === '.' || decoded === '..' || /[/\\\u0000-\u001f\u007f]/.test(decoded)) {
        return 'has a non-canonical or unsafe encoded path segment';
      }
      // A downstream router or proxy must not be able to turn a still-encoded
      // separator or dot segment into path syntax by decoding this segment a
      // second (or later) time. Check each nested layer without changing the
      // canonical spelling we publish.
      let nested = decoded;
      while (/%[0-9a-f]{2}/i.test(nested)) {
        let next;
        try { next = decodeURIComponent(nested); } catch { break; }
        if (next === nested) break;
        if (next === '.' || next === '..' || /[/\\\u0000-\u001f\u007f]/.test(next)) {
          return 'has a nested percent escape that can become a path separator, control character or dot segment';
        }
        nested = next;
      }
    }
  }
  // The literal text must be the URL's own spelling, so that what is checked is
  // what is published (no %2e dot segments, no mixed-case host, no decoded host).
  if (url.href !== probe) return `is not written canonically (it would be ${url.href})`;
  // The plain host and path rules, on the written text (probe has `name` where a template had {name}).
  const rest = probe.slice('https://'.length);
  const slash = rest.indexOf('/');
  const host = rest.slice(0, slash);
  const path = rest.slice(slash);
  const labels = host.split('.');
  if (host.length > 253 || labels.length < 2 || !labels.every((label) => hostLabel.test(label))) return `host ${host} must be lower-case labels of ASCII letters, digits and hyphen (1 to 63 characters each, none starting or ending with a hyphen), at least two, separated by dots, at most 253 characters in all`;
  if (!/^[A-Za-z0-9._~/%-]*$/.test(path)) return 'path may only use A-Z a-z 0-9 . _ ~ / and - or one canonical encoded native recordset name (no quote, apostrophe, ampersand or other punctuation)';
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return 'must not have a . or .. segment';
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

// A manifest's `homepage` is a public https URL under the same plain host and path rules as every
// published URL (publicHttpsProblem), and at most 200 characters.
export const homepageMaxLength = 200;
export function homepageProblem(value) {
  const problem = publicHttpsProblem(value);
  if (problem) return problem;
  if (value.length > homepageMaxLength) return `is longer than ${homepageMaxLength} characters`;
  return null;
}
