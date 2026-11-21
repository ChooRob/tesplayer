import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.SESSION_SECRET ||= 'test-only-secret-with-at-least-32-characters';
const { createPlexLibrary } = await import('../plex-library.js');

// Music as a source presents it: an artist holds albums and an album holds tracks, the way a
// show holds seasons and a season holds episodes, so the browse screens are shared.
const ARTIST = { ratingKey: '100', type: 'artist', title: 'The Band', titleSort: 'Band', thumb: '/library/metadata/100/thumb/1', childCount: 2, leafCount: 20 };
const ALBUM = { ratingKey: '200', type: 'album', title: 'First Record', year: 1999, parentRatingKey: '100', parentTitle: 'The Band', thumb: '/library/metadata/200/thumb/2', leafCount: 10, index: 1 };
const TRACK = {
  ratingKey: '300', type: 'track', title: 'Opening', index: 1, parentIndex: 1, duration: 215000, viewOffset: 0,
  parentTitle: 'First Record', grandparentTitle: 'The Band', originalTitle: 'The Band feat. Guest',
  parentRatingKey: '200', grandparentRatingKey: '100', parentKey: '/library/metadata/200', grandparentKey: '/library/metadata/100',
  thumb: '/library/metadata/300/thumb/3', parentThumb: '/library/metadata/200/thumb/2', Media: [{ audioCodec: 'flac', Part: [{ key: '/library/parts/1/1/file.flac', Stream: [{ id: 54, streamType: 2 }, { id: 55, streamType: 4, provider: 'com.plexapp.agents.lyricfind', timed: 1 }, { id: 56, streamType: 4, format: 'txt' }] }] }],
};
const answers = {
  '/library/sections': { MediaContainer: { Directory: [{ key: '1', title: 'Movies', type: 'movie' }, { key: '5', title: 'Music', type: 'artist' }] } },
  '/library/sections/5/all': { MediaContainer: { totalSize: 1, Metadata: [ARTIST] } },
  '/library/metadata/100/children': { MediaContainer: { Metadata: [ALBUM] } },
  '/library/metadata/700/children': { MediaContainer: { Metadata: [{ ratingKey: '701', type: 'album', title: '', titleSort: 'Razors Edge', parentTitle: 'AC/DC', year: 1990 }, { ratingKey: '702', type: 'album', title: 'Back In Black', titleSort: 'Back In Black' }] } },
  '/library/metadata/710/children': { MediaContainer: { Metadata: [] } },
  '/library/metadata/710/related': { MediaContainer: { Hub: [
    { title: 'Compilations', hubIdentifier: 'artist.albums.compilation', Metadata: [{ ratingKey: '711', type: 'album', title: 'So Far So Good', year: 1993, parentRatingKey: '710', parentTitle: 'Bryan Adams' }] },
    { title: 'Singles & EPs', hubIdentifier: 'artist.albums.singles' },
    { title: 'Similar Artists', hubIdentifier: 'artist.similar', Metadata: [{ ratingKey: '9', type: 'artist', title: 'Someone' }] },
  ] } },
  '/library/metadata/200/children': { MediaContainer: { Metadata: [TRACK] } },
  '/library/metadata/300': { MediaContainer: { Metadata: [TRACK] } },
  '/library/metadata/100': { MediaContainer: { Metadata: [ARTIST] } },
  '/hubs/sections/5': { MediaContainer: { Hub: [{ hubIdentifier: 'music.recent.albums', Metadata: [ALBUM] }, { hubIdentifier: 'recentlyadded.5', Metadata: [{ ...ALBUM, ratingKey: '201', title: 'Second Record' }] }] } },
  '/playlists': { MediaContainer: { Metadata: [{ ratingKey: 900, type: 'playlist', title: 'Fun', composite: '/playlists/900/composite/123', leafCount: 2, duration: 427000 }] } },
  '/playlists/900/items': { MediaContainer: { Metadata: [{ ...TRACK, ratingKey: '301', index: 7, title: 'Complicated' }, { ...TRACK, ratingKey: '302', index: 3, title: 'Sk8er Boi' }, { ratingKey: '9', type: 'movie', title: 'Not music' }] } },
  '/library/metadata/100/similar': { MediaContainer: { Metadata: [
    { ratingKey: '101', type: 'artist', title: 'Frida', thumb: '/library/metadata/101/thumb/1', leafCount: 12 },
    { ratingKey: '102', type: 'artist', title: 'Donna Summer', thumb: '/library/metadata/102/thumb/1' },
    { ratingKey: '100', type: 'artist', title: 'The Band itself' },
    { type: 'artist', title: 'Not in the library' },
  ] } },
  '/library/metadata/100/related': { MediaContainer: { Hub: [
    { hubIdentifier: 'artist.albums', title: 'Albums', Metadata: [ALBUM] },
    { hubIdentifier: 'artist.sonicallysimilar', title: 'Sonically Similar Artists', Metadata: [
      { ratingKey: '101', type: 'artist', title: 'Frida' }, { ratingKey: '103', type: 'artist', title: 'Roxette', thumb: '/library/metadata/103/thumb/1' },
    ] },
  ] } },
  '/library/metadata/100/popularLeaves': { MediaContainer: { Metadata: [
    { ...TRACK, ratingKey: '311', index: 5, title: 'Dancing Queen' }, { ...TRACK, ratingKey: '312', index: 9, title: 'Mamma Mia' }, { ratingKey: '8', type: 'album', title: 'Not a track' },
  ] } },
  '/library/metadata/300/nearest': { MediaContainer: { Metadata: [
    { ...TRACK, ratingKey: '300', title: 'The same track' },
    { ...TRACK, ratingKey: '501', title: 'Sounds Alike', index: 4 },
    { ...TRACK, ratingKey: '502', title: 'Also Close', index: 9 },
    { ratingKey: '9', type: 'album', title: 'Not a track' },
  ] } },
  '/albums': { MediaContainer: { totalSize: 3, Metadata: [ALBUM] } },
  '/tracks': { MediaContainer: { totalSize: 120, Metadata: [TRACK] } },
  '/library/sections/5/genre': { MediaContainer: { Directory: [{ key: '31', title: 'Rock' }, { key: '30', title: 'Jazz' }] } },
  '/hubs/search': { MediaContainer: { Hub: [{ Metadata: [ARTIST, ALBUM, TRACK] }] } },
};
const originalFetch = globalThis.fetch;
const asked = [];
globalThis.fetch = async value => {
  const url = new URL(value);
  asked.push(url.pathname + url.search);
  // Lyric streams: the first has times and is served as XML; the second only answers without a format.
  if (url.pathname === '/library/streams/55') return new Response('<MediaContainer><Lyrics><Line startOffset="1000"><Span>Hello there</Span></Line><Line startOffset="4000"><Span>General &amp; Kenobi</Span></Line></Lyrics></MediaContainer>');
  if (url.pathname === '/library/streams/56') return url.searchParams.has('format') ? new Response('', { status: 404 }) : new Response('Plain words\nMore words');
  const body = answers[url.pathname === '/library/sections/5/all' && url.searchParams.get('type') === '9' ? '/albums'
    : url.pathname === '/library/sections/5/all' && url.searchParams.get('type') === '10' ? '/tracks' : url.pathname];
  if (!body) return new Response('{}', { status: 404 });
  return Response.json(body);
};
test.after(() => { globalThis.fetch = originalFetch; });
const library = createPlexLibrary({ plexUrl: 'http://plex.example:32400', token: 't', clientId: 'c' });
const sized = (key, size) => `/api/library/thumb?path=${encodeURIComponent(key)}&width=${size}&height=${size}`;
const squareThumb = key => sized(key, 320);

test('a music library is a "music" library, whatever Plex calls it', async () => {
  assert.deepEqual(await library.libraries(), [
    { id: '1', title: 'Movies', type: 'movie' },
    { id: '5', title: 'Music', type: 'music', views: [{ id: 'artists', label: 'Artists' }, { id: 'albums', label: 'Albums' }, { id: 'tracks', label: 'Tracks' }, { id: 'genres', label: 'Genres' }] },
  ]);
});

