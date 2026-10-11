/* Kadans — açık kaynak müzik çalar.
   Piped API (CORS açık örnekler) üzerinden arama + akış, tamamen istemci tarafında.
   Beğeniler ve çalma listeleri localStorage'da tutulur: hesap gerekmez. */

'use strict';

/* ---------- Invidious API istemcisi (yedekli) ---------- */
const INSTANCES = [
  'https://invidious.flokinet.to',
  'https://invidious.f5.si',
  'https://iv.melmac.space',
];

let activeInstance = localStorage.getItem('kd_instance') || INSTANCES[0];

async function api(path, { timeout = 9000 } = {}) {
  const order = [activeInstance, ...INSTANCES.filter(i => i !== activeInstance)];
  let lastErr;
  for (const base of order) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(base + path, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      activeInstance = base;
      localStorage.setItem('kd_instance', base);
      setNet(true, base.replace('https://', ''));
      return json;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
    }
  }
  setNet(false, 'bağlantı yok');
  throw lastErr || new Error('Tüm sunucular yanıt vermedi');
}

function normalize(item) {
  return {
    id: item.videoId,
    title: item.title,
    artist: item.author || 'Bilinmeyen',
    thumbnail: `https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg`,
    length: item.lengthSeconds,
    live: !!item.liveNow,
  };
}

function fromBackend(x) {
  return { id: x.id, title: x.title, artist: x.artist || 'Bilinmeyen',
           thumbnail: x.thumbnail || `https://i.ytimg.com/vi/${x.id}/mqdefault.jpg`,
           length: x.length || 0, live: false };
}

async function searchMusic(q) {
  if (API_BASE) {
    const r = await fetch(`${API_BASE}/ara?q=${encodeURIComponent(q)}`);
    if (r.ok) return (await r.json()).map(fromBackend);
  }
  const data = await api(`/api/v1/search?q=${encodeURIComponent(q)}&type=video`);
  return (data || []).filter(i => i.type === 'video' && !i.liveNow).map(normalize);
}

async function getTrending(region = 'TR') {
  if (API_BASE) {
    try {
      const r = await fetch(`${API_BASE}/ana-sayfa`);
      if (r.ok) return (await r.json()).map(fromBackend);
    } catch { /* örneklere düş */ }
  }
  try {
    const data = await api(`/api/v1/trending?region=${region}&type=music`);
    const songs = (data || []).filter(i => (i.lengthSeconds || 0) > 60 && i.lengthSeconds < 900).map(normalize);
    if (songs.length) return songs;
  } catch { /* aramalara düş */ }
  // Trend müzik listeleri: canlı yayın ve klipsiz doğrudan şarkı
  const queries = ['yeni çıkan türkçe pop şarkılar 2026', 'top hits 2026 songs', 'türkçe rap 2026'];
  const all = [];
  const seen = new Set();
  for (const q of queries) {
    try {
      for (const s of await searchMusic(q)) {
        if (!seen.has(s.id) && !s.live && s.length > 60 && s.length < 900) {
          seen.add(s.id);
          all.push(s);
        }
      }
    } catch { /* tek sorgu düşse de devam */ }
  }
  if (!all.length) throw new Error('içerik alınamadı');
  return all;
}

/* İsteğe bağlı kendi proxy sunucun: siteyi ?api=http://localhost:8000 ile aç.
   backend/main.py'nin /stream ucu akışı doğrudan verir; örnekler yedek olur. */
const _apiParam = new URLSearchParams(location.search).get('api');
if (_apiParam === '0') localStorage.removeItem('kd_api');
else if (_apiParam) localStorage.setItem('kd_api', _apiParam);
const API_BASE = _apiParam && _apiParam !== '0' ? _apiParam : (localStorage.getItem('kd_api') || '');

