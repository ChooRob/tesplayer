// Adapted from drive-in (server/index.js Plex API routes + server/plex-thumbnails.js),
// trimmed: no disk cache for thumbnails, no retry wrapper.

import { plexDeviceHeaders } from './plex-connection.js';
import { describeTrack, orderTracks, toWebVtt, readSubtitleText, TEXT_FORMATS, TRACK_ID } from './subtitles.js';

const THUMBNAIL_PRESETS = {
  landscape: { width: 600, height: 338 },
  poster: { width: 390, height: 585 },
  backdrop: { width: 1280, height: 720 },
};

export function createPlexLibrary({ plexUrl, token, clientId, productName = 'FreeStuffCrazy Player' }) {
  // Without a client identifier, two different profiles' requests are
  // indistinguishable to Plex beyond the token itself. For ordinary reads
  // that's fine, but hub/shelf endpoints like /hubs/sections/{id} (see
  // hubContinueWatching below) are exactly the kind of personalized,
  // possibly server-cached response where that ambiguity is risky --
  // sending a distinct, per-profile identifier removes it rather than
  // relying on Plex keying correctly off the token alone.
  async function plexApi(path) {
    const headers = { Accept: 'application/json', 'X-Plex-Token': token, ...plexDeviceHeaders(productName) };
    if (clientId) headers['X-Plex-Client-Identifier'] = clientId;
    const res = await fetch(`${plexUrl}${path}`, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Plex API ${res.status}: ${res.statusText}`);
    return res.json();
  }

  function thumbnailProxyUrl(path, preset = 'landscape') {
    if (!path) return null;
    const dimensions = THUMBNAIL_PRESETS[preset];
    const params = new URLSearchParams({ path, width: String(dimensions.width), height: String(dimensions.height) });
    return `/api/library/thumb?${params}`;
  }

  function thumbnailUpstreamUrl(path, width, height) {
    const plexBase = new URL(plexUrl);
    const source = new URL(path, plexBase);
    if (source.origin !== plexBase.origin || source.search || !/^\/library\/metadata\/\d+\/(?:thumb|art|banner)(?:\/\d+)?$/.test(source.pathname)) throw new TypeError('Invalid Plex thumbnail path');
    const upstream = new URL('/photo/:/transcode', plexBase);
    upstream.searchParams.set('width', String(width));
    upstream.searchParams.set('height', String(height));
    upstream.searchParams.set('minSize', '1');
    upstream.searchParams.set('upscale', '0');
    upstream.searchParams.set('url', `${source.pathname}${source.search}`);
    return upstream;
  }

  async function libraries() {
    const data = await plexApi('/library/sections');
    return data.MediaContainer.Directory.map((d) => ({ id: d.key, title: d.title, type: d.type }));
  }

  async function libraryItems(id, { sort = 'addedAt:desc', start = 0, size } = {}) {
    const sizeParam = size ? `&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}` : '';
    const data = await plexApi(`/library/sections/${encodeURIComponent(id)}/all?sort=${encodeURIComponent(sort)}${sizeParam}`);
    const items = (data.MediaContainer.Metadata || []).map((m) => {
      const media = m.Media?.[0];
      return {
        ratingKey: m.ratingKey,
        title: m.title,
        year: m.year,
        type: m.type,
        thumbnail: thumbnailProxyUrl(m.thumb, 'poster'),
        duration: m.duration ? Math.round(m.duration / 60000) : null,
        durationMs: m.duration || null,
        viewOffset: m.viewOffset || 0,
        videoCodec: media?.videoCodec,
        audioCodec: media?.audioCodec,
        resolution: media ? `${media.width}x${media.height}` : null,
        childCount: m.childCount,
        leafCount: m.leafCount,
        viewedLeafCount: m.viewedLeafCount || 0,
      };
    });
    return { total: data.MediaContainer.totalSize, items };
  }

  async function showEpisodes(id) {
    const data = await plexApi(`/library/metadata/${encodeURIComponent(id)}/allLeaves`);
    return (data.MediaContainer.Metadata || []).map(mapEpisode);
  }

  function mapEpisode(m) {
    const media = m.Media?.[0];
    return {
      ratingKey: m.ratingKey,
      title: m.title,
      season: m.parentIndex,
      episode: m.index,
      duration: m.duration ? Math.round(m.duration / 60000) : null,
      durationMs: m.duration || null,
      viewOffset: m.viewOffset || 0,
      thumbnail: thumbnailProxyUrl(m.thumb, 'landscape'),
      videoCodec: media?.videoCodec,
    };
  }

  // A show's direct children are its seasons.
  async function showSeasons(id) {
    const data = await plexApi(`/library/metadata/${encodeURIComponent(id)}/children`);
    return (data.MediaContainer.Metadata || []).map((m) => ({
      ratingKey: m.ratingKey,
      type: 'season',
      title: m.title,
      index: m.index,
      showRatingKey: m.parentRatingKey,
      showTitle: m.parentTitle,
      thumbnail: thumbnailProxyUrl(m.thumb, 'poster'),
      leafCount: m.leafCount,
      viewedLeafCount: m.viewedLeafCount || 0,
    }));
  }

  // A season's direct children are its episodes.
  async function seasonEpisodes(id) {
    const data = await plexApi(`/library/metadata/${encodeURIComponent(id)}/children`);
    return (data.MediaContainer.Metadata || []).map(mapEpisode);
  }

  // Full metadata for the details screen shown before a fresh (non-resume) play.
  async function itemDetails(id) {
    const data = await plexApi(`/library/metadata/${encodeURIComponent(id)}`);
    const m = (data.MediaContainer.Metadata || [])[0];
    if (!m) throw new Error('Item not found');
    const media = m.Media?.[0];
    return {
      ratingKey: m.ratingKey,
      type: m.type,
      librarySectionId: m.librarySectionID != null ? String(m.librarySectionID) : null,
      title: m.title,
      showTitle: m.grandparentTitle || null,
      // Keep season and show references for next-up reconstruction.
      parentKey: m.parentKey || null,
      grandparentKey: m.grandparentKey || null,
      season: m.parentIndex,
      episode: m.index,
      year: m.year,
      summary: m.summary || '',
      contentRating: m.contentRating || null,
      audienceRating: m.audienceRating || m.rating || null,
      genres: (m.Genre || []).map((g) => g.tag),
      duration: m.duration ? Math.round(m.duration / 60000) : null,
      durationMs: m.duration || null,
      viewOffset: m.viewOffset || 0,
      thumbnail: thumbnailProxyUrl(m.thumb, 'poster'),
      backdrop: thumbnailProxyUrl(m.art || m.thumb, 'backdrop'),
      videoCodec: media?.videoCodec,
      resolution: media ? `${media.width}x${media.height}` : null,
    };
  }

  // An item's subtitle streams. One Plex can hand over as a text file (an external
  // SubRip file) is `text`; the rest, including every one inside the video file, can
  // only be drawn into the picture by the transcoder, so they are `burn`.
  async function subtitleStreams(id) {
    const data = await plexApi(`/library/metadata/${encodeURIComponent(id)}`);
    const part = data.MediaContainer.Metadata?.[0]?.Media?.[0]?.Part?.[0];
    return (part?.Stream || []).filter(stream => stream.streamType === 3 && TRACK_ID.test(String(stream.id)));
  }

  async function subtitleTracks(id) {
    return orderTracks((await subtitleStreams(id)).map(stream => describeTrack({
      id: stream.id,
      label: stream.displayTitle || stream.extendedDisplayTitle || stream.language,
      language: stream.languageCode || stream.languageTag,
      kind: typeof stream.key === 'string' && stream.key.startsWith('/library/streams/') && TEXT_FORMATS.has(String(stream.codec || stream.format).toLowerCase()) ? 'text' : 'burn',
      forced: stream.forced === true || stream.forced === 1,
      isDefault: stream.default === true || stream.default === 1,
    })));
  }

  // A text track as WebVTT. Only one of this item's own streams can be asked for.
  async function subtitleText(id, trackId) {
    const stream = (await subtitleStreams(id)).find(candidate => String(candidate.id) === String(trackId));
    if (!stream || typeof stream.key !== 'string' || !stream.key.startsWith('/library/streams/')
      || !TEXT_FORMATS.has(String(stream.codec || stream.format).toLowerCase())) return null;
    const headers = { 'X-Plex-Token': token, ...plexDeviceHeaders(productName) };
    if (clientId) headers['X-Plex-Client-Identifier'] = clientId;
    const res = await fetch(`${plexUrl}${stream.key}`, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!res.ok) { await res.body?.cancel(); throw new Error(`Plex subtitle ${res.status}`); }
    return toWebVtt(await readSubtitleText(res));
  }

  // Normalize section hubs, including seasons mixed into Recently Added.
  function mapHubItem(m) {
    const isEpisode = m.type === 'episode';
    const isSeason = m.type === 'season';
    return {
      ratingKey: m.ratingKey,
      type: m.type,
      librarySectionId: m.librarySectionID != null ? String(m.librarySectionID) : null,
      title: m.title,
      year: m.year,
      season: isEpisode ? m.parentIndex : undefined,
      episode: isEpisode ? m.index : undefined,
      showTitle: isEpisode ? m.grandparentTitle : (isSeason ? m.parentTitle : undefined),
      showRatingKey: isSeason ? m.parentRatingKey : undefined,
      thumbnail: thumbnailProxyUrl(m.thumb, isEpisode ? 'landscape' : 'poster'),
      duration: m.duration ? Math.round(m.duration / 60000) : null,
      durationMs: m.duration || null,
      viewOffset: m.viewOffset || 0,
      leafCount: m.leafCount,
      viewedLeafCount: m.viewedLeafCount || 0,
    };
  }

  async function sectionHubItems(sectionId, pattern, { count = 12 } = {}) {
    const data = await plexApi(`/hubs/sections/${encodeURIComponent(sectionId)}?count=${count}&includeMeta=1`);
    const hub = (data.MediaContainer.Hub || []).find((h) => pattern.test(h.hubIdentifier || ''));
    return hub?.Metadata || [];
  }

  // Read section-level Continue Watching with the requesting profile’s token.
  async function hubContinueWatching() {
    const sectionsData = await plexApi('/library/sections');
    const sectionIds = (sectionsData.MediaContainer.Directory || [])
      .filter((d) => d.type === 'movie' || d.type === 'show')
      .map((d) => d.key);

    const results = [];
    for (const id of sectionIds) {
      try {
        const items = await sectionHubItems(id, /inprogress/i);
        for (const m of items) results.push({ ...mapHubItem(m), lastViewedAt: m.lastViewedAt || 0 });
      } catch {
        // One section's hub lookup failed -- skip it, same as other
        // best-effort spots, rather than losing every other section's.
      }
    }
    results.sort((a, b) => b.lastViewedAt - a.lastViewedAt);
    return results.map(({ lastViewedAt, ...rest }) => rest);
  }

  // Read Recently Added from the section’s hubs.
  async function recentlyAdded(sectionId, { count = 12 } = {}) {
    const items = await sectionHubItems(sectionId, /recentlyadded/i, { count });
    return items.map(mapHubItem);
  }

  // PMS account IDs may differ from Home IDs; use stable IDs or explicit mappings.
  async function accounts() {
    const data = await plexApi('/accounts');
    return (data.MediaContainer.Account || []).map((a) => ({ id: String(a.id), name: a.name }));
  }

  // Read completed playback history scoped to a PMS account ID.
  async function historyForAccount(accountId, { limit = 100 } = {}) {
    const data = await plexApi(`/status/sessions/history/all?accountID=${encodeURIComponent(accountId)}&sort=viewedAt:desc&X-Plex-Container-Size=${limit}`);
    return data.MediaContainer.Metadata || [];
  }

  function parseMetadataId(key) {
    const m = /\/library\/metadata\/(\d+)/.exec(key || '');
    return m ? m[1] : null;
  }

  // Reconstruct next-up from completed episodes, merging Plex history with local
  // completions and keeping the newest record per show.
  async function continueWatchingForAccount(accountId, { limit = 20, localFinished = {} } = {}) {
    const history = await historyForAccount(accountId, { limit: 200 });

    const perShow = new Map(); // grandparentKey -> { parentKey, ratingKey, grandparentTitle, librarySectionId, updatedAt }
    for (const entry of history) {
      if (entry.type !== 'episode' || !entry.grandparentKey) continue;
      if (perShow.has(entry.grandparentKey)) continue; // sorted desc -- first hit is newest
      perShow.set(entry.grandparentKey, {
        parentKey: entry.parentKey,
        ratingKey: entry.ratingKey,
        grandparentTitle: entry.grandparentTitle,
        librarySectionId: entry.librarySectionID,
        updatedAt: entry.viewedAt * 1000, // Plex history timestamps are in seconds
      });
    }
    for (const [grandparentKey, local] of Object.entries(localFinished)) {
      const existing = perShow.get(grandparentKey);
      if (!existing || local.updatedAt > existing.updatedAt) {
        perShow.set(grandparentKey, {
          parentKey: local.parentKey,
          ratingKey: local.ratingKey,
          grandparentTitle: local.grandparentTitle,
          librarySectionId: local.librarySectionId,
          updatedAt: local.updatedAt,
        });
      }
    }

    const candidates = [...perShow.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);

    const results = [];
    for (const entry of candidates) {
      const seasonId = parseMetadataId(entry.parentKey);
      if (!seasonId) continue;
      try {
        const episodes = await seasonEpisodes(seasonId);
        const idx = episodes.findIndex((e) => e.ratingKey === entry.ratingKey);
        const next = idx >= 0 ? episodes[idx + 1] : null;
        if (!next) continue;
        results.push({
          ...next,
          type: 'episode',
          librarySectionId: entry.librarySectionId != null ? String(entry.librarySectionId) : null,
          showTitle: entry.grandparentTitle,
          viewOffset: 0,
        });
      } catch {
        // Season/episode lookup failed (deleted since watched, etc) -- skip.
      }
    }
    return results;
  }

  async function search(query) {
    const data = await plexApi(`/hubs/search?query=${encodeURIComponent(query)}&limit=10`);
    const results = [];
    for (const hub of data.MediaContainer.Hub || []) {
      for (const m of hub.Metadata || []) {
        results.push({
          ratingKey: m.ratingKey,
          title: m.title,
          year: m.year,
          type: m.type,
          thumbnail: thumbnailProxyUrl(m.thumb, 'poster'),
        });
      }
    }
    return results;
  }

  return {
    subtitleTracks, subtitleText,
    libraries, libraryItems, showEpisodes, showSeasons, seasonEpisodes, itemDetails, hubContinueWatching, recentlyAdded, search, thumbnailUpstreamUrl,
    accounts, historyForAccount, continueWatchingForAccount,
  };
}
