import { iconEl } from './icons.js';
// Page fullscreen retains the app's controls for both playback engines.
// Safari's video-only fullscreen is a fallback for Standard playback.
const TESLA_TOKEN = /\bTesla(?:\/|\s)|\bQtCarBrowser\b/i;
const OVERRIDE_KEY = 'freeStuffCrazyPlayer.tesla';

function storageOf() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

// A car whose browser does not say what it is can be told once: open the player with
// ?tesla=1 in the address and it is remembered (?tesla=0 forgets it). Returns
// true or false when told, and null when nobody has said.
export function teslaOverride(search = globalThis.location?.search ?? '', storage = storageOf()) {
  const asked = new URLSearchParams(search).get('tesla');
  const told = asked === '1' ? true : asked === '0' ? false : null;
  try {
    if (told === true) storage?.setItem(OVERRIDE_KEY, '1');
    else if (told === false) storage?.removeItem(OVERRIDE_KEY);
    else return storage?.getItem(OVERRIDE_KEY) === '1' ? true : null;
  } catch { /* nothing remembered */ }
  return told;
}

export function isTeslaBrowser(userAgent = navigator.userAgent, { search, storage } = {}) {
  return teslaOverride(search, storage) ?? TESLA_TOKEN.test(userAgent);
}

// Current Tesla software sends a user agent that looks like Chrome on desktop Linux,
// with no mention of Tesla. What still gives it away is a touchscreen with no mouse.
// Only a hint: the Tesla way is used with it only after ordinary fullscreen fails.
export function looksLikeCarBrowser({
  userAgent = navigator.userAgent,
  touchPoints = navigator.maxTouchPoints,
  coarsePointer = globalThis.matchMedia?.('(pointer: coarse)').matches,
  noHover = globalThis.matchMedia?.('(hover: none)').matches,
} = {}) {
  const linuxDesktop = /\bX11;\s*(?:GNU\/)?Linux\b/i.test(userAgent) && !/Android|CrOS|Mobile/i.test(userAgent);
  return linuxDesktop && (touchPoints > 0 || !!coarsePointer || !!noHover);
}

export function fullscreenMode(doc, video, tesla = false) {
  // Tesla always uses its dedicated path, irrespective of exposed browser APIs.
  if (tesla) return 'tesla';
  if (doc.fullscreenElement || doc.webkitFullscreenElement) return 'exit-page';
  if (video?.webkitDisplayingFullscreen) return 'exit-video';
  const root = doc.documentElement;
  if (doc.fullscreenEnabled !== false && typeof root.requestFullscreen === 'function') return 'page';
  if (doc.webkitFullscreenEnabled !== false && typeof root.webkitRequestFullscreen === 'function') return 'webkit-page';
  if (video && !video.hidden && video.style.display !== 'none'
    && typeof video.webkitEnterFullscreen === 'function'
    && video.webkitSupportsFullscreen !== false && video.readyState >= 1) return 'video';
  return 'unavailable';
}

// Tesla's fullscreen workaround navigates away, so carry the current VOD
// position in the return URL instead of reusing the original resume point.
export function fullscreenReturnUrl(url, playback) {
  const target = new URL(url);
  if (target.searchParams.get('live') === '1' || !playback
    || !Number.isFinite(playback.currentTime) || playback.currentTime < 0) return url;
  target.searchParams.set('resume', String(playback.currentTime));
  target.searchParams.set('paused', playback.paused ? '1' : '0');
  return target.href;
}

export async function goFullscreen({
  doc = document, video = null, tesla = isTeslaBrowser(), navigate = url => { window.location.href = url; },
  url = window.location.href, playback = null, carLike = looksLikeCarBrowser(), settleMs = 250,
} = {}) {
  const mode = fullscreenMode(doc, video, tesla);
  // The Tesla way: a page on YouTube's domain puts the browser in fullscreen, then sends it back here.
  const teslaWay = () => navigate(`https://www.youtube.com/redirect?q=${encodeURIComponent(fullscreenReturnUrl(url, playback))}`);
  if (mode === 'tesla') return teslaWay();
  if (mode === 'exit-page') return (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
  if (mode === 'exit-video') return video.webkitExitFullscreen();
  if (mode === 'page' || mode === 'webkit-page') {
    // Fullscreen the root, not the canvas alone, to retain overlay controls.
    const request = mode === 'page' ? doc.documentElement.requestFullscreen : doc.documentElement.webkitRequestFullscreen;
    if (!carLike) return request.call(doc.documentElement);
    // This looks like a car's browser, which may refuse or quietly ignore ordinary
    // fullscreen (and Canvas has no video of its own to fullscreen). If it did not
    // take, use the Tesla way; any other browser is never redirected.
    let entered = false;
    try {
      await request.call(doc.documentElement);
      if (settleMs) await new Promise(resolve => setTimeout(resolve, settleMs));
      entered = !!(doc.fullscreenElement || doc.webkitFullscreenElement);
    } catch { /* refused */ }
    if (!entered) return teslaWay();
    return undefined;
  }
  if (mode === 'video') return video.webkitEnterFullscreen();
  throw new Error('This browser cannot fullscreen this playback mode. Try Standard playback for native video fullscreen.');
}

export function setupFullscreenButton(btn, { video = null, getPlaybackState = () => null } = {}) {
  if (!btn) return;
  const tesla = isTeslaBrowser();
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  status.style.cssText = 'color:#fff;background:#222;font:13px system-ui;padding:8px;border-radius:6px;max-width:280px';
  status.hidden = true;
  btn.after(status);
  btn.style.display = '';
  function update() {
    const mode = fullscreenMode(document, video, tesla);
    const exiting = mode.startsWith('exit-');
    // The label can be visually hidden on phones (.shortLabel .label), leaving the icon.
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = exiting ? ' Exit fullscreen' : ' Fullscreen';
    btn.replaceChildren(iconEl(exiting ? 'fullscreen-exit' : 'fullscreen', '', document), label);
    btn.classList.add('shortLabel');
    // Pages without a video (browse) have nothing to fall back to, e.g. on iPhone.
    if (!video) btn.style.display = mode === 'unavailable' ? 'none' : '';
    btn.setAttribute('aria-label', exiting ? 'Exit fullscreen' : 'Enter fullscreen');
    btn.setAttribute('aria-pressed', String(exiting));
    btn.setAttribute('aria-disabled', String(mode === 'unavailable'));
    btn.title = mode === 'unavailable'
      ? 'Fullscreen is unavailable for this playback mode in this browser'
      : mode === 'video' ? 'Open native video fullscreen' : exiting ? 'Exit fullscreen' : 'Enter fullscreen';
  }
  btn.addEventListener('click', async () => {
    status.hidden = true;
    try { await goFullscreen({ video, tesla, playback: getPlaybackState() }); }
    catch (err) {
      status.textContent = fullscreenMode(document, video, tesla) === 'unavailable'
        ? err.message : 'Fullscreen was blocked by the browser. Try again or use the browser’s fullscreen control.';
      status.hidden = false;
    }
    update();
  });
  for (const event of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(event, update);
  if (video) {
    for (const event of ['loadedmetadata', 'emptied', 'webkitbeginfullscreen', 'webkitendfullscreen']) video.addEventListener(event, update);
    new MutationObserver(update).observe(video, { attributes: true, attributeFilter: ['hidden', 'style'] });
  }
  update();
}
