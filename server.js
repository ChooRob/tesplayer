import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { installationId, dataDir } from './private-storage.js';
import { createRecentlyMarked } from './recently-marked.js';
import { nextEpisodeAfter, showIdFromKey } from './next-episode.js';
import { openStore } from './storage.js';
import { applyTrustProxy } from './trust-proxy.js';
import { existsSync, readFileSync, writeFileSync, appendFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { AUTO_QUALITY_LEVELS, QUALITY_LEVELS, qualityTiers } from './public/engine/quality-tiers.js';
import { createWatchTimeMeter } from './watch-time-meter.js';
import { createPlaybackSessions } from './playback-sessions.js';
import { securityHeaders, sameOriginRequests, rateLimit, mediaProxyPath, safeError, accessLog } from './security.js';
import { Readable } from 'node:stream';
import { registerAdmin } from './admin-auth.js';
import { firstPluginWith, loadConfiguredPlugins } from './plugins.js';
import { checkSourceConfig, createSources } from './sources.js';
import { createAccountDirectory } from './accounts.js';
import { createPublicAccountIds } from './account-ids.js';

const ITEM_KEY = process.env.ITEM_KEY;
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const APP_ORIGIN = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).origin : null;
if (process.env.NODE_ENV === 'production' && (!APP_ORIGIN || !APP_ORIGIN.startsWith('https://'))) throw new Error('Production requires an HTTPS APP_ORIGIN');

