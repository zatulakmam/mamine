// mamine — app.js
// Backend: Supabase (Auth + Postgres + Storage). Foto tersimpan di cloud,
// jadi bisa dibuka dari perangkat mana pun.
// IndexedDB lama hanya dibaca untuk memindahkan data lama ke cloud.

// ============================================================
//  SUPABASE CONFIG
// ============================================================
const SUPABASE_URL = 'https://tyaplawpnosyrvuxkjxn.supabase.co';
// Publishable key: aman dipakai di browser selama RLS aktif.
// JANGAN pernah taruh secret key (sb_secret_...) di file ini.
const SUPABASE_KEY = 'sb_publishable_CkxjLEUQcWL59NsO2n02ZA_hwmZdAyW';
const OWNER_EMAIL  = 'zatulakmam296@gmail.com';
const BUCKET       = 'photos';
const SIGNED_URL_TTL = 60 * 60 * 24; // 24 jam; di-refresh tiap halaman dimuat

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================================
//  LEGACY LOCAL DB (hanya untuk membaca data lama)
// ============================================================
let db = null;

function initIndexedDB() {
  return new Promise((resolve) => {
    if (!window.indexedDB) {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open('MamineDB', 2);

      req.onupgradeneeded = (e) => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains('photos')) {
          const pStore = database.createObjectStore('photos', { keyPath: 'id' });
          pStore.createIndex('uid', 'uid', { unique: false });
          pStore.createIndex('createdAt', 'createdAt', { unique: false });
          pStore.createIndex('album', 'album', { unique: false });
        }
        if (!database.objectStoreNames.contains('albums')) {
          const aStore = database.createObjectStore('albums', { keyPath: 'id' });
          aStore.createIndex('uid', 'uid', { unique: false });
          aStore.createIndex('name', 'name', { unique: false });
        }
      };

      req.onsuccess = (e) => { db = e.target.result; resolve(db); };
      req.onerror = () => {
        console.warn('IndexedDB unavailable, using localStorage fallback');
        resolve(null);
      };
    } catch (_) {
      resolve(null);
    }
  });
}

function idbGetAll(storeName, indexName, key) {
  return new Promise((resolve) => {
    if (!db) {
      const fallbackKey = storeName === 'albums' ? 'mamine_albums' : 'mamine_photos';
      const all = JSON.parse(localStorage.getItem(fallbackKey) || '[]');
      const filtered = key ? all.filter(p => p[indexName] === key) : all;
      resolve(filtered);
      return;
    }
    try {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = indexName ? store.index(indexName).getAll(key) : store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch (_) {
      resolve([]);
    }
  });
}

// ============================================================
//  GLOBAL STATE
// ============================================================
let allPhotos = [];
let allAlbums = [];
let filteredPhotos = [];
let currentSort = 'date';
let lightboxIndex = 0;
let currentViewingAlbum = null;
let uploadTargetAlbum = '';
let selectedPhotoIdsForAlbum = new Set();


// ============================================================
//  AUTH (satu password, akun tetap di Supabase)
// ============================================================
function showLock() {
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('app-screen').style.display = 'none';
}

async function enterApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'flex';
  await loadData();
  await checkLegacyData();
}

window.handleLogin = async function() {
  const passEl = document.getElementById('login-pass');
  const errEl  = document.getElementById('login-error');
  errEl.style.display = 'none';

  if (!passEl.value) {
    errEl.textContent = '> ERROR: Password harus diisi!';
    errEl.style.display = 'block';
    return;
  }

  const { error } = await sb.auth.signInWithPassword({ email: OWNER_EMAIL, password: passEl.value });
  if (error) {
    errEl.textContent = '> ERROR: Password salah atau koneksi bermasalah.';
    errEl.style.display = 'block';
    return;
  }
  passEl.value = '';
  await enterApp();
};

window.handleLogout = async function() {
  await sb.auth.signOut();
  allPhotos = [];
  allAlbums = [];
  filteredPhotos = [];
  showLock();
};

async function boot() {
  const { data } = await sb.auth.getSession();
  if (data && data.session) await enterApp();
  else showLock();
}