async function getStreamUrl(videoId) {
  if (API_BASE) return `${API_BASE}/stream?videoId=${videoId}&quality=high`;
  // Örnekler anlık düşebiliyor: her örnekte 3 deneme + tüm tur biterse bir tur daha.
  for (let round = 0; round < 2; round++) {
    for (const base of INSTANCES) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 12000);
        try {
          const res = await fetch(`${base}/api/v1/videos/${videoId}`, { signal: ctrl.signal });
          clearTimeout(t);
          if (!res.ok) continue;
          const data = await res.json();
          const audio = (data.adaptiveFormats || [])
            .filter(f => f.url && (f.type || '').startsWith('audio'))
            .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));
          if (audio[0]?.url) return audio[0].url;
        } catch {
          clearTimeout(t);
        }
      }
    }
    if (round === 0) await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error('Ses akışı alınamadı');
}

/* ---------- durum ---------- */
const state = {
  queue: [],
  index: -1,
  playing: false,
  shuffle: false,
  repeat: false, // tek şarkı tekrarı
  likes: JSON.parse(localStorage.getItem('kd_likes') || '[]'),
  playlists: JSON.parse(localStorage.getItem('kd_playlists') || '[]'), // {id,name,songs:[]}
};

function persist() {
  localStorage.setItem('kd_likes', JSON.stringify(state.likes));
  localStorage.setItem('kd_playlists', JSON.stringify(state.playlists));
}

const $ = s => document.querySelector(s);
const audio = $('#audio');

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), 2600);
}

function setNet(ok, label) {
  $('#net-dot').className = 'net-dot ' + (ok ? 'ok' : 'bad');
  $('#net-label').textContent = label;
}

