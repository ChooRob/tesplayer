// Server-clock accounting shared by live streams and Plex. Heartbeats report only
// playback state; media positions and seeks never determine time charged.
// getStreamLimit returns a positive per-account cap; anything else means unlimited.
// A new playback sends its first heartbeat only once the player has loaded,
// which on a slow device (or a resume deep into a file) can take longer than
// leaseMs. Until that first heartbeat it has startupMs before it can expire.
export function createWatchTimeMeter({recordUsage,getQuotaStatus,getStreamLimit=()=>null,now=Date.now,leaseMs=25000,startupMs=90000,maximum=1000}) {
  const viewers=new Map();
  const liveUntil = entry => Math.max(entry.seenAt + leaseMs, entry.startupUntil || 0);
  function otherActiveStreams(viewer, accountKey) {
    return [...viewers].filter(([owner, entry]) =>
      owner !== viewer && entry.accountKey === accountKey && entry.state !== 'stopped'
      && !entry.exhausted && !entry.expired && now() <= liveUntil(entry)).length;
  }
  async function streamLimitFor(accountKey) {
    const limit = await getStreamLimit(accountKey);
    return Number.isInteger(limit) && limit > 0 ? limit : Infinity;
  }
  async function atStreamLimit(viewer, accountKey) {
    if (!accountKey) return false;
    const limit = await streamLimitFor(accountKey);
    return otherActiveStreams(viewer, accountKey) >= limit;
  }
  async function settle(entry) {
    const end=Math.min(now(),entry.seenAt+leaseMs);
    const seconds=entry.state==='playing'?Math.max(0,end-entry.chargedAt)/1000:0;
    entry.chargedAt=now();
    if(seconds>0)await recordUsage(entry.accountKey,seconds);
    const quota=await getQuotaStatus(entry.accountKey);
    if(quota && quota.remainingSeconds<=0 && !entry.exhausted) {
      entry.exhausted=true;entry.state='stopped';
      await entry.onExhausted?.(quota);
    }
    if(!entry.exhausted && !entry.expired && now()>liveUntil(entry)) {
      entry.expired=true;entry.state='paused';await entry.onExpired?.();
    }
    return quota;
  }
  async function begin({viewer,accountKey,playbackId,onExhausted,onExpired}) {
    if(!viewer || !accountKey)return;
    let old=viewers.get(viewer);
    if(old)await settle(old);
    // Count and claim with no await in between, so racing starts can't both fit.
    const limit=await streamLimitFor(accountKey);
    old=viewers.get(viewer);
    if (otherActiveStreams(viewer, accountKey) >= limit) {
      const error = new Error('Account stream limit reached');
      error.code = 'ACCOUNT_STREAM_LIMIT';
      throw error;
    }
    if(old?.playbackId===playbackId){old.onExhausted=onExhausted;old.onExpired=onExpired;old.expired=false;old.seenAt=now();old.chargedAt=now();old.startupUntil=now()+startupMs;old.state='paused';return;}
    if(viewers.size>=maximum && !old) {
      const stale=[...viewers].find(([,entry])=>liveUntil(entry)<now());
      if(stale)viewers.delete(stale[0]);else throw Error('Watch-time tracking capacity reached');
    }
    // Safari can send a heartbeat while /api/start is still pending.
    // Only IDs that actually owned playback can have been replaced.
    const previousIds = old ? [...old.previousIds, old.playbackId].slice(-16) : [];
    viewers.set(viewer,{accountKey,playbackId,previousIds,onExhausted,onExpired,expired:false,state:'paused',chargedAt:now(),seenAt:now(),startupUntil:now()+startupMs,exhausted:false});
    return { replaced: !!old };
  }
  async function heartbeat(viewer,playbackId,state) {
    const entry=viewers.get(viewer);
    if(!entry || entry.playbackId!==playbackId)return {stale:true,replaced:entry?.previousIds.includes(playbackId) ?? false};
    if (entry.state === 'stopped' && !entry.exhausted) return { stale: true };
    const quota=await settle(entry);
    // From the first heartbeat on, the ordinary lease applies.
    if(!entry.exhausted && !entry.expired) {entry.state=state;entry.seenAt=now();entry.chargedAt=now();entry.startupUntil=0;}
    return {quota,exhausted:entry.exhausted,expired:entry.expired};
  }
  async function tick() {
    await Promise.all([...viewers.values()].map(entry=>settle(entry)));
  }
  async function stop(viewer) {
    const entry=viewers.get(viewer);if(!entry)return;
    await settle(entry);viewers.delete(viewer);
  }
  async function close() {await tick();viewers.clear();}
  return {begin,heartbeat,tick,stop,close,atStreamLimit};
}