boot();

// Tampilkan pesan kalau ada operasi cloud yang gagal tanpa ditangani
window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  alert('Terjadi kesalahan saat menghubungi server. Cek koneksi internet lalu coba lagi.');
});

// ============================================================
//  CLOUD HELPERS
// ============================================================
async function getSignedUrlMap(paths) {
  const map = {};
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(chunk, SIGNED_URL_TTL);
    if (error) throw error;
    (data || []).forEach(d => { if (d.signedUrl) map[d.path] = d.signedUrl; });
  }
  return map;
}

function photoToRow(photo) {
  return {
    id: photo.id,
    name: photo.name,
    path: photo.path,
    type: photo.type,
    fav: !!photo.fav,
    album: photo.album || '',
    created_at: (photo.createdAt instanceof Date ? photo.createdAt : new Date(photo.createdAt)).toISOString()
  };
}

async function savePhotoToDb(photo) {
  const { error } = await sb.from('photos').upsert(photoToRow(photo));
  if (error) throw error;
}

async function saveAlbumToDb(album) {
  const { error } = await sb.from('albums').upsert({
    id: album.id,
    name: album.name,
    created_at: (album.createdAt instanceof Date ? album.createdAt : new Date(album.createdAt)).toISOString()
  });
  if (error) throw error;
}

function extFromName(name) {
  const e = String(name || '').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
  return e && e.length <= 5 ? e : 'bin';
}

// Foto JPEG/HEIC dikecilkan (maks 2400px, kualitas 85%) supaya hemat kuota dan cepat dimuat.
// Video dan format lain diunggah apa adanya. Kalau kompresi gagal, file asli yang diunggah.
async function prepareFile(file) {
  const compressible = /^image\/(jpeg|jpg|heic|heif)$/i.test(file.type);
  if (compressible) {
    try {
      const bmp = await createImageBitmap(file);
      const MAX = 2400;
      const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
      if (scale < 1 || file.size > 1.5 * 1024 * 1024) {
        const canvas = document.createElement('canvas');
        canvas.width  = Math.round(bmp.width * scale);
        canvas.height = Math.round(bmp.height * scale);
        canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
        if (blob && blob.size < file.size) {
          return { blob, contentType: 'image/jpeg', ext: 'jpg' };
        }
      }
    } catch (_) { /* pakai file asli */ }
  }
  return { blob: file, contentType: file.type || 'application/octet-stream', ext: extFromName(file.name) };
}

// ============================================================
//  LOAD DATA (PHOTOS & ALBUMS)
// ============================================================
async function loadData() {
  try {
    const [pRes, aRes] = await Promise.all([
      sb.from('photos').select('*').order('created_at', { ascending: false }),
      sb.from('albums').select('*')
    ]);
    if (pRes.error) throw pRes.error;
    if (aRes.error) throw aRes.error;

    const rows = pRes.data || [];
    const urlMap = await getSignedUrlMap(rows.map(r => r.path));

    allPhotos = rows.map(r => ({
      id: r.id,
      name: r.name,
      path: r.path,
      type: r.type,
      fav: !!r.fav,
      album: r.album || '',
      createdAt: new Date(r.created_at),
      url: urlMap[r.path] || ''
    }));

    allAlbums = (aRes.data || []).map(a => ({
      id: a.id,
      name: a.name,
      createdAt: new Date(a.created_at)
    }));
  } catch (e) {
    console.error('Data load failed:', e);
    alert('Gagal memuat data dari server. Cek koneksi internet lalu muat ulang halaman.');
    allPhotos = [];
    allAlbums = [];
  }

  syncPhotosAlbums();

  filteredPhotos = [...allPhotos];
  renderGallery(filteredPhotos);
  renderAlbums();
  renderFavorites();
  renderMemories(allPhotos);
  updateCounts();
}

function syncPhotosAlbums() {
  const existingNames = new Set(allAlbums.map(a => a.name.toUpperCase()));
  allPhotos.forEach(p => {
    if (p.album && !existingNames.has(p.album.toUpperCase())) {
      const newAlb = {
        id: 'alb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: p.album.toUpperCase(),
        createdAt: new Date()
      };
      allAlbums.push(newAlb);
      existingNames.add(newAlb.name);
      saveAlbumToDb(newAlb);
    }
  });
}