const fmt = s => {
  if (!isFinite(s)) return '0:00';
  s = Math.floor(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/* ---------- çalar ---------- */
function current() { return state.queue[state.index] || null; }

function isLiked(id) { return state.likes.some(s => s.id === id); }

function toggleLike(song) {
  const i = state.likes.findIndex(s => s.id === song.id);
  if (i >= 0) state.likes.splice(i, 1);
  else state.likes.unshift(song);
  persist();
  syncLikeBtn();
  if (view === 'likes') renderLikes();
}

function syncLikeBtn() {
  const song = current();
  const btn = $('#btn-like');
  btn.hidden = !song;
  if (song) btn.classList.toggle('is-on', isLiked(song.id));
}

function playQueue(songs, startIdx = 0) {
  state.queue = [...songs];
  state.index = startIdx;
  load(true);
  renderQueue();
}

function load(autoplay = false) {
  const song = current();
  if (!song) return;
  audio.pause();
  $('#np-title').textContent = song.title;
  $('#np-artist').textContent = song.artist;
  const art = $('#np-art');
  art.hidden = false;
  $('#np-art-ph').hidden = true;
  art.src = song.thumbnail || '';
  syncLikeBtn();
  document.title = `${song.title} — Kadans`;

  toast('Yükleniyor…');
  getStreamUrl(song.id)
    .then(url => {
      if (!url) throw new Error('Ses bulunamadı');
      if (current()?.id !== song.id) return;
      audio.src = url;
      audio.play().then(() => toast.dismiss?.()).catch(() => {});
      $('#toast').hidden = true;
    })
    .catch(e => {
      console.error(e);
      toast('Akış alınamadı, sonraki deneniyor…');
      setTimeout(next, 1200);
    });
  markPlayingRow();
}

function next() {
  if (state.shuffle && state.queue.length > 1) {
    let n;
    do { n = Math.floor(Math.random() * state.queue.length); } while (n === state.index);
    state.index = n;
  } else if (state.index < state.queue.length - 1) {
    state.index++;
  } else {
    state.index = 0; // listenin sonunda başa dön
  }
  load(true);
  renderQueue();
}

function prev() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  state.index = state.index > 0 ? state.index - 1 : state.queue.length - 1;
  load(true);
  renderQueue();
}

/* ---------- render ---------- */
let view = 'home';

function showView(name, plId = null) {
  view = name;
  for (const v of ['home', 'search', 'likes', 'playlist']) {
    $(`#view-${v}`).hidden = v !== name;
  }
  document.querySelectorAll('.rail-link').forEach(b =>
    b.classList.toggle('is-active', b.dataset.nav === name || (name === 'playlist' && b.dataset.nav === 'home')));
  document.querySelectorAll('.pl-item').forEach(b =>
    b.classList.toggle('is-active', b.dataset.plid === String(plId)));
  $('#main').scrollTop = 0;
}

function songRow(song, i, onPlay) {
  const row = document.createElement('button');
  row.className = 'row';
  row.dataset.id = song.id;
  row.innerHTML = `
    ${i != null ? `<span class="row-n">${i + 1}</span>` : ''}
    <img class="row-art" loading="lazy" src="${song.thumbnail || ''}" alt="" onerror="this.style.visibility='hidden'">
    <span class="row-meta"><span class="row-t"></span><span class="row-a"></span></span>`;
  row.querySelector('.row-t').textContent = song.title;
  row.querySelector('.row-a').textContent = song.artist;
  row.addEventListener('click', e => {
    if (e.target.closest('.like-btn')) return;
    onPlay();
  });
  const like = document.createElement('button');
  like.className = 'icon-btn like-btn' + (isLiked(song.id) ? ' is-on' : '');
  like.title = 'Beğen';
  like.setAttribute('aria-label', 'Beğen');
  like.innerHTML = '<i class="ic" style="--m:url(https://unpkg.com/@fluentui/svg-icons@1.1.260/icons/heart_24_filled.svg)"></i>';
  like.addEventListener('click', () => {
    toggleLike(song);
    like.classList.toggle('is-on', isLiked(song.id));
  });
  row.appendChild(like);
  return row;
}

function fillList(el, songs) {
  el.innerHTML = '';
  if (!songs.length) {
    el.innerHTML = '<p class="empty-note">Burada henüz bir şey yok.</p>';
    return;
  }
  // Bilişsel yük: ilk 5 öğe açık, gerisi isteğe açılır.
  const VISIBLE = 5;
  const render = (count) => {
    el.innerHTML = '';
    songs.slice(0, count).forEach((s, i) => el.appendChild(songRow(s, i, () => playQueue(songs, i))));
    if (songs.length > count) {
      const more = document.createElement('button');
      more.className = 'show-more';
      more.textContent = `${songs.length - count} tane daha göster`;
      more.addEventListener('click', () => render(count + 15));
      el.appendChild(more);
    }
    markPlayingRow();
  };
  render(Math.min(VISIBLE, songs.length));
}

function markPlayingRow() {
  const song = current();
  document.querySelectorAll('.row').forEach(r =>
    r.classList.toggle('is-playing', song && r.dataset.id === song.id));
}

async function renderHome() {
  const grid = $('#home-grid');
  grid.innerHTML = Array.from({ length: 12 }, () => '<div class="skeleton" style="aspect-ratio:1"></div>').join('');
  try {
    const songs = await getTrending('TR');
    grid.innerHTML = '';
    songs.slice(0, 24).forEach(s => {
      const card = document.createElement('button');
      card.className = 'card';
      card.innerHTML = `<img class="card-art" loading="lazy" src="${s.thumbnail || ''}" alt="" onerror="this.style.opacity=.25">
        <div class="card-t"></div><div class="card-a"></div>`;
      card.querySelector('.card-t').textContent = s.title;
      card.querySelector('.card-a').textContent = s.artist;
      card.addEventListener('click', () => playQueue(songs, songs.indexOf(s)));
      grid.appendChild(card);
    });
  } catch {
    grid.innerHTML = '<p class="empty-note">Trendler yüklenemedi. Ağ bağlantını kontrol et.</p>';
  }
}

function renderLikes() { fillList($('#likes-list'), state.likes); }

function renderPlaylists() {
  const list = $('#pl-list');
  list.innerHTML = '';
  if (!state.playlists.length) {
    list.innerHTML = '<p class="pl-empty">Liste yok — + ile ekle</p>';
    return;
  }
  for (const pl of state.playlists) {
    const b = document.createElement('button');
    b.className = 'pl-item';
    b.dataset.plid = pl.id;
    b.textContent = `${pl.name} (${pl.songs.length})`;
    b.addEventListener('click', () => openPlaylist(pl.id));
    list.appendChild(b);
  }
}

function openPlaylist(id) {
  const pl = state.playlists.find(p => p.id === id);
  if (!pl) return;
  showView('playlist', id);
  $('#pl-title').textContent = pl.name;
  fillList($('#pl-songs'), pl.songs);
}

function renderQueue() {
  const list = $('#queue-list');
  list.innerHTML = '';
  state.queue.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'queue-row' + (i === state.index ? ' is-now' : '');
    b.innerHTML = `<img src="${s.thumbnail || ''}" alt="" loading="lazy">
      <span class="row-meta"><span class="row-t"></span><span class="row-a"></span></span>`;
    b.querySelector('.row-t').textContent = s.title;
    b.querySelector('.row-a').textContent = s.artist;
    b.addEventListener('click', () => { state.index = i; load(true); renderQueue(); });
    list.appendChild(b);
  });
}

