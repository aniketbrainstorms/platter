(() => {
'use strict';

/* ───────── helpers ───────── */
const $ = (s, r = document) => r.querySelector(s);
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem('platter.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('platter.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('platter.' + k); } catch {} }
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const fmt = s => { s = Math.max(0, Math.floor(isFinite(s) ? s : 0)); return Math.floor(s / 60) + ':' + pad(s % 60); };

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M6 5.5v13l9-6.5zM17 5h2v14h-2z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M18 5.5v13l-9-6.5zM5 5h2v14H5z"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24"><path d="M3 7h3c5 0 6 10 11 10h4M3 17h3c1.6 0 2.8-.8 3.8-2M14 9c.9-1.2 1.9-2 3.2-2H21M18 4l3 3-3 3M18 14l3 3-3 3"/></svg>',
  repeat: '<svg viewBox="0 0 24 24"><path d="M4 11V9a3 3 0 0 1 3-3h13M17 3l3 3-3 3M20 13v2a3 3 0 0 1-3 3H4M7 21l-3-3 3-3"/></svg>'
};

let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 3200);
}

/* ───────── auth (Google Identity Services, token model) ───────── */
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const Auth = {
  token: LS.get('token'),
  valid() { return !!(this.token && this.token.exp > Date.now() + 60000); },
  connected() { return this.valid() || !!LS.get('apiKey'); },
  loadGIS() {
    return new Promise((res, rej) => {
      if (window.google?.accounts?.oauth2) return res();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = res; s.onerror = () => rej(new Error('Could not load Google sign-in'));
      document.head.appendChild(s);
    });
  },
  async signIn() {
    const id = LS.get('clientId');
    if (!id) throw new Error('Add your Google Client ID first');
    await this.loadGIS();
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: id, scope: SCOPE,
        callback: r => {
          if (r.error) return reject(new Error(r.error_description || r.error));
          this.token = { value: r.access_token, exp: Date.now() + (+r.expires_in || 3600) * 1000 };
          LS.set('token', this.token); resolve();
        },
        error_callback: e => reject(new Error(e.type === 'popup_closed' ? 'Sign-in was closed' : (e.type || 'Sign-in failed')))
      });
      client.requestAccessToken();
    });
  },
  signOut() {
    try { if (this.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(this.token.value, () => {}); } catch {}
    this.token = null; LS.del('token'); LS.del('playlists');
  }
};

/* ───────── YouTube Data API ───────── */
async function api(path, params = {}) {
  const q = new URLSearchParams(params);
  const headers = {};
  if (Auth.valid()) headers.Authorization = 'Bearer ' + Auth.token.value;
  else if (LS.get('apiKey')) q.set('key', LS.get('apiKey'));
  else if (Auth.token) throw new Error('Session expired. Sign in again in Settings.');
  else throw new Error('Connect your account in Settings first.');
  const r = await fetch('https://www.googleapis.com/youtube/v3/' + path + '?' + q, { headers });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { Auth.token = null; LS.del('token'); throw new Error('Session expired. Sign in again in Settings.'); }
  if (!r.ok) throw new Error(j.error?.message || 'YouTube API error ' + r.status);
  return j;
}

const isoSecs = iso => {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
};

function toTrack(v) {
  const sn = v.snippet, th = sn.thumbnails || {};
  const topic = / - Topic$/.test(sn.channelTitle || '');
  let artist = (sn.channelTitle || '').replace(/ - Topic$/, '').replace(/VEVO$/i, '');
  let title = sn.title || '';
  if (!topic) { const m = /^(.+?)\s[-–—]\s(.+)$/.exec(title); if (m) { artist = m[1]; title = m[2]; } }
  title = title.replace(/\s*[\(\[](official|lyric|lyrics|audio|video|music video|visuali[sz]er|hd|4k)[^\)\]]*[\)\]]/ig, '').trim();
  return {
    id: v.id, title, artist,
    thumb: (th.medium || th.high || th.default || {}).url || '',
    hi: (th.maxres || th.standard || th.high || th.medium || {}).url || '',
    dur: isoSecs(v.contentDetails?.duration)
  };
}