test('a music library with no genres does not offer the Genres view', async () => {
  const key = '/library/sections/5/genre';
  const had = answers[key];
  answers[key] = { MediaContainer: { Directory: [] } };
  try {
    const music = (await library.libraries()).find((entry) => entry.id === '5');
    assert.deepEqual(music.views.map((view) => view.id), ['artists', 'albums', 'tracks']);
  } finally { answers[key] = had; }
});

test('a music library lists its genres by name, and the albums of one genre', async () => {
  const { total, items } = await library.libraryItems('5', { view: 'genres' });
  assert.equal(total, 2);
  assert.deepEqual(items.map((item) => [item.type, item.ratingKey, item.title]), [['genre', '30', 'Jazz'], ['genre', '31', 'Rock']]);
  assert.ok(asked.some((path) => path === '/library/sections/5/genre?type=9'));
  await library.libraryItems('5', { view: 'albums', genre: '30' });
  assert.ok(asked.some((path) => path.startsWith('/library/sections/5/all?') && path.includes('type=9') && path.includes('genre=30')));
  await library.libraryItems('5', { view: 'tracks', genre: '30' });
  assert.ok(asked.some((path) => path.includes('type=10') && path.includes('album.genre=30')), 'the tracks of a genre are those of its albums');
});

test('artists are listed with square art', async () => {
  const { total, items } = await library.libraryItems('5');
  assert.equal(total, 1);
  assert.equal(items[0].type, 'artist');
  assert.equal(items[0].title, 'The Band');
  assert.equal(items[0].thumbnail, squareThumb('/library/metadata/100/thumb/1'));
  assert.equal(items[0].leafCount, 20, 'the number of tracks');
  assert.equal(items[0].sortTitle, 'Band', 'the name the list is ordered by, which the letter bar goes by');
});

test('an artist\'s children are albums that know their artist', async () => {
  const [album] = await library.showSeasons('100');
  assert.deepEqual(
    { type: album.type, title: album.title, year: album.year, showRatingKey: album.showRatingKey, showTitle: album.showTitle, leafCount: album.leafCount },
    { type: 'album', title: 'First Record', year: 1999, showRatingKey: '100', showTitle: 'The Band', leafCount: 10 });
  assert.equal(album.thumbnail, squareThumb('/library/metadata/200/thumb/2'));
});

test('an album\'s children are tracks with their number, artist and length', async () => {
  const [track] = await library.seasonEpisodes('200');
  assert.deepEqual(track, {
    ratingKey: '300', type: 'track', title: 'Opening', episode: 1, season: 1, artist: 'The Band feat. Guest', album: 'First Record',
    duration: 4, durationMs: 215000, viewOffset: 0, thumbnail: sized('/library/metadata/200/thumb/2', 128), audioCodec: 'flac',
  });
});

test('details, recently added and search keep the type and the square art', async () => {
  const details = await library.itemDetails('300');
  assert.equal(details.type, 'track');
  assert.equal(details.thumbnail, sized('/library/metadata/200/thumb/2', 512), 'the album\'s art, large, for the player');
  assert.equal(details.artist, 'The Band feat. Guest');
  assert.equal(details.album, 'First Record');
  assert.equal(details.grandparentKey, '/library/metadata/100', 'the artist, for the track\'s parents');
  assert.equal((await library.itemDetails('100')).type, 'artist');

  const [recent] = await library.recentlyAdded('5');
  assert.equal(recent.type, 'album');
  assert.equal(recent.showRatingKey, '100', 'an album opens under its artist');
  assert.equal(recent.showTitle, 'The Band');
  assert.equal(recent.thumbnail, squareThumb('/library/metadata/200/thumb/2'));

  const found = await library.search('band');
  assert.deepEqual(found.map(item => item.type), ['artist', 'album', 'track']);
  assert.ok(found.every(item => item.thumbnail.includes('width=320&height=320')));
});

test('the browse page opens artists and albums like shows and seasons, and shows tracks as rows', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(page, /OPENS_CHILDREN = new Set\(\['show', 'artist'\]\)/);
  assert.match(page, /OPENS_GROUP = new Set\(\['season', 'album'\]\)/);
  assert.match(page, /\.card\.square img \{ aspect-ratio: 1\/1; \}/);
  assert.match(page, /item\.type === 'album'/);
});

test('a music library can be listed by album or by track, a page at a time', async () => {
  asked.length = 0;
  const albums = await library.libraryItems('5', { sort: 'titleSort', view: 'albums', start: 0, size: 500 });
  assert.equal(albums.total, 3);
  assert.deepEqual(albums.items.map(item => [item.type, item.title, item.showRatingKey, item.showTitle]), [['album', 'First Record', '100', 'The Band']],
    'an album listed on its own still knows its artist');
  assert.equal(albums.items[0].thumbnail, squareThumb('/library/metadata/200/thumb/2'));
  const tracks = await library.libraryItems('5', { sort: 'titleSort', view: 'tracks', start: 500, size: 500 });
  assert.equal(tracks.total, 120);
  assert.equal(tracks.items[0].type, 'track');
  assert.equal(tracks.items[0].artist, 'The Band feat. Guest');
  assert.equal(tracks.items[0].episode, 1, 'the track number');

  assert.ok(asked.some(url => url === '/library/sections/5/all?type=9&X-Plex-Container-Start=0&X-Plex-Container-Size=500'), asked.join('\n'));
  assert.ok(asked.some(url => url === '/library/sections/5/all?type=10&X-Plex-Container-Start=500&X-Plex-Container-Size=500'), asked.join('\n'));

  // No view, or one Plex does not know, is the default listing (artists), and a paging-less call asks for no page.
  asked.length = 0;
  await library.libraryItems('5', { sort: 'titleSort', view: 'artists' });
  await library.libraryItems('5', { sort: 'titleSort', view: 'nonsense' });
  assert.deepEqual(asked, ['/library/sections/5/all?sort=titleSort', '/library/sections/5/all?sort=titleSort']);
});

test('the browse page has a view switch and loads in pages, and has no filter box (the search box does that job)', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(page, /id="viewSwitch"/);
  assert.doesNotMatch(page, /gridFilter|Filter this screen/);
  assert.match(page, /import \{ filterItems \} from "\/browse-filter\.js"/, 'the search matches by words, in any order');
  assert.match(page, /view: currentView/, 'the view is kept in the address, the player link and the detail link');
  assert.match(page, /start=\$\{items\.length\}&size=\$\{LIBRARY_PAGE\}/);
  assert.match(page, /if \(item\.type === 'album' && onLibraryPage\) skippedSeasons = true/);
});

