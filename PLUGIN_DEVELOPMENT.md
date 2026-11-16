# Plugin development

Plugins are trusted server-side code. Set `FREESTUFFCRAZY_PLUGINS_DIR` to a
directory of `*-plugin.js` files, or `FREESTUFFCRAZY_PLUGIN_MODULES` to a
comma-separated list of module paths. A missing directory or a plugin that
fails to import stops startup, so access rules supplied by plugins cannot
silently disappear.

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
- `context.onUsage(listener)` is called with `(accountKey, seconds)` each time
  watch time is counted. Unlike `recordUsage`, any number of plugins can listen.
- `context.activeStreams()` returns `[{ accountKey }]` for streams playing right
  now. Watch time is only counted when a plugin supplies account keys.

An admin-only page is a tab on the Admin page: `context.admin.registerTab({ id,
label, file })` takes the absolute path of a browser module that exports
`mount(container)`. Serve its data under `/api/admin/<plugin-id>/`, which core
only answers for the signed-in admin with an unlocked (passkey) session.

To add a browse tab, import `registerTab` from `/tab-registry.js` in a
frontend script and provide an ID, label, and `onOpen`/`onClose` callbacks.
