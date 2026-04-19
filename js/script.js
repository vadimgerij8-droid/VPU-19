import { initializeApp } from "firebase/app";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut, GoogleAuthProvider, signInWithPopup
} from "firebase/auth";
import {
  getFirestore, collection, doc, setDoc, getDoc, getDocs, addDoc,
  updateDoc, deleteDoc, query, orderBy, where, Timestamp,
  increment, runTransaction, writeBatch
} from "firebase/firestore";

// ========== КОНФІГУРАЦІЯ ==========
const firebaseConfig = {
  apiKey: "AIzaSyAoYoOeKo3zbpQxrP-6DjP94uMfMRsXxGo",
  authDomain: "vpu-19.firebaseapp.com",
  projectId: "vpu-19",
  storageBucket: "vpu-19.firebasestorage.app",
  messagingSenderId: "1021666755140",
  appId: "1:1021666755140:web:a9ad8540f1de8ea0527211"
};

const CLOUDINARY_CLOUD_NAME = "dv6ehoqiq";
const CLOUDINARY_UPLOAD_PRESET = "VPU19VB";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

// ---- State ----
let currentUser = null;
let currentUserDoc = null;
let editingMasterId = null;
let pendingMasterPhotoFile = null;
let pendingProfilePhotoFile = null;
let pendingPostPhotoFile = null;
let reviewTargetPostId = null;
let reviewStarValue = 0;

// ---- Helpers ----
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function openModal(id) { document.getElementById(id).classList.add('open'); }
window.closeModal = id => document.getElementById(id).classList.remove('open');
document.querySelectorAll('.modal-overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); }));

let toastTimer;
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function starsHtml(avg, interactive = false, postId = '') {
  const full = Math.round(avg);
  if (interactive) {
    return [1,2,3,4,5].map(i =>
      `<span class="star-icon${i<=full?' filled':''}" data-val="${i}" data-post="${postId}"
        onmouseover="hoverStars(${i},'${postId}')" onmouseout="unhoverStars('${postId}')"
        onclick="submitRating('${postId}',${i})"><i class="fas fa-star"></i></span>`
    ).join('');
  }
  return [1,2,3,4,5].map(i => `<span class="star-icon${i<=full?' filled':''}"><i class="fas fa-star"></i></span>`).join('');
}

window.hoverStars = (val, postId) => {
  document.querySelectorAll(`.stars-interactive [data-post="${postId}"]`).forEach(s => {
    s.classList.toggle('hovered', parseInt(s.dataset.val) <= val);
  });
};
window.unhoverStars = postId => {
  document.querySelectorAll(`.stars-interactive [data-post="${postId}"]`).forEach(s => s.classList.remove('hovered'));
};

// ---- Cloudinary upload ----
async function uploadToCloudinary(file, folder = '') {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
  if (folder) formData.append('folder', folder);
  const response = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, { method: 'POST', body: formData });
  if (!response.ok) { const error = await response.json(); throw new Error(error.error?.message || 'Помилка завантаження на Cloudinary'); }
  const data = await response.json();
  return data.secure_url;
}

function getSessionId() {
  let sid = localStorage.getItem('ratingSession');
  if (!sid) { sid = 'anon_' + Math.random().toString(36).slice(2,11); localStorage.setItem('ratingSession', sid); }
  return sid;
}

// ---- Navigate ----
window.navigate = async (page, userId = null) => {
  document.querySelectorAll('.page').forEach(p => { p.classList.remove('active'); p.style.opacity = '0'; p.style.transform = 'translateY(20px)'; });
  const el = document.getElementById(`page-${page}`);
  el.classList.add('active');
  setTimeout(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; }, 10);
  if (page === 'home') renderHome();
  else if (page === 'masters') renderMasters();
  else if (page === 'profile') renderProfile(userId || currentUser?.uid);
  else if (page === 'admin') renderAdmin();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  window.closeMobileMenu();
};

// ---- RENDER HOME ----
async function renderHome() {
  const feedEl = document.getElementById('feedContainer');
  feedEl.innerHTML = '<div class="loading-wrap"><div class="spinner"></div><div>Завантаження...</div></div>';

  try {
    const mastersSnap = await getDocs(query(collection(db, 'users'), where('role', 'in', ['master','admin'])));
    const postsSnap = await getDocs(query(collection(db, 'posts'), orderBy('createdAt', 'desc')));

    document.getElementById('statMasters').textContent = mastersSnap.size;
    document.getElementById('statWorks').textContent = postsSnap.size;

    let totalRatingSum = 0, totalRatingCount = 0;
    postsSnap.forEach(d => { totalRatingSum += d.data().ratingSum || 0; totalRatingCount += d.data().ratingCount || 0; });
    const globalAvg = totalRatingCount > 0 ? (totalRatingSum / totalRatingCount).toFixed(1) : '—';
    document.getElementById('statRating').textContent = globalAvg;

    if (postsSnap.empty) {
      feedEl.innerHTML = '<div class="empty-state"><h3>Ще немає робіт</h3><p>Станьте майстром і додайте першу роботу!</p></div>';
      return;
    }

    const ratedPosts = new Set(JSON.parse(localStorage.getItem('ratedPosts') || '[]'));
    let html = '';
    const authorCache = {};

    const reviewsSnap = await getDocs(collection(db, 'reviews'));
    const reviewCountByPost = {};
    reviewsSnap.forEach(r => {
      const pid = r.data().postId;
      reviewCountByPost[pid] = (reviewCountByPost[pid] || 0) + 1;
    });

    for (const docSnap of postsSnap.docs) {
      const post = { id: docSnap.id, ...docSnap.data() };
      if (!authorCache[post.authorId]) {
        const aSnap = await getDoc(doc(db, 'users', post.authorId));
        authorCache[post.authorId] = aSnap.exists() ? aSnap.data() : { name: 'Невідомий', photoURL: null };
      }
      const author = authorCache[post.authorId];
      const avg = post.ratingCount > 0 ? (post.ratingSum / post.ratingCount).toFixed(1) : 0;
      const hasRated = ratedPosts.has(post.id);
      const isOwn = currentUser && currentUser.uid === post.authorId;
      const canDelete = isOwn || currentUserDoc?.role === 'admin';
      const reviewCount = reviewCountByPost[post.id] || 0;
      const isClient = currentUser && currentUserDoc?.role === 'user';
      const dateStr = post.createdAt ? new Date(post.createdAt.toDate()).toLocaleDateString('uk-UA', { day:'numeric', month:'long', year:'numeric' }) : 'Дата невідома';

      html += `
        <div class="post-card animate-on-scroll" id="post-${post.id}">
          <div class="post-header">
            <div class="post-avatar">${author.photoURL ? `<img src="${esc(author.photoURL)}" loading="lazy">` : '<i class="fas fa-user-circle" style="font-size:2rem;color:var(--gray-mid)"></i>'}</div>
            <div>
              <div class="post-author" onclick="navigate('profile','${post.authorId}')">${esc(author.name || author.email)}</div>
              <div class="post-date">${dateStr}</div>
            </div>
          </div>
          ${post.imageURL ? `<img class="post-image" src="${esc(post.imageURL)}" alt="Робота" loading="lazy">` : ''}
          ${post.caption ? `<div class="post-caption">${esc(post.caption)}</div>` : ''}
          <div class="post-rating-row" id="rating-row-${post.id}">
            <div class="stars-display">${starsHtml(avg)}</div>
            <span class="rating-avg">${avg > 0 ? avg : '—'}</span>
            <span class="rating-count">${post.ratingCount || 0} оцінок</span>
            ${hasRated
              ? `<span class="rated-badge" style="margin-left:auto">Ви оцінили</span>`
              : `<span class="rate-label">Оцінити:</span><div class="stars-interactive" id="rate-${post.id}">${starsHtml(0, true, post.id)}</div>`
            }
          </div>
          <div class="post-reviews-section">
            ${isClient ? `<button class="btn-write-review" onclick="openWriteReview('${post.id}')"><i class="far fa-comment-dots"></i> Написати відгук</button>` : ''}
            <button class="post-reviews-toggle" onclick="toggleReviews('${post.id}', this)">
              <i class="far fa-comments"></i> Відгуки <span class="reviews-count-badge" id="rev-count-${post.id}">${reviewCount}</span>
              <span style="margin-left:auto;font-size:.7rem;color:var(--gray-mid)" id="rev-arrow-${post.id}"><i class="fas fa-chevron-down"></i></span>
            </button>
            <div class="post-reviews-list" id="reviews-list-${post.id}"></div>
          </div>
          <div class="post-footer">
            ${canDelete ? `<button class="post-delete-btn" onclick="deletePost('${post.id}')"><i class="far fa-trash-alt"></i> Видалити</button>` : ''}
          </div>
        </div>`;
    }
    feedEl.innerHTML = html;
    initScrollAnimation();
  } catch(e) {
    feedEl.innerHTML = `<div class="empty-state"><h3>Помилка завантаження</h3><p>${esc(e.message)}</p></div>`;
  }
}

