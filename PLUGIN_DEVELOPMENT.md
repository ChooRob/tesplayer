# Plugin development

Plugins are trusted server-side code. Set `FREESTUFFCRAZY_PLUGINS_DIR` to a
directory of `*-plugin.js` files, or `FREESTUFFCRAZY_PLUGIN_MODULES` to a
comma-separated list of module paths. A missing directory or a plugin that
fails to import stops startup, so access rules supplied by plugins cannot
silently disappear.

A plugin's default export is an object with any subset of these hooks (`sources` is covered in its own section below):

```js
export default {
  registerRoutes(app, context) { /* add Express routes */ },
  publicPaths: ['/my-page'], // exact paths of the plugin's own routes that work signed out
  getFrontendAssets() { return { scripts: ['/my-tab.js'] }; },
  resolveServer(userToken, { serverId }) { /* override which Plex server a login lands on; serverId = one the viewer chose */ },
  listServers(userToken) { /* { ok, servers: [{ id, name, owned, sharedBy, online, relayOnly }] }: offered when an account has several */ },
  getAccountKey(session) { /* group a person across devices/sessions */ },
  getStartQualityCap(req) { /* 'low' to start this client at the lowest quality, else null */ },
  getQuotaStatus(accountKey) { /* { remainingSeconds, resetAt, breakdown?: [{ label, seconds }] } | null */ },
  recordUsage(accountKey, secondsElapsed, { kind }) { /* usage accounting; kind is 'music' or 'video' */ },
  getStreamLimit(accountKey) { /* max concurrent streams, or null for unlimited */ },
  sources: { 'my-server': { configure(env) {}, create(args) {} } }, // a new kind of media server; see "Writing a source"
  embyServers: { resolve(address) {}, fetch(url, init) {} }, // let users sign in to their own Emby server; see below
  createStore({ dataDir }) { /* storage backend; default is JSON files in dataDir */ },
};
```

Every plugin's `registerRoutes` and `getFrontendAssets` hooks run. For each
other hook, only the first plugin defining it is used. A `getStreamLimit` or
quota plugin also needs `getAccountKey`; otherwise streams per account are
unlimited. Each login plays one stream at a time.

`registerRoutes` receives `context` with the app's session, token, and proxy
helpers. Use `context.store.collection(name)` for saved state; it provides
async `get`, `entries`, `set`, `delete`, and atomic `update` methods. The
default store uses JSON files; `createStore` can provide another backend.

A plugin can also watch what the player does, read-only, with three helpers on
`context` that cannot change sign-in or playback (a listener that throws is
ignored):

- `context.onSignIn(listener)` is called with `{ sourceType, userKey }` when
  someone signs in, once per sign-in and not on a profile switch. `userKey` is
  opaque, such as `plex:<account ID>` or `jellyfin:<server>:<user>`.
- `context.onUsage(listener)` is called with `(accountKey, seconds, { kind })` each time
  watch time is counted; `kind` is `'music'` for music and `'video'` for everything
  else (movies, shows, live TV). Unlike `recordUsage`, any number of plugins can listen.
- `context.activeStreams()` returns `[{ accountKey }]` for streams playing right
  now. Watch time is only counted when a plugin supplies account keys.

An admin-only page is a tab on the Admin page: `context.admin.registerTab({ id,
label, file, order })` takes the absolute path of a browser module that exports
`mount(container)`. Tabs appear in plugin load order; a lower optional `order` (default 0) moves a tab earlier. Serve its data under `/api/admin/<plugin-id>/`, which core
only answers for the signed-in admin with an unlocked (passkey) session.

To add a browse tab, import `registerTab` from `/tab-registry.js` in a
frontend script and provide an ID, label, and `onOpen`/`onClose` callbacks.

## Writing a source

A source is a media backend: Plex and Jellyfin are two. A plugin can add a third
(Emby, a folder of files, anything that can list items and produce a stream). The
player pages need no changes; they talk to core, and core talks to the source.

```js
// my-server-plugin.js
export default {
  sources: {
    'my-server': {
      // Is this install using it? Return null for no, an options object for yes
      // (`{}` is fine), or throw an Error to show a setup problem on the login
      // page. Name the setting at fault, never its value: the message is public.
      configure(env, { plugins }) { // plugins: every loaded plugin, if yours depends on a hook of theirs
        if (!env.MY_SERVER_URL) return null;
        if (!/^https?:\/\//.test(env.MY_SERVER_URL)) throw new Error('MY_SERVER_URL must be the server\'s http(s) address.');
        return { url: env.MY_SERVER_URL };
      },
      // Optional: lines to log at startup, for example a setting that is no longer used.
      warnings: env => [],
      // Called once at startup with { id, config, plugins, store, pipeUpstream,
      // signedIn, options }. `id` is the type ('my-server'). `options` is what
      // configure returned. `store` is the same store plugins use.
      async create({ id, store, pipeUpstream, signedIn, options }) { return { /* the shape below */ }; },
    },
  },
};
```