// Handle asynchronous errors on both streams so disconnects and upstream timeouts
// do not terminate the process.
function pipeUpstream(upstream, res) {
  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', (err) => {
    console.error(`Upstream stream error: ${safeError(err)}`);
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  });
  res.on('error', () => stream.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// Plugins execute trusted server code and are loaded only when explicitly
// configured. Failure to load a configured security/quota plugin is fatal.
const pluginsDir = process.env.FREESTUFFCRAZY_PLUGINS_DIR
  ? new URL(`${process.env.FREESTUFFCRAZY_PLUGINS_DIR.replace(/\/$/, '')}/`, import.meta.url) : null;
const externalPluginPaths = (process.env.FREESTUFFCRAZY_PLUGIN_MODULES || '').split(',').map(s => s.trim()).filter(Boolean);
const plugins = await loadConfiguredPlugins({ directory: pluginsDir, modules: externalPluginPaths });

// Saved state goes through one store: a plugin's createStore backend, or JSON files in dataDir.
const store = await openStore({ plugins, dataDir });

// The media backends (see sources.js). A session is signed in to exactly one
// of them, named in its cookie; requests use that one.
// Setup problems (no backend, a malformed JELLYFIN_URL) don't stop the server:
// the login page shows them so whoever runs it knows what to fix.
const { configured, problems: setupProblems, warnings: setupWarnings } = checkSourceConfig(process.env, plugins);
for (const problem of setupProblems) console.error(`Setup: ${problem}`);
for (const warning of setupWarnings) console.warn(`Setup: ${warning}`);
// Plugins may watch (never change) two things: a viewer signing in, and watch
// time being counted. A listener that throws is ignored; it can't affect playback.
const signInListeners = [];
const usageListeners = [];
const notify = (listeners, ...args) => { for (const listener of listeners) { try { listener(...args); } catch { /* observers cannot break the player */ } } };
const signedIn = event => notify(signInListeners, event);
const sources = await createSources({ plugins, configured, context: { config, plugins, store, pipeUpstream, signedIn } });
const sourceList = [...sources.values()];
const defaultSource = sourceList[0];
const plexSource = sourceList.find(source => source.type === 'plex') || null;
// Each source only accepts its own credential, so at most one claims a request.
const sessionSourceFor = req => sourceList.find(source => source.auth.getSessionId(req)) || null;
// Progress from a player that is still running must not undo a Mark as watched or unwatched.
const recentlyMarked = createRecentlyMarked();
const sourceFor = req => sessionSourceFor(req) || defaultSource;
// Pages and endpoints anyone may load, signed in or not.
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/safe-navigation.js', '/icons.js', '/api/auth/sources', '/api/auth/setup']);
// Plugins may list pages and APIs of their own that work without signing in
// (`publicPaths`, exact paths). They must not expose anything account-specific.
const pluginPublicPaths = new Set(plugins.flatMap(plugin => (Array.isArray(plugin.publicPaths) ? plugin.publicPaths : [])
  .filter(path => typeof path === 'string' && path.startsWith('/') && !path.startsWith('/api/admin'))));
const isPublicPath = path => PUBLIC_PATHS.has(path) || pluginPublicPaths.has(path)
  || sourceList.some(source => source.auth.isPublicPath?.(path));

const playbackSessions = createPlaybackSessions({
  maximum: config.plex.maxSessions,
  idleMs: config.plex.sessionIdleMinutes * 60000,
  // Each stream records which source started it, and that source stops it.
  stop: active => (sources.get(active.source) || defaultSource).playback.stop(active),
});
const viewerFor = req => sessionSourceFor(req)?.auth.getSessionId(req) || (!config.auth.enabled ? 'local-auth-disabled' : null);
setInterval(() => playbackSessions.prune().catch(() => console.error('Playback cleanup failed')), 60000).unref();

async function stopState(state) {
  await playbackSessions.stopState(state);
}
async function stopOwner(req) {
  await playbackSessions.stopOwner(viewerFor(req));
}

// Quota and stream limits group usage by an account key that the source
// derives from the session (plex:<account ID> for Plex). A plugin's
// getAccountKey(session, key) may still adjust it. Without any limit plugin
// there is nothing to group, so no key is computed.
const LIMIT_HOOKS = ['getAccountKey', 'getQuotaStatus', 'recordUsage', 'getStreamLimit'];
const usesAccountKeys = plugins.some(plugin => LIMIT_HOOKS.some(hook => typeof plugin[hook] === 'function'));
const accountKeyPlugin = firstPluginWith(plugins, 'getAccountKey');
async function accountKeyForRequest(req) {
  if (!usesAccountKeys) return null;
  const source = sourceFor(req);
  const key = await source.auth.getSessionAccountKey(req);
  if (!key || !accountKeyPlugin) return key;
  const session = { ...source.auth.getSessionCredential?.(req), sourceId: source.id, sourceType: source.type, accountId: await source.auth.getSessionAccountId(req) };
  return accountKeyPlugin.getAccountKey(session, key);
}

export const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) await applyTrustProxy(app, process.env.TRUST_PROXY);
// First middleware so every response -- including 400/401/403/429 rejections
// below -- gets logged, not just successful requests.
app.use(accessLog(path.join(dataDir, 'access.log')));
// Open the session cookie once per request, before anything reads it.
app.use(async (req, res, next) => {
  try {
    for (const source of sourceList) {
      await new Promise((resolve, reject) => source.auth.loadSession(req, res, error => (error ? reject(error) : resolve())));
    }
    next();
  } catch (error) {
    next(error);
  }
});
app.use(securityHeaders(new URL('./public', import.meta.url).pathname, {
  mediaOriginForRequest: req => sourceFor(req)?.playback.mediaOrigin(req) || '',
}));
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && !req.secure) return res.status(400).send('HTTPS required');
  next();
});
const extraMutatingPaths = new Set(['/api/start', '/api/playback-speed']);
app.use(sameOriginRequests(APP_ORIGIN, extraMutatingPaths));
app.use(express.json({ limit: '16kb' }));
app.use('/api/auth', rateLimit({ maximum: 300, windowMs: 600000 }));
app.use(['/api/library', '/api/plex', '/proxy'], rateLimit({ maximum: 600, windowMs: 60000 }));
app.use(['/api/start'], rateLimit({ maximum: 20, windowMs: 60000 }));

// Enable isolation only on canvas2, where shared audio buffers require it.
app.use((req, res, next) => {
  if (req.path === '/canvas2' || req.path === '/canvas2.html') {
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    res.set('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  next();
});

// With no usable backend there is nothing to sign in to: serve only the login
// page, which lists the setup problems, and refuse everything else.
if (!sourceList.length) {
  app.use((req, res, next) => {
    if (PUBLIC_PATHS.has(req.path)) return next();
    if (req.path.startsWith('/api/')) return res.status(503).json({ error: 'FreeStuffCrazy Player is not set up yet', problems: setupProblems });
    res.redirect('/login');
  });
}

// Authenticate pages, API routes and static assets unless auth is explicitly
// disabled. The signed-in source also renews its cookie here.
app.use((req, res, next) => {
  if (!config.auth.enabled) return next();
  const source = sessionSourceFor(req);
  if (source) return source.auth.requireAuth(req, res, next);
  if (isPublicPath(req.path)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect(`/login?return=${encodeURIComponent(req.originalUrl)}`);
});

// Which backends the login page should offer a button for.
app.get('/api/auth/sources', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(sourceList.map(source => ({ id: source.id, type: source.type, name: source.name, ...source.signInOptions })));
});
// Setup problems for the login page to show; they name settings, never values.
app.get('/api/auth/setup', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ problems: setupProblems });
});