// ============================================================
//  PINDAHKAN DATA LAMA (IndexedDB browser -> cloud)
// ============================================================
let legacyPhotos = [];
let legacyAlbums = [];
let legacyLoaded = false;

async function checkLegacyData() {
  if (!legacyLoaded) {
    try {
      await initIndexedDB();
      legacyPhotos = (await idbGetAll('photos')) || [];
      legacyAlbums = (await idbGetAll('albums')) || [];
    } catch (_) {}
    legacyLoaded = true;
  }
  const cloudIds = new Set(allPhotos.map(p => p.id));
  const remaining = legacyPhotos.filter(p => !cloudIds.has(p.id));
  const btn = document.getElementById('btn-migrate');
  if (!btn) return;
  btn.disabled = false;
  btn.style.display = remaining.length ? 'block' : 'none';
  btn.textContent = `☁️ PINDAHKAN ${remaining.length} FOTO LAMA`;
}

window.migrateLegacy = async function() {
  const cloudIds = new Set(allPhotos.map(p => p.id));
  const todo = legacyPhotos.filter(p => !cloudIds.has(p.id));
  if (!todo.length) return;
  if (!confirm(`Unggah ${todo.length} foto lama dari browser ini ke cloud? Data lama di browser tidak dihapus.`)) return;

  const btn = document.getElementById('btn-migrate');
  btn.disabled = true;
  let ok = 0, fail = 0;

  for (let i = 0; i < todo.length; i++) {
    const lp = todo[i];
    btn.textContent = `⏳ ${i + 1} / ${todo.length}`;
    try {
      const blob = await (await fetch(lp.url)).blob();
      const ext  = extFromName(lp.name) !== 'bin' ? extFromName(lp.name) : (blob.type.split('/')[1] || 'bin');
      const path = `${lp.id}.${ext}`;
      const { error: upErr } = await sb.storage.from(BUCKET).upload(path, blob, {
        contentType: blob.type || 'application/octet-stream',
        cacheControl: '31536000',
        upsert: true
      });
      if (upErr) throw upErr;
      await savePhotoToDb({
        id: lp.id,
        name: lp.name,
        path,
        type: lp.type || (blob.type.startsWith('video') ? 'video' : 'image'),
        fav: !!lp.fav,
        album: lp.album || '',
        createdAt: lp.createdAt || new Date()
      });
      ok++;
    } catch (e) {
      console.error('Migrasi gagal:', lp.name, e);
      fail++;
    }
  }

  const albumNames = new Set(allAlbums.map(a => a.name.toUpperCase()));
  for (const la of legacyAlbums) {
    const n = String(la.name || '').toUpperCase();
    if (!n || albumNames.has(n)) continue;
    try {
      await saveAlbumToDb({ id: la.id, name: n, createdAt: la.createdAt || new Date() });
      albumNames.add(n);
    } catch (e) { console.error(e); }
  }

  await loadData();
  await checkLegacyData();
  alert(`Selesai: ${ok} berhasil, ${fail} gagal. Data lama di browser ini tidak dihapus otomatis.`);
};

function updateCounts() {
  document.getElementById('photo-count').textContent = allPhotos.length;
  document.getElementById('side-storage').textContent = `${allPhotos.length} FOTO TERSIMPAN`;
}

// ============================================================
//  ALBUM LOGIC
// ============================================================
window.createAlbumPrompt = function() {
  document.getElementById('create-album-modal').style.display = 'flex';
  const input = document.getElementById('new-album-name');
  input.value = '';
  setTimeout(() => input.focus(), 60);
};