async function hydrate(ids) {
  ids = ids.filter(Boolean);
  if (!ids.length) return [];
  const j = await api('videos', { part: 'snippet,contentDetails', id: ids.join(','), maxResults: 50 });
  const by = new Map(j.items.map(v => [v.id, toTrack(v)]));
  return ids.map(i => by.get(i)).filter(Boolean);
}

const tok = t => (t ? { pageToken: t } : {});
const Loaders = {
  async search(q, t) {
    const j = await api('search', { part: 'id', type: 'video', videoCategoryId: '10', videoEmbeddable: 'true', maxResults: 25, q, ...tok(t) });
    return { tracks: await hydrate(j.items.map(i => i.id.videoId)), next: j.nextPageToken };
  },
  async playlist(id, t) {
    const j = await api('playlistItems', { part: 'contentDetails', playlistId: id, maxResults: 50, ...tok(t) });
    return { tracks: await hydrate(j.items.map(i => i.contentDetails.videoId)), next: j.nextPageToken };
  },
  async liked(t) {
    const j = await api('videos', { part: 'snippet,contentDetails', myRating: 'like', maxResults: 50, ...tok(t) });
    return { tracks: j.items.map(toTrack), next: j.nextPageToken };
  }
};

async function fetchPlaylists() {
  const j = await api('playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: 50 });
  const list = j.items.map(p => ({
    id: p.id, title: p.snippet.title, count: p.contentDetails.itemCount,
    thumb: (p.snippet.thumbnails?.medium || p.snippet.thumbnails?.default || {}).url || ''
  }));
  LS.set('playlists', list);
  return list;
}

/* ───────── views ───────── */
const views = { home: $('#v-home'), col: $('#v-col') };
function show(name) {
  for (const k in views) views[k].classList.toggle('on', k === name);
  $('#app').scrollTop = 0;
}
const overlay = (el, open) => { el.classList.toggle('open', open); el.setAttribute('aria-hidden', String(!open)); };

function trackRow(t, i, now) {
  return `<button class="row${now ? ' now' : ''}" data-i="${i}">
    <span class="n">${pad(i + 1)}</span>
    <img src="${esc(t.thumb)}" alt="" loading="lazy">
    <span class="meta"><b>${esc(t.title)}</b><i>${esc(t.artist)}</i></span>
    <span class="d">${t.dur ? fmt(t.dur) : ''}</span></button>`;
}

/* home */
function renderHome() {
  $('#year').textContent = new Date().getFullYear();
  const connected = Auth.connected();
  $('#connect').hidden = connected;

  const lists = LS.get('playlists', []);
  const canLibrary = Auth.valid();
  $('#railWrap').hidden = !canLibrary;
  if (canLibrary) {
    let html = `<button class="card" data-liked="1">
      <div class="sleeve"><div class="vinyl"></div><div class="cover liked">LIKED</div></div>
      <div class="cardMeta"><b>Liked music</b><i>Your likes</i></div></button>`;
    lists.forEach(p => {
      html += `<button class="card" data-pl="${esc(p.id)}" data-title="${esc(p.title)}" data-count="${p.count}">
        <div class="sleeve"><div class="vinyl"></div><img class="cover" src="${esc(p.thumb)}" alt="" loading="lazy"></div>
        <div class="cardMeta"><b>${esc(p.title)}</b><i>${p.count} tracks</i></div></button>`;
    });
    $('#rail').innerHTML = html;
  }

  const recent = LS.get('recent', []);
  $('#recentWrap').hidden = !recent.length;
  $('#recent').innerHTML = recent.map((t, i) => trackRow(t, i, P.queue[P.idx]?.id === t.id)).join('');
}

/* collection */
let col = null;
function fitTitle(el, text) {
  const n = text.length;
  const s = n > 24 ? 8 : n > 16 ? 11 : n > 9 ? 14 : 17;
  el.style.fontSize = `calc(var(--vw)*${s})`;
}
function renderCollection() {
  const c = col; if (!c) return;
  $('#cTitle').textContent = c.title; fitTitle($('#cTitle'), c.title);
  $('#cSub').textContent = c.loading && !c.tracks.length ? 'Loading…' : c.sub + (c.tracks.length ? ' · ' + c.tracks.length + ' tracks' : '');
  const cur = P.queue[P.idx]?.id;
  let html = c.tracks.map((t, i) => trackRow(t, i, t.id === cur)).join('');
  if (c.error && !c.tracks.length) html = `<p class="mono empty">${esc(c.error)}</p>`;
  else if (!c.loading && !c.tracks.length) html = '<p class="mono empty">Nothing here.</p>';
  $('#cRows').innerHTML = html;
  $('#more').hidden = !c.next;
  $('#more').textContent = c.loading ? 'Loading…' : 'See more';
}
async function openCollection(title, sub, loader) {
  const c = col = { title, sub, loader, tracks: [], next: null, loading: false, error: '' };
  show('col'); closeAll();
  await loadMore(c);
}
async function loadMore(c = col) {
  if (!c || c.loading) return;
  c.loading = true; if (c === col) renderCollection();
  try {
    const r = await c.loader(c.next);
    c.tracks.push(...r.tracks); c.next = r.next || null; c.error = '';
  } catch (e) { c.error = e.message; toast(e.message); }
  c.loading = false; if (c === col) renderCollection();
}

/* ───────── player ───────── */
const P = {
  yt: null, ready: false, pending: null,
  queue: [], idx: -1, playing: false,
  shuffle: !!LS.get('shuffle', false), repeat: LS.get('repeat', 0), // 0 off · 1 all · 2 one
  errs: 0, scrubbing: false, video: false
};

window.onYouTubeIframeAPIReady = () => {
  P.yt = new YT.Player('yt', {
    width: '200', height: '200',
    playerVars: { playsinline: 1, controls: 0, disablekb: 1, rel: 0, fs: 0, iv_load_policy: 3,
      ...(location.protocol.startsWith('http') ? { origin: location.origin } : {}) },
    events: {
      onReady: () => { P.ready = true; if (P.pending) { P.yt.loadVideoById(P.pending); P.pending = null; } },
      onStateChange: onState,
      onError: onErr
    }
  });
};
(function loadYT() {
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  s.onerror = () => toast('Could not load the YouTube player. Check your connection.');
  document.head.appendChild(s);
})();

function onState(e) {
  const S = YT.PlayerState;
  if (e.data === S.PLAYING) { P.playing = true; P.errs = 0; }
  else if (e.data === S.PAUSED) P.playing = false;
  else if (e.data === S.ENDED) { next(true); return; }
  paint();
}
function onErr() {
  P.errs++;
  if (P.errs >= Math.min(P.queue.length, 5)) { P.playing = false; paint(); return toast('Those tracks cannot be played here.'); }
  toast('Cannot play this one. Skipping.');
  setTimeout(() => next(true), 700);
}

function play(queue, i) { P.queue = queue.slice(); go(i); }
function go(i) {
  const t = P.queue[i]; if (!t) return;
  P.idx = i;
  addRecent(t);
  if (P.ready) P.yt.loadVideoById(t.id); else P.pending = t.id;
  setMedia(t); paint();
}
function next(auto) {
  if (!P.queue.length) return;
  if (auto && P.repeat === 2) { P.yt.seekTo(0); P.yt.playVideo(); return; }
  let i;
  if (P.shuffle && P.queue.length > 1) { do { i = Math.floor(Math.random() * P.queue.length); } while (i === P.idx); }
  else { i = P.idx + 1; if (i >= P.queue.length) { if (P.repeat === 1 || !auto) i = 0; else { P.playing = false; P.yt.pauseVideo(); paint(); return; } } }
  go(i);
}
function prev() {
  if (P.ready && P.yt.getCurrentTime() > 3) return P.yt.seekTo(0, true);
  go(Math.max(0, P.idx - 1));
}
function toggle() {
  if (!P.ready || P.idx < 0) return;
  P.playing ? P.yt.pauseVideo() : P.yt.playVideo();
}

function addRecent(t) {
  const r = LS.get('recent', []).filter(x => x.id !== t.id);
  r.unshift(t); LS.set('recent', r.slice(0, 12));
}

/* paint everything that depends on the current track */
function paint() {
  const t = P.queue[P.idx];
  document.body.classList.toggle('playing', P.playing);
  $('#mini').classList.toggle('show', !!t);
  for (const id of ['#miniPlay', '#play']) $(id).innerHTML = P.playing ? ICON.pause : ICON.play;
  $('#shuf').classList.toggle('on', P.shuffle);
  $('#rep').classList.toggle('on', P.repeat > 0);
  $('#rep').dataset.m = P.repeat;
  if (!t) return;
  $('#miniArt').src = t.thumb; $('#miniTitle').textContent = t.title; $('#miniArtist').textContent = t.artist;
  $('#nowArt').src = t.hi || t.thumb; $('#nowTitle').textContent = t.title; $('#nowArtist').textContent = t.artist;
  $('#nowCount').textContent = pad(P.idx + 1) + ' / ' + pad(P.queue.length);
  $('#tDur').textContent = fmt(t.dur);
  $('#nowQueue').innerHTML = P.queue.slice(P.idx + 1, P.idx + 21).map((q, k) => trackRow(q, P.idx + 1 + k, false)).join('')
    || '<p class="mono empty">End of queue.</p>';
  // keep "now" highlight in lists
  document.querySelectorAll('#cRows .row, #recent .row').forEach(r => {
    const list = r.parentElement.id === 'cRows' ? col?.tracks : LS.get('recent', []);
    r.classList.toggle('now', list?.[+r.dataset.i]?.id === t.id);
  });
}

/* progress */
setInterval(() => {
  if (!P.ready || !P.yt.getCurrentTime || P.idx < 0) return;
  const t = P.queue[P.idx];
  const cur = P.yt.getCurrentTime() || 0;
  const dur = P.yt.getDuration() || t.dur || 0;
  if (dur && !P.scrubbing) {
    const p = Math.min(100, cur / dur * 100) + '%';
    $('#mini').style.setProperty('--p', p);
    $('#now').style.setProperty('--p', p);
    $('#tCur').textContent = fmt(cur);
    $('#tDur').textContent = fmt(dur);
  }
  if ('mediaSession' in navigator && dur && cur <= dur) {
    try { navigator.mediaSession.setPositionState({ duration: dur, position: cur, playbackRate: 1 }); } catch {}
  }
}, 500);

/* scrubbing */
(function scrub() {
  const bar = $('#bar');
  const ratio = e => { const r = bar.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  const show = (e) => {
    const t = P.queue[P.idx]; const dur = (P.ready && P.yt.getDuration()) || t?.dur || 0; const x = ratio(e);
    $('#now').style.setProperty('--p', x * 100 + '%'); $('#tCur').textContent = fmt(x * dur); return x * dur;
  };
  bar.addEventListener('pointerdown', e => { P.scrubbing = true; bar.setPointerCapture(e.pointerId); show(e); });
  bar.addEventListener('pointermove', e => { if (P.scrubbing) show(e); });
  bar.addEventListener('pointerup', e => { if (!P.scrubbing) return; const s = show(e); P.scrubbing = false; if (P.ready) P.yt.seekTo(s, true); });
  bar.addEventListener('pointercancel', () => { P.scrubbing = false; });
})();

/* lock screen / control centre */
function setMedia(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist, album: 'Platter',
    artwork: [{ src: t.hi || t.thumb, sizes: '480x360' }]
  });
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const set = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
  set('play', () => P.ready && P.yt.playVideo());
  set('pause', () => P.ready && P.yt.pauseVideo());
  set('nexttrack', () => next(false));
  set('previoustrack', prev);
  set('seekto', d => P.ready && P.yt.seekTo(d.seekTime, true));
}