function initScrollAnimation() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
      }
    });
  }, { threshold: 0.1 });
  document.querySelectorAll('.animate-on-scroll').forEach(el => observer.observe(el));
}

window.toggleReviews = async (postId, btn) => {
  const listEl = document.getElementById(`reviews-list-${postId}`);
  const arrowEl = document.getElementById(`rev-arrow-${postId}`);
  if (listEl.classList.contains('open')) {
    listEl.classList.remove('open');
    arrowEl.innerHTML = '<i class="fas fa-chevron-down"></i>';
    return;
  }
  listEl.classList.add('open');
  arrowEl.innerHTML = '<i class="fas fa-chevron-up"></i>';
  listEl.innerHTML = '<div style="padding:16px;font-size:.75rem;color:var(--gray-mid)">Завантаження...</div>';
  try {
    const snap = await getDocs(query(collection(db, 'reviews'), where('postId', '==', postId), orderBy('createdAt', 'desc')));
    if (snap.empty) {
      listEl.innerHTML = '<div style="padding:16px;font-size:.78rem;color:var(--gray-mid)">Відгуків ще немає. Будьте першим!</div>';
      return;
    }
    const sessionId = getSessionId();
    const reviewIds = snap.docs.map(d => d.id);
    const likesSnap = await getDocs(query(collection(db, 'reviewLikes'), where('reviewId', 'in', reviewIds)));
    const likeMap = {};
    likesSnap.forEach(doc => {
      const l = doc.data();
      if (!likeMap[l.reviewId]) likeMap[l.reviewId] = { likes: 0, dislikes: 0, userVote: null };
      if (l.type === 'like') likeMap[l.reviewId].likes++;
      else likeMap[l.reviewId].dislikes++;
      if (l.userId === sessionId || l.userId === currentUser?.uid) likeMap[l.reviewId].userVote = l.type;
    });
    let html = '';
    for (const d of snap.docs) {
      const r = d.data();
      const dateStr = r.createdAt ? new Date(r.createdAt.toDate()).toLocaleDateString('uk-UA', { day:'numeric', month:'long', year:'numeric' }) : '';
      const stars = [1,2,3,4,5].map(i => `<span class="star-icon${i<=(r.rating||0)?' filled':''}"><i class="fas fa-star"></i></span>`).join('');
      const likeData = likeMap[d.id] || { likes:0, dislikes:0, userVote: null };
      html += `
        <div class="review-item" id="review-${d.id}">
          <div class="review-meta">
            <span class="review-author">${esc(r.authorName || 'Анонім')}</span>
            <div class="review-stars">${stars}</div>
            <span class="review-date">${dateStr}</span>
          </div>
          <div class="review-text">${esc(r.text)}</div>
          <div class="review-actions">
            <button class="like-btn ${likeData.userVote === 'like' ? 'active' : ''}" onclick="handleReviewLike('${d.id}', 'like')">
              <i class="far fa-thumbs-up"></i> <span class="like-count" id="like-count-${d.id}">${likeData.likes}</span>
            </button>
            <button class="dislike-btn ${likeData.userVote === 'dislike' ? 'active' : ''}" onclick="handleReviewLike('${d.id}', 'dislike')">
              <i class="far fa-thumbs-down"></i> <span class="dislike-count" id="dislike-count-${d.id}">${likeData.dislikes}</span>
            </button>
          </div>
        </div>`;
    }
    listEl.innerHTML = html;
  } catch(e) {
    listEl.innerHTML = `<div style="padding:16px;font-size:.75rem;color:#c0392b">${esc(e.message)}</div>`;
  }
};

