// Media sources are the backends the player plays from (Plex today). Each one
// is created by a factory for its type and gives server.js the same shape:
//
//   id, type, name
//   isValidId(id)                  -- item/library IDs in this backend's format
//   auth                           -- the signed-in session: loadSession and
//                                     requireAuth middleware, getSessionId,
//                                     getSessionUser, getSessionProfileId,
//                                     getSessionAccountId, getSessionAccountKey,
//                                     clearSession, signOutEverywhere
//   registerRoutes(app, context)   -- the backend's own sign-in routes
//   library(req)                   -- libraries, libraryItems, recentlyAdded,
//                                     showSeasons, showEpisodes, seasonEpisodes,
//                                     itemDetails, search, continueWatching,
//                                     and optionally subtitleTracks(itemId) and
//                                     subtitleText(itemId, trackId) (see subtitles.js)
//   sendThumbnail(req, res)
//   watchState                     -- reportProgress, markWatched, markUnwatched
//   playback                       -- start, proxy, stop, directCapable, mediaOrigin
//   accounts                       -- search(query), describe(key) for admin
//                                     pages; see accounts.js
//
// A library's type is 'movie', 'show', 'music', or 'video' (plain video files with little or no metadata: home videos,
// music videos, Plex's Other Videos). A video library lists films, and is offered Play and Shuffle over all of them (a movie library, one
// "Play something" button that shuffles them).
//
// Music uses the same calls, so the browse pages need nothing source-specific: a library of
// type 'music' lists items of type 'artist'; showSeasons(artistId) returns the artist's albums
// (type 'album', with showRatingKey and showTitle naming the artist); seasonEpisodes(albumId)
// returns the album's tracks (type 'track', with `episode` the track number, `season` the disc,
// `artist`, `album`, durationMs). Artwork is square. A track is played like any item: playback.start
// answers with an HLS playlist, here audio only. A library may list `views` (artists, albums, tracks) and
// libraryItems takes { sort, view, start, size, genre }; sources that cannot page just answer with everything. A `genres`
// view lists items of type 'genre' ({ ratingKey, title }), and `genre` (one of their ratingKeys) with view 'albums' lists
// only that genre's albums. Optional
// playlists() -> [{ ratingKey, type: 'playlist', title, thumbnail, leafCount }], playlistItems(id) -> tracks (a playlist may
// also hold videos: items of type 'movie' or 'episode', in its order, which the page opens where they are), and
// similarArtists(artistId) -> [{ title, items: [artist items] }], popularTracks(artistId) -> tracks and
// similarTracks(trackId) -> tracks that sound like it (nearest first) list playlists,
// artists like an artist and an artist's most played tracks;
// lyricTracks(trackId) -> [{ id, label, timed }] and lyricText(trackId, id) -> { timed, lines: [{ startMs, text }] }
// (see lyrics.js for the parsers) give a track's lyrics. See "Music" in PLUGIN_DEVELOPMENT.md.
//
// Plugins add backend types by exporting
//   sources: { <type>: { configure(env, { plugins }), warnings?(env), create(args) } }
// Plex, Jellyfin and Emby are exported the same way, by bundled-sources.js, and always loaded.
// `configure(env, { plugins })` says whether this install uses the type: return null when it
// does not, or an options object (possibly empty) when it does, or throw an Error
// whose message names the setting at fault (never its value) to show a setup
// problem on the login page. `create({ id, config, plugins, store, pipeUpstream,
// signedIn, options })` returns the shape above; its `id` is the type. See
// "Writing a source" in PLUGIN_DEVELOPMENT.md.

import { bundledSources, PLEX_EMAIL_FORMAT } from './bundled-sources.js';

export { PLEX_EMAIL_FORMAT };
const SOURCE_TYPE = /^[a-z0-9-]{1,32}$/;

// The source types plugins export (the bundled Plex and Jellyfin first), as
// { type, create, configure, warnings }. A bare
// function is accepted as `create` but is never set up, since nothing says when.
function pluginSourceTypes(plugins) {
  const found = [];
  for (const plugin of [bundledSources, ...plugins]) {
    for (const [type, entry] of Object.entries(plugin.sources || {})) {
      const create = typeof entry === 'function' ? entry : entry?.create;
      const configure = typeof entry === 'function' ? null : entry?.configure;
      const warnings = typeof entry === 'function' ? null : entry?.warnings;
      if (typeof create !== 'function' || (configure != null && typeof configure !== 'function') || (warnings != null && typeof warnings !== 'function')) throw new Error(`Invalid source factory for ${type}`);
      if (!SOURCE_TYPE.test(type)) throw new Error(`Invalid source type ${type}`);
      if (found.some(other => other.type === type)) throw new Error(`Duplicate source type ${type}`);
      found.push({ type, create, configure, warnings });
    }
  }
  return found;
}