window.createAlbum = async function() {
  const input = document.getElementById('new-album-name');
  const rawName = input.value.trim();
  if (!rawName) return;

  const albumName = rawName.toUpperCase();

  // Check duplicate
  if (allAlbums.some(a => a.name.toUpperCase() === albumName)) {
    alert(`Album "${albumName}" sudah ada!`);
    return;
  }

  const newAlbum = {
    id: 'alb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name: albumName,
    createdAt: new Date()
  };

  allAlbums.push(newAlbum);
  await saveAlbumToDb(newAlbum);

  input.value = '';
  document.getElementById('create-album-modal').style.display = 'none';

  // Render album grid immediately
  renderAlbums();

  // Open the newly created album directly so user can add photos
  openAlbum(albumName);
};

function renderAlbums() {
  const grid = document.getElementById('albums-grid');
  const empty = document.getElementById('empty-albums');

  if (!allAlbums.length) {
    empty.style.display = 'flex';
    grid.innerHTML = '';
    return;
  }

  empty.style.display = 'none';

  grid.innerHTML = allAlbums.map(album => {
    const photosInAlbum = allPhotos.filter(p => (p.album || '').toUpperCase() === album.name.toUpperCase());
    const count = photosInAlbum.length;
    const coverPhoto = photosInAlbum[0];

    const coverHtml = coverPhoto
      ? `<img src="${coverPhoto.url}" alt="${escapeHtml(album.name)}" />`
      : `<div style="font-size:36px;">📦</div>`;

    return `
      <div class="album-card" onclick="openAlbum('${escapeHtml(album.name)}')">
        <div class="album-cover">${coverHtml}</div>
        <div class="album-info">
          <div class="album-name">${escapeHtml(album.name)}</div>
          <div class="album-count">${count} FOTO</div>
        </div>
      </div>
    `;
  }).join('');
}

window.openAlbum = function(albumName) {
  currentViewingAlbum = albumName.toUpperCase();
  const photos = allPhotos.filter(p => (p.album || '').toUpperCase() === currentViewingAlbum);

  document.getElementById('album-modal-title').textContent = `📦 ${currentViewingAlbum} (${photos.length} FOTO)`;

  const emptyState = document.getElementById('album-empty-state');
  const grid = document.getElementById('album-photo-grid');

  if (!photos.length) {
    emptyState.style.display = 'flex';
    grid.innerHTML = '';
  } else {
    emptyState.style.display = 'none';
    grid.innerHTML = photos.map((p, i) => photoCard(p, i, photos)).join('');
  }

  document.getElementById('album-modal').style.display = 'flex';
};

window.closeAlbumModal = function() {
  document.getElementById('album-modal').style.display = 'none';
  currentViewingAlbum = null;
};

// Trigger direct photo upload into currently open album
window.triggerAlbumUpload = function() {
  uploadTargetAlbum = currentViewingAlbum || '';
  document.getElementById('file-input').click();
};

// Delete current viewing album
window.deleteCurrentAlbum = async function() {
  if (!currentViewingAlbum) return;
  const albumNameToDelete = currentViewingAlbum;

  if (!confirm(`Hapus album "${albumNameToDelete}"? (Foto di dalamnya tidak akan terhapus, hanya dikeluarkan dari album)`)) {
    return;
  }

  const albumObj = allAlbums.find(a => a.name.toUpperCase() === albumNameToDelete);
  allAlbums = allAlbums.filter(a => a.name.toUpperCase() !== albumNameToDelete);

  const affectedPhotos = allPhotos.filter(p => (p.album || '').toUpperCase() === albumNameToDelete);
  affectedPhotos.forEach(p => { p.album = ''; });

  if (albumObj) {
    const { error } = await sb.from('albums').delete().eq('id', albumObj.id);
    if (error) console.error(error);
  }
  for (const p of affectedPhotos) {
    await savePhotoToDb(p);
  }

  closeAlbumModal();
  renderAlbums();
  renderGallery(filteredPhotos);
};