/* video toggle: iframe stays put (moving it would reload it), we just overlay it on the sleeve */
function placeVideo() {
  const w = $('#yt-wrap');
  w.classList.toggle('vid', P.video);
  if (!P.video) { w.removeAttribute('style'); return; }
  const r = $('#stage').getBoundingClientRect();
  Object.assign(w.style, { left: r.left + 'px', top: r.top + 'px', right: 'auto', bottom: 'auto', width: r.width + 'px', height: r.height + 'px' });
}
window.addEventListener('resize', () => P.video && placeVideo());

/* ───────── navigation & events ───────── */
function closeAll() {
  overlay($('#menu'), false); overlay($('#settings'), false);
}
function openNow(open) {
  overlay($('#now'), open);
  if (!open && P.video) { P.video = false; $('#vidBtn').textContent = 'Show video'; placeVideo(); }
}
function openSettings() {
  $('#cid').value = LS.get('clientId', ''); $('#key').value = LS.get('apiKey', '');
  $('#status').textContent = Auth.valid() ? 'Signed in' : Auth.connected() ? 'API key only' : 'Not connected';
  overlay($('#menu'), false); overlay($('#settings'), true);
}
function openLiked() {
  if (!Auth.valid()) { toast('Sign in with Google to see your likes.'); return openSettings(); }
  openCollection('Liked', 'Your liked music', t => Loaders.liked(t));
}
function go_(dest) {
  closeAll();
  if (dest === 'home') show('home');
  else if (dest === 'search') { show('home'); setTimeout(() => $('#q').focus(), 50); }
  else if (dest === 'liked') openLiked();
  else if (dest === 'settings') openSettings();
}