window.handleReviewLike = async (reviewId, type) => {
  const sessionId = getSessionId();
  const userId = currentUser?.uid || sessionId;
  const likesRef = collection(db, 'reviewLikes');
  const q = query(likesRef, where('reviewId', '==', reviewId), where('userId', '==', userId));
  const snap = await getDocs(q);
  
  let batch = writeBatch(db);
  let likeDelta = 0, dislikeDelta = 0;
  
  if (!snap.empty) {
    const existing = snap.docs[0];
    const existingType = existing.data().type;
    if (existingType === type) {
      batch.delete(existing.ref);
      if (type === 'like') likeDelta = -1;
      else dislikeDelta = -1;
    } else {
      batch.update(existing.ref, { type });
      if (type === 'like') { likeDelta = 1; dislikeDelta = -1; }
      else { likeDelta = -1; dislikeDelta = 1; }
    }
  } else {
    batch.set(doc(likesRef), { reviewId, userId, type, createdAt: Timestamp.now() });
    if (type === 'like') likeDelta = 1;
    else dislikeDelta = 1;
  }
  
  await batch.commit();
  const likeSpan = document.getElementById(`like-count-${reviewId}`);
  const dislikeSpan = document.getElementById(`dislike-count-${reviewId}`);
  const likeBtn = document.querySelector(`.like-btn[onclick*="'${reviewId}'"]`);
  const dislikeBtn = document.querySelector(`.dislike-btn[onclick*="'${reviewId}'"]`);
  
  if (likeSpan && dislikeSpan) {
    likeSpan.textContent = Math.max(0, parseInt(likeSpan.textContent) + likeDelta);
    dislikeSpan.textContent = Math.max(0, parseInt(dislikeSpan.textContent) + dislikeDelta);
  }
  if (likeBtn && dislikeBtn) {
    const newVote = (!snap.empty && snap.docs[0].data().type === type) ? null : type;
    likeBtn.classList.toggle('active', newVote === 'like');
    dislikeBtn.classList.toggle('active', newVote === 'dislike');
  }
  showToast(type === 'like' ? '👍 Лайк!' : '👎 Дизлайк', 'success');
};

window.openWriteReview = postId => {
  if (!currentUser) { openAuthModal(); return; }
  if (currentUserDoc?.role !== 'user') { showToast('Тільки клієнти можуть залишати відгуки', 'error'); return; }
  reviewTargetPostId = postId;
  reviewStarValue = 0;
  document.getElementById('reviewText').value = '';
  document.querySelectorAll('#reviewStarPicker span').forEach(s => s.classList.remove('sel'));
  openModal('modalReview');
};

document.querySelectorAll('#reviewStarPicker span').forEach(sp => {
  sp.addEventListener('click', () => {
    reviewStarValue = parseInt(sp.dataset.v);
    document.querySelectorAll('#reviewStarPicker span').forEach(s => {
      s.classList.toggle('sel', parseInt(s.dataset.v) <= reviewStarValue);
    });
  });
  sp.addEventListener('mouseover', () => {
    const v = parseInt(sp.dataset.v);
    document.querySelectorAll('#reviewStarPicker span').forEach(s => {
      s.classList.toggle('sel', parseInt(s.dataset.v) <= v);
    });
  });
  sp.addEventListener('mouseout', () => {
    document.querySelectorAll('#reviewStarPicker span').forEach(s => {
      s.classList.toggle('sel', parseInt(s.dataset.v) <= reviewStarValue);
    });
  });
});

document.getElementById('submitReviewBtn').onclick = async () => {
  if (!currentUser) return;
  const text = document.getElementById('reviewText').value.trim();
  if (!text) { showToast('Напишіть текст відгуку', 'error'); return; }
  if (!reviewStarValue) { showToast('Оберіть оцінку (зірки)', 'error'); return; }
  try {
    const btn = document.getElementById('submitReviewBtn');
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Надсилання...';
    btn.disabled = true;
    await addDoc(collection(db, 'reviews'), {
      postId: reviewTargetPostId,
      authorId: currentUser.uid,
      authorName: currentUserDoc?.name || currentUser.displayName || 'Анонім',
      text,
      rating: reviewStarValue,
      createdAt: Timestamp.now()
    });
    closeModal('modalReview');
    showToast('Відгук надіслано!', 'success');
    const countEl = document.getElementById(`rev-count-${reviewTargetPostId}`);
    if (countEl) countEl.textContent = parseInt(countEl.textContent || 0) + 1;
    const listEl = document.getElementById(`reviews-list-${reviewTargetPostId}`);
    if (listEl?.classList.contains('open')) {
      toggleReviews(reviewTargetPostId, null);
      setTimeout(() => toggleReviews(reviewTargetPostId, null), 100);
    }
  } catch(e) {
    showToast('Помилка: ' + e.message, 'error');
  } finally {
    const btn = document.getElementById('submitReviewBtn');
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Надіслати відгук';
    btn.disabled = false;
  }
};

window.submitRating = async (postId, value) => {
  const ratedPosts = new Set(JSON.parse(localStorage.getItem('ratedPosts') || '[]'));
  if (ratedPosts.has(postId)) { showToast('Ви вже оцінили цю роботу', 'error'); return; }
  try {
    const sid = getSessionId();
    await runTransaction(db, async tx => {
      const ratingRef = doc(collection(db, 'ratings'));
      const postRef = doc(db, 'posts', postId);
      tx.set(ratingRef, { postId, value, sessionId: sid, createdAt: Timestamp.now() });
      tx.update(postRef, { ratingSum: increment(value), ratingCount: increment(1) });
    });
    ratedPosts.add(postId);
    localStorage.setItem('ratedPosts', JSON.stringify([...ratedPosts]));
    const rowEl = document.getElementById(`rating-row-${postId}`);
    if (rowEl) rowEl.innerHTML = await refreshRatingHtml(postId);
    showToast(`Оцінку ${value} ★ збережено!`, 'success');
  } catch(e) { showToast('Помилка: ' + e.message, 'error'); }
};

async function refreshRatingHtml(postId) {
  const snap = await getDoc(doc(db, 'posts', postId));
  const d = snap.data();
  const avg = d.ratingCount > 0 ? (d.ratingSum / d.ratingCount).toFixed(1) : 0;
  return `<div class="stars-display">${starsHtml(avg)}</div>
    <span class="rating-avg">${avg > 0 ? avg : '—'}</span>
    <span class="rating-count">${d.ratingCount || 0} оцінок</span>
    <span class="rated-badge" style="margin-left:auto">Ви оцінили</span>`;
}

window.deletePost = async postId => {
  if (!confirm('Видалити цю роботу?')) return;
  try {
    await deleteDoc(doc(db, 'posts', postId));
    document.getElementById(`post-${postId}`)?.remove();
    showToast('Роботу видалено', 'success');
    const worksSpan = document.getElementById('statWorks');
    if (worksSpan) worksSpan.textContent = parseInt(worksSpan.textContent || 0) - 1;
  } catch(e) { showToast(e.message, 'error'); }
};