export const NOTHING_CONFIGURED = 'No media server is set up. In the server\'s .env, set PLEX_EMAIL (the Plex account that signs in) for Plex, JELLYFIN_URL for Jellyfin, or EMBY_URL for Emby, then restart.';

// The sources this install is set up for, and what is wrong with the setup: each
// source type (the bundled Plex and Jellyfin, then any from plugins) says for
// itself whether it is used. Problems name the setting at fault, never its value,
// and don't stop the server: the login page shows them. Warnings are only
// logged. The first source listed is the default.
export function checkSourceConfig(env = process.env, plugins = []) {
  const configured = [];
  const problems = [];
  const warnings = [];
  for (const { type, configure, warnings: warn } of pluginSourceTypes(plugins)) {
    if (warn) warnings.push(...warn(env));
    if (!configure) continue;
    try {
      const options = configure(env, { plugins });
      if (options) configured.push({ id: type, type, ...(typeof options === 'object' ? options : {}) });
    } catch (error) { problems.push(error?.message || `The ${type} source is not set up correctly.`); }
  }
  if (!configured.length && !problems.length) problems.push(NOTHING_CONFIGURED);
  return { configured, problems, warnings };
}

export const configuredSources = (env = process.env, plugins = []) => checkSourceConfig(env, plugins).configured;

// An empty result is allowed: the server then only serves the login page,
// which shows the setup problems.
export async function createSources({ plugins = [], configured = configuredSources(process.env, plugins), context }) {
  const factories = {};
  for (const { type, create } of pluginSourceTypes(plugins)) factories[type] = create;
  const sources = new Map();
  for (const { id, type, ...options } of configured) {
    if (typeof id !== 'string' || !SOURCE_TYPE.test(id) || sources.has(id)) throw new Error(`Invalid source id ${id}`);
    if (!Object.hasOwn(factories, type)) throw new Error(`Unknown source type ${type}`);
    const source = await factories[type]({ id, ...context, options });
    const problems = sourceProblems(source, { id, type });
    if (problems.length) throw new Error(`The ${type} source does not match the source contract: ${problems.join('; ')}`);
    sources.set(id, source);
  }
  return sources;
}

// What the server needs from a source (the shape at the top of this file). Returns
// every way `source` falls short, so an author sees them all at once. Only the
// presence and kind of each member is checked, not what it does.
const MEMBERS = {
  auth: ['loadSession', 'requireAuth', 'getSessionId', 'getSessionUser', 'getSessionProfileId', 'getSessionAccountId', 'getSessionAccountKey', 'clearSession', 'signOutEverywhere'],
  watchState: ['reportProgress', 'markWatched', 'markUnwatched'],
  playback: ['start', 'proxy', 'stop', 'directCapable', 'mediaOrigin'],
};
export const LIBRARY_METHODS = ['libraries', 'libraryItems', 'recentlyAdded', 'showSeasons', 'showEpisodes', 'seasonEpisodes', 'itemDetails', 'search', 'continueWatching'];

export function sourceProblems(source, { id, type } = {}) {
  const problems = [];
  if (!source || typeof source !== 'object') return ['the factory must return an object'];
  if (id !== undefined && source.id !== id) problems.push(`id must be "${id}"`);
  if (type !== undefined && source.type !== type) problems.push(`type must be "${type}"`);
  if (typeof source.name !== 'string' || !source.name.trim()) problems.push('name must be a non-empty string');
  for (const name of ['isValidId', 'registerRoutes', 'library', 'sendThumbnail']) {
    if (typeof source[name] !== 'function') problems.push(`${name} must be a function`);
  }
  for (const [group, names] of Object.entries(MEMBERS)) {
    if (!source[group] || typeof source[group] !== 'object') { problems.push(`${group} must be an object`); continue; }
    for (const name of names) if (typeof source[group][name] !== 'function') problems.push(`${group}.${name} must be a function`);
  }
  const page = source.signInOptions?.signInPage;
  if ((type ?? source.type) !== 'plex' && (type ?? source.type) !== 'jellyfin' && page === undefined)
    problems.push('signInOptions.signInPage is required for a plugin source');
  else if (page !== undefined && !SIGN_IN_PAGE.test(page))
    problems.push('signInOptions.signInPage must be a path on this site, such as /my-source/sign-in');
  return problems;
}

// A same-site path for a source's own sign-in page; the login page links to it.
export const SIGN_IN_PAGE = /^\/(?!\/)[A-Za-z0-9\-._~\/]{0,200}$/;
