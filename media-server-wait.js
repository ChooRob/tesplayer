// A media server that has not answered in time is usually busy, not broken: a drive
// spinning up after sleeping, or a transcoder starting. The proxy then answers 503
// with Retry-After, and the player asks again for a while (public/engine/media-retry.js)
// instead of giving up on the stream.

export const MEDIA_SERVER_SLOW = 'MEDIA_SERVER_SLOW';
export const RETRY_AFTER_SECONDS = 1;

// True for the error AbortSignal.timeout() raises.
export const isTimeout = err => err?.name === 'TimeoutError';

export function sendMediaServerSlow(res) {
  res.set('Retry-After', String(RETRY_AFTER_SECONDS));
  return res.status(503).json({ code: MEDIA_SERVER_SLOW, error: 'The media server is taking a while to answer' });
}