async function renderMasters() {
  const container = document.getElementById('mastersList');
  container.innerHTML = '<div class="loading-wrap"><div class="spinner"></div><div>Завантаження...</div></div>';
  try {
    const q = query(collection(db, 'users'), where('role', 'in', ['master', 'admin']));
    const snap = await getDocs(q);
    if (snap.empty) { container.innerHTML = '<div class="empty-state"><h3>Майстрів поки немає</h3><p>Зареєструйтесь як майстер або додайте через адмін-панель</p></div>'; return; }
    let html = '';
    for (const docSnap of snap.docs) {
      const u = docSnap.data();
      const postsSnap = await getDocs(query(collection(db, 'posts'), where('authorId', '==', docSnap.id)));
      let rSum = 0, rCount = 0;
      postsSnap.forEach(p => { rSum += p.data().ratingSum || 0; rCount += p.data().ratingCount || 0; });
      const avg = rCount > 0 ? (rSum / rCount).toFixed(1) : 0;
      html += `
        <div class="master-card animate-on-scroll" onclick="navigate('profile','${docSnap.id}')">
          <div class="master-card-photo">${u.photoURL ? `<img src="${esc(u.photoURL)}" loading="lazy">` : '<i class="fas fa-user-tie" style="font-size:3rem;color:var(--gray-mid)"></i>'}</div>
          <div class="master-card-info">
            <div class="master-card-name">${esc(u.name || u.email)}</div>
            <div class="master-card-role"><i class="fas fa-${u.role === 'admin' ? 'crown' : 'cut'}"></i> ${u.role === 'admin' ? 'Адміністратор' : 'Майстер'}</div>
            <div class="master-card-stats"><span><i class="far fa-image"></i> ${postsSnap.size} робіт</span>${u.phone ? `<span><i class="fas fa-phone-alt"></i> ${esc(u.phone)}</span>` : ''}</div>
            <div class="master-card-rating-row">
              <div class="stars-display">${starsHtml(avg)}</div>
              <span class="rating-avg">${avg > 0 ? avg : '—'}</span>
              <span class="rating-count">${rCount} оцінок</span>
            </div>
          </div>
        </div>`;
    }
    container.innerHTML = html;
    initScrollAnimation();
  } catch(e) {
    container.innerHTML = `<div class="empty-state"><h3>Помилка</h3><p>${esc(e.message)}</p></div>`;
  }
}