// Reuse an incompressible sample so proxies can't make the download look faster
// by compressing it. This route does not open a playback session or count as playback.
const speedSample = crypto.randomBytes(1024 * 1024);
// A plugin's getStartQualityCap(req) may ask for this client to start at the
// lowest quality ('low'); the client then skips the speed sample.
const startCapPlugin = firstPluginWith(plugins, 'getStartQualityCap');
async function startQualityCap(req) {
  try {
    return (await startCapPlugin?.getStartQualityCap(req)) === 'low' ? 'low' : null;
  } catch (err) {
    console.warn(`Start-quality plugin failed: ${safeError(err)}`);
    return null;
  }
}
app.get('/api/playback-speed', rateLimit({ maximum: 20 }), async (req, res) => {
  const cap = await startQualityCap(req);
  const sample = cap ? Buffer.alloc(0) : speedSample;
  res.set({
    'Cache-Control': 'private, no-store, no-transform',
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(sample.length),
    'X-Playback-Bitrates': AUTO_QUALITY_LEVELS.map(level => qualityTiers(config.plex.videoBitrate)[level].videoBitrate).join(','),
    ...(cap ? { 'X-Playback-Start-Cap': cap } : {}),
  });
  res.end(sample);
});

// Stop this viewer's stream and watch-time lease, e.g. before switching profiles.
async function endPlayback(req) {
  await stopOwner(req);
  await watchTimeMeter.stop(viewerFor(req));
}

// Each source's own sign-in routes.
for (const source of sources.values()) source.registerRoutes(app, { rateLimit, endPlayback });

// What a browser sees of a plugin's quota status: the time left, when more
// arrives, and optional labelled rows ({ label, seconds }) explaining the
// total. Anything else the plugin returns stays on the server.
function publicQuota(quota) {
  if (!quota || !Number.isFinite(quota.remainingSeconds)) return null;
  const resetAt = typeof quota.resetAt === 'string' && Number.isFinite(Date.parse(quota.resetAt)) ? quota.resetAt : null;
  const breakdown = Array.isArray(quota.breakdown)
    ? quota.breakdown.filter(row => typeof row?.label === 'string' && row.label.trim() && Number.isFinite(row.seconds))
      .slice(0, 8).map(row => ({ label: row.label.trim().slice(0, 60), seconds: row.seconds }))
    : [];
  return { remainingSeconds: quota.remainingSeconds, resetAt, breakdown };
}

// The ID a viewer can post publicly to be found by an administrator: a keyed
// hash of the account key (see account-ids.js), so no real Plex or server
// identifier is shown. Only readable plex:/jellyfin: keys get one, never the
// token-hash fallback.
const installId = installationId();
const publicAccountIds = createPublicAccountIds(installId);
function shareableAccountId(key) {
  return typeof key === 'string' && /^(plex|jellyfin):\S+$/.test(key) ? publicAccountIds.publicId(key) : null;
}

// Backs the "who's logged in" badge on browse.html. quota is null unless a plugin defines getQuotaStatus.
app.get('/api/auth/me', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
  const source = sessionSourceFor(req);
  const user = source?.auth.getSessionUser(req);
  const server = user ? await source.auth.getSessionServer?.(req) : null;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const accountKey = await accountKeyForRequest(req);
  const quotaOwner = accountKey && firstPluginWith(plugins, 'getQuotaStatus');
  const quota = quotaOwner ? publicQuota(await quotaOwner.getQuotaStatus(accountKey)) : null;
  const profile = source.auth.getSessionProfileId(req);
  // A per-person, per-install key a plugin can use for browser-side history.
  const playbackScope = profile ? crypto.createHash('sha256').update(`${installId}:${accountKey || ''}:${profile}`).digest('hex').slice(0, 32) : null;
  res.json({ ...user, ...(server ? { server } : {}), source: { id: source.id, type: source.type, name: source.name }, profiles: typeof source.auth.listHomeUsersForSession === 'function',
    quota, playbackScope, ...(shareableAccountId(accountKey) ? { accountId: shareableAccountId(accountKey) } : {}), accountStreamInUse: await watchTimeMeter.atStreamLimit(viewerFor(req), accountKey), adminAvailable: await admin.available(req) });
  } catch (err) { res.status(502).json({ error: safeError(err) }); }
});

