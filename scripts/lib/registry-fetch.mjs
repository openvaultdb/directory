// Reads a registry's index.json over https (CC0-1.0). One deadline for the whole read (both attempts), one retry
// of a failure that may pass, a redirect that is final and never followed, a host that must be one of two, and a
// failure message that names the registry and the cause. A registry outage must not hang a run, and a single
// dropped connection must not fail it; a build still never falls back to stale data.

export const registryTimeoutMs = 20_000;
export const registryRetryDelayMs = 1_000;
// Where a registry index may be read from: GitHub's raw file host only. (A github.com/.../raw/... link always answers
// with a redirect, which is final here, so it could never be read.)
export const registryHosts = ['raw.githubusercontent.com'];

const redirects = new Set([301, 302, 303, 307, 308]);
// A certificate or TLS failure will not pass on a second try.
const permanentCauses = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED|HOSTNAME_MISMATCH|ERR_TLS)/;
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Why a fetch failed, for a message: the error's message and, when the runtime wraps it ("fetch failed"), its cause's
// code or message (ENOTFOUND, UND_ERR_CONNECT_TIMEOUT, a certificate error, ...).
const causeOf = (error) => {
  const cause = error?.cause;
  const detail = cause?.code ?? cause?.message;
  return detail && !String(error.message).includes(detail) ? `${error.message} (${detail})` : String(error?.message ?? error);
};

// A problem with `url` as a registry index URL, or null: https, on one of registryHosts.
export function registryUrlProblem(url, envName) {
  let parsed;
  try { parsed = new URL(url); } catch { parsed = null; }
  const hint = envName ? ` (check ${envName})` : '';
  if (parsed?.protocol !== 'https:') return `must be read over https; ${JSON.stringify(url)} is not an https URL${hint}`;
  if (parsed.username || parsed.password) return `must not contain credentials; ${JSON.stringify(url)} does${hint}`;
  if (parsed.port) return `must use the default https port; ${JSON.stringify(url)} names port ${parsed.port}${hint}`;
  if (!registryHosts.includes(parsed.hostname)) return `must be read from ${registryHosts.join(' or ')}; ${JSON.stringify(url)} is on ${parsed.hostname}${hint}`;
  return null;
}

// One attempt, cut off when `signal` aborts (a connection that never answers, a body that never ends).
// Returns { text } or { status } (the status of an answer that is not a success).
async function attempt(url, fetchImpl, signal) {
  const aborted = new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('no answer within the deadline')), { once: true });
  });
  return Promise.race([
    (async () => {
      // redirect: 'manual' hands back the 3xx answer itself: it is reported, never followed.
      const response = await fetchImpl(url, { redirect: 'manual', signal });
      if (!response.ok) return { status: response.status };
      return { text: await response.text() };
    })(),
    aborted,
  ]);
}

// Fetches `url` for the registry called `name` (for messages): the text of the response. `url` must pass
// registryUrlProblem. The deadline is `timeoutMs` for everything; a failure to connect, a timeout of one attempt,
// a 5xx and a 429 are tried once more (while time remains); a redirect, a certificate failure, a 404, a 403 and every other answer are
// final. Throws "cannot read the <name> (<url>): <reason>".
export async function readRegistryText({ name, url, envName, fetchImpl = fetch, timeoutMs = registryTimeoutMs, retryDelayMs = registryRetryDelayMs }) {
  const problem = registryUrlProblem(url, envName);
  if (problem) throw new Error(`the ${name} index ${problem}`);
  const controller = new AbortController();
  const { signal } = controller;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reason; // why the last attempt failed
  try {
    for (let tries = 1; tries <= 2 && !signal.aborted; tries += 1) {
      try {
        const result = await attempt(url, fetchImpl, signal);
        if (result.text !== undefined) return result.text;
        reason = `HTTP ${result.status}`;
        if (redirects.has(result.status)) { reason += ', a redirect (a redirect is never followed)'; break; }
        if (result.status < 500 && result.status !== 429) break;
      } catch (error) {
        if (signal.aborted) break;
        reason = causeOf(error);
        if (permanentCauses.test(error?.cause?.code ?? '')) break;
      }
      if (tries === 1 && !signal.aborted) await Promise.race([wait(retryDelayMs), new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }); })]);
    }
  } finally {
    clearTimeout(timer);
  }
  // The deadline ended it: say so, and what the last attempt said before that.
  if (signal.aborted) reason = `no answer within ${timeoutMs} ms${reason ? ` (the last attempt failed with ${reason})` : ''}`;
  throw new Error(`cannot read the ${name} (${url}): ${reason}`);
}
