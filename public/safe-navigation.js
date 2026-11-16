export function safeReturnPath(value, origin) {
  try {
    const url = new URL(value || '/browse', origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)
      || url.username || url.password) return '/browse';
    if (!['/browse', '/browse.html', '/detail', '/detail.html', '/canvas2', '/canvas2.html', '/canvas', '/canvas.html', '/'].includes(url.pathname)) return '/browse';
    return url.pathname + url.search;
  } catch { return '/browse'; }
}