document.addEventListener('click', e => {
  const g = e.target.closest('[data-go]'); if (g) return go_(g.dataset.go);

  const row = e.target.closest('.row');
  if (row) {
    const i = +row.dataset.i;
    if (row.closest('#cRows')) return play(col.tracks, i);
    if (row.closest('#recent')) return play(LS.get('recent', []), i);
    if (row.closest('#nowQueue')) return go(i);
  }
  const card = e.target.closest('.card');
  if (card) {
    if (card.dataset.liked) return openLiked();
    const id = card.dataset.pl;
    return openCollection(card.dataset.title, card.dataset.count + ' tracks in playlist', t => Loaders.playlist(id, t));
  }
});

$('#logo').onclick = () => { closeAll(); show('home'); };
$('#back').onclick = () => show('home');
$('#menuBtn').onclick = () => overlay($('#menu'), true);
$('#menuClose').onclick = () => overlay($('#menu'), false);
$('#settingsClose').onclick = () => overlay($('#settings'), false);
$('#more').onclick = () => loadMore();
$('#playAll').onclick = () => col?.tracks.length && play(col.tracks, 0);
$('#shufAll').onclick = () => {
  if (!col?.tracks.length) return;
  P.shuffle = true; LS.set('shuffle', true);
  play(col.tracks, Math.floor(Math.random() * col.tracks.length));
};

