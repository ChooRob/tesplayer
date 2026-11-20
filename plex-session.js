// Adapted from drive-in (https://github.com/1MoreBuild/drive-in,
// server/plex-session-health.js). Distinguishes a segment that's genuinely
// 404 because the transcode session expired/was killed from one that's just
// not encoded yet (Plex's HLS segments are generated on demand), and retries
// the latter with backoff instead of failing the whole stream on a transient
// race.

const RETRY_DELAYS_MS = [0, 250, 500, 1000];
// A missing session must stay missing this long before it counts as gone.
const EXPIRED_CONFIRM_MS = 2500;
const SEGMENT_BUDGET_MS = 8000; // stay under the browser's ~12s inactivity timeout
const PROBE_TTL_MS = 250;

export function plexSessionId(path) {
  return /\/session\/([^/?]+)\//.exec(path)?.[1] || null;
}

// Plex's /transcode/sessions inventory (also what python-plexapi polls). A
// failed or malformed inventory means "unknown", not "expired" -- never treat
// a network hiccup on the health check itself as proof the session is gone.
export function sessionHealth(data, session) {
  const container = data?.MediaContainer;
  if (!session || !container) return 'unknown';
  const sessions = container.TranscodeSession;
  if (!Array.isArray(sessions)) return container.size === 0 ? 'expired' : 'unknown';
  if (sessions.some((entry) => entry.key === session || entry.key === `/transcode/sessions/${session}`)) {
    return 'alive';
  }
  if (sessions.some((entry) => typeof entry.key !== 'string')) return 'unknown';
  return 'expired';
}

export function createPlexSessionProbe({ baseUrl, token }) {
  let snapshot = null;
  let expiresAt = 0;
  let pending = null;

  const probe = async (session) => {
    if (!session) return 'unknown';
    if (!pending && Date.now() >= expiresAt) {
      pending = (async () => {
        let data = null;
        try {
          const res = await fetch(`${baseUrl}/transcode/sessions`, {
            headers: { Accept: 'application/json', 'X-Plex-Token': token },
            redirect: 'error',
            signal: AbortSignal.timeout(2000),
          });
          data = res.ok ? await res.json() : null;
        } catch {
          // leave data as null -> "unknown"
        }
        snapshot = data;
        expiresAt = Date.now() + PROBE_TTL_MS;
      })().finally(() => { pending = null; });
    }
    if (pending) await pending;
    return sessionHealth(snapshot, session);
  };

  return probe;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  return fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
}

// Fetches a Plex HLS segment, retrying a 404 (segment not encoded yet) until the budget runs out. The
// session-health probe decides whether the session itself is gone, but only a session that stays gone is
// believed: after a seek Plex restarts its transcoder, and for a moment the session is missing from its list
// while it comes back. Returns { response, expired }.
export async function fetchPlexSegment(url, { headers, probe, session, budgetMs = SEGMENT_BUDGET_MS, confirmExpiredMs = EXPIRED_CONFIRM_MS, retryDelaysMs = RETRY_DELAYS_MS } = {}) {
  const deadline = Date.now() + budgetMs;
  let expiredSince = null;
  let response = null;

  for (let attempt = 0; ; attempt += 1) {
    const delay = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)];
    if (attempt > 0 && delay) await new Promise((r) => setTimeout(r, delay));

    const remaining = Math.max(1000, deadline - Date.now());
    response = await fetchWithTimeout(url, { headers }, remaining);
    if (response.status !== 404) return { response, expired: false };

    await response.body?.cancel().catch(() => {});
    const health = await probe(session);
    if (health === 'expired') {
      expiredSince ??= Date.now();
      if (Date.now() - expiredSince >= confirmExpiredMs) return { response: null, expired: true };
    } else {
      expiredSince = null;
    }
    if (Date.now() + (retryDelaysMs[Math.min(attempt + 1, retryDelaysMs.length - 1)] || 0) >= deadline) return { response, expired: false };
  }
}
