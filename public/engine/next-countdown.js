// The short wait before the next episode starts by itself, so the viewer can
// cancel. Timers are passed in so tests do not need real seconds.
export const NEXT_COUNTDOWN_SECONDS = 5;

export function createNextCountdown({
  seconds = NEXT_COUNTDOWN_SECONDS, onTick, onDone,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
} = {}) {
  let timer = null;
  let remaining = 0;
  const stop = () => {
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
    remaining = 0;
  };
  return {
    get active() { return timer !== null; },
    start() {
      if (timer !== null) return false;
      remaining = seconds;
      onTick?.(remaining);
      timer = setIntervalFn(() => {
        remaining -= 1;
        if (remaining > 0) return onTick?.(remaining);
        stop();
        onDone?.();
      }, 1000);
      return true;
    },
    cancel() {
      const wasActive = timer !== null;
      stop();
      return wasActive;
    },
  };
}
