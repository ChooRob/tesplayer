// One place for plugins (admin pages, limits) to find and name accounts,
// whatever backend they belong to. An account is identified by the same
// opaque key quota and stream-limit plugins already receive (plex:123, or
// jellyfin:<server> for a Jellyfin server). Each source answers for its own keys:
//
//   source.accounts.search(query) -> [{ key, label, detail? }]
//   source.accounts.describe(key) -> { key, label, detail? } | null  (null: not this source's key)
//   source.accounts.list()        -> every account the source knows (for public IDs)
//
// With publicIds (see account-ids.js), search also takes the public ID a viewer
// was shown. A match is flagged exact: true, since it names one account.

const MAX_RESULTS = 20;

export function createAccountDirectory(sources, { publicIds } = {}) {
  const withAccounts = () => [...sources.values()].filter(source => source.accounts);
  const tag = (source, account) => ({ ...account, source: source.name });

  return {
    // Accounts matching a name, email or ID, across every source.
    async search(query) {
      const value = typeof query === 'string' ? query.trim() : '';
      if (!value || value.length > 254) return [];
      const code = publicIds?.parse(value);
      if (code) {
        const known = await Promise.all(withAccounts().map(async source => {
          try { return (await source.accounts.list?.() ?? []).map(account => tag(source, account)); } catch { return []; }
        }));
        const found = known.flat().filter(account => publicIds.publicId(account.key) === code);
        if (found.length) return found.slice(0, MAX_RESULTS).map(account => ({ ...account, exact: true }));
      }
      const results = await Promise.all(withAccounts().map(async source => {
        try { return (await source.accounts.search(value)).map(account => tag(source, account)); }
        catch { return []; }
      }));
      return results.flat().slice(0, MAX_RESULTS);
    },

    // The account for a key, or null when no source recognizes it.
    async describe(key) {
      if (typeof key !== 'string' || !key || key.length > 256) return null;
      for (const source of withAccounts()) {
        // A backend that can't be reached right now just doesn't recognize the key.
        const account = await source.accounts.describe(key).catch(() => null);
        if (account) return tag(source, account);
      }
      return null;
    },
  };
}
