// Inline SVG icons. The Tesla browser has no font for symbol characters
// (arrows, play/pause marks, emoji), which render as empty boxes, so every
// icon in the UI is drawn from these paths instead.
const PATHS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
  back: 'M12 5V1L7 6l5 5V7c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6H4c0 4.4 3.6 8 8 8s8-3.6 8-8-3.6-8-8-8z',
  forward: 'M12 5V1l5 5-5 5V7c-3.3 0-6 2.7-6 6s2.7 6 6 6 6-2.7 6-6h2c0 4.4-3.6 8-8 8s-8-3.6-8-8 3.6-8 8-8z',
  check: 'M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
  gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  'arrow-right': 'M4 11h12.17l-5.59-5.59L12 4l8 8-8 8-1.41-1.41L16.17 13H4v-2z',
  'arrow-left': 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  'chevron-left': 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z',
  'chevron-right': 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  fullscreen: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  'fullscreen-exit': 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
  tune: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
  move: 'M10 9h4V6h3l-5-5-5 5h3v3zm-1 1H6V7l-5 5 5 5v-3h3v-4zm14 2l-5-5v3h-3v4h3v3l5-5zm-9 3h-4v3H7l5 5 5-5h-3v-3z',
  lyrics: 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z',
  repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
  'repeat-one': 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z',
  radio: 'M12 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-4.24-1.76A5.96 5.96 0 0 0 6 12c0 1.65.67 3.15 1.76 4.24l1.41-1.41A3.98 3.98 0 0 1 8 12c0-1.1.45-2.1 1.17-2.83L7.76 8.24zm8.48 0l-1.41 1.41A3.98 3.98 0 0 1 16 12c0 1.1-.45 2.1-1.17 2.83l1.41 1.41A5.96 5.96 0 0 0 18 12c0-1.65-.67-3.15-1.76-4.24zM4.93 5.51A9.94 9.94 0 0 0 2 12c0 2.76 1.12 5.26 2.93 7.07l1.41-1.41A7.95 7.95 0 0 1 4 12c0-2.21.9-4.21 2.34-5.66L4.93 4.93zm14.14 0l-1.41 1.41A7.95 7.95 0 0 1 20 12c0 2.21-.9 4.21-2.34 5.66l1.41 1.41A9.94 9.94 0 0 0 22 12c0-2.76-1.12-5.26-2.93-7.07z',
  shuffle: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  'skip-prev': 'M6 6h2v12H6zm3.5 6l8.5 6V6z',
  'skip-next': 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
  dot: 'M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z',
  cc: 'M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z',
};
const NS = 'http://www.w3.org/2000/svg';

// Markup for an icon; `label` is short text drawn inside it (e.g. "30").
// Names come from the table above, never from user input.
export function iconSvg(name, label = '') {
  const d = PATHS[name];
  if (!d) throw new Error(`Unknown icon: ${name}`);
  const text = label ? `<text x="12" y="16.2" text-anchor="middle" font-size="7.5" font-weight="700" font-family="sans-serif">${label}</text>` : '';
  return `<svg class="ico" width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-0.2em" aria-hidden="true"><path d="${d}"/>${text}</svg>`;
}

export function iconEl(name, label = '', doc = document) {
  const d = PATHS[name];
  if (!d) throw new Error(`Unknown icon: ${name}`);
  const svg = doc.createElementNS(NS, 'svg');
  for (const [key, value] of Object.entries({ class: 'ico', width: '1.25em', height: '1.25em', viewBox: '0 0 24 24', fill: 'currentColor', style: 'vertical-align:-0.2em', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  const path = doc.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  if (label) {
    const text = doc.createElementNS(NS, 'text');
    for (const [key, value] of Object.entries({ x: '12', y: '16.2', 'text-anchor': 'middle', 'font-size': '7.5', 'font-weight': '700', 'font-family': 'sans-serif' })) text.setAttribute(key, value);
    text.textContent = label;
    svg.append(text);
  }
  return svg;
}

// Fill every <span data-icon="name" [data-label="30"]> under root.
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    el.replaceChildren(iconEl(el.dataset.icon, el.dataset.label || '', el.ownerDocument));
  }
}
