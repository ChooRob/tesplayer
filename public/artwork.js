// Artwork that is missing or will not load: the title on a blue tile, as a picture that can stand in for the
// image's own source. (A card in a list does this with CSS instead; see .noArt in browse.html.)

const escapeXml = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A title broken into lines of about `max` characters, at most `limit` of them.
export function titleLines(title, max = 14, limit = 4) {
  const lines = [];
  let line = '';
  for (const word of String(title || '').trim().split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > max) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  if (lines.length > limit) { lines.length = limit; lines[limit - 1] = `${lines[limit - 1].slice(0, max - 1)}…`; }
  return lines;
}

// The tile as an SVG data address, which the page's image policy allows.
export function fallbackArt(title) {
  const lines = titleLines(title);
  const size = lines.some((line) => line.length > 11) ? 34 : 42;
  const top = 200 - ((lines.length - 1) * size * 1.25) / 2;
  const text = lines.map((line, i) => `<text x="200" y="${Math.round(top + i * size * 1.25)}" text-anchor="middle" dominant-baseline="middle" font-family="-apple-system,system-ui,sans-serif" font-weight="600" font-size="${size}" fill="#fff">${escapeXml(line)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs><linearGradient id="g" x1="0" y1="0" x2=".6" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#1e3a8a"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/>${text}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// Sets the image's source, and swaps in the tile when there is none or it fails. `instead` is another picture to
// try first when the main one fails (an artist's, for an album's).
export function showArt(img, src, title, instead = null) {
  // Asked again for the same picture (the play bar redraws often), it is left as it is, tile or not.
  const wanted = `${src || ''}\n${instead || ''}\n${title || ''}`;
  if (img.dataset.art === wanted) return;
  img.dataset.art = wanted;
  img.onerror = null;
  if (!src && instead) { showArt(img, instead, title); img.dataset.art = wanted; return; }
  if (!src) { img.src = fallbackArt(title); return; }
  img.onerror = () => {
    img.onerror = () => { img.onerror = null; img.src = fallbackArt(title); };
    img.src = instead && instead !== src ? instead : fallbackArt(title);
    if (!(instead && instead !== src)) img.onerror = null;
  };
  img.src = src;
}