// Select photos from gallery to add into current album
window.openAddFromGalleryModal = function() {
  if (!currentViewingAlbum) return;

  selectedPhotoIdsForAlbum.clear();
  const photosInThisAlbum = new Set(
    allPhotos.filter(p => (p.album || '').toUpperCase() === currentViewingAlbum).map(p => p.id)
  );

  const grid = document.getElementById('select-photos-grid');
  grid.innerHTML = allPhotos.map(p => {
    const isAlreadyIn = photosInThisAlbum.has(p.id);
    if (isAlreadyIn) selectedPhotoIdsForAlbum.add(p.id);

    const media = p.type === 'video'
      ? `<video src="${p.url}"></video>`
      : `<img src="${p.url}" alt="${escapeHtml(p.name)}" />`;

    return `
      <div class="select-photo-item ${isAlreadyIn ? 'is-selected' : ''}" 
           id="sel-item-${p.id}" onclick="togglePhotoSelection('${p.id}')">
        <span class="check-badge">${isAlreadyIn ? '✓' : ''}</span>
        ${media}
      </div>
    `;
  }).join('');

  document.getElementById('select-photos-modal').style.display = 'flex';
};

window.togglePhotoSelection = function(photoId) {
  const el = document.getElementById(`sel-item-${photoId}`);
  if (!el) return;

  if (selectedPhotoIdsForAlbum.has(photoId)) {
    selectedPhotoIdsForAlbum.delete(photoId);
    el.classList.remove('is-selected');
    el.querySelector('.check-badge').textContent = '';
  } else {
    selectedPhotoIdsForAlbum.add(photoId);
    el.classList.add('is-selected');
    el.querySelector('.check-badge').textContent = '✓';
  }
};

window.saveSelectedPhotosToAlbum = async function() {
  if (!currentViewingAlbum) return;

  const targetAlbum = currentViewingAlbum;

  for (const photo of allPhotos) {
    if (selectedPhotoIdsForAlbum.has(photo.id)) {
      photo.album = targetAlbum;
      await savePhotoToDb(photo);
    } else if ((photo.album || '').toUpperCase() === targetAlbum) {
      photo.album = '';
      await savePhotoToDb(photo);
    }
  }

  closeSelectPhotosModal();
  openAlbum(targetAlbum);
  renderAlbums();
  renderGallery(filteredPhotos);
};

window.closeSelectPhotosModal = function() {
  document.getElementById('select-photos-modal').style.display = 'none';
};

// ============================================================
//  UPLOAD LOGIC
// ============================================================
window.triggerUpload = function() {
  uploadTargetAlbum = '';
  document.getElementById('file-input').click();
};

window.handleFileSelect = async function(event) {
  const files = Array.from(event.target.files);
  event.target.value = '';
  if (!files.length) return;

  const modal = document.getElementById('upload-modal');
  const listEl = document.getElementById('upload-list');
  const progressBar = document.getElementById('progress-bar');

  modal.style.display = 'flex';
  listEl.innerHTML = '';
  progressBar.style.width = '0%';
  document.getElementById('upload-status').textContent = '[ LOADING... ]';

  const assignedAlbum = uploadTargetAlbum || '';

  const items = files.map((f, i) => {
    const li = document.createElement('div');
    li.className = 'upload-item';
    li.innerHTML = `
      <span class="upload-item-icon">${f.type.startsWith('video') ? '🎬' : '🖼️'}</span>
      <span class="upload-item-name">${f.name}</span>
      <span class="upload-item-status pending" id="us-${i}">...</span>
    `;
    listEl.appendChild(li);
    return { file: f, index: i };
  });

  let done = 0;

  for (const { file, index } of items) {
    const statusEl = document.getElementById(`us-${index}`);
    statusEl.textContent = 'uploading...';

    try {
      const { blob, contentType, ext } = await prepareFile(file);
      const id   = 'photo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const path = `${id}.${ext}`;

      const { error: upErr } = await sb.storage.from(BUCKET).upload(path, blob, {
        contentType,
        cacheControl: '31536000'
      });
      if (upErr) throw upErr;

      const photo = {
        id,
        name: file.name,
        path,
        url: '',
        type: file.type.startsWith('video') ? 'video' : 'image',
        fav: false,
        album: assignedAlbum,
        createdAt: new Date()
      };

      try {
        await savePhotoToDb(photo);
      } catch (dbErr) {
        await sb.storage.from(BUCKET).remove([path]);
        throw dbErr;
      }

      const urlMap = await getSignedUrlMap([path]);
      photo.url = urlMap[path] || '';
      allPhotos.unshift(photo);

      statusEl.textContent = '✓ OK';
      statusEl.className = 'upload-item-status ok';
    } catch (e) {
      statusEl.textContent = '✗ GAGAL';
      statusEl.className = 'upload-item-status err';
      console.error(e);
    }

    done++;
    progressBar.style.width = `${Math.round((done / files.length) * 100)}%`;
    document.getElementById('upload-status').textContent = `[ UPLOADING... ] ${done} / ${files.length}`;
  }

  document.getElementById('upload-status').textContent = `[ SELESAI! ] ${done} foto berhasil diupload. 🐰`;

  filteredPhotos = [...allPhotos];
  renderGallery(filteredPhotos);
  renderMemories(allPhotos);
  renderFavorites();
  renderAlbums();
  updateCounts();

  if (currentViewingAlbum) {
    openAlbum(currentViewingAlbum);
  }
};

