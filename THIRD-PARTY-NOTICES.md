# Third-party notices

FreeStuffCrazy Player's original code is MIT-licensed; third-party components retain their
own licenses. These notices must accompany source and binary distributions.

## drive-in

Copyright (c) 2025 1MoreBuild. MIT License: [full notice](licenses/drive-in-MIT.txt).

`public/engine/player.js`, `plex-session.js` and `plex-library.js` identify
adaptations of drive-in's playback engine, session handling and library helpers.
FreeStuffCrazy Player modifies these for its own UI, buffering, authentication and profile
handling. Existing source attribution is retained.

Original project URL: <https://github.com/1MoreBuild/drive-in>.
Current canonical repository: <https://github.com/HaitianLiu5/drive-in>.
License verified from that repository on 2026-11-06. The exact original
adaptation revision was not recorded; this is not a claim of a byte-for-byte port.

## Mediabunny 1.65.0

Copyright (c) 2026-present, Vanilagy and contributors. MPL-2.0:
[full license](licenses/MPL-2.0.txt).

The browser bundle is `public/vendor/mediabunny.mjs`. Its version and SHA-256 are
recorded in `vendor.json`. Corresponding upstream source is available under
MPL-2.0 at immutable commit
[`cd6612380c7e3f1261d74b9b550e6fc3b65a53bc`](https://github.com/Vanilagy/mediabunny/tree/cd6612380c7e3f1261d74b9b550e6fc3b65a53bc)
(tag `v1.65.0`). No runtime-code changes to the bundle are introduced by this
release preparation. The original bundled copyright/license header is retained.

Run `npm run vendor:verify` to detect local bundle changes. Run
`npm run vendor:verify:upstream` with npm registry access to compare the bundle
against the exact published package. Registry comparison was unavailable in the
preparation environment. See `scripts/verify-vendor.mjs` for the verification path.
If modifying MPL-covered files, make the corresponding modified source available
under MPL-2.0; the application MIT license does not replace those rights.

## npm dependencies

| Component | Locked version | License and notice |
|---|---|---|
| hls.js | 1.7.4 | [Apache-2.0 text](licenses/Apache-2.0.txt); [upstream notice](licenses/hls.js-LICENSE.txt) |
| Express | 4.22.3 | MIT; [notice](licenses/express-LICENSE.txt) |
| dotenv | 16.6.1 | BSD-2-Clause; [notice](licenses/dotenv-LICENSE.txt) |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | 2.0.4 | MIT; [notice](licenses/qrcode-generator-MIT.txt) |
| [SimpleWebAuthn](https://github.com/MasterKale/SimpleWebAuthn) | Browser 13.3.0, server 13.3.3 | MIT; [notice](licenses/simplewebauthn-MIT.txt) |

`package-lock.json` records exact transitive versions and integrity values.
Their license files are installed with the packages by `npm ci`; preserve them
when distributing node_modules or a container. Recheck this table when updating
dependencies. Do not treat `npm audit` as a license audit.

## Icons

The icon shapes in `public/icons.js` (play, pause, replay, forward, check,
settings, arrows, chevrons, fullscreen, volume and lock) are adapted from
[Material Design icons](https://github.com/google/material-design-icons),
Copyright Google LLC, licensed under the
[Apache License 2.0](licenses/Apache-2.0.txt). They are combined into one module
and some carry a number label; the shapes are otherwise unchanged. The status
dot is a plain circle and is not from that set.

## FFmpeg and container software

FFmpeg/ffprobe are external executables; the Docker image installs Debian's
packaged build. Its license obligations depend on enabled components, including
GPL components when present. Debian package copyright/source information is
retained in `/usr/share/doc` inside the image. Before redistributing a built
image, satisfy the source-distribution requirements of the exact Debian/FFmpeg
build and other OS packages you ship. This repository does not publish a
prebuilt image or relicense those components.

The names "FreeStuffCrazy" and "FreeStuffCrazy Player" and the FreeStuffCrazy logo are
not licensed under the MIT license; forks should use their own name and logo.
Tesla, Plex, Jellyfin, YouTube and other product names are trademarks of their respective
owners. FreeStuffCrazy Player is an independent project and is not endorsed by them.
