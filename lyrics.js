// Lyrics, as sources hand them over, as lines the player can show. Some are timed (each line
// knows when it is sung, so the player can light the current one) and some are plain text.
//
//   { timed: boolean, lines: [{ startMs: number | null, text: string }] }
//
// Three forms are read: LRC ("[01:23.45] words", what lyric providers sync with), the XML Plex
// serves for a lyric stream (lines made of spans that carry their own start offset), and plain text.

const MAX_BYTES = 512 * 1024;
const MAX_LINES = 2000;
const MAX_LINE = 400;

const clean = text => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_LINE);

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': ' ' };
const decode = text => text
  .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, entity => ENTITIES[entity])
  .replace(/&#(\d{1,6});/g, (_m, code) => (Number(code) <= 0x10ffff ? String.fromCodePoint(Number(code)) : ''))
  .replace(/&#x([0-9a-f]{1,6});/gi, (_m, code) => (parseInt(code, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(code, 16)) : ''));

// Text without its <tags>, in one pass (a pattern like /<[^>]*>/ rescans to the end from every "<" that has no ">").
const stripTags = text => {
  let out = '';
  let from = 0;
  for (;;) {
    const open = text.indexOf('<', from);
    if (open < 0) return out + text.slice(from);
    out += text.slice(from, open);
    const close = text.indexOf('>', open);
    if (close < 0) return out + text.slice(open);
    from = close + 1;
  }
};

const finish = lines => {
  const kept = lines.slice(0, MAX_LINES);
  return { timed: kept.some(line => line.startMs !== null), lines: kept };
};

// LRC: one or more [mm:ss.xx] stamps before each line's words, plus tags like [ar:Artist] and [offset:+250].
export function parseLrc(text) {
  const lines = [];
  let offset = 0;
  for (const raw of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const stamps = [];
    let rest = raw.trim();
    for (let match; (match = /^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/.exec(rest));) {
      stamps.push(Number(match[1]) * 60000 + Number(match[2]) * 1000 + Number((match[3] ?? '0').padEnd(3, '0').slice(0, 3)));
      rest = rest.slice(match[0].length);
    }
    if (!stamps.length) {
      const tag = /^\[(\w+):([^\]]*)\]$/.exec(rest);
      if (tag?.[1].toLowerCase() === 'offset' && /^[-+]?\d+$/.test(tag[2].trim())) offset = Number(tag[2].trim());
      continue; // other tags (artist, title, ...) are not lyrics
    }
    // Enhanced LRC puts <mm:ss.xx> before words; the line's own stamp is enough.
    const words = clean(rest.replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, ''));
    for (const stamp of stamps) lines.push({ startMs: Math.max(0, stamp - offset), text: words });
  }
  lines.sort((a, b) => a.startMs - b.startMs);
  return finish(lines);
}

export function parsePlain(text) {
  return finish(String(text).replace(/\r\n?/g, '\n').split('\n').map(line => ({ startMs: null, text: clean(line) })));
}

// Plex's XML: <Line startOffset="12000"><Span startOffset="12000" endOffset="13000">Words</Span> ...</Line>.
// A line without its own offset takes its first span's. Untimed lines keep their order.
//
// Read in one pass, never trying a tag again from the start: a regular expression that searches ahead for a
// closing tag from every opening tag takes quadratic time on a file full of tags that are never closed, and the
// text comes from a media server the viewer chose. A tag with no closing tag ends the reading, since no later
// one can have a closing tag either.
const LINE_OPEN = /<Line\b([^>]{0,300})>/gi;
const LINE_CLOSE = /<\/Line>/gi;
const SPAN_START = /<Span\b/gi;
const SPAN_CLOSE = /<\/Span>/gi;
const startOffset = attributes => { const match = /\bstartOffset="(\d+)"/i.exec(attributes); return match ? Number(match[1]) : null; };

function readSpans(inner) {
  const words = [];
  let startMs = null;
  SPAN_START.lastIndex = 0;
  for (let found; (found = SPAN_START.exec(inner));) {
    // The tag ends within a few hundred characters or it is not a tag.
    const head = inner.slice(found.index + 5, found.index + 5 + 300);
    const end = head.indexOf('>');
    if (end < 0) continue;
    const attributes = head.slice(0, end);
    const selfClosing = attributes.endsWith('/');
    const offset = startOffset(attributes);
    if (startMs === null && offset !== null) startMs = offset;
    const bodyStart = found.index + 5 + end + 1;
    if (selfClosing) { // <Span ... /> carries its words in an attribute
      words.push(decode(/\b(?:text|value)="([^"]*)"/i.exec(attributes)?.[1] ?? ''));
      SPAN_START.lastIndex = bodyStart;
      continue;
    }
    SPAN_CLOSE.lastIndex = bodyStart;
    const close = SPAN_CLOSE.exec(inner);
    if (!close) break;
    words.push(decode(stripTags(inner.slice(bodyStart, close.index))));
    SPAN_START.lastIndex = SPAN_CLOSE.lastIndex;
  }
  return { words, startMs };
}

export function parseLyricsXml(text) {
  const lines = [];
  const xml = String(text);
  LINE_OPEN.lastIndex = 0;
  for (let open; lines.length < MAX_LINES && (open = LINE_OPEN.exec(xml));) {
    LINE_CLOSE.lastIndex = LINE_OPEN.lastIndex;
    const close = LINE_CLOSE.exec(xml);
    if (!close) break;
    const inner = xml.slice(LINE_OPEN.lastIndex, close.index);
    LINE_OPEN.lastIndex = LINE_CLOSE.lastIndex;
    const spans = readSpans(inner);
    const spoken = clean(spans.words.length ? spans.words.join('') : decode(stripTags(inner)));
    lines.push({ startMs: startOffset(open[1]) ?? spans.startMs, text: spoken });
  }
  return finish(lines);
}

// Whatever came back, as lyrics: XML if it looks like XML, LRC if it has time stamps, else plain.
export function parseLyrics(text) {
  const body = String(text ?? '');
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('Lyrics too large');
  const trimmed = body.replace(/^﻿/, '').trimStart();
  let result;
  if (/^<(?:\?xml|MediaContainer|Lyrics|Line)\b/i.test(trimmed)) result = parseLyricsXml(trimmed);
  else if (/^\s*\[\d{1,3}:\d{2}/m.test(trimmed)) result = parseLrc(trimmed);
  else result = parsePlain(trimmed);
  // Blank runs at the ends are not lyrics; blank lines inside are verse breaks and stay.
  const lines = result.lines.slice();
  while (lines.length && !lines[0].text) lines.shift();
  while (lines.length && !lines.at(-1).text) lines.pop();
  return { timed: lines.some(line => line.startMs !== null), lines };
}