window.closeUploadModal = function() {
  document.getElementById('upload-modal').style.display = 'none';
};

// ============================================================
//  RENDER GALLERY
// ============================================================
function renderGallery(photos) {
  const grid  = document.getElementById('photo-grid');
  const empty = document.getElementById('empty-gallery');

  if (!photos.length) {
    empty.style.display = 'flex';
    grid.innerHTML = '';
    return;
  }

  empty.style.display = 'none';
  const sorted = sortPhotos(photos);
  grid.innerHTML = sorted.map((p, i) => photoCard(p, i, sorted)).join('');
}

function photoCard(photo, index, list) {
  const isVideo = photo.type === 'video';
  const isFav   = photo.fav;
  const albumBadge = photo.album
    ? `<span style="font-size:10px; color:#5de6e6; margin-left:4px;">[${escapeHtml(photo.album)}]</span>`
    : '';

  const media = isVideo
    ? `<video src="${photo.url}" preload="metadata" muted></video><div class="video-badge">▶ VIDEO</div>`
    : `<img src="${photo.url}" alt="${escapeHtml(photo.name)}" loading="lazy" />`;

  return `
    <div class="photo-item" onclick="openLightbox(${index}, event, '${photo.id}')" data-id="${photo.id}">
      ${media}
      <div class="photo-overlay">
        <div class="photo-overlay-content">
          <span class="photo-name">${escapeHtml(photo.name)} ${albumBadge}</span>
          <button class="fav-toggle ${isFav ? 'active' : ''}"
            onclick="quickToggleFav('${photo.id}', event)" title="Favorit">♥</button>
        </div>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m]);
}

function sortPhotos(photos) {
  return [...photos].sort((a, b) => {
    if (currentSort === 'date') {
      const da = a.createdAt instanceof Date ? a.createdAt : new Date(a.createdAt || 0);
      const db_ = b.createdAt instanceof Date ? b.createdAt : new Date(b.createdAt || 0);
      return db_ - da;
    }
    return String(a.name).localeCompare(String(b.name));
  });
}

window.setSort = function(sort, btn) {
  currentSort = sort;
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderGallery(filteredPhotos);
};

// ============================================================
//  SEARCH
// ============================================================
window.handleSearch = function() {
  const q = document.getElementById('search-input').value.toLowerCase();
  filteredPhotos = q
    ? allPhotos.filter(p => p.name.toLowerCase().includes(q) || (p.album && p.album.toLowerCase().includes(q)))
    : [...allPhotos];
  renderGallery(filteredPhotos);
  document.getElementById('photo-count').textContent = filteredPhotos.length;
};

// ============================================================
//  LIGHTBOX & ALBUM TAGGING
// ============================================================
let currentLightboxList = [];

window.openLightbox = function(index, event, photoId) {
  if (event?.target?.classList.contains('fav-toggle')) return;

  const currentList = currentViewingAlbum
    ? allPhotos.filter(p => (p.album || '').toUpperCase() === currentViewingAlbum)
    : (filteredPhotos.length ? filteredPhotos : allPhotos);

  currentLightboxList = sortPhotos(currentList);
  lightboxIndex = photoId
    ? currentLightboxList.findIndex(p => p.id === photoId)
    : index;

  if (lightboxIndex < 0) lightboxIndex = 0;

  updateLightbox();
  document.getElementById('lightbox').style.display = 'flex';
  document.addEventListener('keydown', lbKeyHandler);
};

function updateLightbox() {
  const photo = currentLightboxList[lightboxIndex];
  if (!photo) return;

  const img = document.getElementById('lb-img');
  const vid = document.getElementById('lb-vid');

  if (photo.type === 'video') {
    img.style.display = 'none';
    vid.style.display = 'block';
    vid.src = photo.url;
  } else {
    vid.style.display = 'none';
    vid.src = '';
    img.style.display = 'block';
    img.src = photo.url;
    img.alt = photo.name;
  }

  document.getElementById('lb-title').textContent = photo.name;
  const d = photo.createdAt instanceof Date ? photo.createdAt : new Date(photo.createdAt || 0);
  document.getElementById('lb-date').textContent = d.toLocaleDateString('id-ID', {
    day: 'numeric', month: 'long', year: 'numeric'
  });

  const favBtn = document.getElementById('lb-fav-btn');
  favBtn.textContent = photo.fav ? '★ HAPUS FAV' : '★ FAVORIT';
  favBtn.style.background = photo.fav ? '#8b6914' : '';

  populateLightboxAlbumSelect(photo.album || '');
}

function populateLightboxAlbumSelect(currentAlbum) {
  const select = document.getElementById('lb-album-select');
  if (!select) return;

  let optionsHtml = `<option value="">[ TANPA ALBUM ]</option>`;
  allAlbums.forEach(a => {
    const isSelected = (currentAlbum || '').toUpperCase() === a.name.toUpperCase();
    optionsHtml += `<option value="${escapeHtml(a.name)}" ${isSelected ? 'selected' : ''}>📦 ${escapeHtml(a.name)}</option>`;
  });

  select.innerHTML = optionsHtml;
}

window.handleLightboxAlbumChange = async function(newAlbum) {
  const photo = currentLightboxList[lightboxIndex];
  if (!photo) return;

  photo.album = newAlbum;
  await savePhotoToDb(photo);

  renderAlbums();
  renderGallery(filteredPhotos);

  if (currentViewingAlbum) {
    openAlbum(currentViewingAlbum);
  }
};

window.closeLightbox = function(event) {
  if (event && event.target !== document.getElementById('lightbox')) return;
  _closeLightbox();
};

function _closeLightbox() {
  document.getElementById('lightbox').style.display = 'none';
  try { document.getElementById('lb-vid').pause(); } catch(_) {}
  document.removeEventListener('keydown', lbKeyHandler);
}

window.lbNav = function(dir) {
  if (!currentLightboxList.length) return;
  lightboxIndex = (lightboxIndex + dir + currentLightboxList.length) % currentLightboxList.length;
  updateLightbox();
};

function lbKeyHandler(e) {
  if (e.key === 'ArrowRight') lbNav(1);
  if (e.key === 'ArrowLeft')  lbNav(-1);
  if (e.key === 'Escape')     _closeLightbox();
}

// ============================================================
//  FAVORITES
// ============================================================
window.toggleFav = async function() {
  const photo = currentLightboxList[lightboxIndex];
  if (!photo) return;
  await setFav(photo.id, !photo.fav);
  updateLightbox();
  renderFavorites();
};

window.quickToggleFav = async function(id, event) {
  event.stopPropagation();
  const photo = allPhotos.find(p => p.id === id);
  if (!photo) return;
  await setFav(id, !photo.fav);
  renderGallery(filteredPhotos);
  renderFavorites();
  if (currentViewingAlbum) openAlbum(currentViewingAlbum);
};

async function setFav(id, val) {
  const photo = allPhotos.find(p => p.id === id);
  if (!photo) return;
  photo.fav = val;
  await savePhotoToDb(photo);
}

function renderFavorites() {
  const favs  = allPhotos.filter(p => p.fav);
  const grid  = document.getElementById('fav-grid');
  const empty = document.getElementById('empty-fav');

  if (!favs.length) {
    empty.style.display = 'flex';
    grid.innerHTML = '';
  } else {
    empty.style.display = 'none';
    grid.innerHTML = favs.map((p, i) => photoCard(p, i, favs)).join('');
  }
}

// ============================================================
//  DELETE PHOTO
// ============================================================
window.deletePhoto = async function() {
  const photo = currentLightboxList[lightboxIndex];
  if (!photo) return;

  if (!confirm(`Hapus "${photo.name}"?`)) return;

  const { error: delErr } = await sb.from('photos').delete().eq('id', photo.id);
  if (delErr) {
    console.error(delErr);
    alert('Gagal menghapus foto. Coba lagi.');
    return;
  }
  await sb.storage.from(BUCKET).remove([photo.path]);

  allPhotos = allPhotos.filter(p => p.id !== photo.id);
  filteredPhotos = filteredPhotos.filter(p => p.id !== photo.id);

  _closeLightbox();
  renderGallery(filteredPhotos);
  renderFavorites();
  renderAlbums();
  renderMemories(allPhotos);
  updateCounts();

  if (currentViewingAlbum) openAlbum(currentViewingAlbum);
};

// ============================================================
//  DOWNLOAD PHOTO
// ============================================================
window.downloadPhoto = async function() {
  const photo = currentLightboxList[lightboxIndex];
  if (!photo) return;

  try {
    const res  = await fetch(photo.url);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = photo.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
  } catch (_) {
    window.open(photo.url, '_blank');
  }
};

// ============================================================
//  MEMORIES (Grouped by Month)
// ============================================================
function renderMemories(photos) {
  const container = document.getElementById('memories-container');
  if (!photos.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">🌙</div><p>BELUM ADA KENANGAN.</p></div>';
    return;
  }

  const groups = {};
  photos.forEach(p => {
    const d = p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt || 0);
    const key   = `${d.getFullYear()}-${String(d.getMonth()).padStart(2,'0')}`;
    const label = d.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' }).toUpperCase();
    if (!groups[key]) groups[key] = { label, photos: [] };
    groups[key].photos.push(p);
  });

  const sorted = Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]));

  container.innerHTML = sorted.map(([, g]) => `
    <div class="memory-group">
      <div class="memory-group-title">🌙 ${g.label}</div>
      <div class="memory-strip">
        ${g.photos.map(p => `
          <div class="photo-item" onclick="openLightboxById('${p.id}')">
            ${p.type === 'video'
              ? `<video src="${p.url}" preload="metadata" muted></video>`
              : `<img src="${p.url}" alt="${escapeHtml(p.name)}" loading="lazy" />`
            }
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

window.openLightboxById = function(id) {
  currentLightboxList = sortPhotos(allPhotos);
  const idx = currentLightboxList.findIndex(p => p.id === id);
  if (idx < 0) return;
  lightboxIndex = idx;
  updateLightbox();
  document.getElementById('lightbox').style.display = 'flex';
  document.addEventListener('keydown', lbKeyHandler);
};

// ============================================================
//  NAVIGATION & SIDEBAR
// ============================================================
window.switchView = function(view, btn) {
  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  document.getElementById(`view-${view}`).style.display = 'block';
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  if (view === 'favorites') renderFavorites();
  if (view === 'albums')    renderAlbums();
  if (view === 'memories')  renderMemories(allPhotos);
  if (view === 'gallery') {
    filteredPhotos = [...allPhotos];
    renderGallery(filteredPhotos);
  }

  if (window.innerWidth < 768) toggleSidebar(false);
};

window.toggleSidebar = function(force) {
  const sb = document.getElementById('sidebar');
  if (force === false) { sb.classList.remove('open'); return; }
  sb.classList.toggle('open');
};

// ESC key to close all modals
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.getElementById('lightbox').style.display            = 'none';
    document.getElementById('album-modal').style.display         = 'none';
    document.getElementById('create-album-modal').style.display  = 'none';
    document.getElementById('upload-modal').style.display        = 'none';
    document.getElementById('select-photos-modal').style.display = 'none';
  }
});
