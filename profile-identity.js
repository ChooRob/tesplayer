// profile must come from Plex's Home list, looked up using the signed session's
// immutable profile ID. Session/client-provided names must never be passed here.
export function resolveAccountId(profile, accounts, mappings = {}) {
  if (!profile) return null;
  const configured = Object.hasOwn(mappings, profile.id) ? mappings[profile.id] : null;
  if (configured != null) return accounts.find(account => account.id === String(configured))?.id || null;
  const exact = accounts.find(account => account.id === profile.id);
  if (exact) return exact.id;
  // Display names can be changed by an account owner and are not unique across
  // households. Never let a matching name select history using the admin token.
  return null;
}

export async function authorizedNextUp(items, library, existingKeys) {
  const permitted = await Promise.all(items.map(async item => {
    try { return { ...await library.itemDetails(item.ratingKey), viewOffset: 0 }; }
    catch { return null; }
  }));
  return permitted.filter(item => item && !existingKeys.has(item.ratingKey));
}
