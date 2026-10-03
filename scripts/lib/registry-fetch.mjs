// Reads a registry's index.json over https (CC0-1.0): a timeout on every attempt and one retry,
// and a failure message that names the registry. A registry outage must not hang a run, and a
// single dropped connection must not fail it; a build still never falls back to stale data.

export const registryTimeoutMs = 20_000;
export const registryRetryDelayMs = 1_000;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// One attempt: the response text, or an Error whose message says why not. A hung connection or a body
// that never ends is cut off after `timeoutMs`.
async function attempt(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error(`no answer within ${timeoutMs} ms`)); }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal });
        if (!response.ok) return { status: response.status };
        return { text: await response.text() };
      })(),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Fetches `url` for the registry called `name` (for messages): the text of the response. Tries twice when
// the connection fails, times out or the server answers 5xx or 429; any other status (404, 403) is final.
// Throws "cannot read the <name> (<url>): <reason>".
export async function readRegistryText({ name, url, fetchImpl = fetch, timeoutMs = registryTimeoutMs, retryDelayMs = registryRetryDelayMs }) {
  let reason;
  for (let tries = 1; tries <= 2; tries += 1) {
    try {
      const result = await attempt(url, fetchImpl, timeoutMs);
      if (result.text !== undefined) return result.text;
      reason = `HTTP ${result.status}`;
      if (result.status < 500 && result.status !== 429) break;
    } catch (error) {
      reason = error.message;
    }
    if (tries === 1) await wait(retryDelayMs);
  }
  throw new Error(`cannot read the ${name} (${url}): ${reason}`);
}