$('#sf').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('#q').value.trim(); if (!q) return;
  $('#q').blur();
  openCollection(q, 'Search results', t => Loaders.search(q, t));
});

$('#miniOpen').onclick = () => openNow(true);
$('#nowClose').onclick = () => openNow(false);
$('#miniPlay').onclick = $('#play').onclick = toggle;
$('#miniNext').onclick = $('#next').onclick = () => next(false);
$('#miniPrev').onclick = $('#prev').onclick = prev;
$('#shuf').onclick = () => { P.shuffle = !P.shuffle; LS.set('shuffle', P.shuffle); paint(); };
$('#rep').onclick = () => { P.repeat = (P.repeat + 1) % 3; LS.set('repeat', P.repeat); paint(); };
$('#vidBtn').onclick = () => {
  P.video = !P.video; $('#vidBtn').textContent = P.video ? 'Hide video' : 'Show video'; placeVideo();
};

/* settings */
$('#saveCfg').onclick = () => {
  const cid = $('#cid').value.trim(), key = $('#key').value.trim();
  cid ? LS.set('clientId', cid) : LS.del('clientId');
  key ? LS.set('apiKey', key) : LS.del('apiKey');
  toast('Saved'); $('#status').textContent = Auth.valid() ? 'Signed in' : Auth.connected() ? 'API key only' : 'Not connected';
  renderHome();
};
$('#signIn').onclick = async () => {
  $('#saveCfg').click();
  try {
    await Auth.signIn();
    $('#status').textContent = 'Signed in';
    await fetchPlaylists().catch(e => toast(e.message));
    renderHome(); overlay($('#settings'), false); toast('Connected');
  } catch (e) { toast(e.message); }
};
$('#signOut').onclick = () => { Auth.signOut(); $('#status').textContent = 'Signed out'; renderHome(); toast('Signed out'); };

/* ───────── boot ───────── */
renderHome(); paint();
$('#mini').classList.remove('show');
if (Auth.valid()) fetchPlaylists().then(renderHome).catch(() => {});
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
})();