/* ---------- olaylar ---------- */
$('#btn-play').addEventListener('click', () => {
  if (!current()) return;
  audio.paused ? audio.play() : audio.pause();
});
$('#btn-next').addEventListener('click', next);
$('#btn-prev').addEventListener('click', prev);
$('#btn-like').addEventListener('click', () => toggleLike(current()));
$('#btn-shuffle').addEventListener('click', e => {
  state.shuffle = !state.shuffle;
  e.currentTarget.classList.toggle('is-on', state.shuffle);
  e.currentTarget.setAttribute('aria-pressed', state.shuffle);
});
$('#btn-repeat').addEventListener('click', e => {
  state.repeat = !state.repeat;
  e.currentTarget.classList.toggle('is-on', state.repeat);
  e.currentTarget.setAttribute('aria-pressed', state.repeat);
});
$('#btn-queue').addEventListener('click', e => {
  const d = $('#queue-drawer');
  d.hidden = !d.hidden;
  e.currentTarget.setAttribute('aria-expanded', !d.hidden);
});
$('#btn-queue-close').addEventListener('click', () => {
  $('#queue-drawer').hidden = true;
  $('#btn-queue').setAttribute('aria-expanded', 'false');
});

$('#btn-new-pl').addEventListener('click', () => {
  const name = prompt('Çalma listesi adı:');
  if (!name?.trim()) return;
  state.playlists.push({ id: Date.now(), name: name.trim(), songs: [] });
  persist();
  renderPlaylists();
});

document.querySelectorAll('.rail-link').forEach(b =>
  b.addEventListener('click', () => {
    const nav = b.dataset.nav;
    if (nav === 'home') { showView('home'); renderHome(); }
    if (nav === 'likes') { showView('likes'); renderLikes(); }
    if (nav === 'search') { showView('search'); $('#search-input').focus(); }
  }));

let searchT;
$('#search-input').addEventListener('input', e => {
  const q = e.target.value.trim();
  clearTimeout(searchT);
  if (!q) return;
  searchT = setTimeout(async () => {
    showView('search');
    $('#search-title').textContent = 'Aranıyor…';
    $('#search-list').innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join('');
    try {
      const songs = await searchMusic(q);
      $('#search-title').textContent = `"${q}" için sonuçlar`;
      fillList($('#search-list'), songs);
      markPlayingRow();
    } catch {
      $('#search-title').textContent = 'Arama başarısız';
      $('#search-list').innerHTML = '<p class="empty-note">Sunuculara ulaşılamadı, tekrar dene.</p>';
    }
  }, 420);
});
$('#search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') e.target.dispatchEvent(new Event('input'));
});