Plex, Jellyfin and Emby are sources in exactly this form. They ship in the source
(`bundled-sources.js` holds their `configure` and `warnings`) and are always loaded,
ahead of any plugin, so what you write here is the same interface they use; their
code (`plex-source.js`, `jellyfin-source.js`, `emby-source.js`) is the reference. Emby is the
smallest and the one with its own sign-in page (`public/emby-sign-in.html`, linked through
`signInOptions.signInPage`), so it is the closest model for a plugin source.

The type is lowercase letters, digits and dashes (up to 32), and cannot be `plex`
or `jellyfin` or another plugin's. A source that is not configured is simply not
created. When it is, core checks the object `create` returns and refuses to start
if anything is missing, naming every problem at once (`sourceProblems` in
`sources.js`). That check looks at presence only; the rest is on you.

### What `create` returns

| Member | What it is |
| --- | --- |
| `id`, `type`, `name` | `id` and `type` as given; `name` is shown to viewers. |
| `isValidId(id)` | True for an item or library ID in your format. Core calls it before every route that takes one, so IDs reaching your code are already checked. Make it strict. |
| `signInOptions` | `{ signInPage: '/my-server/sign-in', signInLabel: 'Sign in to My Server' }`. The login page shows a link to this path on your own site. Required for people to be able to sign in. |
| `registerRoutes(app, { rateLimit, endPlayback })` | Add your routes: the sign-in page, its API, anything else. Core's sign-in checks apply to everything except paths `auth.isPublicPath` returns true for, so make the sign-in routes public there. |
| `auth` | The signed-in session, below. |
| `library(req)` | Returns an object of read methods for this viewer, below. |
| `sendThumbnail(req, res)` | Serves `GET /api/library/thumb`, whose query is whatever your items' `thumbnail` URLs put there. Restrict what it will fetch: it is a proxy. |
| `watchState` | `reportProgress(req, { itemId, timeMs, state, durationMs })`, `markWatched(req, itemId)`, `markUnwatched(req, itemId)`, and optionally `watchedFraction(req)` (default 0.9: how far in counts as watched). |
| `playback` | Streaming, below. |
| `accounts` (optional) | `search(query)`, `describe(key)`, `list()`: how admin pages find accounts. Each returns `{ key, label, detail? }`; `describe` returns null for a key that is not yours. |