// Lets the client skip its "direct to the media server" playback attempt
// entirely when the server could never actually grant one (e.g. a plain-HTTP
// LAN address) -- avoids wasting a whole transcode session on an attempt
// that's guaranteed to fail before falling back.
app.get(['/api/playback/direct-capable', '/api/plex/direct-capable'], (req, res) => {
  res.json({ capable: sourceFor(req).playback.directCapable(req) });
});

// Collect frontend tabs from all configured plugins.
app.get('/api/plugin/frontend', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
  const assets = await Promise.all(plugins.map((p) => p.getFrontendAssets?.(req)));
  res.json({ scripts: assets.flatMap(a => a?.scripts || []), playerScripts: assets.flatMap(a => a?.playerScripts || []) });
  } catch (err) { res.status(502).json({ error: safeError(err) }); }
});

app.post('/api/auth/logout', async (req, res) => {
  try { await stopOwner(req); } catch { /* Login revocation must still succeed. */ }
  await watchTimeMeter.stop(viewerFor(req)).catch(() => {});
  sourceFor(req).auth.clearSession(req, res);
  res.json({ ok: true });
});

// Sessions are stateless cookies, so plain sign-out only clears this browser.
// This rejects every cookie the account was issued, on every device.
app.post('/api/auth/logout-everywhere', async (req, res) => {
  try { await stopOwner(req); } catch { /* Revocation must still succeed. */ }
  await watchTimeMeter.stop(viewerFor(req)).catch(() => {});
  try {
    const source = sessionSourceFor(req);
    if (!source) throw new Error('Not authenticated');
    await source.auth.signOutEverywhere(req, res);
    res.json({ ok: true });
  } catch (err) {
    res.status(safeError(err) === 'Not authenticated' ? 401 : 409).json({ error: safeError(err) });
  }
});

// Null when there's no quota plugin or time remains, otherwise the
// exhausted quota itself (so callers can report when it resets).
async function exceededQuota(accountKey) {
  if (!accountKey) return null;
  const quotaOwner = firstPluginWith(plugins, 'getQuotaStatus');
  const quota = await quotaOwner?.getQuotaStatus(accountKey);
  return quota && quota.remainingSeconds <= 0 ? quota : null;
}

const liveResponses = new Map();
const watchTimeMeter = createWatchTimeMeter({
  maximum: config.auth.maxSessions,
  recordUsage: async (key,seconds) => {
    await firstPluginWith(plugins,'recordUsage')?.recordUsage(key,seconds);
    notify(usageListeners,key,seconds);
  },
  getQuotaStatus: key => firstPluginWith(plugins,'getQuotaStatus')?.getQuotaStatus(key),
  getStreamLimit: key => firstPluginWith(plugins,'getStreamLimit')?.getStreamLimit(key),
});
let meteringTickRunning=false;
const meteringTimer=setInterval(async()=>{
  if(meteringTickRunning)return;
  meteringTickRunning=true;
  try{await watchTimeMeter.tick();}catch{console.error('Watch-time accounting failed');}
  finally{meteringTickRunning=false;}
},1000);
meteringTimer.unref();

