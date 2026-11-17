// Where the browse page is, kept in its address so a reload (or coming back from
// the player or a movie's page) lands on the same screen:
//   tab    the library or plugin tab
//   show   a show whose seasons are listed
//   season one season of that show, whose episodes are listed
// Item IDs are Plex ratingKeys or Jellyfin IDs, so letters, digits and dashes.

const KEY = /^[A-Za-z0-9-]{1,64}$/;

// The tab, show and season in an address, each only if it looks like an ID. A
// season means nothing without its show.
export function readBrowseView(search) {
  const params = new URLSearchParams(search);
  const pick = name => {
    const value = params.get(name);
    return value && KEY.test(value) ? value : null;
  };
  const show = pick('show');
  return { tab: pick('tab'), show, season: show ? pick('season') : null };
}

// Sets (or removes) the three on a URLSearchParams and returns it.
export function writeBrowseView(params, { tab = null, show = null, season = null } = {}) {
  for (const [name, value] of [['tab', tab], ['show', show], ['season', show ? season : null]]) {
    if (value) params.set(name, value);
    else params.delete(name);
  }
  return params;
}

// "/browse" for whatever view an address carries, so Back returns to it.
export function browseUrlFrom(search) {
  const query = writeBrowseView(new URLSearchParams(), readBrowseView(search)).toString();
  return `/browse${query ? `?${query}` : ''}`;
}

// Copies the view an address carries onto another set of parameters (a link to
// the player or a detail page). `keepSeason: false` is for moving on to another
// episode, which may be in a different season.
export function carryBrowseView(from, to, { keepSeason = true } = {}) {
  const view = readBrowseView(from);
  return writeBrowseView(to, { ...view, season: keepSeason ? view.season : null });
}
