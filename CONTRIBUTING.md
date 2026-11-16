# Contributing

Use Node.js 24, run `npm ci`, then `npm test`, `npm run vendor:verify` and
`npm run check:release` before proposing a change. Keep tests independent of real
Plex accounts. Include the browser/device and playback engine when reporting
playback issues; redact URLs and account information.

Preserve Tesla-specific fullscreen behavior, support Standard playback on
ordinary browsers, and keep playback preferences per device rather than account.
Do not put provider-specific defaults or credentials into source or fixtures.

Original contributions use the repository's MIT license. Preserve upstream
notices and the existing license of third-party files; do not relabel the
Mediabunny bundle as MIT. Dependency updates should include the exact version,
source, checksum/license review and relevant playback checks.

For a Mediabunny update, review the upstream release and source tag, download the
exact npm package without running package scripts, replace the bundle, update
`vendor.json` and notices, and verify against the registry. Keep modifications to
MPL-covered source available as required by its license. Avoid editing the
generated bundle without corresponding source changes.
