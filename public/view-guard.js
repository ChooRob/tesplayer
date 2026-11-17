// The browse page's grid shows one thing at a time (a library, a show's seasons,
// a season's episodes, or search results). Each of those is fetched, and a slow
// connection can deliver an earlier fetch after the viewer has moved on, so it
// would draw Movies over TV Shows. Every action that changes the grid starts a
// new view; a response for any earlier view is dropped and its request aborted.
export function createViewGuard() {
  let latest = 0;
  let controller = null;
  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      const mine = ++latest;
      return { signal: controller.signal, isCurrent: () => mine === latest };
    },
  };
}

// Whether a failure is only the abort of a request that was replaced.
export const wasAborted = error => error?.name === 'AbortError';
