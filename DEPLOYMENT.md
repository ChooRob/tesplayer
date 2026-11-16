# Run with Docker Compose

This guide is for running your own copy. To use the hosted player instead, see [Try the hosted player](README.md#try-the-hosted-player-before-you-self-host).

```text
Your browser ──HTTPS──► Caddy :443 ──private Docker network──► Player :3000
```

Compose starts the player and Caddy. Only Caddy opens host ports; it obtains and renews certificates. [Caddy's HTTPS guide](https://caddyserver.com/docs/automatic-https) explains its certificate behavior.

## Set up

1. Install Docker with the Compose plugin. Make sure this machine can reach your Plex or Jellyfin server.
2. Copy the sample settings:

   ```sh
   cp .env.example .env
   cp config.example.json config.json
   ```

3. Edit `.env`. Set `APP_ORIGIN` to the HTTPS address viewers will open. Replace `SESSION_SECRET=changeme` with a random value; `openssl rand -hex 32` can generate one. For Plex, set the owner's `PLEX_EMAIL`. For Jellyfin, set `JELLYFIN_URL`. If the Plex account owns multiple servers, set `PLEX_URL` to the one you want.
4. Follow the address-specific steps below, then start the containers:

   ```sh
   chmod 600 .env
   docker compose up --build -d
   ```

5. Open `APP_ORIGIN` in a browser. For startup errors, run `docker compose logs -f caddy freestuffcrazy-player`.

### Domain name (recommended)

Set `APP_ORIGIN=https://player.example.com`. Point its DNS record to this machine and allow inbound TCP 80 and 443. The included `Caddyfile` obtains a browser-trusted certificate and redirects HTTP to HTTPS. UDP 443 is optional for HTTP/3.

### Public IP address

[Let's Encrypt issues publicly trusted IP certificates](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability), but Caddy's default IP certificate comes from its own CA and is not trusted by other devices. To use a public IP without a domain:

1. Set `APP_ORIGIN=https://YOUR_PUBLIC_IP` in `.env`. The IP must reach this machine on TCP 80 or 443; forward those ports through your router if needed.
2. Run `cp Caddyfile.public-ip Caddyfile` before `docker compose up --build -d`.
3. Keep the `caddy-data` volume. IP certificates last about six days; Caddy must be able to renew them automatically.

The public-IP Caddyfile explicitly selects Let's Encrypt's `shortlived` ACME profile. Use a stable public IP; if it changes, update `APP_ORIGIN` and restart. [Caddy's ACME profile documentation](https://caddyserver.com/docs/caddyfile/directives/tls#acme) describes this setting.

### Private LAN IP address

**This will not work in a Tesla.** Its browser cannot trust Caddy's local CA. Use a domain, a public IP certificate, or the [hosted player](README.md#try-the-hosted-player-before-you-self-host) for the car.

Set `APP_ORIGIN=https://192.168.1.10` (replace the address with your own) and keep the default `Caddyfile`. After Caddy starts, copy its CA certificate with `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt`. Install it as a trusted root on each viewing device; devices where you cannot do that will reject the site.

## Keep it running

- Update with `docker compose pull caddy` and `docker compose up --build -d`.
- Back up the `freestuffcrazy-player-data` and `caddy-data` volumes, plus `.env` and `config.json`. The player volume may hold the Plex token saved at first sign-in, so protect it like `.env`. Losing `SESSION_SECRET` signs everyone out.
- Logs stay small in production. The server's output has startup, setup problems and failures, not every playback report. `access.log` in the data volume records page loads, sign-in and other deliberate actions, and errors, with each client's IP address; it rotates at about 5 MB to `access.1.log`. `canvas-health.log` keeps buffering and error reports, up to 1 MB.
- The private Docker subnet is `172.30.241.0/24`, with Caddy at `172.30.241.2`. If it conflicts with your network, change the subnet, both service addresses, and `TRUST_PROXY` together in `docker-compose.yml`.
