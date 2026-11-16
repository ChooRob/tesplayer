// Adapted from drive-in (https://github.com/1MoreBuild/drive-in,
// server/plex-session-health.js). Distinguishes a segment that's genuinely
// 404 because the transcode session expired/was killed from one that's just
// not encoded yet (Plex's HLS segments are generated on demand), and retries
// the latter with backoff instead of failing the whole stream on a transient
// race.

const RETRY_DELAYS_MS = [0, 250, 500, 1000];
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

// Fetches a Plex HLS segment, retrying a 404 a few times (segment not encoded
// yet) before asking the session-health probe whether the session itself is
// gone. Returns { response, expired }.
export async function fetchPlexSegment(url, { headers, probe, session } = {}) {
  const deadline = Date.now() + SEGMENT_BUDGET_MS;

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    if (RETRY_DELAYS_MS[attempt]) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));

    const remaining = Math.max(1000, deadline - Date.now());
    const response = await fetchWithTimeout(url, { headers }, remaining);
    if (response.status !== 404) return { response, expired: false };

    await response.body?.cancel().catch(() => {});
    const health = await probe(session);
    if (health === 'expired') return { response: null, expired: true };
    if (attempt === RETRY_DELAYS_MS.length - 1) return { response, expired: false };
  }
}