test('the player shows a track as a music player: cover, the album\'s queue with the current track lit, and Previous and Next', () => {
  const page = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(page, /id="musicCover" hidden/);
  assert.match(page, /id="musicQueueList"/);
  assert.match(page, /if \(item\.type === 'track'\) \{\s+showMusicTrack\(item, \{ initial: true \}\);/);
  assert.match(page, /function showMusicTrack\(item, \{ initial = false \} = \{\}\) \{\s+isMusic = true;/);
  assert.match(page, /\.q\.current button \{ background: rgba\(8, 120, 230, \.3\)/, 'the playing track is highlighted');
  assert.match(page, /\.q\.played button \{ opacity: \.5; \}/, 'earlier tracks are dimmed');
  assert.match(page, /api\/library\/season\/\$\{encodeURIComponent\(albumId\)\}\/episodes/, 'the queue is the album, read through the same call as an album screen');
  assert.match(page, /keepControlsUp = true;\s+showOverlay\(\);/, 'the controls stay up');
  assert.match(page, /if \(isMusic \|\| queue\.length\) \{ playNextBtn\.hidden = true; return; \}/, 'the controls have Next, so the floating one is hidden');
  assert.match(page, /if \(queue\.length && !movingOn\) \{ goNext\(\{ auto: true \}\); return; \}/, 'no countdown between tracks (or queued videos): the next one starts, or the same again if repeating');
  assert.match(page, /id="prevTrackBtn"/);
  assert.match(page, /id="nextTrackBtn"/);
  const media = readFileSync(new URL('../public/media-session.js', import.meta.url), 'utf8');
  assert.match(media, /actions\.nextTrack\?\.\(\)/, 'media keys move between tracks while music plays');
});

test('a track\'s lyrics: the sets it has, and each as lines, timed when Plex has times', async () => {
  assert.deepEqual(await library.lyricTracks('300'), [
    { id: '55', label: 'LyricFind', timed: true },
    { id: '56', label: 'Embedded', timed: false },
  ]);
  asked.length = 0;
  assert.deepEqual(await library.lyricText('300', '55'), { timed: true, lines: [{ startMs: 1000, text: 'Hello there' }, { startMs: 4000, text: 'General & Kenobi' }] });
  assert.ok(asked.includes('/library/streams/55?format=xml'), 'asks for the XML form, as Plex Web does');
  // The second set has no XML form: it is asked for again plainly.
  assert.deepEqual(await library.lyricText('300', '56'), { timed: false, lines: [{ startMs: null, text: 'Plain words' }, { startMs: null, text: 'More words' }] });
  // Only this track's own lyric streams, and never the audio stream or someone else's.
  assert.equal(await library.lyricText('300', '54'), null);
  assert.equal(await library.lyricText('300', '999'), null);
});

test('the music player has a lyrics button that swaps the queue for the words and follows timed lyrics', () => {
  const page = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(page, /id="lyricsBtn" hidden/, 'shown only when the track has lyrics');
  assert.match(page, /id="musicLyrics"/);
  assert.doesNotMatch(page, /showLyrics #musicQueue/, 'the tracks stay on screen');
  assert.match(page, /#musicCover\.showLyrics #musicCoverImg \{ width: 88px; height: 88px;/, 'the cover shrinks to make room');
  const cover = page.slice(page.indexOf('<div id="musicNow">'), page.indexOf('<section id="musicQueue"'));
  assert.match(cover, /id="musicLyrics"/, 'the lyrics are in the cover\'s column');
  assert.match(page, /\/api\/library\/lyrics\/\$\{encodeURIComponent\(trackId\)\}/);
  assert.match(page, /\/api\/library\/lyric\/\$\{encodeURIComponent\(itemKey\)\}\/\$\{encodeURIComponent\(set\.id\)\}/);
  assert.match(page, /updateLyrics\(stats\.mediaTime\)/, 'the lit line follows the playback clock');
  assert.match(page, /player\?\.seek\(line\.startMs \/ 1000\)/, 'a timed line can be tapped');
  assert.match(page, /textContent = line\.text/, 'lyrics are text, never markup');
  assert.doesNotMatch(page.slice(page.indexOf('// ---- Lyrics ----')), /innerHTML/);
});

test('the browse page puts music first and returns to the last tab', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(page, /libraries = orderLibraries\(await fetchJson\('\/api\/library\/libraries'\)\)/);
  assert.match(page, /writeTabMemory\(tabStorage, \{ tab: currentLibraryId, view: currentView \}\)/, 'every screen saves the tab');
  assert.match(page, /const requestedTab = addressTab \?\? startingTab\(remembered,/, 'the address wins, then the remembered tab');
  assert.match(page, /remembered\.views\[requestedTab\]/, 'and that library\'s own view');
});

test('playlists of music: the list, and each one\'s tracks numbered by their place in it', async () => {
  assert.deepEqual(await library.playlists(), [{
    ratingKey: '900', type: 'playlist', title: 'Fun', thumbnail: squareThumb('/playlists/900/composite/123'),
    leafCount: 2, duration: 7, durationMs: 427000,
  }]);
  const tracks = await library.playlistItems('900');
  assert.deepEqual(tracks.map(track => [track.ratingKey, track.type, track.title, track.episode]), [['301', 'track', 'Complicated', 1], ['302', 'track', 'Sk8er Boi', 2]],
    'the playlist\'s own order, not the album\'s track numbers, and nothing that is not a track');
  assert.equal(tracks[0].artist, 'The Band feat. Guest');
  assert.ok(asked.includes('/playlists?playlistType=audio'));
});

test('a playlist\'s picture can be fetched, and no other picture path is opened up', () => {
  assert.match(library.thumbnailUpstreamUrl('/playlists/900/composite/123', 320, 320).searchParams.get('url'), /^\/playlists\/900\/composite\/123$/);
  assert.match(library.thumbnailUpstreamUrl('/library/metadata/5/thumb/1', 320, 320).searchParams.get('url'), /\/library\/metadata\/5\/thumb\/1/);
  for (const bad of ['/playlists/900/items', '/playlists/abc/composite', '/library/metadata/5/children', '/playlists/900/composite/1/../../x', '/accounts', '//evil.example/playlists/9/composite']) {
    assert.throws(() => library.thumbnailUpstreamUrl(bad, 320, 320), /Invalid Plex thumbnail path/, bad);
  }
});

test('artists like an artist: those related in the library, then those that sound alike, without repeats', async () => {
  const sections = await library.similarArtists('100');
  assert.deepEqual(sections.map(section => [section.title, section.items.map(item => item.title)]), [
    ['Similar Artists', ['Frida', 'Donna Summer']],
    ['Sonically Similar Artists', ['Roxette']],
  ], 'not the artist itself, not one that is not in the library, not one already shown');
  assert.deepEqual(sections[0].items[0], { ratingKey: '101', type: 'artist', title: 'Frida', thumbnail: squareThumb('/library/metadata/101/thumb/1'), leafCount: 12 });
  // Plex answering nothing, or failing, is just no rows.
  assert.deepEqual(await library.similarArtists('55'), []);
});

test('the browse page has a Playlists tab, a playlist screen and rows of similar artists', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(page, /\{ id: 'playlists', title: 'Playlists', type: 'playlists' \}/);
  assert.match(page, /async function openPlaylist\(playlist\)/);
  assert.match(page, /\/api\/library\/playlist\/\$\{playlist\.ratingKey\}\/items/);
  assert.match(page, /async function loadSimilarArtists\(artistKey, view\)/);
  const similar = page.slice(page.indexOf('async function loadSimilarArtists'), page.indexOf('// A playlist: its tracks'));
  assert.match(similar, /carousel\.className = 'carousel'/, 'a carousel, like Continue Watching');
  assert.match(similar, /setupCarousel\(row\)/, 'the same scrolling and buttons');
  assert.match(similar, /carousel\.append\(button\('prev'\), row, button\('next'\)\)/);
  assert.match(page, /\.recentCard\.artist img \{ aspect-ratio: 1\/1; \}/, 'square artist pictures');
  assert.match(page, /seasons\.length === 1 && showItem\?\.type !== 'artist'/, 'an artist with one album still gets its own page, with its similar artists');
});

test('a long biography is cut to three lines with a More button, so the albums sit near the top', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(page, /#detailSummary \{[^}]*-webkit-line-clamp: 3;/);
  assert.match(page, /#detailSummary\.expanded \{ display: block; overflow: visible; \}/);
  assert.match(page, /id="detailSummaryToggle" hidden aria-expanded="false"/, 'hidden until the text is actually cut off');
  assert.match(page, /summaryToggle\.hidden = !\(summaryEl\.scrollHeight > summaryEl\.clientHeight \+ 1\)/);
  assert.match(page, /summaryToggle\.textContent = open \? 'Less' : 'More'/);
});

test('a list scrolls to its real end: the page counts columns the way the CSS lays them out', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(page, /\.grid \{\s+--col-min: 150px;/);
  assert.match(page, /\.grid\.trackList \{ --col-min: 300px;/, 'the track list says its columns are wider');
  assert.match(page, /style\.getPropertyValue\('--col-min'\)/, 'and the page reads that, instead of assuming 150');
  assert.doesNotMatch(page, /minmax\(300px, 1fr\)/, 'no second copy of the width to fall out of step');
  const player = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(player, /cover\.style\.bottom = `\$\{controls\.offsetHeight \+ 8\}px`/, 'the queue and lyrics end above the controls');
});

test('loading is a centered spinner, not words; messages are still words', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(page, /#loading\.spinning \{ display: flex; justify-content: center; align-items: center;/);
  assert.match(page, /role="status"|setAttribute\('role', 'status'\)/, 'announced to screen readers');
  assert.doesNotMatch(page, /loadingEl\.textContent = [`'](?:Loading|Searching)/, 'no loading words');
  assert.doesNotMatch(page, /Loading \$\{/, 'nor "Loading <name>…"');
  assert.match(page, /showMessage\(`Failed to load: \$\{err\.message\}`\)/, 'a failure still says so');
  assert.match(page, /showMessage\('This playlist is empty'\)/);
  assert.match(page, /@media \(prefers-reduced-motion: reduce\)/);
});

test('the cover column cannot grow past the space above the controls, so lyrics and tracks scroll inside it', () => {
  const page = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(page, /grid-template-rows: minmax\(0, 1fr\); gap: 3vw;/, 'one row, not taller than the space');
  assert.match(page, /#musicNow \{[^}]*min-height: 0;/);
  assert.match(page, /#musicLyrics \{[^}]*min-height: 0;/);
  assert.match(page, /#musicQueue \{[^}]*min-height: 0;/);
});

test('shuffle and repeat buttons sit in the music controls and act on the queue', () => {
  const page = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(page, /id="shuffleBtn" hidden/);
  assert.match(page, /id="repeatBtn" hidden/);
  assert.match(page, /shuffleQueue\(withIndex\(queueData, queueIndex\)\)/);
  assert.match(page, /nextRepeat\(queueData\.repeat\)/);
  assert.match(page, /nextPosition\(withIndex\(queueData, queueIndex\), \{ auto \}\)/, 'a finished track follows the repeat mode');
  assert.match(page, /localStorage\.setItem\(REPEAT_KEY, repeat\)/, 'repeat is remembered');
});

test('music resumes without the blue "Resuming at" banner; video still shows it', () => {
  const page = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  const resume = page.slice(page.indexOf('if (resumeSeconds > 0 && !showingStillImage)'));
  assert.match(resume.slice(0, 1200), /await player\.seek\(resumeSeconds\);\s+\/\/ Music picks up/, 'it still seeks to where it was');
  assert.match(resume.slice(0, 1400), /if \(!isMusic && !urlParams\.has\('queue'\)\) \{\s+showBanner\(`Resuming at/, 'the banner is for video only');
});

test('the loading spinner sits under the Artists/Albums/Tracks switch and the filter, which stay on screen', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  const controls = page.indexOf('<div id="gridControls" hidden>');
  const loading = page.indexOf('<div id="loading"></div>');
  const grid = page.indexOf('<div id="grid">');
  assert.ok(controls > 0 && controls < loading && loading < grid, 'controls, then the spinner, then the list');
  // The switch is drawn before the list is asked for, so it is there while the list loads.
  const open = page.slice(page.indexOf('async function openLibrary('), page.indexOf('async function openShowSeasons('));
  assert.ok(open.indexOf('renderViewSwitch(lib)') > 0 && open.indexOf('renderViewSwitch(lib)') < open.indexOf('fetchLibraryItems(lib, currentView'));
});

test('similar artists and the filter sit above the header\'s backdrop, and the header picture is as tall as the picture', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(page, /#grid, #loading, #gridControls, #similarSections, #popularSection \{ position: relative; z-index: 1; \}/, 'not painted under the fixed fade');
  assert.match(page, /#detailPoster \{[^}]*align-self: flex-start;/, 'not stretched to the height of the text');
  assert.match(page, /#detailBackdropFade \{\s+position: fixed; inset: 0; z-index: 0;/, 'the layer that was hiding them');
});

test('choosing a track draws the music screen at once from the saved queue, so the page is not blank while the stream starts', () => {
  const page = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  const early = page.slice(page.indexOf('<script>\n    // Music: draw the player'), page.indexOf('<script type="module">'));
  assert.ok(early.length > 500, 'a plain script before the module, so it runs before the first paint');
  assert.match(early, /sessionStorage\.getItem\('freeStuffCrazyPlayer\.queue'\)/);
  assert.match(early, /documentElement\.classList\.add\('music'\)/);
  for (const drawn of ["$('musicCoverImg')", "$('musicCoverTitle')", "$('musicQueueList')", "$('musicCover').hidden = false", "'prevTrackBtn', 'nextTrackBtn', 'shuffleBtn', 'repeatBtn'"]) assert.ok(early.includes(drawn), drawn);
  assert.match(early, /textContent = /, 'text, never markup');
  assert.doesNotMatch(early, /innerHTML/);
  assert.match(page, /html\.music, html\.music body \{ background: #111; \}/, 'the browse page\'s dark, not black');
  // The key the early script reads is the same one the queue is saved under.
  const queue = readFileSync(new URL('../public/music-queue.js', import.meta.url), 'utf8');
  assert.match(queue, /const KEY = 'freeStuffCrazyPlayer\.queue';/);
});

test('an artist\'s page has a Radio button that plays the artist mixed with similar artists', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(page, /id="detailRadio" hidden/, 'only on an artist');
  assert.match(page, /radio: \(\) => startRadio\(showItem, ratingKey\)/);
  const radio = page.slice(page.indexOf('async function startRadio'), page.indexOf('// Rows of artists like this one'));
  assert.match(radio, /gatherRadio\(\{ fetchJson, artistKey \}\)/, 'the artist and its similar artists, gathered through the pages\' own routes');
  assert.match(radio, /label: `\$\{artist\.title\} Radio`/);
});

test('a long library list has a # A-Z bar at its right edge that scrolls to a letter', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(page, /<nav id="letterBar" aria-label="Jump to a letter" hidden><\/nav>/);
  assert.match(page, /import \{ LETTERS, letterIndex, targetIndex, LETTER_BAR_MIN_ITEMS \} from "\/letter-index\.js"/);
  assert.match(page, /#letterBar \{ position: fixed; right: 2px;/);
  assert.match(page, /body\.hasLetterBar #grid \{ padding-right: 40px; \}/, 'the bar does not cover the last column');
  assert.match(page, /letterPositions = letterIndex\(gridState\.items, currentView\)/, 'built from what is on screen, as filtered');
  assert.match(page, /pendingLetter = letter/, 'a letter tapped before its section loaded is gone to when it arrives');
  assert.match(page, /lib\?\.type !== 'playlists'/, 'not on a short list of playlists');
});

test('an artist\'s popular tracks: from Plex\'s own list, numbered by popularity, or from the artist\'s details', async () => {
  const popular = await library.popularTracks('100');
  assert.deepEqual(popular.map(track => [track.ratingKey, track.title, track.episode, track.type]), [['311', 'Dancing Queen', 1, 'track'], ['312', 'Mamma Mia', 2, 'track']], 'tracks only, in order, numbered 1, 2...');
  assert.equal(popular[0].album, 'First Record');
  // No list of its own (here: no such path): the artist's details may carry the tracks.
  answers['/library/metadata/55'] = { MediaContainer: { Metadata: [{ ratingKey: '55', type: 'artist', PopularLeaves: [{ ...TRACK, ratingKey: '401', title: 'From details' }] }] } };
  assert.deepEqual((await library.popularTracks('55')).map(track => track.title), ['From details']);
  answers['/library/metadata/56'] = { MediaContainer: { Metadata: [{ ratingKey: '56', type: 'artist', PopularLeaves: { Metadata: [{ ...TRACK, ratingKey: '402', title: 'Nested' }] } }] } };
  assert.deepEqual((await library.popularTracks('56')).map(track => track.title), ['Nested']);
  assert.deepEqual(await library.popularTracks('57'), [], 'Plex has none: no error');
});

test('an artist\'s page shows Popular Tracks above its albums, five at first with Show More', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.ok(page.indexOf('id="popularSection"') > 0 && page.indexOf('id="popularSection"') < page.indexOf('<div id="grid">'), 'above the albums');
  assert.match(page, /const POPULAR_PREVIEW = 5;/);
  assert.match(page, /api\/library\/popular\/\$\{artistKey\}/);
  assert.match(page, /loadPopularTracks\(ratingKey, view, showItem\.title\)/);
  assert.match(page, /onPlay: \(\) => playQueue\(\{ label: `\$\{artistTitle\} — Popular`, items: tracks, start: index \}\)/, 'tapping one plays the list from there');
  assert.match(page, /#popularSection \{ position: relative; z-index: 1; \}|#similarSections, #popularSection \{ position: relative; z-index: 1; \}/, 'above the header\'s backdrop');
});

test('every row of the music player\'s queue says who it is by and from what album', () => {
  const page = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /track\.artist !== queue\[queueIndex\]\?\.artist/, 'not only rows that differ from the playing one');
  const rows = page.match(/\[(?:track|item)\.artist, (?:track|item)\.album\]\.filter\(Boolean\)\.join\(' — '\)/g) || [];
  assert.equal(rows.length, 2, 'the queue and the early copy of it draw the same line');
});

test('an artist radio keeps going: the queue remembers its artist and the player tops it up before it runs out', () => {
  const player = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  const browse = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(browse, /playQueue\(\{ label: `\$\{artist\.title\} Radio`, items, radio: \{ artistKey \} \}\)/, 'the radio queue is told its artist');
  assert.match(player, /changeQueue\(withIndex\(queueData, plan\.pos\)\);\n\s+rollRadioWindow\(\);/, 'the window rolls along each time the track changes');
  assert.match(player, /if \(nextPlan\) nextPlan\.pos -= dropped;/, 'the track opened ahead keeps its place when the front is dropped');
  assert.match(player, /if \(queueData\.radio\) extendRadio\(\)\.then\(\(added\) => \{ if \(added\) goNext\(\{ auto \}\); \}\)/, 'and at the very end, it gets more and carries on');
  assert.match(player, /const have = \[\.\.\.queueData\.items, \.\.\.radioPool\]\.map\(\(track\) => track\.ratingKey\);/, 'not repeating what is queued');
  assert.match(player, /nextPosition\(withIndex\(queueData, queueIndex\)\) === null && !queueData\.radio/, 'Next is never greyed out on a radio');
});

test('the extra sections of an artist page (popular tracks, similar artists) can never put an error on the page', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(page, /function optionalSection\(run\) \{\s+try \{ Promise\.resolve\(run\(\)\)\.catch\(\(\) => \{\}\); \} catch/);
  assert.match(page, /optionalSection\(\(\) => loadPopularTracks\(ratingKey, view, showItem\.title\)\)/);
  assert.match(page, /optionalSection\(\(\) => loadSimilarArtists\(ratingKey, view\)\)/);
  const popular = page.slice(page.indexOf('async function loadPopularTracks'), page.indexOf('// Rows of artists like this one'));
  assert.match(popular, /catch \{ \/\* no popular tracks: no section, and no message \*\/ \}/);
  assert.doesNotMatch(popular, /showMessage|showLoadError|textContent = `Failed/, 'it never writes a message');
  // The page calls only functions that exist.
  for (const name of ['loadPopularTracks', 'loadSimilarArtists', 'startRadio', 'optionalSection', 'buildArtistCard']) {
    assert.match(page, new RegExp(`function ${name}\\(`), `${name} is defined`);
  }
});

test('the artist and album on the playing screen are links to their screens', () => {
  const page = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(page, /browseUrlFor\(\{ tab, view: 'artists', show: artistId \}\)/, 'the artist\'s page');
  assert.match(page, /browseUrlFor\(\{ tab, show: artistId, season: albumId \}\)/, 'the album\'s tracks');
  assert.match(page, /idFromKey\(item\.grandparentKey\)/);
  assert.match(page, /idFromKey\(item\.parentKey\)/);
  assert.match(page, /link\.textContent = text;/, 'text, never markup');
  assert.match(page, /#musicCoverSub a \{[^}]*pointer-events: auto;/, 'clickable, though the cover layer is not');
});

test('music\'s controls never fade: not while it plays, and not for a page that is music from the first moment', () => {
  const page = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(page, /let keepControlsUp = new URLSearchParams\(location\.search\)\.has\('queue'\);/, 'a queue in the address means music from the start');
  assert.match(page, /if \(overlayPinned \|\| keepControlsUp \|\|/, 'the fade timer never starts for music');
  // Playing used to un-pin the controls (setPinned(state !== 'playing')), which is why they faded; the fade now checks music itself.
  assert.match(page, /setPinned\(state !== 'playing'\)/);
});

test('the Artists/Albums/Tracks switch really hides on an artist\'s or album\'s page', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  // display: flex on these ids beats the hidden attribute, so the page has to say hidden means hidden.
  assert.match(page, /#gridControls\[hidden\], #viewSwitch\[hidden\][^{]*\{ display: none !important; \}/);
  // Every id with its own display rule is covered.
  for (const id of ['gridControls', 'viewSwitch']) {
    assert.match(page, new RegExp(`#${id} \\{[^}]*display: flex`), `${id} sets display`);
    assert.ok(page.includes(`#${id}[hidden]`), `${id}[hidden] is covered`);
  }
  // The switch is hidden on every screen but a library's own list, which draws it again.
  const clear = page.slice(page.indexOf('function clearGrid()'), page.indexOf('function renderGrid('));
  assert.match(clear, /viewSwitchEl\.hidden = true;/);
});

test('tracks that sound like a track: nearest first, never the track itself, and none is just none', async () => {
  const similar = await library.similarTracks('300');
  assert.deepEqual(similar.map(track => [track.ratingKey, track.title, track.type]), [['501', 'Sounds Alike', 'track'], ['502', 'Also Close', 'track']]);
  assert.ok(asked.some(url => url.startsWith('/library/metadata/300/nearest?limit=40&maxDistance=0.25')));
  assert.deepEqual(await library.similarTracks('301'), [], 'a library that has not been analysed answers nothing');
});

test('clicking a track plays it and then tracks that sound like it, and falls back to its own list', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(page, /if \(item\.type === 'track'\) \{ playTrackWithSimilar\(item\); return; \}/);
  const play = page.slice(page.indexOf('async function playTrackWithSimilar'), page.indexOf('function playTrackFromList'));
  assert.match(play, /api\/library\/similar-tracks\/\$\{track\.ratingKey\}/);
  assert.match(play, /playQueue\(\{ label: `Similar to \$\{track\.title\}`, items: \[track, \.\.\.more\], start: 0 \}\)/, 'the track first, then what sounds like it');
  assert.match(play, /if \(!more\.length\) \{ playTrackFromList\(track\); return; \}/, 'nothing similar: its own list, as before');
  assert.match(play, /SIMILAR_WAIT_MS/, 'and a slow answer does not hold up the music');
});

test('music keeps playing while you browse: the player sits in a frame, with a bar at the bottom, and stops for movies and shows', () => {
  const browse = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  const player = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  // the browse page
  assert.match(browse, /id="nowPlaying" class="minimized"/);
  assert.match(browse, /id="playbar" role="region" aria-label="Playing now" hidden/);
  assert.match(browse, /frame\.setAttribute\('allow', 'autoplay; cross-origin-isolated'\)/);
  assert.match(browse, /#nowPlaying\.minimized \{ inset: auto 0 0 auto; width: 2px; height: 2px; opacity: 0; pointer-events: none; z-index: -1;/, 'alive but not shown: not display: none, which would stop it');
  assert.doesNotMatch(browse, /#nowPlaying\.minimized \{[^}]*display: none/);
  assert.match(browse, /if \(saved && musicHost\.supported\(\)\) \{ musicHost\.start\(params\); return; \}/, 'held in the frame, else the player\'s own page as before');
  assert.match(browse, /window\.crossOriginIsolated === true/);
  assert.match(browse, /if \(!keepsMusicPlaying\(lib\)\) musicHost\.stop\(\);/, 'movies and shows stop it');
  assert.match(browse, /musicHost\.stop\(\); \/\/ a plugin's tab/, 'and so does a plugin tab such as Live TV');
  assert.match(browse, /fromFrame\(event, frame\?\.contentWindow, location\.origin\)/, 'only its own frame is listened to');
  assert.match(browse, /cleanState\(event\.data\)/);
  assert.match(browse, /els\.title\.textContent = shown\.title/, 'text, never markup');
  // the player
  assert.match(player, /const embedded = window\.parent !== window && new URLSearchParams\(location\.search\)\.get\('embedded'\) === '1';/);
  assert.match(player, /if \(embedded\) \{ window\.parent\.postMessage\(\{ type: MUSIC_MESSAGE, event: 'minimize' \}, location\.origin\); return; \}/, '"Browse" only shrinks it');
  assert.match(player, /if \(embedded && !leavesFrame\) target\.searchParams\.set\('embedded', '1'\);/, 'the next track stays in the frame (a video does not)');
  assert.match(player, /fromParent\(event, window\.parent, location\.origin\)/, 'only its own page is listened to');
  assert.match(player, /cleanCommand\(event\.data\)/);
  assert.match(player, /broadcastMusic\(true\);\s+\n?\s*(?:renderPlayPause|updateNext|\S)/, 'state changes are reported');
  assert.match(player, /broadcastMusic\(\);\s+updateLyrics\(stats\.mediaTime\)/, 'and progress, a second at a time');
});

test('an album Plex sends with an empty title is named by its sort title, as Plex does', async () => {
  const albums = await library.showSeasons('700');
  assert.deepEqual(albums.map(album => album.title), ['Razors Edge', 'Back In Black']);
});

test('inside the browse page\'s frame the player never navigates to the browse page, which cannot be framed', () => {
  const player = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  const uses = player.match(/location\.replace\(returnUrl\)/g) || [];
  assert.equal(uses.length, 1, 'only leavePlayer goes to the browse page');
  assert.match(player, /function leavePlayer\(\) \{\s+if \(embedded\)/);
});

test('the letter bar runs the full height and its letters share it equally', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(page, /#letterBar \{ position: fixed; right: 2px; top: 64px; bottom: 8px;/);
  assert.match(page, /#letterBar button \{ width: 34px; flex: 1 1 0;/);
});

test('in the frame, artist and album links go to the browse page in that page, not inside the frame', () => {
  const player = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  const browse = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(player, /if \(embedded\) link\.addEventListener\('click', \(ev\) => \{ ev\.preventDefault\(\); window\.parent\.postMessage\(\{ type: MUSIC_MESSAGE, event: 'navigate', url: href \}/);
  assert.match(browse, /event\.data\.event === 'navigate'/);
  assert.match(browse, /target\.origin !== location\.origin \|\| target\.pathname !== '\/browse'/, 'only this site\'s browse page');
});

test('the bar has a button that brings the player back up', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(page, /id="playbarExpand" aria-label="Open the player"/);
  assert.match(page, /getElementById\('playbarExpand'\)\.addEventListener\('click', \(\) => setOpen\(true\)\)/);
});

test('the open-player button is a labelled pill, and the rest of the bar still opens it', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(page, /id="playbarExpandText">Now Playing</);
  assert.match(page, /getElementById\('playbarOpen'\)\.addEventListener\('click', \(\) => setOpen\(true\)\)/);
});

test('an artist whose albums are all compilations, singles or the like still lists them', async () => {
  const albums = await library.showSeasons('710');
  assert.deepEqual(albums.map(album => [album.ratingKey, album.title, album.type, album.group]), [['711', 'So Far So Good', 'album', 'Compilations']], 'and not the similar artists');
  const normal = await library.showSeasons('700');
  assert.equal(normal.length, 2, 'an artist with no related hubs lists its albums as before');
});

test('the current lyric line is marked by colour alone, which is cheap for an older car to draw', () => {
  const page = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(page, /#lyricLines\.timed li\.active \{ color: #fff; \}/);
  assert.doesNotMatch(page, /#lyricLines\.timed li[^{]*\{[^}]*(font-weight|transform)/);
});

test('music reads ahead, several segments at once at every quality, so the car is not waiting on each segment', () => {
  const html = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(html, /const MUSIC_READ_AHEAD_SECONDS = 300;/);
  assert.match(html, /const MUSIC_READ_AHEAD_PARALLELISM = 2;/);
  assert.match(html, /if \(next !== current\) \{/, 'a radio queue that rolled is saved, and one that did not is left alone, whatever the length');
  assert.doesNotMatch(html, /next\.items\.length === queueData\.items\.length/);
  assert.match(html, /const readAheadParallelism = queueData \? MUSIC_READ_AHEAD_PARALLELISM : undefined;/);
  assert.match(html, /const readAheadSeconds = queueData \? MUSIC_READ_AHEAD_SECONDS : filmReadAhead\[currentQuality\] \|\| 0;/);
});

test('the queue title is light enough to read on the dark panel', () => {
  const html = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(html, /#musicQueueAlbum \{[^}]*color: #e8e8ea;/);
  assert.match(html, /#musicCoverTitle \{[^}]*color: #f4f4f6;/);
});

test('the minimized bar shows the time and the play button follows what the player means to do', () => {
  const browse = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  const canvas = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(browse, /id="playbarTime"/);
  assert.match(browse, /els\.time\.textContent = shown\.duration \? `\$\{clockOf\(shown\.position\)\} \/ \$\{clockOf\(shown\.duration\)\}` : ''/);
  assert.match(browse, /const playing = shown\.playing;/);
  assert.match(browse, /els\.play\.classList\.toggle\('busy', busy\)/, 'a spinner while loading or buffering, also before the player has reported');
  assert.match(canvas, /playing: player\?\.wantsPlayback === true/);
});

test('the script that draws the playbar imports the icon helper it uses', () => {
  const browse = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  const scripts = browse.split('<script type="module">').slice(1).map((part) => part.split('</script>')[0]);
  const bar = scripts.find((script) => script.includes('const musicHost'));
  assert.ok(bar, 'the script holding the music host');
  assert.match(bar, /import \{[^}]*\biconEl\b[^}]*\} from ["']\/icons\.js["']/);
});

test('gapless music: the next track is opened near the end, and the page follows when playback crosses into it', () => {
  const page = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(page, /let playbackId = newPlaybackId\(\);/, 'the stream id can change');
  assert.match(page, /let itemKey = isLive/, 'and so can the track');
  assert.match(page, /player\.prepareNext\(`\/api\/start\?\$\{params\}`, \{ readAheadSeconds: MUSIC_READ_AHEAD_SECONDS, readAheadParallelism: MUSIC_READ_AHEAD_PARALLELISM \}\)/);
  assert.match(page, /onTrackChange: \(\) => beginNextTrack\(\),/);
  assert.match(page, /keepNextTrackReady\(stats\);/);
  assert.match(page, /history\.replaceState\(null, '', here\);/, 'a reload resumes the track now playing');
  assert.match(page, /showMusicTrack\(plan\.item\);/);
  // Anything that moves away, or changes what is next, lets go of the stream opened ahead.
  assert.match(page, /movingOn = true;\s+discardNextPlan\(\);/);
  assert.match(page, /discardNextPlan\(\);\s+queueData = next;/);
  // The finished track is reported as played out, and its stream released.
  assert.match(page, /state: 'stopped', durationMs: ms/);
  // The server allows a viewer one stream, so opening the next ends this one's session: only start once the rest
  // is downloaded, and report under the new id from then on.
  assert.match(page, /const PREPARE_BEFORE_END_SECONDS = 45;/);
  assert.match(page, /player\.prefetcher\?\.hasAllAhead\?\.\(\)\) void prepareNextTrack\(\);/);
  assert.match(page, /heartbeatsPaused \|\| |streamLimitHandled \|\| heartbeatsPaused/);
  assert.match(page, /if \(!\(await claimStream\(plan\.id\)\)\) throw new Error\('next stream not accepted'\);\s+playbackId = plan\.id;/);
  assert.match(page, /if \(plan\.id !== playbackId\) releaseStream\(plan\.id\);/, 'a stream that is the current one is not stopped');
});

test('the minimized bar keeps a fixed space for the time, so the buttons do not move as it ticks', () => {
  const browse = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(browse, /#playbarTime \{[^}]*min-width: 13ch;[^}]*text-align: right;[^}]*font-variant-numeric: tabular-nums;/);
});

test('Next, Previous and queue taps move on inside the page, falling back to a reload', () => {
  const html = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(html, /async function skipToTrack\(pos\)/);
  assert.match(html, /player\.adoptPrepared\(\)/);
  assert.match(html, /void skipToTrack\(index\)\.then\(\(moved\) => \{ if \(!moved && !skipping\) reload\(\); \}\)/);
  assert.match(html, /function followToTrack\(plan\)/);
  const player = readFileSync(new URL('../public/engine/player.js', import.meta.url), 'utf8');
  assert.match(player, /const reusable = this\.audioContext/);
});

test('a refresh brings the music player back, on the same list and screen', () => {
  const html = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(html, /MUSIC_SESSION_KEY/);
  assert.match(html, /async function restore\(\)/);
  assert.match(html, /musicHost\.restore\(\);/);
  assert.match(html, /readQueue, MAX_QUEUE/);
  assert.match(html, /forget\(\);\n\s+setOpen\(false\);/, 'closing the player forgets the session');
  const canvas = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(canvas, /queue: queueData\?\.id \?\? null/);
});

test('music recovers from a failed stream in place, and falls back to a reload', () => {
  const canvas = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(canvas, /if \(recovery && await recoverMusicInPlace\(\)\) return;\n\s+await reloadPlaybackOnce\(quality, \{ recovery \}\);/);
  const body = canvas.slice(canvas.indexOf('async function recoverMusicInPlace()'));
  const recover = body.slice(0, body.indexOf('\n      }\n') + 9);
  assert.match(recover, /startTime: at/, 'the new stream starts where the old one stopped');
  assert.match(recover, /if \(wanted\) await player\.play\(\)/, 'it plays again only if it was playing');
  assert.match(recover, /QUIET_RECOVERY_GAP_MS\) return false/, 'a second failure soon after is not retried quietly');
  assert.match(recover, /catch \{\s+return false;/, 'failing returns to the full reload');
  assert.match(recover, /setHeartbeatsPaused\(true\)[\s\S]*setHeartbeatsPaused\(false\)/);
  assert.doesNotMatch(recover, /location\./, 'it never leaves the page');
});

test('steering wheel Next and Previous go through the buttons, so they show the spinner too', () => {
  const canvas = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(canvas, /nextTrack: \(\) => \{ if \(!isMusic\) return false; nextTrackBtn\.click\(\); return true; \}/);
  assert.match(canvas, /previousTrack: \(\) => \{ if \(!isMusic\) return false; prevTrackBtn\.click\(\); return true; \}/);
  assert.match(canvas, /if \(button\) broadcastMusic\(true\)/, 'the library page is told a skip is under way');
  assert.match(canvas, /skipping: nextTrackBtn\.classList\.contains\('skipping'\) \? 'next'/);
  const html = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(html, /if \(next\.skipping && !skipFrom\) skipping\(next\.skipping === 'next' \? els\.next : els\.prev\)/);
});

test('sliding a finger over the letter bar scrolls with it and shows the letter left of the finger', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(page, /#letterBar \{ touch-action: none;/, 'the page does not scroll under the finger');
  assert.match(page, /#letterBubble \{ position: fixed;/);
  assert.match(page, /letterBarEl\.addEventListener\('pointermove'/);
  assert.match(page, /event\.clientX - size - 28/, 'the letter sits to the left of the finger');
  assert.match(page, /if \(letter === scrubbing\.letter\) return;/, 'the list moves only when the letter changes');
  assert.match(page, /letterBubble\.hidden = true;/, 'it goes away when the finger lifts');
  assert.match(page, /event\.detail === 0\) tapLetter\(letter\)/, 'the keyboard still works');
});

test('scrolling the grid keeps the cards that stay in view instead of rebuilding them all', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  const render = page.slice(page.indexOf('function renderVirtualGridWindow()'), page.indexOf('function scheduleRenderVirtualGridWindow'));
  assert.doesNotMatch(render.slice(render.indexOf('gridState.renderedRange = range;')), /gridItemsEl\.innerHTML = ''/, 'a scroll step must not empty the grid');
  assert.match(render, /cards\.get\(items\[i\]\)/, 'a card already built is reused');
  assert.match(render, /child\.remove\(\)/, 'cards that left the window are removed');
  assert.match(render, /insertBefore\(card, cursor\)/);
});

test('saved music belongs to the signed-in person: bound to them, refused for anyone else, cleared on logout', async () => {
  const { clearSavedMusic, MUSIC_SESSION_KEY, MUSIC_QUEUE_KEY } = await import('../public/saved-music.js');
  const fake = () => { const data = new Map([[MUSIC_SESSION_KEY, 'a'], [MUSIC_QUEUE_KEY, 'b'], ['other', 'c']]); return { data, removeItem: key => data.delete(key) }; };
  const local = fake();
  const session = fake();
  clearSavedMusic([local, session]);
  assert.deepEqual([...local.data.keys()], ['other'], 'only the music is removed');
  assert.deepEqual([...session.data.keys()], ['other']);
  assert.doesNotThrow(() => clearSavedMusic([{ removeItem() { throw new Error('blocked'); } }, undefined]));

  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(page, /typeof user\?\.stateScope === 'string'/, 'who is signed in comes from the server');
  assert.match(page, /if \(!frame \|\| !queue \|\| !owner\) return;/, 'nothing is saved without knowing whose it is');
  assert.match(page, /JSON\.stringify\(\{ \.\.\.JSON\.parse\(value\), owner, savedAt/, 'the session records its owner');
  assert.match(page, /if \(!who \|\| saved\.owner !== who\) \{ if \(who\) clearSavedMusic\(\); return; \}/, 'someone else\'s is neither shown nor played, and is removed');
  assert.ok(page.indexOf('saved.owner !== who') < page.indexOf('readQueue(localStorage, id)'), 'the owner is checked before the queue is read');
  const badge = readFileSync(new URL('../public/user-badge.js', import.meta.url), 'utf8');
  assert.equal(badge.match(/clearSavedMusic\(\)/g).length, 3, 'log out, log out everywhere and switching profile each clear it');
});

test('a search covers every tab: each shows its count, the chosen one is lit, and choosing another shows its results', () => {
  const page = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(page, /searchInput\.placeholder = own \? `Search \$\{own\}…` : 'Search all libraries…'/, 'the box says it covers every library');
  assert.match(page, /\.libraries button \.searchCount/, 'tabs can carry a count');
  assert.match(page, /async function countSearchResults\(state\)/);
  assert.match(page, /if \(searchState\) showSearchResults\(lib, searchViewOf\(lib\)\); else openLibrary\(lib\);/, 'a tab shows its results while searching');
  assert.match(page, /btn\.classList\.toggle\('active', selected\)/, 'the tab on screen is lit');
  assert.match(page, /setAttribute\('aria-current', 'true'\)/);
  assert.match(page, /if \(searchState\) showSearchResults\(lib, candidate\.id\); else openLibrary\(lib, candidate\.id\);/, 'music views switch inside the results');
  assert.doesNotMatch(page, /<button id="back">/, 'the toolbar has no back button');
  assert.doesNotMatch(page, /showBack|backEl/);
  assert.match(page, /<button type="button" id="searchClear" aria-label="Clear search"/, 'the search box has a clear button');
  assert.match(page, /if \(searchState\) exitSearch\(\);\n\s+searchInput\.focus\(\);/, 'clearing it leaves the results and keeps the cursor in the box');
  assert.match(page, /event\.key === 'Escape'/, 'Escape clears too');
  assert.match(page, /::-webkit-search-cancel-button/, 'the browser\'s own clear mark is not shown twice');
  assert.match(page, /else if \(searchState\) exitSearch\(\)/, 'an empty search leaves them too');
  assert.doesNotMatch(page, /\$\{results\.length\} \$\{results\.length === 1 \? 'result' : 'results'\} for/, 'no line saying how many results there are: the tabs say it');
  assert.match(page, /const searchMatches = \(items, query\) => filterItems\(items, query\)/, 'every word typed is matched, in the title, artist, album, show or year');
  assert.equal(page.match(/endSearch\(\);/g).length >= 5, true, 'opening a library, a plugin tab, a show, a season or a playlist ends the search');
  assert.match(page, /activePluginTab\?\.onSearch \? activePluginTab\.label/, 'a plugin tab searches itself');
});

test('tapping the playing track in the queue restarts it instead of pausing', () => {
  const canvas = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(canvas, /if \(index === queueIndex\) \{ void Promise\.resolve\(player\?\.seek\(0\)\)/);
  assert.doesNotMatch(canvas, /if \(index === queueIndex\) \{ if \(player\?\.state === 'playing'\) player\.pause\(\)/);
});

test('reopening the app (a new tab) brings the music player back, not only a refresh', () => {
  const html = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(html, /localStorage\.setItem\(SESSION_KEY/, 'the session is kept on the device, not only in the tab');
  assert.match(html, /localStorage\.getItem\(SESSION_KEY\)/);
  assert.doesNotMatch(html, /sessionStorage\.getItem\(SESSION_KEY\)/);
  assert.match(html, /saveQueue\(localStorage, current\)/, 'the queue is copied, since session storage ends with the tab');
  assert.match(html, /readQueue\(localStorage, id\)[\s\S]{0,80}saveQueue\(sessionStorage, queue\)/, 'a copied queue is put back for the player');
  assert.match(html, /RESTORE_WITHIN_MS/, 'an old session is not resurrected');
  assert.match(html, /playing: state\?\.playing === true/, 'whether it was playing is kept');
  assert.match(html, /if \(saved\.playing !== true\) params\.set\('paused', '1'\)/, 'music that was playing carries on');
});

test('the skip buttons show a spinner from the tap until the track has changed', () => {
  const canvas = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(canvas, /#controls button\.skipping::after/);
  assert.match(canvas, /if \(isMusic && queue\.length\) setSkipBusy\(nextTrackBtn\)/);
  assert.match(canvas, /skipping = false;\n\s+setHeartbeatsPaused\(false\);\n\s+setSkipBusy\(null\);/);
  const browse = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(browse, /#playbarControls button\.skipping::after/);
  assert.match(browse, /skipping\(els\.next\); command\('next'\)/);
  assert.match(browse, /next\.key !== skipFrom\.key\) skipping\(null\)/);
});

test('a report sent just before a track change cannot raise the stream-limit message', () => {
  const html = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(html, /function setHeartbeatsPaused\(value\) \{ heartbeatsPaused = value; usageEpoch \+= 1; \}/);
  assert.match(html, /if\(sentEpoch!==usageEpoch \|\| heartbeatsPaused\)return;\n\s+if\(response\.status===403/);
  assert.doesNotMatch(html, /^\s+heartbeatsPaused = (true|false);/m, 'only the helper changes it');
});

test('banners sit above the music screen and are solid', () => {
  const html = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  const banner = html.match(/#resumeBanner \{[^}]*\}/)[0];
  assert.match(banner, /z-index: 6;/);
  assert.match(banner, /background: #0a84ff;/);
});

test('two failures reported together reload the page once', () => {
  const html = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(html, /if \(reloadingPlayback\) return;\n\s+reloadingPlayback = true;\n\s+try \{[\s\S]*?await reloadPlaybackOnce\(quality, \{ recovery \}\);\n\s+\} finally \{ reloadingPlayback = false; \}/);
});

test('the Shuffle and Radio buttons really are hidden where the screen has no such action', () => {
  const browse = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  assert.match(browse, /#detailActions button \{ display: inline-flex;/, 'the buttons are given a display');
  assert.match(browse, /#detailActions button\[hidden\] \{ display: none; \}/, 'which must not beat the hidden attribute');
  const playlist = browse.slice(browse.indexOf('async function openPlaylist'), browse.indexOf('async function openPlaylist') + 2500);
  assert.doesNotMatch(playlist.slice(0, playlist.indexOf('renderGrid')), /radio:/, 'a playlist has no radio');
});

test('music going round again on a shuffled repeat is mixed at the end, and that one track is not opened ahead', () => {
  const page = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(page, /if \(wrapsReshuffled\(withIndex\(queueData, queueIndex\)\)\) \{\s+discardNextPlan\(\);\s+queueData = reshuffledForRepeat\(withIndex\(queueData, queueIndex\)\);\s+queue = queueData\.items;\s+\}\s+goToQueueIndex\(to\);/,
    'mixed again before it goes round, with any track opened ahead (taken from the old order) let go');
  assert.match(page, /if \(wrapsReshuffled\(withIndex\(queueData, queueIndex\)\)\) return;\s+const pos = nextPosition\(withIndex\(queueData, queueIndex\), \{ auto: true \}\);/,
    'nothing is opened ahead from the end of such a queue, since what follows is not known yet');
});

test('a playlist screen plays all of it, tracks as music and videos as films, and shows every entry', () => {
  const html = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  const screen = html.slice(html.indexOf('async function openPlaylist'), html.indexOf('async function openSeason'));
  assert.match(screen, /play: \(\) => playQueue\(\{ label: playlist\.title, items: entries \}\)/);
  assert.match(screen, /shuffle: \(\) => playQueue\(\{ label: playlist\.title, items: entries, shuffle: true \}\)/);
  assert.match(screen, /renderGrid\(entries,/, 'every entry is shown, not just the tracks');
  // Saved music that points at a video is not put back as background music.
  assert.match(html, /if \(!track \|\| track\.video\) \{ forget\(\); return; \}/);
  // A queue that opens on a video starts as a film does.
  assert.match(html, /video = video \|\| !!queue\.items\[queue\.index\]\.video;/);
});

test('the player opens each queue entry the way it is: a video as a film (taking the page from a frame), a track as music', () => {
  const player = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(player, /goToItem\(track\.ratingKey, \{ queue: queueData\?\.id, video: !!track\.video \}\)/);
  assert.match(player, /queueId\) target\.searchParams\.set\(video \? 'videoQueue' : 'queue', queueId\)/);
  assert.match(player, /const leavesFrame = embedded && video;/);
  assert.match(player, /if \(leavesFrame\) \{ try \{ localStorage\.removeItem\(MUSIC_SESSION_KEY\); \}/, 'the music kept for reopening the app is let go, so it does not come back behind the film');
  assert.match(player, /\(leavesFrame \? window\.parent\.location : location\)\.replace\(target\)/);
  assert.match(player, /if \(!track \|\| track\.video\) return;/, 'a video is not opened ahead as music');
  assert.match(player, /if \(!track \|\| track\.video \|\| movingOn/, 'a video is not skipped to in the music page');
});
