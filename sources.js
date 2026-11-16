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
//                                     itemDetails, search, continueWatching
//   sendThumbnail(req, res)
//   watchState                     -- reportProgress, markWatched, markUnwatched
//   playback                       -- start, proxy, stop, directCapable, mediaOrigin
//   accounts                       -- search(query), describe(key) for admin
//                                     pages; see accounts.js
//
// Plugins can add backend types by exporting `sources: { <type>: factory }`.

import { createPlexSource } from './plex-source.js';
import { createJellyfinSource, parseJellyfinUrl, tenantServersOf } from './jellyfin-source.js';
import { plexEmail } from './admin-auth.js';
import { firstPluginWith } from './plugins.js';

const BUILT_IN = { plex: createPlexSource, jellyfin: createJellyfinSource };

export const NOTHING_CONFIGURED = 'No media server is set up. In the server\'s .env, set PLEX_EMAIL (the Plex account that signs in) and PLEX_TOKEN for Plex, or JELLYFIN_URL for Jellyfin, then restart.';
export const PLEX_EMAIL_FORMAT = 'PLEX_EMAIL must be the email address of the Plex account that signs in, such as you@example.com.';
export const PLEX_TOKEN_MISSING = 'PLEX_EMAIL is set, but PLEX_TOKEN isn\'t. FreeStuffCrazy Player needs PLEX_TOKEN to reach your Plex server.';

// The built-in sources this install is set up for, and what is wrong with the
// setup. A single-tenant install names its Plex account with PLEX_EMAIL (plus
// PLEX_TOKEN to reach the server) and its Jellyfin server with JELLYFIN_URL;
// with a plugin that chooses servers, PLEX_TOKEN alone (or that plugin, for
// Jellyfin) is enough. Problems name the setting at fault, never its value,
// and don't stop the server: the login page shows them. Warnings are only
// logged. The first source listed is the default.
export function checkSourceConfig(env = process.env, plugins = []) {
  const configured = [];
  const problems = [];
  const warnings = [];
  const pluginChoosesPlexServer = !!firstPluginWith(plugins, 'resolveServer');
  if (env.PLEX_EMAIL?.trim()) {
    if (!plexEmail(env)) problems.push(PLEX_EMAIL_FORMAT);
    else if (!env.PLEX_TOKEN) problems.push(PLEX_TOKEN_MISSING);
    else configured.push({ id: 'plex', type: 'plex' });
  } else if (env.PLEX_TOKEN) {
    if (pluginChoosesPlexServer) configured.push({ id: 'plex', type: 'plex' });
    else warnings.push('PLEX_TOKEN is set without PLEX_EMAIL, so Plex sign-in is off. Set PLEX_EMAIL to the Plex account that signs in.');
  }
  if (env.JELLYFIN_URL) {
    try {
      parseJellyfinUrl(env.JELLYFIN_URL);
      configured.push({ id: 'jellyfin', type: 'jellyfin' });
    } catch (error) { problems.push(error.message); }
  } else if (tenantServersOf(plugins)) configured.push({ id: 'jellyfin', type: 'jellyfin' });
  if (!configured.length && !problems.length) problems.push(NOTHING_CONFIGURED);
  return { configured, problems, warnings };
}

export const configuredSources = (env = process.env, plugins = []) => checkSourceConfig(env, plugins).configured;

// An empty result is allowed: the server then only serves the login page,
// which shows the setup problems.
export async function createSources({ plugins = [], configured = configuredSources(process.env, plugins), context }) {
  const factories = { ...BUILT_IN };
  for (const plugin of plugins) {
    for (const [type, factory] of Object.entries(plugin.sources || {})) {
      if (typeof factory !== 'function') throw new Error(`Invalid source factory for ${type}`);
      if (Object.hasOwn(factories, type)) throw new Error(`Duplicate source type ${type}`);
      factories[type] = factory;
    }
  }
  const sources = new Map();
  for (const { id, type, ...options } of configured) {
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(id) || sources.has(id)) throw new Error(`Invalid source id ${id}`);
    if (!Object.hasOwn(factories, type)) throw new Error(`Unknown source type ${type}`);
    sources.set(id, await factories[type]({ id, ...context, options }));
  }
  return sources;
}
