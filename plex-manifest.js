import { mediaProxyPath, directPlexOrigin } from './security.js';

// Only media belonging to this viewer's transcode can leave the manifest.
// Never forward credentials that Plex happens to include in a URI.
export function proxyMediaUri(value, baseUrl, sessionId) {
  const url = new URL(value, baseUrl);
  const base = new URL(baseUrl);
  const path = url.pathname.replace(/^\//, '');
  if (url.origin !== base.origin || !mediaProxyPath(path, sessionId)) throw new Error('Invalid Plex media URI');
  const query = new URLSearchParams();
  for (const key of ['offset', 'copyts', 'wait', 'partIndex', 'mediaIndex']) {
    if (url.searchParams.has(key)) query.set(key, url.searchParams.get(key));
  }
  return `/proxy/${path}${query.size ? '?' + query : ''}`;
}

export function rewriteManifest(text, baseUrl, sessionId, directToken = '') {
  const rewrite = value => {
    const proxy = proxyMediaUri(value, baseUrl, sessionId);
    if (!directToken || !directPlexOrigin(new URL(baseUrl).origin)) return proxy;
    const url = new URL(proxy.slice('/proxy'.length), new URL(baseUrl).origin);
    // Keep playlists on our origin so every child URI is validated and authenticated.
    if (url.pathname.endsWith('.m3u8')) return proxy + (proxy.includes('?') ? '&' : '?') + 'direct=1';
    url.searchParams.set('X-Plex-Token', directToken);
    return url.href;
  };
  return text.split('\n').map(line => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${rewrite(uri)}"`);
    return rewrite(line.trim());
  }).join('\n');
}
