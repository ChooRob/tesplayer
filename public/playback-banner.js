// Hiding a banner must also remove its action: opacity alone still captures clicks.
export function createPlaybackBanner(element, { schedule = setTimeout, cancel = clearTimeout } = {}) {
  let timer;
  function hide() {
    cancel(timer);
    element.classList.remove('visible', 'clickable');
    element.onclick = null;
  }
  function show(text, { persist = false, onClick } = {}) {
    hide();
    element.textContent = text;
    element.classList.add('visible');
    element.classList.toggle('clickable', !!onClick);
    element.onclick = onClick || null;
    if (!persist) timer = schedule(hide, 4000);
  }
  return { show, hide };
}
