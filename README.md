<h1 align="center"><img src="assets/readme-banner.svg" alt="FreeStuffCrazy Player" width="560"></h1>

Watch your Plex or Jellyfin library in a Tesla browser. A passenger can use it while the car is moving! Tesla support depends on the car's browser version, and its cellular connection can be slow. See the [FAQ](FAQ.md) for known issues.

The FreeStuffCrazy Player is open source and can be self hosted.

## Try the hosted player before you self host

Open **<https://player.freestuffcrazy.com>**, choose Plex or Jellyfin, and sign in. Nothing is installed in the car, and your media stays on your server. Each account gets **60 minutes of watch time a week**, resetting Monday at 00:00 UTC. That time comes from extra server capacity at [FreeStuffCrazy.com](https://freestuffcrazy.com) and is subject to change without notice. A Tesla's cellular connection can be slow; tethering to your phone has worked better for us ([FAQ](FAQ.md#video-is-slow-or-keeps-buffering-in-a-tesla)).

- **Plex:** Sign in with the code or QR code. The account can own the server, have it shared, or be a Home profile. Turn on **Remote Access** in Plex so the hosted player can reach it; Plex's relay limits video quality.
- **Jellyfin with a public HTTPS address:** Enter it (such as `https://jellyfin.example.com`), then sign in with Quick Connect or your username and password. Plain HTTP and private addresses are refused.
- **Jellyfin without a public address:** Install the [FreeStuffCrazy Player Connector](https://github.com/FreeStuffCrazy/jellyfin-plugin-freestuffcrazy), restart Jellyfin, and link it from the plugin's page in the dashboard. Enter the server name shown there into the hosted player. No port forwarding is needed; streams are limited to about 2 Mbps.

## Run your own player

You need Docker with Compose, a Plex or Jellyfin server the machine can reach, and an HTTPS address. The included setup runs the player with Caddy, which provides HTTPS.

1. Copy `.env.example` to `.env` and `config.example.json` to `config.json`.
2. Edit `.env`: set `APP_ORIGIN` to your HTTPS address, replace `SESSION_SECRET=changeme` with a random secret, and add a media server: `PLEX_EMAIL` (the owner's email; the first sign-in links the server) or `JELLYFIN_URL`. See [.env.example](.env.example) for optional settings.
3. Follow the [deployment guide](DEPLOYMENT.md) to choose a domain or IP address, then start:

   ```sh
   chmod 600 .env
   docker compose up --build -d
   ```

4. Open `APP_ORIGIN` and sign in. If it won't start, run `docker compose logs -f caddy freestuffcrazy-player`.

A domain is easiest. A public IP can use a browser-trusted certificate ([setup](DEPLOYMENT.md#public-ip-address)). A private LAN IP uses a local CA that Tesla browsers cannot trust. Keep `.env` private and never commit it.

## Playback help

In a Tesla, Canvas playback is the default. It needs HTTPS and is what lets a passenger watch while the car moves. Quality can be Auto, Ultra, High, Medium, or Low; if video keeps buffering in a Tesla, pick a lower one and see the [FAQ](FAQ.md#video-is-slow-or-keeps-buffering-in-a-tesla).

The [FAQ](FAQ.md) also covers sound and steering wheel issues.

## For developers

Use Node.js 24: run `npm ci`, configure `.env`, run `npm start`, and open `http://localhost:3000`. Run `npm test` to check changes. See [plugin development](PLUGIN_DEVELOPMENT.md) and [contributing](CONTRIBUTING.md).

## License and attribution

Original code is [MIT](LICENSE); adapted drive-in code and Mediabunny keep their own licenses (see [third-party notices](THIRD-PARTY-NOTICES.md)).

FreeStuffCrazy Player is a [FreeStuffCrazy](https://freestuffcrazy.com) project. If you publish a modified version, please credit FreeStuffCrazy and link to its site; this is a request, not a license term. The FreeStuffCrazy name and logo are not licensed for use as your own brand.