async function renderProfile(userId) {
  const container = document.getElementById('profileContainer');
  if (!userId) {
    container.innerHTML = '<div style="padding:160px 48px;text-align:center"><p style="font-size:.9rem;color:var(--gray-mid)">Увійдіть, щоб переглянути профіль</p><button class="btn-primary" style="margin-top:24px" onclick="openAuthModal()"><i class="fas fa-sign-in-alt"></i> Увійти</button></div>';
    return;
  }
  container.innerHTML = '<div class="loading-wrap" style="padding:160px"><div class="spinner"></div></div>';
  try {
    const userSnap = await getDoc(doc(db, 'users', userId));
    if (!userSnap.exists()) { container.innerHTML = '<div style="padding:120px;text-align:center">Користувача не знайдено</div>'; return; }
    const user = userSnap.data();
    const postsQuery = query(collection(db, 'posts'), where('authorId', '==', userId));
    const postsSnap = await getDocs(postsQuery);
    let posts = postsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    posts.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
    let rSum = 0, rCount = 0;
    posts.forEach(p => { rSum += p.ratingSum || 0; rCount += p.ratingCount || 0; });
    const avg = rCount > 0 ? (rSum / rCount).toFixed(1) : 0;
    const isOwn = currentUser && currentUser.uid === userId;
    const isMaster = user.role === 'master' || user.role === 'admin';
    const postIds = posts.map(p => p.id);
    let allReviews = [];
    if (postIds.length > 0) {
      const reviewsSnap = await getDocs(query(collection(db, 'reviews'), orderBy('createdAt', 'desc')));
      reviewsSnap.forEach(d => {
        const r = { id: d.id, ...d.data() };
        if (postIds.includes(r.postId)) allReviews.push(r);
      });
    }
    let reviewsTabHtml = '';
    if (allReviews.length === 0) reviewsTabHtml = '<p style="color:var(--gray-mid);font-size:.82rem">Відгуків ще немає</p>';
    else {
      const postMap = {};
      posts.forEach(p => postMap[p.id] = p);
      reviewsTabHtml = '<div class="profile-reviews-list">' + allReviews.map(r => {
        const dateStr = r.createdAt ? new Date(r.createdAt.toDate()).toLocaleDateString('uk-UA', { day:'numeric', month:'long', year:'numeric' }) : '';
        const stars = [1,2,3,4,5].map(i => `<span class="star-icon${i<=(r.rating||0)?' filled':''}"><i class="fas fa-star"></i></span>`).join('');
        const postCaption = postMap[r.postId]?.caption || 'Публікація';
        return `<div class="profile-review-card">
          <div class="profile-review-card-meta">
            <div class="profile-review-card-info">
              <div class="profile-review-card-author">${esc(r.authorName || 'Анонім')}</div>
              <div class="profile-review-card-post">До: ${esc(postCaption.length > 40 ? postCaption.slice(0,40)+'…' : postCaption)}</div>
            </div>
            <div class="profile-review-card-date">${dateStr}</div>
          </div>
          <div style="display:flex;gap:3px;margin-bottom:8px">${stars}</div>
          <div class="profile-review-card-text">${esc(r.text)}</div>
        </div>`;
      }).join('') + '</div>';
    }
    let haircutRatingsHtml = '';
    if (posts.length === 0) haircutRatingsHtml = '<p style="color:var(--gray-mid);font-size:.82rem">Ще немає публікацій з оцінками</p>';
    else {
      const ratedPosts = posts.filter(p => p.ratingCount > 0).sort((a,b) => {
        const avgA = a.ratingSum / a.ratingCount;
        const avgB = b.ratingSum / b.ratingCount;
        return avgB - avgA;
      });
      const unratedPosts = posts.filter(p => !p.ratingCount);
      const allSorted = [...ratedPosts, ...unratedPosts];
      haircutRatingsHtml = '<div class="haircut-ratings-list">' + allSorted.map(p => {
        const pAvg = p.ratingCount > 0 ? (p.ratingSum / p.ratingCount).toFixed(1) : null;
        const stars = [1,2,3,4,5].map(i => `<span class="star-icon${pAvg && i<=Math.round(pAvg)?' filled':''}"><i class="fas fa-star"></i></span>`).join('');
        return `<div class="haircut-rating-item">
          ${p.imageURL ? `<img class="haircut-rating-thumb" src="${esc(p.imageURL)}" loading="lazy" onerror="this.style.display='none'">` : '<div class="haircut-rating-thumb"><i class="fas fa-image" style="font-size:2rem;color:var(--gray-mid)"></i></div>'}
          <div class="haircut-rating-info">
            <div class="haircut-rating-caption">${esc(p.caption || 'Без опису')}</div>
            <div class="haircut-rating-stats">
              <div style="display:flex;gap:3px">${stars}</div>
              <span class="haircut-rating-avg">${pAvg || '—'}</span>
              <span class="haircut-rating-count">${p.ratingCount || 0} оцінок</span>
            </div>
          </div>
        </div>`;
      }).join('') + '</div>';
    }
    const isClientProfile = !isMaster;
    container.innerHTML = `
      <div class="profile-layout">
        <div class="profile-sidebar">
          <div class="profile-avatar">${user.photoURL ? `<img src="${esc(user.photoURL)}">` : `<div class="profile-avatar-placeholder"><i class="fas fa-user-circle"></i></div>`}</div>
          <div class="profile-name">${esc(user.name || user.email?.split('@')[0] || 'Користувач')}</div>
          <div class="profile-role-badge"><i class="fas fa-${user.role === 'admin' ? 'crown' : (user.role==='master'?'cut':'user')}"></i> ${user.role === 'admin' ? 'Адміністратор' : user.role === 'master' ? 'Майстер' : 'Клієнт'}</div>
          ${user.bio ? `<p class="profile-bio">${esc(user.bio)}</p>` : ''}
          ${isMaster && user.phone ? `<div class="profile-phone-display"><i class="fas fa-phone-alt"></i> ${esc(user.phone)}</div>` : ''}
          <div class="profile-stats">
            <div class="profile-stat"><span class="profile-stat-value">${posts.length}</span><span class="profile-stat-label">Робіт</span></div>
            <div class="profile-stat"><span class="profile-stat-value">${rCount}</span><span class="profile-stat-label">Оцінок</span></div>
            <div class="profile-stat"><span class="profile-stat-value">${allReviews.length}</span><span class="profile-stat-label">Відгуків</span></div>
          </div>
          ${avg > 0 ? `<div class="profile-sidebar-stars">${starsHtml(avg)}</div><div class="profile-avg-label">Середній рейтинг: ${avg}</div>` : '<div class="profile-avg-label">Ще немає оцінок</div>'}
          ${isOwn ? `
            <button class="btn-edit-profile" onclick="openEditProfileModal()"><i class="fas fa-pen"></i> Редагувати профіль</button>
            ${isMaster ? `<button class="btn-primary" style="margin-top:12px;width:100%" onclick="openCreatePost()"><i class="fas fa-plus-circle"></i> Нова робота</button>` : ''}
            <button class="btn-secondary" style="margin-top:12px;width:100%;background:transparent;color:rgba(255,255,255,.5);border-color:rgba(255,255,255,.2)" onclick="doLogout()"><i class="fas fa-sign-out-alt"></i> Вийти</button>
          ` : ''}
        </div>
        <div class="profile-main">
          ${isClientProfile ? `
            <h3 class="profile-section-title"><i class="fas fa-user"></i> Профіль клієнта</h3>
            <p style="color:var(--gray-mid);font-size:.82rem">Клієнт може залишати відгуки до робіт майстрів у стрічці.</p>
          ` : `
            <div class="profile-tabs">
              <button class="profile-tab active" onclick="switchProfileTab('works', this)"><i class="far fa-images"></i> Роботи (${posts.length})</button>
              <button class="profile-tab" onclick="switchProfileTab('reviews', this)"><i class="far fa-comments"></i> Відгуки (${allReviews.length})</button>
              <button class="profile-tab" onclick="switchProfileTab('ratings', this)"><i class="fas fa-star"></i> Оцінки стрижок</button>
            </div>
            <div class="profile-tab-pane active" id="ptab-works">
              ${posts.length ? `
                <div class="profile-posts-grid">
                  ${posts.map(p => `
                    <div class="profile-post-item">
                      <img src="${esc(p.imageURL)}" loading="lazy" onerror="this.src='https://placehold.co/400?text=No+Image'">
                      <div class="profile-post-overlay"><i class="fas fa-star"></i> ${p.ratingCount > 0 ? (p.ratingSum/p.ratingCount).toFixed(1) : '—'}</div>
                    </div>`).join('')}
                </div>` : '<p style="color:var(--gray-mid);font-size:.82rem">Ще немає опублікованих робіт</p>'}
            </div>
            <div class="profile-tab-pane" id="ptab-reviews">
              ${reviewsTabHtml}
            </div>
            <div class="profile-tab-pane" id="ptab-ratings">
              ${haircutRatingsHtml}
            </div>
          `}
        </div>
      </div>
    `;
  } catch(e) {
    container.innerHTML = `<div style="padding:120px;text-align:center;color:var(--gray-mid)">${esc(e.message)}</div>`;
  }
}

window.switchProfileTab = (tab, el) => {
  document.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.profile-tab-pane').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById(`ptab-${tab}`)?.classList.add('active');
};

window.openEditProfileModal = () => {
  pendingProfilePhotoFile = null;
  document.getElementById('editProfileName').value = currentUserDoc?.name || '';
  document.getElementById('editProfileBio').value = currentUserDoc?.bio || '';
  const isMaster = ['master','admin'].includes(currentUserDoc?.role);
  const phoneGroup = document.getElementById('editPhoneGroup');
  phoneGroup.style.display = isMaster ? 'block' : 'none';
  document.getElementById('editProfilePhone').value = currentUserDoc?.phone || '';
  const area = document.getElementById('editProfilePhotoArea');
  if (currentUserDoc?.photoURL) {
    area.style.backgroundImage = `url(${currentUserDoc.photoURL})`;
    area.style.backgroundSize = 'cover';
    area.style.backgroundPosition = 'center';
  } else {
    area.style.backgroundImage = '';
  }
  openModal('modalEditProfile');
};

document.getElementById('editProfilePhotoInput').onchange = e => {
  pendingProfilePhotoFile = e.target.files[0];
  if (pendingProfilePhotoFile) {
    const url = URL.createObjectURL(pendingProfilePhotoFile);
    const area = document.getElementById('editProfilePhotoArea');
    area.style.backgroundImage = `url(${url})`;
    area.style.backgroundSize = 'cover';
    area.style.backgroundPosition = 'center';
  }
};

