# FreeStuffCrazy Player

A self-hosted Plex browser player with a touch-friendly library browser,
Plex Home profiles, and per-device playback preferences.

The player offers Standard playback using HTML video/HLS and Canvas playback
using WebCodecs and an AudioWorklet. Canvas is the default on desktop browsers and
the Tesla; phones and tablets default to Standard. Users can switch in playback
settings, saved per browser. Tesla browsers retain their dedicated
fullscreen navigation workaround; other browsers use page/native fullscreen.
Tesla support is experimental and depends on browser/vehicle software.

Playback settings also have a quality choice, saved per browser: Auto, Ultra, High,
Medium or Low. Auto measures the connection when playback starts, picks High or
below, and steps down if playback struggles. Ultra requests up to 1080p/60 fps for
newer hardware and a fast connection; it is only used when chosen. High is up to
720p/30 fps. The settings dialog shows what is playing and lets you set a tier by hand
if Auto gets it wrong. Plugin-provided live streams outside the selected quality are
converted on the server, which requires FFmpeg CPU capacity.

When a TV episode counts as watched, a Play Next button appears over the video, and
the next episode starts by itself when the current one ends.

Problems and workarounds, including Tesla sound and steering wheel notes, are in
[FAQ.md](FAQ.md).

## Requirements

- Node.js 24 and npm, or Docker Compose with an HTTPS reverse proxy.
- A reachable Plex Media Server, its owner's Plex token for server discovery,
  and a Plex account with access to that server for browser sign-in.
- Server-side Plex transcoding support for media the browser cannot play.

No media, provider accounts, credentials or playlists are included. Use media
and services you are authorized to access. Plex subscription requirements depend
on the Plex features you use. The app is not affiliated with Tesla or Plex.

## Local setup

```sh
git clone https://github.com/<you>/player.git
cd player
npm ci
cp .env.example .env
chmod 600 .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Edit `.env`: set `SESSION_SECRET` to the generated random value, then set up
Plex, Jellyfin, or both. For Plex, set `PLEX_EMAIL` to the email of the Plex
account that will sign in (its Home profiles can too), plus `PLEX_URL` and
`PLEX_TOKEN`. For Jellyfin, set `JELLYFIN_URL` to the server's address, such as
`http://192.168.1.50:8096`. If neither is set or one is malformed, the login page
says which setting to fix. Do not paste credentials into issues or commit `.env`.
`ITEM_KEY` is optional; normal browsing selects the item to play. See Plex's official
[token instructions](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/); that page distinguishes temporary inspection tokens from its linked app-authentication flow.

```sh
npm test
npm start
```

Open `http://localhost:3000` and sign in with Plex or Jellyfin, whichever you configured.

## Production and Tesla access

Use HTTPS for remote devices. Set `NODE_ENV=production`, `APP_ORIGIN` to your
HTTPS origin, and `TRUST_PROXY` to the actual reverse proxy IP/CIDR. Production
rejects plain HTTP and uses Secure session cookies. Docker Compose publishes
the application only on host loopback and persists private state in a volume.

Read [DEPLOYMENT.md](DEPLOYMENT.md) before running `docker compose up --build -d`.
The repository does not provision certificates or a reverse proxy. On a Tesla,
open your HTTPS origin while parked. Canvas requires a secure context,
cross-origin isolation and supported WebCodecs/audio APIs; unsupported devices
should use Standard playback. Per-device preferences live in browser storage.

## Plugins

This core app has no built-in plugins — it just loads whatever plugin files
it's pointed at. Set `FREESTUFFCRAZY_PLUGINS_DIR` to a directory of `*-plugin.js`
files, or `FREESTUFFCRAZY_PLUGIN_MODULES` (comma-separated module paths) to load
specific ones. A missing directory, or a plugin that throws on import, just
means running without it; a configured plugin that fails to load stops
startup, since plugins execute trusted server-side code.

A plugin's default export is an object with any subset of these hooks:

```js
export default {
  registerRoutes(app, context) { /* add Express routes */ },
  publicPaths: ['/my-page'], // exact paths of the plugin's own routes that work signed out
  getFrontendAssets() { return { scripts: ['/my-tab.js'] }; },
  resolveServer(userToken) { /* override which Plex server a login lands on */ },
  getAccountKey(session) { /* group a person across devices/sessions */ },
  getStartQualityCap(req) { /* 'low' to start this client at the lowest quality, else null */ },
  getQuotaStatus(accountKey) { /* { remainingSeconds, resetAt, breakdown?: [{ label, seconds }] } | null */ },
  recordUsage(accountKey, secondsElapsed) { /* usage accounting */ },
  getStreamLimit(accountKey) { /* max concurrent streams, or null for unlimited */ },
  createStore({ dataDir }) { /* storage backend; default is JSON files in dataDir */ },
};
```

`registerRoutes`/`getFrontendAssets` are additive (every plugin's runs).
`resolveServer`/`getAccountKey`/`getQuotaStatus`/`recordUsage`/
`getStreamLimit`/`getStartQualityCap`/`createStore` each return a single value, so only the first plugin
defining a given one is used. Streams per account are unlimited unless a
plugin's `getStreamLimit` returns a positive integer; like quotas, this needs
a plugin that defines `getAccountKey`. Each login still plays
one stream at a time; starting another on the same login replaces it. `context` passed to `registerRoutes`
exposes core's own session/token/playback-proxy helpers so a plugin's
routes don't need to reimplement them. Core and plugins save state through
`context.store.collection(name)` (async `get`, `entries`, `set`, `delete`
and atomic `update`; see `storage.js`) rather than their own files. The
built-in backend keeps each collection in a JSON file; a plugin defining
`createStore` can supply another, such as a database, without other changes. To add a browse tab, a frontend
script imports `registerTab` from `/tab-registry.js` and calls it with an
id, label, and `onOpen`/`onClose` callbacks.

## Configuration and data

Before starting playback in Auto, the player samples the connection to the app
server for up to 1.5 seconds (at most 1 MiB) and picks a starting quality between
High and Low. It can still step down during playback if the connection or device
struggles.

`config.example.json` documents authentication and Plex session limits.
`plex.videoBitrate` (kbit/s) is the ceiling for Plex High, which never goes above
2000, and the floor for Plex Ultra, which never goes below 6000; Medium and Low are
fractions of High.
`config.json` contains the active settings. Keep profile/account ID mappings
local to your deployment rather than publishing them. Private files are stored
under `DATA_DIR` (the project directory by default, `/app/data` in Docker).
Sessions contain Plex tokens and must be protected like `.env`.

## Development and validation

```sh
npm run dev
npm test
npm run vendor:verify
npm run check:release
```

Tests use fake upstream responses; passing tests do not certify real vehicle,
browser, provider or Plex-version compatibility. Docker execution and live
browser testing still need separate verification. `npm run release:source`
creates an allowlisted source archive without credentials, runtime state or
Git history.

## Name and attribution

FreeStuffCrazy Player is a [FreeStuffCrazy](https://freestuffcrazy.com) project.
The sign-in page says so ("A FreeStuffCrazy project", linked to
<https://freestuffcrazy.com>).

The license lets you use and change this code freely, and it requires only that
you keep the copyright and license notices. In addition, we ask that:

- an app built from this code says *Based on work by FreeStuffCrazy* somewhere
  users can see it (an About page or footer), with "FreeStuffCrazy" linked to
  <https://freestuffcrazy.com> (the main site, not the player); and
- a modified version does not use the name "FreeStuffCrazy" or its logo as its own
  name or brand, and does not suggest that we make or endorse it.

The first is a request, not a license term. The name and logo are not licensed
for reuse; see the trademark note in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## License

Original code: [MIT](LICENSE). Adapted drive-in code retains its MIT notice;
Mediabunny retains MPL-2.0; other dependencies retain their own licenses.
See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for source links and notices.