async function beginWatchTime(req,res) {
  await checkPlaybackAllowed(req);
  const viewer=viewerFor(req),accountKey=await accountKeyForRequest(req);
  if(!accountKey)return;
  const playbackId=String(req.query.playbackId || 'legacy');
  if(!/^[a-zA-Z0-9-]{1,100}$/.test(playbackId))throw Error('Invalid playback ID');
  const stopPlayback = async()=>{
    for(const response of liveResponses.get(viewer) || [])response.destroy();
    liveResponses.delete(viewer);
    await stopOwner(req);
  };
  const start = await watchTimeMeter.begin({viewer,accountKey,playbackId,onExhausted:stopPlayback,onExpired:stopPlayback});
  if (start?.replaced) {
    for (const response of liveResponses.get(viewer) || []) response.destroy();
    liveResponses.delete(viewer);
    if (res) await stopOwner(req);
  }
  // Settling the previous player may have just consumed the last seconds.
  if(await exceededQuota(accountKey)) {
    const error=new Error('Playback time limit reached');error.code='QUOTA_EXCEEDED';throw error;
  }
  if(res) {
    if(!liveResponses.has(viewer))liveResponses.set(viewer,new Set());
    const responses=liveResponses.get(viewer);responses.add(res);
    res.once('close',()=>{responses.delete(res);if(!responses.size && liveResponses.get(viewer)===responses)liveResponses.delete(viewer);});
  }
}

// A deploy script needs to know whether anyone is watching, and the production
// access log no longer records playback heartbeats, so a player reporting that it
// is playing refreshes this file's modification time (at most every 10 seconds).
let lastPlaybackMark=0;
function markPlaybackActive(){
  const at=Date.now();
  if(at-lastPlaybackMark<10000)return;
  lastPlaybackMark=at;
  try{writeFileSync(path.join(dataDir,'.playback-active'),String(at),{mode:0o600});}catch{ /* only a courtesy to deploy scripts */ }
}
app.post('/api/playback/usage',async(req,res)=>{
  const {playbackId,state}=req.body || {};
  if(typeof playbackId!=='string' || !/^[a-zA-Z0-9-]{1,100}$/.test(playbackId) || !['playing','paused','stopped'].includes(state))return res.status(400).json({error:'Valid playback ID and state required'});
  if(state==='playing')markPlaybackActive();
  try {
    // Without a limit plugin nothing is metered, so beginWatchTime never
    // registered this playback; there is no session that could have expired.
    if(!(await accountKeyForRequest(req)))return res.json({ok:true,quota:null});
    const result=await watchTimeMeter.heartbeat(viewerFor(req),playbackId,state);
    if(result.exhausted)return res.status(403).json({error:'Playback time limit reached',code:'QUOTA_EXCEEDED',resetAt:result.quota?.resetAt});
    if(result.expired){if(PLAYBACK_DIAGNOSTICS)console.warn('[playback-lease] expired',playbackId);return res.status(409).json({error:'Playback heartbeat expired',code:'PLAYBACK_EXPIRED'});}
    if(result.stale){
      const code=result.replaced?'ACCOUNT_STREAM_LIMIT':'PLAYBACK_EXPIRED';
      if(PLAYBACK_DIAGNOSTICS)console.warn('[playback-lease] stale',playbackId,code);
      return res.status(409).json({error:'Playback session changed',code});
    }
    res.json({ok:true,quota:publicQuota(result.quota)});
  }catch{res.status(503).json({error:'Unable to update watch time'});}
});

// Extra audio-output diagnostics are kept only outside production.
const PLAYBACK_DIAGNOSTICS = process.env.NODE_ENV !== 'production';
app.get('/api/playback/diagnostics', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ enabled: PLAYBACK_DIAGNOSTICS });
});

