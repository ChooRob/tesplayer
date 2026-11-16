export function createPlaybackSessions({ maximum = 8, idleMs = 1800000, stop, now = Date.now }) {
  const viewers = new Map();
  const locks = new Map();
  async function run(owner, operation, { create = true } = {}) {
    if (!owner) throw new Error('Not authenticated');
    // Reject simultaneous mutations for one viewer instead of allowing races
    // between a start, a retry, and an unload beacon.
    if (locks.has(owner)) throw new Error('Playback operation already in progress');
    locks.set(owner, true);
    try {
      let state = viewers.get(owner);
      if (!state && !create) return;
      if (!state) {
        if (viewers.size >= maximum) throw new Error('Playback capacity reached');
        state = { active: null, tuned: null, touched: now() }; viewers.set(owner, state);
      }
      state.touched = now();
      try { return await operation(state); }
      finally { if (!state.active && !state.tuned) viewers.delete(owner); }
    } finally { locks.delete(owner); }
  }
  async function stopState(state) {
    const active = state.active;
    state.active = null; state.tuned = null;
    // active is whatever the source recorded when it started the stream.
    if (active) await stop(active);
  }
  return {
    run, stopState,
    owns(owner, id) {
      const state = viewers.get(owner);
      if (!state || state.active?.sessionId !== id) return false;
      state.touched = now(); return true;
    },
    async stopOwner(owner) { return run(owner, stopState, { create: false }); },
    async prune() {
      await Promise.all([...viewers].filter(([owner, state]) => !locks.has(owner) && now() - state.touched >= idleMs)
        .map(([owner]) => run(owner, stopState, { create: false })));
    },
    async close() { await Promise.all([...viewers.values()].map(stopState)); viewers.clear(); },
  };
}