document.getElementById('saveProfileBtn').onclick = async () => {
  if (!currentUser) return;
  const name = document.getElementById('editProfileName').value.trim();
  const bio = document.getElementById('editProfileBio').value.trim();
  const isMaster = ['master','admin'].includes(currentUserDoc?.role);
  const phone = isMaster ? document.getElementById('editProfilePhone').value.trim() : undefined;
  try {
    const updates = { name, bio };
    if (isMaster && phone !== undefined) updates.phone = phone;
    if (pendingProfilePhotoFile) {
      const photoURL = await uploadToCloudinary(pendingProfilePhotoFile, `avatars/${currentUser.uid}`);
      updates.photoURL = photoURL;
    }
    await updateDoc(doc(db, 'users', currentUser.uid), updates);
    currentUserDoc = { ...currentUserDoc, ...updates };
    closeModal('modalEditProfile');
    showToast('Профіль оновлено', 'success');
    renderProfile(currentUser.uid);
  } catch(e) { showToast(e.message, 'error'); }
};

async function renderAdmin() {
  try {
    const [mastersSnap, postsSnap, ratingsSnap] = await Promise.all([
      getDocs(query(collection(db, 'users'), where('role', 'in', ['master','admin']))),
      getDocs(collection(db, 'posts')),
      getDocs(collection(db, 'ratings'))
    ]);
    document.getElementById('dashMasters').textContent = mastersSnap.size;
    document.getElementById('dashPosts').textContent = postsSnap.size;
    document.getElementById('dashRatings').textContent = ratingsSnap.size;

    const allUsersSnap = await getDocs(collection(db, 'users'));
    document.getElementById('adminMastersTbody').innerHTML = allUsersSnap.docs.map(docSnap => {
      const u = docSnap.data();
      return `<tr>
        <td><div class="table-avatar">${u.photoURL ? `<img src="${esc(u.photoURL)}">` : '<i class="fas fa-user-circle" style="font-size:1.8rem;color:var(--gray-mid)"></i>'}</div></td>
        <td>${esc(u.name || '—')}</td>
        <td>${esc(u.email)}</td>
        <td><select onchange="changeRole('${docSnap.id}',this.value)" style="border:1px solid var(--gray-light);padding:4px 8px;font-size:.72rem;background:white;cursor:pointer">
          <option${u.role==='master'?' selected':''}>master</option>
          <option${u.role==='admin'?' selected':''}>admin</option>
          <option${u.role==='user'?' selected':''}>user</option>
        </select></td>
        <td class="table-actions">
          <button class="btn-secondary btn-sm" onclick="editMaster('${docSnap.id}')"><i class="fas fa-pen"></i> Редагувати</button>
          <button class="btn-danger" onclick="deleteMaster('${docSnap.id}')"><i class="fas fa-trash"></i> Видалити</button>
        </td>
      </tr>`;
    }).join('');

    const settings = JSON.parse(localStorage.getItem('siteSettings') || '{}');
    document.getElementById('settingsName').value = settings.salonName || 'Перукарня ВПУ-19';
    document.getElementById('settingsDesc').value = settings.heroDesc || '';
    document.getElementById('settingsAddress').value = settings.address || '📍 Львівська область, м. Дрогобич, вул. Михайла Грушевського, 59';
    document.getElementById('settingsPhone').value = settings.phone || '📞 +38 (0362) 63-19-19';
    document.getElementById('settingsEmail').value = settings.email || '✉️ vpu19@education.ua';
  } catch(e) { showToast(e.message, 'error'); }
}

window.changeRole = async (userId, role) => {
  try { await updateDoc(doc(db, 'users', userId), { role }); showToast('Роль змінено', 'success'); } catch(e) { showToast(e.message, 'error'); }
};

window.editMaster = async userId => {
  const snap = await getDoc(doc(db, 'users', userId));
  if (!snap.exists()) return;
  const u = snap.data();
  editingMasterId = userId;
  pendingMasterPhotoFile = null;
  document.getElementById('masterModalTitle').innerHTML = '<i class="fas fa-user-tie"></i> Редагувати майстра';
  document.getElementById('masterName').value = u.name || '';
  document.getElementById('masterEmail').value = u.email;
  document.getElementById('masterEmail').disabled = true;
  document.getElementById('masterPassword').value = '';
  document.getElementById('masterPasswordGroup').style.display = 'none';
  document.getElementById('masterRole').value = u.role || 'master';
  document.getElementById('masterBio').value = u.bio || '';
  const area = document.getElementById('masterPhotoArea');
  if (u.photoURL) { area.style.backgroundImage = `url(${u.photoURL})`; area.style.backgroundSize = 'cover'; area.style.backgroundPosition = 'center'; } else { area.style.backgroundImage = ''; }
  openModal('modalMaster');
};

window.deleteMaster = async userId => {
  if (!confirm('Видалити користувача та всі його роботи?')) return;
  try {
    const postsSnap = await getDocs(query(collection(db, 'posts'), where('authorId', '==', userId)));
    for (const p of postsSnap.docs) await deleteDoc(doc(db, 'posts', p.id));
    await deleteDoc(doc(db, 'users', userId));
    showToast('Видалено', 'success');
    renderAdmin();
  } catch(e) { showToast(e.message, 'error'); }
};

window.openAddMasterModal = () => {
  editingMasterId = null;
  pendingMasterPhotoFile = null;
  document.getElementById('masterModalTitle').innerHTML = '<i class="fas fa-user-plus"></i> Додати майстра';
  document.getElementById('masterName').value = '';
  document.getElementById('masterEmail').value = '';
  document.getElementById('masterEmail').disabled = false;
  document.getElementById('masterPassword').value = '';
  document.getElementById('masterPasswordGroup').style.display = 'block';
  document.getElementById('masterRole').value = 'master';
  document.getElementById('masterBio').value = '';
  document.getElementById('masterPhotoArea').style.backgroundImage = '';
  openModal('modalMaster');
};