// Canvas diagnostics are sampled by the player; accept only fixed, bounded fields.
app.post('/api/playback/canvas-health', rateLimit({ maximum: 12, windowMs: 60000 }), (req, res) => {
  const body = req.body || {};
  if (typeof body.playbackId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(body.playbackId)
    || !['loading', 'paused', 'playing', 'buffering', 'ended', 'error'].includes(body.state)) return res.status(400).end();
  const fields = ['mediaTime', 'videoTime', 'videoQueueLength', 'videoDecodeCount', 'videoRenderCount',
    'videoDropCount', 'audioAvailableSeconds', 'audioUnderrunCount', 'audioConsumedFrames', 'audioPacketCount',
    'audioDecodeWaitMs', 'audioWriteWaitMs', 'heapBytes',
    'segmentCount', 'segmentBytes', 'segmentFetchMs', 'segmentSlowestMs'];
  if (PLAYBACK_DIAGNOSTICS) {
    fields.push('audioSampleRate', 'audioBaseLatency', 'audioOutputLatency', 'audioResumeMs', 'audioGain', 'audioLimiterOn', 'audioResumeTimeouts',
      'audioStateChanges', 'audioRestarts', 'audioOutputContextTime', 'audioOutputPerfTime',
      'segmentWaitMs', 'segmentWaitSlowestMs', 'mainThreadMaxLagMs', 'mainThreadLagCount', 'longTaskCount', 'longTaskMs', 'mediaPlayActions', 'mediaPauseActions', 'mediaNextActions', 'mediaPreviousActions', 'mediaSeekActions', 'mediaClipPlaying');
  }
  const metrics = {};
  for (const field of fields) {
    const value = body[field];
    if (value == null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12) return res.status(400).end();
    metrics[field] = value;
  }
  // Recent media-key presses (action:player state:seconds ago), for non-production diagnostics only.
  if (PLAYBACK_DIAGNOSTICS && typeof body.mediaActionLog === 'string'
    && /^[a-z]{1,16}:[a-z]{1,10}:\d{1,4}\.\d(,[a-z]{1,16}:[a-z]{1,10}:\d{1,4}\.\d){0,11}$/.test(body.mediaActionLog)) {
    metrics.mediaActionLog = body.mediaActionLog;
  }
  if (body.audioContextState != null) {
    if (!['none', 'suspended', 'running', 'closed', 'interrupted'].includes(body.audioContextState)) return res.status(400).end();
    metrics.audioContextState = body.audioContextState;
  }
  // A device ID in an unexpected shape is skipped, not a reason to drop the report.
  if (PLAYBACK_DIAGNOSTICS && typeof body.audioSinkId === 'string' && /^(type:)?[\w.:-]{0,100}$/.test(body.audioSinkId)) {
    metrics.audioSinkId = body.audioSinkId;
  }
  // Why a stream failed, for the log; anything not plain printable text is skipped.
  if (body.state === 'error' && typeof body.error === 'string' && /^[\x20-\x7e]{1,160}$/.test(body.error)) {
    metrics.error = body.error;
  }
  if (body.quality != null) {
    if (!QUALITY_LEVELS.includes(body.quality)) return res.status(400).end();
    metrics.quality = body.quality;
  }
  const line = JSON.stringify({ at: new Date().toISOString(), playbackId: body.playbackId, state: body.state,
    live: body.live === true, ...metrics });
  // In production only the reports that matter are kept: every failure on the
  // console, and every report that is not a healthy "playing" sample in the file.
  // Outside production every report goes to both, for debugging.
  if (PLAYBACK_DIAGNOSTICS || body.state === 'error') console.info('[canvas-health]', line);
  if (PLAYBACK_DIAGNOSTICS || body.state !== 'playing') {
    try {
      const logPath = path.join(dataDir, 'canvas-health.log');
      if (existsSync(logPath) && statSync(logPath).size > 1024 * 1024) writeFileSync(logPath, '', { mode: 0o600 });
      appendFileSync(logPath, line + '\n', { mode: 0o600 });
    } catch (err) { console.warn(`Could not write Canvas health log: ${safeError(err)}`); }
  }
  res.status(204).end();
});

// Per-account quota preflight, entirely plugin-driven -- a no-op when no
// plugin defines getQuotaStatus. The stream limit is enforced by watchTimeMeter.begin.
async function checkPlaybackAllowed(req) {
  const accountKey = await accountKeyForRequest(req);
  if (!accountKey) return;
  const quota = await exceededQuota(accountKey);
  if (quota) {
    const err = new Error('Playback time limit reached'); err.code = 'QUOTA_EXCEEDED'; err.resetAt = quota.resetAt; throw err;
  }
}

app.get('/api/start', async (req, res) => {
  const source = sourceFor(req);
  const itemId = req.query.key || ITEM_KEY;
  if (!source.isValidId(itemId)) return res.status(400).json({ error: 'Valid item key required' });
  try {
    await beginWatchTime(req);
    await playbackSessions.run(viewerFor(req), async state => {
      await stopState(state);
      try { await source.playback.start(req, res, { itemId, state, stopState }); }
      catch (error) { await stopState(state); throw error; }
    });
  } catch (err) { res.status(err.code ? 403 : 503).json({ error: err.code === 'ACCOUNT_STREAM_LIMIT' ? 'Account stream limit reached' : safeError(err), code: err.code, resetAt: err.resetAt }); }
});

