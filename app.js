// mamine — app.js
// 100% Client-Side & Local Database (IndexedDB + localStorage)
// Tanpa konfigurasi eksternal — Langsung jalan out-of-the-box!

// ============================================================
//  INDEXEDDB SETUP (LOCAL DATABASE)
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

function idbPut(storeName, data) {
  return new Promise((resolve) => {
    if (!db) {
      const fallbackKey = storeName === 'albums' ? 'mamine_albums' : 'mamine_photos';
      const all = JSON.parse(localStorage.getItem(fallbackKey) || '[]');
      const idx = all.findIndex(p => p.id === data.id);
      if (idx >= 0) all[idx] = data; else all.push(data);
      try { localStorage.setItem(fallbackKey, JSON.stringify(all)); } catch (_) {}
      resolve(data);
      return;
    }
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(data);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  });
}

function idbDelete(storeName, id) {
  return new Promise((resolve) => {
    if (!db) {
      const fallbackKey = storeName === 'albums' ? 'mamine_albums' : 'mamine_photos';
      const all = JSON.parse(localStorage.getItem(fallbackKey) || '[]');
      const filtered = all.filter(p => p.id !== id);
      try { localStorage.setItem(fallbackKey, JSON.stringify(filtered)); } catch (_) {}
      resolve();
      return;
    }
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    } catch (_) {
      resolve();
    }
  });
}

// ============================================================
//  AUTH (LOCAL STORAGE + HASHED PASSWORD)
// ============================================================
async function hashPassword(password) {
  try {
    if (window.crypto && window.crypto.subtle) {
      const encoder = new TextEncoder();
      const data = encoder.encode(password + '_mamine_salt');
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (_) {}
  let hash = 5381;
  const str = password + '_mamine_salt';
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return 'mc_' + Math.abs(hash).toString(16);
}

function getLocalUsers() {
  return JSON.parse(localStorage.getItem('mamine_users') || '[]');
}

function saveLocalUsers(users) {
  localStorage.setItem('mamine_users', JSON.stringify(users));
}

function getCurrentUser() {
  const u = sessionStorage.getItem('mamine_current') || localStorage.getItem('mamine_current_saved');
  return u ? JSON.parse(u) : null;
}

function setCurrentUser(user) {
  if (user) {
    sessionStorage.setItem('mamine_current', JSON.stringify(user));
    localStorage.setItem('mamine_current_saved', JSON.stringify(user));
  } else {
    sessionStorage.removeItem('mamine_current');
    localStorage.removeItem('mamine_current_saved');
  }
}

// ============================================================
//  GLOBAL STATE
// ============================================================
let currentUser = null;
let allPhotos = [];
let allAlbums = [];
let filteredPhotos = [];
let currentSort = 'date';
let lightboxIndex = 0;
let guestModeActive = false;
let currentViewingAlbum = null;
let uploadTargetAlbum = '';
let selectedPhotoIdsForAlbum = new Set();

const DEMO_PHOTOS = [
  { id:'d1', name:'Bunga Sakura.jpg', url:'https://images.unsplash.com/photo-1522383225653-ed111181a951?w=600', type:'image', fav:false, createdAt: new Date('2026-10-01').getTime(), album:'MAMINE_CANTIK' },
  { id:'d2', name:'Pantai Sunset.jpg', url:'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=600', type:'image', fav:true,  createdAt: new Date('2026-09-15').getTime(), album:'LIBURAN' },
  { id:'d3', name:'Kopi Pagi.jpg',     url:'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=600', type:'image', fav:false, createdAt: new Date('2026-08-20').getTime(), album:'' },
  { id:'d4', name:'Hutan Hijau.jpg',   url:'https://images.unsplash.com/photo-1448375240586-882707db888b?w=600', type:'image', fav:false, createdAt: new Date('2026-07-10').getTime(), album:'ALAM' },
  { id:'d5', name:'Bunga Liar.jpg',    url:'https://images.unsplash.com/photo-1490750967868-88df5691cc34?w=600', type:'image', fav:true,  createdAt: new Date('2026-06-05').getTime(), album:'ALAM' },
  { id:'d6', name:'Jalan Kota.jpg',    url:'https://images.unsplash.com/photo-1480714378408-67cf0d13bc1b?w=600', type:'image', fav:false, createdAt: new Date('2026-05-22').getTime(), album:'' },
];

const DEMO_ALBUMS = [
  { id: 'alb_demo1', name: 'MAMINE_CANTIK', createdAt: new Date('2026-10-01').getTime() },
  { id: 'alb_demo2', name: 'LIBURAN', createdAt: new Date('2026-09-15').getTime() },
  { id: 'alb_demo3', name: 'ALAM', createdAt: new Date('2026-07-10').getTime() },
];

// ============================================================
//  BOOT
// ============================================================
async function boot() {
  await initIndexedDB();

  const saved = getCurrentUser();
  if (saved) {
    currentUser = saved;
    showApp();
    await loadData();
  } else {
    showAuth();
  }
}

boot();

// ============================================================
//  UI HELPERS & SCREENS
// ============================================================
function showAuth() {
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('app-screen').style.display = 'none';
}

function showApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'flex';

  const name = currentUser?.name || currentUser?.email?.split('@')[0] || 'Player';
  document.getElementById('side-name').textContent = name.toUpperCase();
  document.getElementById('side-avatar').textContent = name[0]?.toUpperCase() || '?';
}

function showErr(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = '> ERROR: ' + msg;
  el.style.display = 'block';
}

function hideErr(elId) {
  const el = document.getElementById(elId);
  if (el) el.style.display = 'none';
}

// ============================================================
//  LOGIN & REGISTER HANDLERS
// ============================================================
window.handleLogin = async function() {
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  const pass  = document.getElementById('login-pass').value;
  hideErr('login-error');

  if (!email || !pass) {
    showErr('login-error', 'Email & password harus diisi!');
    return;
  }

  const users = getLocalUsers();
  const hash  = await hashPassword(pass);
  const user  = users.find(u => u.email === email && u.hash === hash);

  if (!user) {
    showErr('login-error', 'Email atau password salah.');
    return;
  }

  currentUser = { uid: user.uid, name: user.name, email: user.email };
  setCurrentUser(currentUser);
  guestModeActive = false;
  showApp();
  await loadData();
};

window.handleLogout = function() {
  guestModeActive = false;
  currentUser = null;
  setCurrentUser(null);
  allPhotos = [];
  allAlbums = [];
  filteredPhotos = [];
  showAuth();
};

// ============================================================
//  LOAD DATA (PHOTOS & ALBUMS)
// ============================================================
async function loadData() {
  if (guestModeActive || !currentUser) return;

  try {
    const [photos, albums] = await Promise.all([
      idbGetAll('photos', 'uid', currentUser.uid),
      idbGetAll('albums', 'uid', currentUser.uid)
    ]);

    allPhotos = (photos || []).map(p => ({
      ...p,
      createdAt: new Date(p.createdAt || 0)
    })).sort((a, b) => b.createdAt - a.createdAt);

    allAlbums = (albums || []).map(a => ({
      ...a,
      createdAt: new Date(a.createdAt || 0)
    }));
  } catch (e) {
    console.error('Data load failed:', e);
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
        uid: currentUser?.uid || 'local',
        name: p.album.toUpperCase(),
        createdAt: new Date()
      };
      allAlbums.push(newAlb);
      existingNames.add(newAlb.name);
      saveAlbumToDb(newAlb);
    }
  });
}

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
    uid: currentUser?.uid || 'guest',
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