document.getElementById('saveMasterBtn').onclick = async () => {
  const name = document.getElementById('masterName').value.trim();
  const email = document.getElementById('masterEmail').value.trim();
  const password = document.getElementById('masterPassword').value;
  const role = document.getElementById('masterRole').value;
  const bio = document.getElementById('masterBio').value.trim();
  if (!name || !email) { showToast('Заповніть ім\'я та email', 'error'); return; }
  try {
    if (editingMasterId) {
      const updates = { name, role, bio };
      if (pendingMasterPhotoFile) {
        const photoURL = await uploadToCloudinary(pendingMasterPhotoFile, `avatars/${editingMasterId}`);
        updates.photoURL = photoURL;
      }
      await updateDoc(doc(db, 'users', editingMasterId), updates);
      showToast('Майстра оновлено', 'success');
    } else {
      if (!password) { showToast('Введіть пароль', 'error'); return; }
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      let photoURL = null;
      if (pendingMasterPhotoFile) { photoURL = await uploadToCloudinary(pendingMasterPhotoFile, `avatars/${cred.user.uid}`); }
      await setDoc(doc(db, 'users', cred.user.uid), { email, name, role, bio, photoURL, createdAt: Timestamp.now() });
      showToast('Майстра додано', 'success');
    }
    closeModal('modalMaster');
    renderAdmin();
  } catch(e) { showToast('Помилка: ' + e.message, 'error'); }
};

document.getElementById('masterPhotoInput').onchange = e => {
  pendingMasterPhotoFile = e.target.files[0];
  if (pendingMasterPhotoFile) {
    const url = URL.createObjectURL(pendingMasterPhotoFile);
    const area = document.getElementById('masterPhotoArea');
    area.style.backgroundImage = `url(${url})`; area.style.backgroundSize = 'cover'; area.style.backgroundPosition = 'center';
  }
};

window.switchAdminTab = (tabId, el) => {
  document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.admin-nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`admin-${tabId}`).classList.add('active');
  el.classList.add('active');
};

window.saveSettings = () => {
  const settings = {
    salonName: document.getElementById('settingsName').value,
    heroDesc: document.getElementById('settingsDesc').value,
    address: document.getElementById('settingsAddress').value,
    phone: document.getElementById('settingsPhone').value,
    email: document.getElementById('settingsEmail').value
  };
  localStorage.setItem('siteSettings', JSON.stringify(settings));
  applySettings(settings);
  showToast('Налаштування збережено', 'success');
};

function applySettings(s) {
  if (s.heroDesc) document.getElementById('heroDescription').textContent = s.heroDesc;
  if (s.address) document.getElementById('footerAddress').innerHTML = `<i class="fas fa-map-marker-alt"></i> ${s.address}`;
  if (s.phone) document.getElementById('footerPhone').innerHTML = `<i class="fas fa-phone-alt"></i> ${s.phone}`;
  if (s.email) document.getElementById('footerEmail').innerHTML = `<i class="fas fa-envelope"></i> ${s.email}`;
}

window.openCreatePost = () => {
  if (!currentUser) { openAuthModal(); return; }
  if (!['master','admin'].includes(currentUserDoc?.role)) { showToast('Тільки майстри можуть публікувати роботи', 'error'); return; }
  pendingPostPhotoFile = null;
  document.getElementById('postPhotoInput').value = '';
  document.getElementById('postCaption').value = '';
  document.getElementById('postPhotoArea').style.backgroundImage = '';
  openModal('modalPost');
};

document.getElementById('postPhotoInput').onchange = e => {
  pendingPostPhotoFile = e.target.files[0];
  if (pendingPostPhotoFile) {
    const url = URL.createObjectURL(pendingPostPhotoFile);
    const area = document.getElementById('postPhotoArea');
    area.style.backgroundImage = `url(${url})`; area.style.backgroundSize = 'cover'; area.style.backgroundPosition = 'center'; area.style.minHeight = '200px';
  }
};

document.getElementById('submitPostBtn').onclick = async () => {
  if (!pendingPostPhotoFile) { showToast('Оберіть фото', 'error'); return; }
  const btn = document.getElementById('submitPostBtn');
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Завантаження...';
  btn.disabled = true;
  try {
    const caption = document.getElementById('postCaption').value.trim();
    const imageURL = await uploadToCloudinary(pendingPostPhotoFile, `posts/${currentUser.uid}`);
    await addDoc(collection(db, 'posts'), {
      authorId: currentUser.uid,
      imageURL, caption,
      ratingSum: 0, ratingCount: 0,
      createdAt: Timestamp.now()
    });
    closeModal('modalPost');
    showToast('Роботу опубліковано!', 'success');
    navigate('home');
  } catch(e) {
    showToast('Помилка: ' + e.message, 'error');
  } finally {
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Опублікувати';
    btn.disabled = false;
    pendingPostPhotoFile = null;
  }
};

async function handleGoogleSignIn() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const user = result.user;
    const userDoc = await getDoc(doc(db, 'users', user.uid));
    if (!userDoc.exists()) {
      await setDoc(doc(db, 'users', user.uid), {
        email: user.email,
        name: user.displayName || user.email.split('@')[0],
        photoURL: user.photoURL,
        role: 'user',
        createdAt: Timestamp.now()
      });
    } else {
      if (!userDoc.data().role) await updateDoc(doc(db, 'users', user.uid), { role: 'user' });
    }
    closeModal('modalAuth');
    showToast('Ласкаво просимо!', 'success');
  } catch(e) {
    let msg = e.message;
    if (msg.includes('auth/unauthorized-domain')) msg = 'Помилка: домен не додано в Firebase Console.';
    showToast('Помилка входу через Google: ' + msg, 'error');
  }
}

async function handleMasterRegister() {
  const name = document.getElementById('masterRegName').value.trim();
  const email = document.getElementById('masterRegEmail').value.trim();
  const password = document.getElementById('masterRegPassword').value;
  const confirm = document.getElementById('masterRegPasswordConfirm').value;
  const errDiv = document.getElementById('masterRegError');
  errDiv.style.display = 'none';
  if (!name || !email || !password) { errDiv.textContent = 'Заповніть усі поля'; errDiv.style.display = 'block'; return; }
  if (password !== confirm) { errDiv.textContent = 'Паролі не співпадають'; errDiv.style.display = 'block'; return; }
  if (password.length < 6) { errDiv.textContent = 'Пароль має бути не менше 6 символів'; errDiv.style.display = 'block'; return; }
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, 'users', cred.user.uid), { email, name, role: 'master', createdAt: Timestamp.now() });
    closeModal('modalAuth');
    showToast('Реєстрація пройшла успішно! Ви увійшли як майстер.', 'success');
  } catch(e) { errDiv.textContent = e.message; errDiv.style.display = 'block'; }
}