// Plugin route registration -- runs after every core middleware above, so
// plugin routes are gated/rate-limited the same way without doing it themselves.
// The one admin named in FREESTUFFCRAZY_ADMIN (see admin-auth.js) may unlock the
// admin area; the signed-in source recognizes whether that's this user.
const admin = registerAdmin(app, {
  identityFor: async req => {
    const source = sessionSourceFor(req);
    const identity = await source?.auth.getAdminIdentity?.(req);
    return identity ? { ...identity, sessionId: source.auth.getSessionId(req) } : null;
  },
  rateLimit, store, appOrigin: APP_ORIGIN,
});
const pluginRouteContext = {
  ...plexSource?.legacyPluginContext,
  sourceFor, sources, accountKeyForRequest,
  // Find and name accounts by their limit key, whatever the backend.
  accounts: createAccountDirectory(sources, { publicIds: publicAccountIds }),
  playbackSessions, stopState, stopOwner,
  viewerFor, mediaProxyPath, rateLimit, config, checkPlaybackAllowed,
  safeError, pipeUpstream,
  accountIdForRequest: req => sourceFor(req).auth.getSessionAccountId(req),
  // Save plugin state through store.collection(name); dataDir is for logs and caches only.
  dataDir, store, admin,
  beginWatchTime,
  // Read-only views for stats plugins: sign-ins ({ sourceType, userKey }), watch
  // time as it is counted (accountKey, seconds), and who is playing right now.
  onSignIn: listener => { if (typeof listener === 'function') signInListeners.push(listener); },
  onUsage: listener => { if (typeof listener === 'function') usageListeners.push(listener); },
  activeStreams: () => watchTimeMeter.activeStreams(),
  markMutatingPath: (p) => extraMutatingPaths.add(p),
};
for (const p of plugins) await p.registerRoutes?.(app, pluginRouteContext);

app.get('/proxy/*', (req, res) => sourceFor(req).playback.proxy(req, res, {
  ownsSession: sessionId => playbackSessions.owns(viewerFor(req), sessionId),
}));

// Library browsing and watch state for the signed-in source. /api/plex is the
// original path and stays as an alias.
const library = express.Router();
library.param('id', (req, res, next, id) => {
  if (!sourceFor(req).isValidId(id)) return res.status(400).json({ error: 'Invalid identifier' });
  next();
});
const libraryRoute = (read) => async (req, res) => {
  try {
    res.json(await read(sourceFor(req).library(req), req));
  } catch (err) {
    // A server plugin may explain a failure for the viewer (userMessage), and
    // mark a server that can't be reached through this session again
    // (serverGone): that session ends, and the page offers to sign in again.
    if (typeof err?.userMessage === 'string') {
      const error = err.userMessage.slice(0, 300);
      if (err.serverGone) {
        sourceFor(req).auth.clearSession(req, res);
        return res.status(401).json({ error, code: 'SERVER_GONE' });
      }
      const status = Number.isInteger(err.status) && err.status >= 500 && err.status < 600 ? err.status : 503;
      return res.status(status).json({ error, code: 'SERVER_UNAVAILABLE' });
    }
    res.status(502).json({ error: safeError(err) });
  }
};
library.get('/libraries', libraryRoute(lib => lib.libraries()));
library.get('/library/:id', libraryRoute((lib, req) => lib.libraryItems(req.params.id, { sort: req.query.sort })));
library.get('/library/:id/recentlyadded', libraryRoute((lib, req) => lib.recentlyAdded(req.params.id)));
library.get('/show/:id/episodes', libraryRoute((lib, req) => lib.showEpisodes(req.params.id)));
library.get('/show/:id/seasons', libraryRoute((lib, req) => lib.showSeasons(req.params.id)));
library.get('/season/:id/episodes', libraryRoute((lib, req) => lib.seasonEpisodes(req.params.id)));
library.get('/item/:id', libraryRoute((lib, req) => lib.itemDetails(req.params.id)));
library.get('/ondeck', libraryRoute(lib => lib.continueWatching()));
// The episode after this one, and how far in the item counts as watched -- the
// player offers Play Next from that point and moves on by itself at the end.
library.get('/next/:id', libraryRoute(async (lib, req) => {
  const source = sourceFor(req);
  const watchedAt = source.watchState.watchedFraction?.(req) ?? 0.9;
  const details = await lib.itemDetails(req.params.id);
  const showId = details.type === 'episode' ? showIdFromKey(details.grandparentKey) : null;
  if (!showId || !source.isValidId(showId)) return { next: null, watchedAt };
  return { next: nextEpisodeAfter(await lib.showEpisodes(showId), req.params.id), watchedAt };
}));
library.get('/search', (req, res, next) => (req.query.q ? next() : res.status(400).json({ error: 'q required' })),
  libraryRoute((lib, req) => lib.search(req.query.q)));
