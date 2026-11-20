// Which tab the browse page was on, kept in the browser so a fresh visit (or a reload without
// the tab in the address) comes back to it, and how the order of library tabs is decided.

const KEY = 'freeStuffCrazyPlayer.browseTab';
const ID = /^[A-Za-z0-9-]{1,64}$/;
const VIEW = /^[a-z0-9-]{1,32}$/;

// Music comes first, then the other libraries in the order the source gave them. (Plugin tabs
// are added after these by the page.)
export function orderLibraries(libraries) {
  return [...libraries].sort((a, b) => Number(b.type === 'music') - Number(a.type === 'music'));
}

// { tab, views: { <library id>: <view> } }, or nothing remembered.
export function readTabMemory(storage) {
  try {
    const stored = JSON.parse(storage.getItem(KEY) || 'null');
    if (!stored || typeof stored !== 'object') return { tab: null, views: {} };
    const views = {};
    for (const [library, view] of Object.entries(stored.views && typeof stored.views === 'object' ? stored.views : {})) {
      if (ID.test(library) && typeof view === 'string' && VIEW.test(view)) views[library] = view;
    }
    return { tab: typeof stored.tab === 'string' && ID.test(stored.tab) ? stored.tab : null, views };
  } catch { return { tab: null, views: {} }; }
}

// Remember the tab, and the view of the library it is (a library keeps its own).
export function writeTabMemory(storage, { tab, view = null }) {
  if (!tab || !ID.test(tab)) return;
  try {
    const before = readTabMemory(storage);
    const views = { ...before.views };
    if (view && VIEW.test(view)) views[tab] = view;
    storage.setItem(KEY, JSON.stringify({ tab, views }));
  } catch { /* not remembered */ }
}

// The tab to open when the address names none: the remembered one if it still exists among
// `tabs` (library and plugin tab IDs), else the first.
export function startingTab(memory, tabs) {
  return tabs.find(id => id === memory.tab) ?? tabs[0] ?? null;
}
