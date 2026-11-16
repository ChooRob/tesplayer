// Persist completed episodes for next-up reconstruction when Plex history lacks scrobbles.
// Resume positions remain in Plex.

// PMS account IDs are server-local, so each document holds one server and
// account's completions: "<serverId>:<accountId>" -> { showKey: episode }.
let finished = null;
const documentId = (accountId, serverId) => `${serverId}:${accountId}`;

// Older files nested everything in one object: { version: 2, servers: { server: { account: shows } } },
// or before that { account: shows } with no server at all.
function toDocuments(raw, legacyServerId) {
  if (raw.version === 2 && raw.servers && typeof raw.servers === 'object') {
    return Object.fromEntries(Object.entries(raw.servers).flatMap(([serverId, accounts]) =>
      Object.entries(accounts ?? {}).map(([accountId, shows]) => [documentId(accountId, serverId), shows])));
  }
  const ids = Object.keys(raw);
  if (ids.every(id => id.includes(':'))) return raw;
  return Object.fromEntries(Object.entries(raw).map(([accountId, shows]) => [documentId(accountId, legacyServerId), shows]));
}

// Old data belongs to the configured server, not whichever tenant makes the
// first request. Startup binds it explicitly before any route can read it.
export function bindLegacyServer(serverId, store) {
  if (typeof serverId !== 'string' || !serverId) throw new Error('Configured server required for progress migration');
  finished = store.collection('local-finished', { migrate: raw => toDocuments(raw, serverId) });
}

function collection() {
  if (!finished) throw new Error('Legacy progress must be bound to its configured server first');
  return finished;
}

// Use each server’s configured played threshold, with a 90% fallback.
const finishedThresholds = new Map();
export function setFinishedThreshold(fraction, serverId = 'default') {
  finishedThresholds.set(serverId, fraction);
}

// The fraction of an item that counts as watched on this server.
export const finishedThreshold = (serverId = 'default') => finishedThresholds.get(serverId) ?? 0.9;

// Check whether playback reached the server’s completion threshold.
export function isFinished(viewOffset, durationMs, serverId = 'default') {
  return durationMs > 0 && viewOffset / durationMs >= finishedThreshold(serverId);
}

// Record the latest completed episode per show for next-up reconstruction.
export async function recordFinishedEpisode(accountId, { grandparentKey, parentKey, ratingKey, grandparentTitle, librarySectionId }, serverId = 'default') {
  if (!grandparentKey || !parentKey) return;
  await collection().update(documentId(accountId, serverId), shows => ({
    ...shows,
    [grandparentKey]: { parentKey, ratingKey, grandparentTitle, librarySectionId, updatedAt: Date.now() },
  }));
}

// Only clear a completion if it still refers to this episode.
export async function clearFinishedEpisodeIfCurrent(accountId, grandparentKey, ratingKey, serverId = 'default') {
  if (!grandparentKey) return;
  await collection().update(documentId(accountId, serverId), shows => {
    if (shows?.[grandparentKey]?.ratingKey !== ratingKey) return undefined;
    const { [grandparentKey]: _removed, ...rest } = shows;
    return Object.keys(rest).length ? rest : null;
  });
}

export async function finishedEpisodesForAccount(accountId, serverId = 'default') {
  return (await collection().get(documentId(accountId, serverId))) ?? {};
}