async function handleMasterSignIn() {
  const email = document.getElementById('masterAuthEmail').value.trim();
  const password = document.getElementById('masterAuthPassword').value;
  const errEl = document.getElementById('masterAuthError');
  errEl.style.display = 'none';
  if (!email || !password) { errEl.textContent = 'Заповніть усі поля'; errEl.style.display = 'block'; return; }
  try {
    await signInWithEmailAndPassword(auth, email, password);
    closeModal('modalAuth');
    showToast('Вітаємо, майстре!', 'success');
  } catch(e) { errEl.textContent = 'Невірний email або пароль'; errEl.style.display = 'block'; }
}

function initAuthTabs() {
  const tabs = document.querySelectorAll('.auth-tab');
  const googlePanel = document.getElementById('authGooglePanel');
  const masterPanel = document.getElementById('authMasterPanel');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      if (tab.dataset.tab === 'google') { googlePanel.style.display = 'block'; masterPanel.style.display = 'none'; }
      else { googlePanel.style.display = 'none'; masterPanel.style.display = 'block'; }
    });
  });
  document.getElementById('showMasterRegisterBtn').onclick = (e) => { e.preventDefault(); document.getElementById('masterLoginForm').style.display = 'none'; document.getElementById('masterRegisterForm').style.display = 'block'; };
  document.getElementById('showMasterLoginBtn').onclick = (e) => { e.preventDefault(); document.getElementById('masterRegisterForm').style.display = 'none'; document.getElementById('masterLoginForm').style.display = 'block'; };
}

window.openAuthModal = () => {
  document.querySelector('.auth-tab[data-tab="google"]').click();
  document.getElementById('masterAuthEmail').value = '';
  document.getElementById('masterAuthPassword').value = '';
  document.getElementById('masterAuthError').style.display = 'none';
  document.getElementById('masterRegName').value = '';
  document.getElementById('masterRegEmail').value = '';
  document.getElementById('masterRegPassword').value = '';
  document.getElementById('masterRegPasswordConfirm').value = '';
  document.getElementById('masterRegError').style.display = 'none';
  document.getElementById('masterLoginForm').style.display = 'block';
  document.getElementById('masterRegisterForm').style.display = 'none';
  openModal('modalAuth');
};

document.getElementById('googleSignInBtn').onclick = handleGoogleSignIn;
document.getElementById('masterSignInBtn').onclick = handleMasterSignIn;
document.getElementById('masterRegisterBtn').onclick = handleMasterRegister;

window.doLogout = () => { signOut(auth); showToast('Ви вийшли'); navigate('home'); };

onAuthStateChanged(auth, async user => {
  currentUser = user;
  if (user) {
    const snap = await getDoc(doc(db, 'users', user.uid));
    currentUserDoc = snap.exists() ? snap.data() : null;
    const isAdmin = currentUserDoc?.role === 'admin';
    const isMaster = ['master','admin'].includes(currentUserDoc?.role);
    document.getElementById('authBtn').innerHTML = `<i class="fas fa-user-circle"></i> ${currentUserDoc?.name || 'Профіль'}`;
    document.getElementById('authBtn').onclick = () => navigate('profile');
    document.getElementById('mobileAuthBtn').innerHTML = '<i class="fas fa-user-circle"></i> Профіль';
    document.getElementById('mobileAuthBtn').onclick = () => navigate('profile');
    document.getElementById('adminNavLink').style.display = isAdmin ? 'flex' : 'none';
    document.getElementById('mobileAdminLink').style.display = isAdmin ? 'flex' : 'none';
    if (isMaster) document.getElementById('createPostFab').classList.add('visible');
    else document.getElementById('createPostFab').classList.remove('visible');
  } else {
    currentUserDoc = null;
    document.getElementById('authBtn').innerHTML = '<i class="fas fa-sign-in-alt"></i> Увійти';
    document.getElementById('authBtn').onclick = () => openAuthModal();
    document.getElementById('mobileAuthBtn').innerHTML = '<i class="fas fa-sign-in-alt"></i> Увійти';
    document.getElementById('mobileAuthBtn').onclick = () => openAuthModal();
    document.getElementById('adminNavLink').style.display = 'none';
    document.getElementById('mobileAdminLink').style.display = 'none';
    document.getElementById('createPostFab').classList.remove('visible');
  }
  const activePage = document.querySelector('.page.active');
  if (activePage?.id === 'page-home') renderHome();
  else if (activePage?.id === 'page-profile') renderProfile(user?.uid);
  else if (activePage?.id === 'page-masters') renderMasters();
});

window.closeMobileMenu = () => {
  document.getElementById('mobileMenu').classList.remove('open');
  document.getElementById('menuOverlay').classList.remove('open');
  document.body.style.overflow = '';
};
document.getElementById('hamburgerBtn').onclick = () => {
  document.getElementById('mobileMenu').classList.toggle('open');
  document.getElementById('menuOverlay').classList.toggle('open');
  document.body.style.overflow = document.getElementById('mobileMenu').classList.contains('open') ? 'hidden' : '';
};
document.getElementById('menuOverlay').onclick = closeMobileMenu;

window.addEventListener('scroll', () => document.getElementById('navbar').classList.toggle('scrolled', window.scrollY > 40));

if (window.innerWidth > 1024) {
  const cur = document.getElementById('cursor'), ring = document.getElementById('cursorRing');
  let mx=0, my=0, rx=0, ry=0;
  document.addEventListener('mousemove', e => { mx=e.clientX; my=e.clientY; });
  (function anim() {
    cur.style.left = mx + 'px'; cur.style.top = my + 'px';
    rx += (mx - rx) * .15; ry += (my - ry) * .15;
    ring.style.left = rx + 'px'; ring.style.top = ry + 'px';
    requestAnimationFrame(anim);
  })();
}

// Price list functions
window.openPriceList = function() {
  document.getElementById('modalPriceList').classList.add('open');
};
window.togglePriceCategory = function(headerEl) {
  const items = headerEl.nextElementSibling;
  const arrow = headerEl.querySelector('.price-cat-arrow i');
  const isOpen = items.classList.contains('open');
  if (isOpen) {
    items.classList.remove('open');
    arrow.className = 'fas fa-chevron-down';
    headerEl.classList.remove('open');
  } else {
    items.classList.add('open');
    arrow.className = 'fas fa-chevron-up';
    headerEl.classList.add('open');
  }
};

// Settings init
(function() {
  const s = JSON.parse(localStorage.getItem('siteSettings') || '{}');
  applySettings(s);
})();

initAuthTabs();

// Expose functions to global scope for onclick handlers
window.renderMasters = renderMasters;
window.renderAdmin = renderAdmin;
// Note: many functions already attached to window via assignment. 
