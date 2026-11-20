// Which lyric line is being sung. Timed lines come first, in order of their start time, so the
// current one is the last that has started; plain lyrics (no times) have none.
export function activeLine(lines, ms) {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const start = lines[mid].startMs;
    if (start === null || start === undefined) { high = mid - 1; continue; }
    if (start <= ms) { found = mid; low = mid + 1; } else high = mid - 1;
  }
  return found;
}
