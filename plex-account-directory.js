import { createHmac } from 'node:crypto';

// Plex accounts that have signed in, so admin pages can find them by name:
// Plex account ID -> { username, emailDigest } in core storage. Emails are
// kept only as keyed digests, so an exact email can be matched but not read.
// Reads go to the collection each time, so every reader is current.
export function createPlexAccountDirectory({ collection, secret }) {
  const emailKey = email => createHmac('sha256', secret)
    .update('plex-account-search\0' + email).digest('hex');

  return {
    async remember({ id, username, confirmedEmail }) {
      const emailDigest = confirmedEmail ? emailKey(confirmedEmail) : null;
      await collection.update(String(id), previous => (
        previous && previous.username === username && previous.emailDigest === emailDigest ? undefined : { username, emailDigest }));
    },
    async get(id) {
      const entry = await collection.get(String(id));
      return entry ? { id: String(id), username: entry.username } : null;
    },
    async list() {
      return (await collection.entries()).map(([id, entry]) => ({ id, username: entry.username }));
    },
    async search(query) {
      const value = query.trim().toLowerCase();
      if (!value) return [];
      const digest = value.includes('@') ? emailKey(value) : null;
      return (await collection.entries())
        .filter(([id, entry]) => digest
          ? entry.emailDigest === digest
          : id === value || entry.username.toLowerCase().includes(value))
        .sort(([leftId, left], [rightId, right]) => Number(rightId === value) - Number(leftId === value)
          || left.username.localeCompare(right.username) || leftId.localeCompare(rightId))
        .slice(0, 20)
        .map(([id, { username }]) => ({ id, username }));
    },
  };
}