async function saveAlbumToDb(album) {
  if (guestModeActive) return;
  await idbPut('albums', {
    ...album,
    createdAt: album.createdAt instanceof Date ? album.createdAt.toISOString() : album.createdAt
  });
}

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

  if (!guestModeActive) {
    if (albumObj) await idbDelete('albums', albumObj.id);
    for (const p of affectedPhotos) {
      await savePhotoToDb(p);
    }
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
      const dataUrl = await fileToDataURL(file);

      const photo = {
        id: 'photo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        uid: currentUser.uid,
        name: file.name,
        url: dataUrl,
        type: file.type.startsWith('video') ? 'video' : 'image',
        fav: false,
        album: assignedAlbum,
        createdAt: new Date(),
        size: file.size
      };

      await savePhotoToDb(photo);
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

  document.getElementById('upload-status').textContent = `[ SELESAI! ] ${done} foto berhasil diupload. ⛏️`;

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

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = (e) => resolve(e.target.result);
    reader.onerror = (e) => reject(e);
    reader.readAsDataURL(file);
  });
}

async function savePhotoToDb(photo) {
  if (guestModeActive) return;
  await idbPut('photos', {
    ...photo,
    createdAt: photo.createdAt instanceof Date ? photo.createdAt.toISOString() : photo.createdAt
  });
}

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

  allPhotos = allPhotos.filter(p => p.id !== photo.id);
  filteredPhotos = filteredPhotos.filter(p => p.id !== photo.id);

  if (!guestModeActive) {
    await idbDelete('photos', photo.id);
  }

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
window.downloadPhoto = function() {
  const photo = currentLightboxList[lightboxIndex];
  if (!photo) return;

  const a = document.createElement('a');
  a.href     = photo.url;
  a.download = photo.name;
  a.target   = '_blank';
  a.click();
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
