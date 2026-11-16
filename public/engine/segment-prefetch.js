// Read ahead of the player by downloading upcoming HLS segments in the
// background. The player itself only asks for a segment when its decoded audio
// (capped at 16 s) runs low, which leaves a slow or high-latency connection idle
// whenever it could be filling up. Compressed segments are cheap to hold, so on
// the lower quality tiers we keep up to a minute of them in memory and hand
// them to the player instantly when it asks.

const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
// Give up on a read-ahead download only when no data has arrived for this
// long. A slow download that is still making progress keeps going, since
// restarting it would throw away what already arrived.
const DEFAULT_STALL_TIMEOUT_MS = 30000;
const RETRY_PAUSE_MS = 2000;

const toUrl = (resource) => new URL(
  typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url,
  globalThis.location?.href,
).href;

function rangeStart(init) {
  const headers = new Headers(init?.headers);
  const range = headers.get('Range');
  if (!range) return 0;
  const match = /^bytes=(\d+)-/.exec(range);
  return match ? Number(match[1]) : -1;
}

// Return each media segment's absolute URL and duration, in playlist order.
export function parseMediaPlaylist(text, baseUrl) {
  const segments = [];
  let duration = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      duration = Number.parseFloat(line.slice(8));
    } else if (line && !line.startsWith('#') && duration !== null) {
      segments.push({ url: new URL(line, baseUrl).href, duration: Number.isFinite(duration) ? duration : 0 });
      duration = null;
    }
  }
  return segments;
}

export class SegmentPrefetcher {
  constructor({ readAheadSeconds, maxBytes = DEFAULT_MAX_BYTES, parallelism = 2, stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS, fetchFn = (...args) => fetch(...args), now = () => Date.now() }) {
    this.readAheadSeconds = readAheadSeconds;
    this.maxBytes = maxBytes;
    this.stallTimeoutMs = stallTimeoutMs;
    // Off until the player has chosen where playback starts. While it opens
    // the stream it reads the first segment for track information, and on a
    // resume that is far from where it will actually play.
    this.active = false;
    // Two requests in flight hide a long round trip between segments.
    this.parallelism = parallelism;
    this.fetchFn = fetchFn;
    this.now = now;
    this.segments = [];
    this.indexByUrl = new Map();
    this.entries = new Map(); // index -> { promise, controller, bytes }
    this.position = -1; // furthest segment the player has asked for
    this.bytes = 0;
    this.pausedUntil = 0;
    this.disposed = false;
    this.fetch = this.fetch.bind(this);
  }

  async fetch(resource, init = {}) {
    const url = toUrl(resource);
    const index = this.indexByUrl.get(url);
    if (index === undefined || this.disposed) {
      const response = await this.fetchFn(resource, init);
      if (!this.disposed && /mpegurl/i.test(response.headers.get('content-type') || '')) {
        await this.learnPlaylist(response, url);
      }
      return response;
    }

    this.demand(index);
    const entry = this.entries.get(index);
    // Serve whole segments only; a resumed read mid-segment goes to the network.
    if (entry && rangeStart(init) === 0) {
      this.entries.delete(index);
      try {
        const { buffer, contentType } = await entry.promise;
        this.bytes -= entry.bytes;
        this.fill();
        return new Response(buffer, { status: 200, headers: { 'Content-Type': contentType, 'Content-Length': String(buffer.byteLength) } });
      } catch {
        // Fall through to a normal request if the read-ahead copy failed.
      }
    }
    return this.fetchFn(resource, init);
  }

  async learnPlaylist(response, url) {
    try {
      const segments = parseMediaPlaylist(await response.clone().text(), response.url || url);
      if (!segments.length) return;
      this.segments = segments;
      this.indexByUrl = new Map(segments.map((segment, index) => [segment.url, index]));
    } catch {
      // The player still works without read-ahead.
    }
  }

  // Start reading ahead from the next segment the player asks for.
  activate() {
    if (this.disposed) return;
    for (const [index, entry] of this.entries) this.drop(index, entry);
    this.position = -1;
    this.active = true;
  }

  // Audio and video read the same segments a little apart, so only a jump
  // forward or a large jump back (a seek) moves the read-ahead window.
  demand(index) {
    if (index > this.position || index < this.position - 4) {
      this.position = index;
      for (const [cached, entry] of this.entries) {
        if (cached !== index && (cached < index || !this.inWindow(cached))) this.drop(cached, entry);
      }
    }
    this.fill();
  }

  inWindow(index) {
    if (index <= this.position || index >= this.segments.length) return false;
    let seconds = 0;
    for (let i = this.position + 1; i < index; i++) seconds += this.segments[i].duration;
    return seconds < this.readAheadSeconds;
  }

  drop(index, entry) {
    entry.controller.abort();
    this.bytes -= entry.bytes;
    this.entries.delete(index);
  }

  fill() {
    if (this.disposed || !this.active || this.position < 0 || this.now() < this.pausedUntil) return;
    let inFlight = 0;
    for (const entry of this.entries.values()) if (!entry.done) inFlight += 1;
    for (let index = this.position + 1; inFlight < this.parallelism && this.inWindow(index); index++) {
      if (this.entries.has(index)) continue;
      if (this.bytes >= this.maxBytes) return;
      this.start(index);
      inFlight += 1;
    }
  }

  start(index) {
    const controller = new AbortController();
    const entry = { controller, bytes: 0, done: false };
    let stallTimer = null;
    const progressed = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => controller.abort(new DOMException('Read-ahead stalled', 'TimeoutError')), this.stallTimeoutMs);
      stallTimer.unref?.();
    };
    entry.promise = (async () => {
      progressed();
      try {
        const response = await this.fetchFn(this.segments[index].url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Segment read-ahead failed: ${response.status}`);
        const contentType = response.headers.get('content-type') || 'video/mp2t';
        const chunks = [];
        let length = 0;
        if (response.body) {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            length += value.byteLength;
            progressed();
          }
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return { buffer: bytes.buffer, contentType };
      } finally {
        clearTimeout(stallTimer);
      }
    })();
    entry.promise.then(({ buffer }) => {
      entry.done = true;
      if (this.entries.get(index) !== entry) return;
      entry.bytes = buffer.byteLength;
      this.bytes += entry.bytes;
      this.fill();
    }, () => {
      entry.done = true;
      if (this.entries.get(index) !== entry) return;
      this.entries.delete(index);
      // Back off briefly so a dead connection isn't hammered.
      this.pausedUntil = this.now() + RETRY_PAUSE_MS;
      setTimeout(() => this.fill(), RETRY_PAUSE_MS).unref?.();
    });
    this.entries.set(index, entry);
  }

  dispose() {
    this.disposed = true;
    for (const [index, entry] of this.entries) this.drop(index, entry);
  }
}
