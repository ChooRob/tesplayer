# Frequently asked questions

Tesla browser and audio behavior may change with vehicle software updates. These are observed workarounds, not guarantees.

## Can a passenger watch while the Tesla is moving?

Yes, using **Canvas** playback over HTTPS. Canvas is the default in a Tesla. If video plays only while parked, open playback settings and check **Playback type** is **Canvas**. Standard playback works only while parked. The driver should not watch while driving.

## Video is slow or keeps buffering in a Tesla

A Tesla's cellular connection can be slow at times. It seems to get lower priority on the cellular network than a phone does, and video needs more from the connection than most things the car does, so it shows up here first.

What helps:

- **Tether to your phone.** Connect the car to your phone's hotspot (or to a Wi-Fi network, such as your home Wi-Fi while parked) instead of relying on the car's own cellular connection. Tethering to a phone has worked better for us.
- **Choose a lower quality.** In playback settings, **Quality** is Auto by default. Auto checks the connection when playback starts and steps down if playback struggles. If it keeps stalling, set **Medium** or **Low** yourself. The settings show what is playing now.
- **Give it a moment after a drop.** If the connection is lost, the player shows "No connection. Waiting to reconnect…" and carries on from where you were once it is back.
- **Check what is on the other end.** A Jellyfin server linked through the connector plugin is limited to about 2 Mbps, and a Plex server reached through Plex's own relay is limited by Plex. See the [README](README.md#try-the-hosted-player-before-you-self-host).

These are observations, not guarantees, and how well the car connects depends on where you are and your carrier.

## Do I need to host the player or expose my media server?

You can use the [hosted player](README.md#try-the-hosted-player-before-you-self-host) without running the player yourself. It still needs a way to reach your media server: Plex Remote Access, a public HTTPS Jellyfin address, or the Jellyfin connector plugin. The README explains each option and the hosted watch-time allowance.

## The video plays in a Tesla, but there is no sound

Open the car's **Camera** app, then return to the browser. This has restored sound when the player appeared to be running normally. If it persists, try reopening the browser. You can also try the **Restart sound** in playback settings.

Check the **Volume** slider in the Adjustments panel (the tune button). Boosting above 100% can distort quiet videos. If the issue repeats, include what the car was doing just before it happened when reporting it.

## Why don't the steering wheel Next and Previous buttons work?

Tesla keeps those buttons unavailable to web pages. Use the player's 30-second back and forward controls. The wheel's play/pause button works; a press while paused resumes playback.

## The Fullscreen button does nothing in my Tesla

In a Tesla, the player enters fullscreen by briefly opening a YouTube redirect page that sends you straight back to the same spot in the video. It does this when the car's browser says it is a Tesla, and also when it looks like one and refuses ordinary fullscreen. Because it passes through youtube.com, YouTube sees the player's address for that moment.

If it still does nothing, open the player once with `?tesla=1` added to the address, for example `https://player.freestuffcrazy.com/browse?tesla=1`. The player remembers it. Use `?tesla=0` to turn it off again.
