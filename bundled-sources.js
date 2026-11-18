// Plex and Jellyfin, packaged as source plugins. They ship in the source and are
// always loaded, through exactly the interface a plugin from outside uses (see
// "Writing a source" in PLUGIN_DEVELOPMENT.md), so that interface is the only way
// a source is set up.

import { createPlexSource } from './plex-source.js';
import { createJellyfinSource, parseJellyfinUrl, tenantServersOf } from './jellyfin-source.js';
import { plexEmail } from './admin-auth.js';
import { firstPluginWith } from './plugins.js';

export const PLEX_EMAIL_FORMAT = 'PLEX_EMAIL must be the email address of the Plex account that signs in, such as you@example.com.';

export const bundledSources = {
  sources: {
    // A single-tenant install names its Plex account with PLEX_EMAIL (the server is
    // found when that account first signs in); a plugin that chooses servers needs
    // no setting.
    plex: {
      configure(env, { plugins }) {
        if (env.PLEX_EMAIL?.trim()) {
          if (!plexEmail(env)) throw new Error(PLEX_EMAIL_FORMAT);
          return {};
        }
        return firstPluginWith(plugins, 'resolveServer') ? {} : null;
      },
      warnings: env => (env.PLEX_TOKEN ? ['PLEX_TOKEN is no longer used. The player does not keep a Plex token; you can remove it from .env.'] : []),
      create: createPlexSource,
    },
    jellyfin: {
      configure(env, { plugins }) {
        if (env.JELLYFIN_URL) {
          parseJellyfinUrl(env.JELLYFIN_URL); // throws a message naming JELLYFIN_URL, never its value
          return {};
        }
        return tenantServersOf(plugins) ? {} : null;
      },
      create: createJellyfinSource,
    },
  },
};
