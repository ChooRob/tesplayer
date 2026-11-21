// Which kind of computer the page is running on, where that changes what is worth asking of it: a Tesla MCU2 (an Intel
// Atom) is slow, and an MCU3 (an AMD Ryzen) is about eight times quicker.
//
// Both send a user agent that looks like Chrome on desktop Linux, so that cannot tell them apart. What does is the
// graphics chip behind a touchscreen: an Intel Apollo Lake ("HD Graphics 505") is the MCU2, an AMD one the MCU3.
// Anything not sure is treated as an MCU2: what is known to work there is what it gets.

const APOLLO_LAKE = /Intel.*?(?:HD Graphics 50\d|\bAPL\b|Apollo)/i;
const AMD = /\b(?:AMD|Radeon)\b/i;
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

// 'mcu2', 'mcu3', or 'other' (anything that is not a car's browser, or a car that is neither).
export function deviceClass({
  userAgent = globalThis.navigator?.userAgent || '',
  touchPoints = globalThis.navigator?.maxTouchPoints || 0,
  renderer = gpuRenderer(),
} = {}) {
  if (!LINUX_DESKTOP.test(userAgent) || /Android|CrOS|Mobile/i.test(userAgent)) return 'other'; // not a car's browser
  if (!(touchPoints > 0)) return 'other'; // a desktop Linux machine, with no touchscreen
  if (APOLLO_LAKE.test(renderer)) return 'mcu2';
  if (renderer === '') return 'mcu2'; // a touchscreen on Linux that will not say: the careful choice
  return AMD.test(renderer) ? 'mcu3' : 'other';
}

// True when the music can be asked for at its own sample rate: anything but an MCU2.
export const canUseSourceRate = (environment) => deviceClass(environment) !== 'mcu2';

let cached;
export const thisDevice = () => (cached ??= deviceClass());
export const useSourceRate = () => thisDevice() !== 'mcu2';
export const isMcu3 = () => thisDevice() === 'mcu3';
