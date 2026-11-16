import { AUTO_QUALITY_LEVELS } from './quality-tiers.js';

// Measure the browser's download path to the same server that relays Plex.
// Leave room for audio, bitrate spikes, and changes in cellular throughput.
const HEADROOM = 1.5;
const AUDIO_KBPS = 256;

export async function measureStartupQuality({
  fetcher = fetch, url = '/api/playback-speed', now = () => performance.now(), timeoutMs = 1500,
} = {}) {
  const controller = new AbortController();
  const started = now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let bitrates;
  let bytes = 0;
  try {
    const response = await fetcher(url, {
      cache: 'no-store', redirect: 'error', signal: controller.signal,
    });
    if (!response.ok) return 'high';
    const values = response.headers.get('X-Playback-Bitrates')?.split(',').map(Number);
    if (values?.length !== AUTO_QUALITY_LEVELS.length || !values.every(rate => Number.isFinite(rate) && rate > 0)
      || !response.body?.getReader) return 'high';
    bitrates = values;
    // The server asked for this client to start at the lowest quality, so there
    // is nothing for a speed sample to improve.
    if (response.headers.get('X-Playback-Start-Cap') === 'low') return 'low';
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  } catch {
    // A slow transfer still gives us a usable sample at the deadline.
    if (!controller.signal.aborted || !bitrates) return 'high';
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }

  const kbps = bytes * 8 / Math.max(1, now() - started);
  return AUTO_QUALITY_LEVELS[bitrates.findIndex(rate => kbps >= (rate + AUDIO_KBPS) * HEADROOM)] || 'low';
}
