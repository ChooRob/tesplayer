// Wait until the server answers again, so a player that lost its stream does not
// reload the page into a "site can't be reached" error while the server restarts.
// Any answer below 500 counts as up (a signed-out 401 or a redirect included); a
// refused connection or a gateway error (502/503/504) means keep waiting.

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Each try gets attemptTimeoutMs, long enough for a weak cellular connection.
// Resolves 'up', 'timeout' or 'cancelled'. Waits 1 s between tries at first, then
// longer, never more than 5 s.
export async function waitForServer({
  url = '/login', timeoutMs = 120000, attemptTimeoutMs = 10000, cancelled = () => false,
  fetchImpl = globalThis.fetch?.bind(globalThis), sleep = defaultSleep, now = Date.now,
} = {}) {
  const started = now();
  let delay = 1000;
  while (!cancelled()) {
    try {
      const response = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(attemptTimeoutMs) });
      await response.body?.cancel?.();
      if (response.status < 500) return 'up';
    } catch { /* not answering yet */ }
    if (now() - started >= timeoutMs) return 'timeout';
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.5), 5000);
  }
  return 'cancelled';
}
