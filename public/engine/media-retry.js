// Media requests through the server's relay are asked again while the media server
// is slow to answer: a 502, 503 or 504 (the relay answers 503 with Retry-After when
// the media server has not answered in time, see media-server-wait.js) or a request
// that failed outright. A drive that was asleep takes several seconds to spin up,
// and a playlist that is not there yet must not end the stream. Each request keeps
// trying for up to MEDIA_RETRY_BUDGET_MS, waiting what Retry-After says or a second
// at first and longer after, never more than 5 s. onWaiting is called before each
// wait so the page can say what is happening. Timers are passed in for the tests.

export const MEDIA_RETRY_BUDGET_MS = 60000;
const RETRY_STATUSES = new Set([502, 503, 504]);
const MAX_DELAY_MS = 5000;

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function retryAfterMs(response) {
  const header = response?.headers?.get('retry-after');
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

export function createRetryingFetch({
  fetchFn = (...args) => fetch(...args), budgetMs = MEDIA_RETRY_BUDGET_MS, onWaiting = () => {},
  sleep = defaultSleep, now = () => Date.now(),
} = {}) {
  return async function retryingFetch(resource, init = {}) {
    const started = now();
    let delay = 1000;
    for (let attempt = 1; ; attempt += 1) {
      let response = null;
      let error = null;
      try { response = await fetchFn(resource, init); } catch (err) { error = err; }
      const done = () => { if (error) throw error; return response; };
      // A request the player cancelled, or an answer that is not about waiting, is final.
      if (init.signal?.aborted || (response && !RETRY_STATUSES.has(response.status))) return done();
      const wait = Math.min(MAX_DELAY_MS, retryAfterMs(response) ?? delay);
      if (now() - started + wait > budgetMs) return done();
      await response?.body?.cancel().catch(() => {});
      onWaiting({ attempt, status: response?.status ?? 0 });
      await sleep(wait, init.signal);
      delay = Math.min(Math.round(delay * 1.5), MAX_DELAY_MS);
    }
  };
}

// The same wait for Standard playback, through hls.js's own retry settings: up to 12
// tries a second apart at first, doubling to 5 s, about a minute in all.
const SLOW_SERVER_RETRY = { maxNumRetry: 12, retryDelayMs: 1000, maxRetryDelayMs: MAX_DELAY_MS };
const loadPolicy = (maxTimeToFirstByteMs, maxLoadTimeMs) => ({
  default: { maxTimeToFirstByteMs, maxLoadTimeMs, timeoutRetry: SLOW_SERVER_RETRY, errorRetry: SLOW_SERVER_RETRY },
});
export const HLS_LOAD_POLICIES = {
  manifestLoadPolicy: loadPolicy(Infinity, 20000),
  playlistLoadPolicy: loadPolicy(10000, 20000),
  fragLoadPolicy: loadPolicy(10000, 120000),
};