/* audio olayları */
audio.addEventListener('play', () => {
  state.playing = true;
  $('#btn-play .ic-play').hidden = true;
  $('#btn-play .ic-pause').hidden = false;
});
audio.addEventListener('pause', () => {
  state.playing = false;
  $('#btn-play .ic-play').hidden = false;
  $('#btn-play .ic-pause').hidden = true;
});
audio.addEventListener('ended', () => {
  if (state.repeat) { audio.currentTime = 0; audio.play(); return; }
  next();
});
audio.addEventListener('timeupdate', () => {
  const p = audio.duration ? (audio.currentTime / audio.duration) * 1000 : 0;
  const seek = $('#seek');
  if (!seek.matches(':active')) seek.value = p;
  $('#t-cur').textContent = fmt(audio.currentTime);
  $('#t-dur').textContent = fmt(audio.duration);
  document.querySelector('.player').style.setProperty('--progress', p / 1000);
  seek.style.setProperty('--fill', (p / 10) + '%');
});
$('#seek').addEventListener('input', e => {
  if (audio.duration) audio.currentTime = (e.target.value / 1000) * audio.duration;
});
$('#vol').addEventListener('input', e => {
  audio.volume = e.target.value / 100;
  e.target.style.setProperty('--fill', e.target.value + '%');
});
audio.volume = 0.9;

/* klavye kısayolları */
document.addEventListener('keydown', e => {
  if (e.target.matches('input')) return;
  if (e.code === 'Space') { e.preventDefault(); $('#btn-play').click(); }
  if (e.key === 'ArrowRight' && e.shiftKey) next();
  if (e.key === 'ArrowLeft' && e.shiftKey) prev();
});

/* medya tuşları (kilit ekranı dahil) */
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('nexttrack', next);
  navigator.mediaSession.setActionHandler('previoustrack', prev);
}
audio.addEventListener('play', () => {
  if ('mediaSession' in navigator && current()) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current().title,
      artist: current().artist,
      album: 'Kadans',
      artwork: [{ src: current().thumbnail || '', sizes: '512x512' }],
    });
  }
});

/* ---------- tam ekran çalar (mobil) ---------- */
const sheet = $('#np-sheet');
const proxy = (sheetId, mainId) => {
  const s = $(sheetId), m = $(mainId);
  if (!s || !m) return;
  s.addEventListener('click', () => {
    m.click();
    syncSheet();
  });
};
function syncSheet() {
  const song = current();
  $('#sheet-title').textContent = song ? song.title : 'Bir şey çalmıyor';
  $('#sheet-artist').textContent = song ? song.artist : 'Kadans';
  const art = $('#sheet-art');
  if (song) { art.src = song.thumbnail || ''; art.hidden = false; }
  $('#sheet-play .ic-play').hidden = state.playing;
  $('#sheet-play .ic-pause').hidden = !state.playing;
  $('#sheet-shuffle').classList.toggle('is-on', state.shuffle);
  $('#sheet-repeat').classList.toggle('is-on', state.repeat);
}
$('#np-title').closest('.player-main').addEventListener('click', e => {
  if (e.target.closest('.like-btn')) return;
  if (window.innerWidth <= 880 && current()) { sheet.hidden = false; syncSheet(); }
});
$('#sheet-close').addEventListener('click', () => (sheet.hidden = true));
proxy('#sheet-play', '#btn-play');
proxy('#sheet-next', '#btn-next');
proxy('#sheet-prev', '#btn-prev');
proxy('#sheet-shuffle', '#btn-shuffle');
proxy('#sheet-repeat', '#btn-repeat');
$('#sheet-seek').addEventListener('input', e => {
  if (audio.duration) audio.currentTime = (e.target.value / 1000) * audio.duration;
});
audio.addEventListener('timeupdate', () => {
  const a = $('#sheet-seek');
  if (!a.matches(':active')) a.value = $('#seek').value;
  $('#sheet-t-cur').textContent = $('#t-cur').textContent;
  $('#sheet-t-dur').textContent = $('#t-dur').textContent;
});

/* başlangıç */
renderPlaylists();
renderHome();
setNet(true, 'bağlanıyor…');