library.get('/thumb', (req, res) => sourceFor(req).sendThumbnail(req, res));

// Playback accounting uses /api/playback/usage; progress here is watch state only.
library.post('/progress', async (req, res) => {
  const source = sourceFor(req);
  const { ratingKey, timeMs, state, durationMs } = req.body || {};
  if (!source.isValidId(String(ratingKey)) || !Number.isFinite(timeMs) || timeMs < 0) return res.status(400).json({ error: 'ratingKey and timeMs required' });
  try {
    // Heartbeats are the only point mid-stream where we hear from an active
    // viewer, so this is also where a quota that ran out *during* playback
    // gets caught -- checkPlaybackAllowed only gatekeeps new streams.
    const quota = await exceededQuota(await accountKeyForRequest(req));
    if (quota) {
      await stopOwner(req);
      return res.status(403).json({ error: 'Playback time limit reached', code: 'QUOTA_EXCEEDED', resetAt: quota.resetAt });
    }
    if (recentlyMarked.isRecent(await accountKeyForRequest(req), String(ratingKey))) return res.json({ ok: true, ignored: true });
    await source.watchState.reportProgress(req, { itemId: String(ratingKey), timeMs, state, durationMs });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: safeError(err) });
  }
});

for (const [route, mark] of [['/watched/:id', 'markWatched'], ['/unwatched/:id', 'markUnwatched']]) {
  library.post(route, async (req, res) => {
    try {
      await sourceFor(req).watchState[mark](req, req.params.id);
      const scope = await accountKeyForRequest(req);
      recentlyMarked.mark(scope, req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: safeError(err) });
    }
  });
}
app.use(['/api/library', '/api/plex'], library);

// Serve the pinned player dependency locally (compatible with COEP and offline LAN use).
app.get('/vendor/hls.mjs', (_req, res) => {
  res.sendFile('node_modules/hls.js/dist/hls.mjs', { root: process.cwd() });
});

// Use browse.html as the landing page.
app.get('/', (_req, res) => res.redirect('/browse'));
// Accept both extensionless page URLs and explicit .html paths.
app.use(express.static('public', { extensions: ['html'] }));

app.use((err, req, res, next) => {
  if (res.headersSent) return res.destroy();
  res.status(err.type === 'entity.too.large' ? 413 : 400).json({ error: 'Invalid request' });
});

// Use a checkout-level lock to prevent stale instances on different ports.
const PID_FILE = path.join(dataDir, '.server.pid');

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  if (existsSync(PID_FILE)) {
    const stalePid = Number(readFileSync(PID_FILE, 'utf8').trim());
    // In a container the server is always pid 1, so a lock left by a killed
    // container names this very process; only another live pid is a conflict.
    if (stalePid && stalePid !== process.pid && processAlive(stalePid)) {
      console.error(
        `Another FreeStuffCrazy Player server (pid ${stalePid}) is already running from this checkout. ` +
        `Stop it before starting a new one -- otherwise it'll keep answering requests with stale code.`
      );
      process.exit(1);
    }
  }
  writeFileSync(PID_FILE, String(process.pid));
}

function releaseLock() {
  try {
    if (Number(readFileSync(PID_FILE, 'utf8').trim()) === process.pid) unlinkSync(PID_FILE);
  } catch { /* already gone */ }
}

export function startServer() {
  acquireLock();
  const server = app.listen(PORT, HOST, () => {
    console.log(`FreeStuffCrazy Player listening on http://${HOST}:${PORT}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} on ${HOST} is already in use -- another process (possibly a stale FreeStuffCrazy Player instance) is bound to it.`);
      releaseLock();
      process.exit(1);
    }
    throw err;
  });
  async function shutdown() {
    server.close();
    releaseLock();
    clearInterval(meteringTimer);
    await watchTimeMeter.close();
    await playbackSessions.close();
    await Promise.all(plugins.map(plugin=>plugin.flush?.()));
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startServer();
