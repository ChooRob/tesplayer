// Music is sent to the browser at 48 kHz by default, because the Tesla MCU2's browser is slow and stutters when it has
// to resample a 44.1 kHz stream itself (the media server does the conversion instead). That costs the media server
// work, and no other browser needs it. This says when it is safe to ask for the music as it is.
//
// The MCU2 sends a user agent that looks like Chrome on desktop Linux, so that cannot tell it apart. What does is its
// graphics chip (an Intel Apollo Lake, "HD Graphics 505") on a touchscreen. Anything not sure is treated as an MCU2:
// the 48 kHz stream is the one that is known to work there.

const APOLLO_LAKE = /Intel.*?(?:HD Graphics 50\d|\bAPL\b|Apollo)/i;
const LINUX_DESKTOP = /\bX11;\s*(?:GNU\/)?Linux\b/i;

// The graphics chip's name, or '' when the browser will not say.
export function gpuRenderer(doc = globalThis.document) {
  try {
    const gl = doc.createElement('canvas').getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return typeof name === 'string' ? name : '';
  } catch { return ''; }
}

// True when the music can be asked for at its own sample rate.
export function canUseSourceRate({
  userAgent = globalThis.navigator?.userAgent || '',
  touchPoints = globalThis.navigator?.maxTouchPoints || 0,
  renderer = gpuRenderer(),
} = {}) {
  if (!LINUX_DESKTOP.test(userAgent) || /Android|CrOS|Mobile/i.test(userAgent)) return true; // not a car's browser
  if (!(touchPoints > 0)) return true; // a desktop Linux machine, with no touchscreen
  return renderer !== '' && !APOLLO_LAKE.test(renderer); // a touchscreen on Linux: only when it is known not to be the chip
}

let cached;
export const useSourceRate = () => (cached ??= canUseSourceRate());