**`auth`** keeps one signed-in session per cookie. Required: `loadSession(req, res, next)`
(runs first on every request), `requireAuth(req, res, next)`, `getSessionId(req)`
(a string, or null when this request is not signed in to you; it is how core knows
which source a request belongs to, so it must never claim another source's request),
`getSessionUser(req)` (`{ title, thumb }` or null), `getSessionProfileId(req)`,
`getSessionAccountId(req)`, `getSessionAccountKey(req)`, `clearSession(req, res)`,
`signOutEverywhere(req, res)`. Optional: `isPublicPath(path)`, `getSessionCredential(req)`,
`getSessionServer(req)`, `getAdminIdentity(req)`. Use `session-cookie.js`'s
`createCookieSealer` to keep the credential in a sealed cookie, not on the server;
that is what Plex and Jellyfin do. The account key is what limits and statistics
group a person by, in the form `<type>:<something stable>`.

**`library(req)`** returns these async methods. Items use Plex's field names, which
the pages read:

- `libraries()` → `[{ id, title, type: 'movie' | 'show' }]`
- `libraryItems(libraryId, { sort })` → `{ total, items }`; `recentlyAdded(libraryId)`;
  `search(query)`; `continueWatching()`
- `showSeasons(showId)`, `showEpisodes(showId)`, `seasonEpisodes(seasonId)`
- `itemDetails(itemId)` → one item with `summary`, `genres`, `year`, and for episodes
  `season`, `episode` and `grandparentKey` (the show's ID, or a path ending in it) so
  Play Next can find the next one. The page resumes by seeking within the stream, so the
  playlist always covers the whole item
- An item has `ratingKey` (your ID, as a string), `type` (`movie`, `show`, `season`,
  `episode`), `title`, `thumbnail` (a `/api/library/thumb?...` URL), `durationMs`,
  `viewOffset` (resume point in ms), and for shows `leafCount` and `viewedLeafCount`.
- Optional: `subtitleTracks(itemId)` and `subtitleText(itemId, trackId)`; see
  `subtitles.js` for the track format. Without them there are no captions.
- To fail with something a viewer should read, throw an Error with a `userMessage`
  string. Add `serverGone: true` when the session can no longer work (it is ended and
  the page offers to sign in again).

**`playback`** is the heavy part. The player plays HLS through core's `/proxy/`:

- `start(req, res, { itemId, state, stopState })` handles `GET /api/start`. Set
  `state.active` to an object that includes `{ source: <your id>, sessionId, itemId }`
  plus whatever you need to stop it later, then answer with an HLS playlist
  (`application/vnd.apple.mpegurl`) whose every segment and key URL is rewritten to
  `/proxy/<path>?<query>`. The media server's own address and credentials must never
  reach the browser. Honor `req.query.quality` (`ultra`, `high`, `medium`, `low`; see
  `quality-tiers.js`) and, for captions burned into the picture,
  `req.query.subtitle` (a track ID from `subtitleTracks` whose `kind` is `burn`).
  Throw to fail; core cleans up.
- `proxy(req, res, { ownsSession })` serves `/proxy/*`. Before fetching anything,
  require `ownsSession(sessionId)` to be true for the stream's session ID and that the
  path is one you generated, so one viewer cannot read another's stream or turn the
  proxy into a general fetcher. When your server has not answered in time (a drive
  spinning up, a transcoder starting), answer with a 503 and `Retry-After: 1`: the
  player then asks again for about a minute instead of failing the stream. It asks
  again after a 502, 503 or 504 and after a request that fails outright, never after
  a 4xx; and it reads only the status and the header (the built-in sources also send
  `{ "code": "MEDIA_SERVER_SLOW", "error": "…" }`). A stream that still cannot start
  is reported with a tap-to-retry message. Send the response yourself: a source in a
  plugin cannot count on a path to core's own helper (`media-server-wait.js`).
- `stop(active)` ends the stream upstream, given the object you put in `state.active`.
- `directCapable(req)` and `mediaOrigin(req)` let the browser fetch media straight
  from the server when it can; return `false` and `''` to always go through the proxy.

### Music

A source can offer music with the calls it already has, so the pages need nothing source-specific.
Think of an artist as a show, an album as a season and a track as an episode:

| Screen | Call | Item `type` |
| --- | --- | --- |
| Library list | `libraries()` returns `{ type: 'music' }` | |
| Artists | `libraryItems(libraryId)` | `artist` (`leafCount`: tracks) |
| Albums | `showSeasons(artistId)` | `album`, with `showRatingKey` and `showTitle` naming the artist, `year`, `leafCount` |
| Tracks | `seasonEpisodes(albumId)` | `track`, with `episode` (track number), `season` (disc), `artist`, `album`, `durationMs` |

**Listing a library more than one way.** A library entry may carry `views: [{ id, label }]`
(a music library: `artists`, `albums`, `tracks`), the first being the default. The page shows them as a
switch and calls `libraryItems(libraryId, { sort, view, start, size })`; return that view's items (for
`albums`, `type: 'album'` items that carry `showRatingKey` and `showTitle` so they open under their artist;
for `tracks`, track items) and `{ total }`. `start` and `size` page a long list (the page asks for 500 at
a time and shows the first page at once); a source that cannot page may ignore them and answer with
everything. The page also has a filter box over whatever is on screen, which needs nothing from a source.

`itemDetails` works for all three (a track adds `artist` and `album`), recently added and search may
return albums and artists, and artwork should be square (the pages crop to a square for these types).
A track plays through `playback.start` like a video does, answering with an HLS playlist that has only
an audio track; see `plex-library.js` for the shapes Plex produces.

### Checking your work

- Start the server: a source that does not meet the contract stops startup with a
  list of what is missing. `sourceProblems(source)` is exported from `sources.js` for
  your own tests, as is `LIBRARY_METHODS`; `test/source-plugins.test.js` has a minimal
  source that passes.
- The shipped sources are the reference: `plex-source.js` and `jellyfin-source.js`.
  `emby-source.js` is the closest model for a single server with its own API and password sign-in.
- Plugin code is trusted, so nothing here sandboxes you, but treat everything from
  the browser and from your media server as untrusted when building URLs and paths.

### Letting users bring their own server

A plugin that exports `embyServers` lets people sign in to an Emby server they type, instead of
(or as well as) the one in `EMBY_URL`. `resolve(address)` returns the server URL to use or throws an
`Error` whose message is shown to the user; `fetch(url, init)` makes every request to such a server, so
the plugin alone decides which addresses can be reached (an https-only, public-address-only guard is
the usual choice, since the address comes from a user). Optional: `maxBitrate(url)` (a kbps cap),
`displayAddress(url)` (what to type to sign in again) and `prompt` (`{ hint, label, placeholder }`
for the question). A user's server is keyed by address as well as its ID, and never makes an
admin. Without `EMBY_URL`, the plugin is what turns Emby on. Jellyfin has the same hook, named
`jellyfinServers`.
