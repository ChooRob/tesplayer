// What the browse page keeps on this device so reopening the app returns to the music that was playing: the
// session (which queue, where, playing or not) and a copy of the queue. It belongs to one signed-in person and
// is removed when they sign out or switch profile; the browse page also refuses it for anyone else.
export const MUSIC_SESSION_KEY = 'freeStuffCrazyPlayer.musicSession';
export const MUSIC_QUEUE_KEY = 'freeStuffCrazyPlayer.queue';

export function clearSavedMusic(storages = [globalThis.localStorage, globalThis.sessionStorage]) {
  for (const storage of storages) {
    for (const key of [MUSIC_SESSION_KEY, MUSIC_QUEUE_KEY]) {
      try { storage?.removeItem(key); } catch { /* storage not available */ }
    }
  }
}
