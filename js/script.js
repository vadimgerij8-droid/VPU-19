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

// ========== CONFIG ==========
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

// ========== STATE ==========
let currentUser = null;
let currentUserDoc = null;
let pendingProfilePhotoFile = null;
let pendingPostFiles = [];
let postMediaType = null;
let reviewTargetPostId = null;
let reviewStarValue = 0;
let currentFeedFilter = 'all';

// ========== CACHE ==========
const authorCache = {};

// ========== HELPERS ==========
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
window.closeModal = id => document.getElementById(id).classList.remove('open');

document.querySelectorAll('.modal-overlay').forEach(o =>
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); })
);

let toastTimer;
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function getSessionId() {
  let sid = localStorage.getItem('ratingSession');
  if (!sid) {
    sid = 'anon_' + Math.random().toString(36).slice(2, 11);
    localStorage.setItem('ratingSession', sid);
  }
  return sid;
}

function starsHtml(avg, interactive = false, postId = '') {
  const full = Math.round(avg);
  if (interactive) {
    return [1, 2, 3, 4, 5].map(i =>
      `<span class="star-icon${i <= full ? ' filled' : ''}" data-val="${i}" data-post="${postId}"
        onmouseover="hoverStars(${i},'${postId}')" onmouseout="unhoverStars('${postId}')"
        onclick="submitRating('${postId}',${i})"><i class="fas fa-star"></i></span>`
    ).join('');
  }
  return [1, 2, 3, 4, 5].map(i =>
    `<span class="star-icon${i <= full ? ' filled' : ''}"><i class="fas fa-star"></i></span>`
  ).join('');
}

window.hoverStars = (val, postId) => {
  document.querySelectorAll(`.stars-interactive [data-post="${postId}"]`).forEach(s =>
    s.classList.toggle('hovered', parseInt(s.dataset.val) <= val)
  );
};
window.unhoverStars = postId => {
  document.querySelectorAll(`.stars-interactive [data-post="${postId}"]`).forEach(s =>
    s.classList.remove('hovered')
  );
};

function getPostMediaArray(post) {
  if (post.media && Array.isArray(post.media)) return post.media;
  if (post.mediaURL) return [{ url: post.mediaURL, type: post.mediaType || 'image' }];
  if (post.imageURL) return [{ url: post.imageURL, type: 'image' }];
  return [];
}

// ========== CLOUDINARY ==========
async function uploadToCloudinary(file, folder = '') {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
  if (folder) formData.append('folder', folder);

  const isVideo = file.type.startsWith('video/');
  const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${isVideo ? 'video' : 'image'}/upload`;

  const response = await fetch(url, { method: 'POST', body: formData });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'Помилка завантаження на Cloudinary');
  }
  const data = await response.json();
  return { url: data.secure_url, type: isVideo ? 'video' : 'image' };
}

// ========== NAVIGATION ==========
window.navigate = async (page, userId = null, scrollToPost = null) => {
  document.querySelectorAll('.page').forEach(p => {
    p.classList.remove('active');
    p.style.opacity = '0';
    p.style.transform = 'translateY(20px)';
  });
  const el = document.getElementById(`page-${page}`);
  el.classList.add('active');
  setTimeout(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; }, 10);

  if (page === 'home') {
    await renderHome();
    if (scrollToPost) setTimeout(() => scrollToPostById(scrollToPost), 400);
  } else if (page === 'masters') {
    renderMasters();
  } else if (page === 'profile') {
    renderProfile(userId || currentUser?.uid);
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
  window.closeMobileMenu();
};

function scrollToPostById(postId) {
  const el = document.getElementById(`post-${postId}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.boxShadow = '0 0 0 4px var(--gold)';
    setTimeout(() => { el.style.boxShadow = ''; }, 2000);
  }
}

// ========== RENDER HOME ==========
async function renderHome() {
  const feedEl = document.getElementById('feedContainer');
  feedEl.innerHTML = '<div class="loading-wrap"><div class="spinner"></div><div>Завантаження...</div></div>';

  try {
    const [mastersSnap, postsSnap] = await Promise.all([
      getDocs(query(collection(db, 'users'), where('role', 'in', ['master', 'admin']))),
      getDocs(query(collection(db, 'posts'), orderBy('createdAt', 'desc')))
    ]);

    document.getElementById('statMasters').textContent = mastersSnap.size;
    document.getElementById('statWorks').textContent = postsSnap.size;

    let totalRatingSum = 0, totalRatingCount = 0;
    postsSnap.forEach(d => {
      totalRatingSum += d.data().ratingSum || 0;
      totalRatingCount += d.data().ratingCount || 0;
    });
    document.getElementById('statRating').textContent =
      totalRatingCount > 0 ? (totalRatingSum / totalRatingCount).toFixed(1) : '—';

    let allPosts = postsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (currentFeedFilter !== 'all') {
      allPosts = allPosts.filter(p => p.authorStatus === currentFeedFilter);
    }

    if (allPosts.length === 0) {
      feedEl.innerHTML = "<div class=\"empty-state\"><h3>Немає робіт</h3><p>Публікації з'являться тут</p></div>";
      return;
    }

    const uniqueAuthorIds = [...new Set(allPosts.map(p => p.authorId))];
    await Promise.all(
      uniqueAuthorIds
        .filter(id => !authorCache[id])
        .map(id =>
          getDoc(doc(db, 'users', id)).then(snap => {
            authorCache[id] = snap.exists() ? snap.data() : { name: 'Невідомий', photoURL: null };
          })
        )
    );

    const ratedPosts = new Set(JSON.parse(localStorage.getItem('ratedPosts') || '[]'));

    const reviewsSnap = await getDocs(collection(db, 'reviews'));
    const reviewCountByPost = {};
    reviewsSnap.forEach(r => {
      const pid = r.data().postId;
      reviewCountByPost[pid] = (reviewCountByPost[pid] || 0) + 1;
    });

    const html = allPosts.map(post => {
      const author = authorCache[post.authorId] || { name: 'Невідомий', photoURL: null };
      const avg = post.ratingCount > 0 ? (post.ratingSum / post.ratingCount).toFixed(1) : 0;
      const hasRated = ratedPosts.has(post.id);
      const isOwn = currentUser && currentUser.uid === post.authorId;
      const canDelete = isOwn || currentUserDoc?.role === 'admin';
      const reviewCount = reviewCountByPost[post.id] || 0;
      const dateStr = post.createdAt
        ? new Date(post.createdAt.toDate()).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' })
        : '';

      const media = getPostMediaArray(post);
      let mediaHtml = '';
      if (media.length === 1) {
        const m = media[0];
        mediaHtml = m.type === 'video'
          ? `<div class="single-media"><video class="post-media" controls autoplay muted loop playsinline preload="metadata" src="${esc(m.url)}"></video></div>`
          : `<div class="single-media"><img class="post-image" src="${esc(m.url)}" alt="Робота" loading="lazy"></div>`;
      } else if (media.length > 1) {
        mediaHtml = renderCarousel(post.id, media);
      }

      return `
        <div class="post-card animate-on-scroll" id="post-${post.id}">
          <div class="post-header">
            <div class="post-avatar">
              ${author.photoURL
                ? `<img src="${esc(author.photoURL)}" loading="lazy">`
                : '<i class="fas fa-user-circle" style="font-size:2rem;color:var(--gray-mid)"></i>'}
            </div>
            <div>
              <div class="post-author" onclick="navigate('profile','${post.authorId}')">${esc(author.name || author.email)}</div>
              <div class="post-date">${dateStr}</div>
            </div>
          </div>
          ${mediaHtml}
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
            <button class="btn-write-review" onclick="openWriteReview('${post.id}')">
              <i class="far fa-comment-dots"></i> Написати відгук
            </button>
            <button class="post-reviews-toggle" onclick="toggleReviews('${post.id}', this)">
              <i class="far fa-comments"></i> Відгуки
              <span class="reviews-count-badge" id="rev-count-${post.id}">${reviewCount}</span>
              <span style="margin-left:auto;font-size:.7rem;color:var(--gray-mid)" id="rev-arrow-${post.id}">
                <i class="fas fa-chevron-down"></i>
              </span>
            </button>
            <div class="post-reviews-list" id="reviews-list-${post.id}"></div>
          </div>
          ${canDelete ? `
          <div class="post-footer">
            <button class="post-delete-btn" onclick="deletePost('${post.id}')">
              <i class="far fa-trash-alt"></i> Видалити
            </button>
          </div>` : ''}
        </div>`;
    }).join('');

    feedEl.innerHTML = html;
    initScrollAnimation();
    initCarousels();
    initVideoAutoplay();
  } catch (e) {
    feedEl.innerHTML = `<div class="empty-state"><h3>Помилка завантаження</h3><p>${esc(e.message)}</p></div>`;
    console.error('renderHome error:', e);
  }
}

// ========== CAROUSEL ==========
function renderCarousel(postId, media) {
  const slides = media.map((m, idx) =>
    m.type === 'video'
      ? `<div class="carousel-slide"><video src="${esc(m.url)}" controls autoplay muted loop playsinline preload="metadata" class="carousel-video"></video></div>`
      : `<div class="carousel-slide"><img src="${esc(m.url)}" alt="Slide ${idx + 1}" loading="lazy"></div>`
  ).join('');
  const dots = media.map((_, idx) =>
    `<span class="carousel-dot${idx === 0 ? ' active' : ''}" data-idx="${idx}"></span>`
  ).join('');
  return `
    <div class="post-media-carousel" data-post-id="${postId}">
      <div class="carousel-track">${slides}</div>
      <button class="carousel-nav carousel-prev" aria-label="Попередній"><i class="fas fa-chevron-left"></i></button>
      <button class="carousel-nav carousel-next" aria-label="Наступний"><i class="fas fa-chevron-right"></i></button>
      <div class="carousel-dots">${dots}</div>
      <div class="carousel-counter">1/${media.length}</div>
    </div>`;
}

function initCarousels() {
  document.querySelectorAll('.post-media-carousel').forEach(carousel => {
    const track = carousel.querySelector('.carousel-track');
    const slides = track.querySelectorAll('.carousel-slide');
    const dots = carousel.querySelectorAll('.carousel-dot');
    const counter = carousel.querySelector('.carousel-counter');
    let currentIndex = 0;

    function updateCarousel(index) {
      currentIndex = Math.max(0, Math.min(index, slides.length - 1));
      track.style.transform = `translateX(-${currentIndex * 100}%)`;
      dots.forEach((d, i) => d.classList.toggle('active', i === currentIndex));
      counter.textContent = `${currentIndex + 1}/${slides.length}`;
      slides.forEach((slide, i) => {
        const video = slide.querySelector('video');
        if (video && i !== currentIndex) video.pause();
      });
    }

    carousel.querySelector('.carousel-prev').onclick = () => updateCarousel(currentIndex - 1);
    carousel.querySelector('.carousel-next').onclick = () => updateCarousel(currentIndex + 1);
    dots.forEach(dot => dot.onclick = () => updateCarousel(parseInt(dot.dataset.idx)));

    let startX = 0, moved = false;
    carousel.addEventListener('touchstart', e => { startX = e.touches[0].clientX; moved = false; }, { passive: true });
    carousel.addEventListener('touchmove', e => { if (Math.abs(e.touches[0].clientX - startX) > 10) moved = true; }, { passive: true });
    carousel.addEventListener('touchend', e => {
      if (!moved) return;
      const delta = e.changedTouches[0].clientX - startX;
      if (Math.abs(delta) > 50) updateCarousel(currentIndex + (delta > 0 ? -1 : 1));
    });

    updateCarousel(0);
  });
}

function initScrollAnimation() {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => { if (entry.isIntersecting) entry.target.classList.add('visible'); });
  }, { threshold: 0.1 });
  document.querySelectorAll('.animate-on-scroll').forEach(el => observer.observe(el));
}

function initVideoAutoplay() {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) entry.target.play().catch(() => {});
      else entry.target.pause();
    });
  }, { threshold: 0.5 });
  document.querySelectorAll('.post-media, .carousel-video').forEach(v => observer.observe(v));
}

// ========== FEED TABS ==========
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.feed-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.feed-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFeedFilter = tab.dataset.filter;
      renderHome();
    });
  });
});

// ========== REVIEWS ==========
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
    const snap = await getDocs(
      query(collection(db, 'reviews'), where('postId', '==', postId), orderBy('createdAt', 'desc'))
    );

    if (snap.empty) {
      listEl.innerHTML = '<div style="padding:16px;font-size:.78rem;color:var(--gray-mid)">Відгуків ще немає.</div>';
      return;
    }

    const sessionId = getSessionId();
    const reviewIds = snap.docs.map(d => d.id);

    const likesSnap = await getDocs(
      query(collection(db, 'reviewLikes'), where('reviewId', 'in', reviewIds))
    );

    const likeMap = {};
    likesSnap.forEach(docSnap => {
      const l = docSnap.data();
      if (!likeMap[l.reviewId]) likeMap[l.reviewId] = { likes: 0, dislikes: 0, userVote: null };
      if (l.type === 'like') likeMap[l.reviewId].likes++;
      else likeMap[l.reviewId].dislikes++;
      if (l.userId === sessionId || l.userId === currentUser?.uid) likeMap[l.reviewId].userVote = l.type;
    });

    listEl.innerHTML = snap.docs.map(d => {
      const r = d.data();
      const dateStr = r.createdAt
        ? new Date(r.createdAt.toDate()).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' })
        : '';
      const stars = [1, 2, 3, 4, 5].map(i =>
        `<span class="star-icon${i <= (r.rating || 0) ? ' filled' : ''}"><i class="fas fa-star"></i></span>`
      ).join('');
      const likeData = likeMap[d.id] || { likes: 0, dislikes: 0, userVote: null };
      return `
        <div class="review-item" id="review-${d.id}">
          <div class="review-meta">
            <span class="review-author">${esc(r.authorName || 'Анонім')}</span>
            <div class="review-stars">${stars}</div>
            <span class="review-date">${dateStr}</span>
          </div>
          <div class="review-text">${esc(r.text)}</div>
          <div class="review-actions">
            <button class="like-btn ${likeData.userVote === 'like' ? 'active' : ''}" onclick="handleReviewLike('${d.id}','like')">
              <i class="far fa-thumbs-up"></i>
              <span class="like-count" id="like-count-${d.id}">${likeData.likes}</span>
            </button>
            <button class="dislike-btn ${likeData.userVote === 'dislike' ? 'active' : ''}" onclick="handleReviewLike('${d.id}','dislike')">
              <i class="far fa-thumbs-down"></i>
              <span class="dislike-count" id="dislike-count-${d.id}">${likeData.dislikes}</span>
            </button>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    listEl.innerHTML = `<div style="padding:16px;font-size:.75rem;color:#c0392b">${esc(e.message)}</div>`;
  }
};

window.handleReviewLike = async (reviewId, type) => {
  const sessionId = getSessionId();
  const userId = currentUser?.uid || sessionId;
  const likesRef = collection(db, 'reviewLikes');
  const snap = await getDocs(query(likesRef, where('reviewId', '==', reviewId), where('userId', '==', userId)));

  const batch = writeBatch(db);
  let likeDelta = 0, dislikeDelta = 0, newVote = null;

  if (!snap.empty) {
    const existing = snap.docs[0];
    const existingType = existing.data().type;
    if (existingType === type) {
      batch.delete(existing.ref);
      if (type === 'like') likeDelta = -1; else dislikeDelta = -1;
    } else {
      batch.update(existing.ref, { type });
      newVote = type;
      if (type === 'like') { likeDelta = 1; dislikeDelta = -1; } else { likeDelta = -1; dislikeDelta = 1; }
    }
  } else {
    batch.set(doc(likesRef), { reviewId, userId, type, createdAt: Timestamp.now() });
    newVote = type;
    if (type === 'like') likeDelta = 1; else dislikeDelta = 1;
  }

  await batch.commit();

  const likeSpan = document.getElementById(`like-count-${reviewId}`);
  const dislikeSpan = document.getElementById(`dislike-count-${reviewId}`);
  if (likeSpan) likeSpan.textContent = Math.max(0, parseInt(likeSpan.textContent) + likeDelta);
  if (dislikeSpan) dislikeSpan.textContent = Math.max(0, parseInt(dislikeSpan.textContent) + dislikeDelta);

  const likeBtn = document.querySelector(`.like-btn[onclick*="'${reviewId}'"]`);
  const dislikeBtn = document.querySelector(`.dislike-btn[onclick*="'${reviewId}'"]`);
  if (likeBtn) likeBtn.classList.toggle('active', newVote === 'like');
  if (dislikeBtn) dislikeBtn.classList.toggle('active', newVote === 'dislike');

  showToast(type === 'like' ? '👍 Лайк!' : '👎 Дизлайк', 'success');
};

window.openWriteReview = postId => {
  reviewTargetPostId = postId;
  reviewStarValue = 0;
  document.getElementById('reviewText').value = '';
  document.getElementById('reviewAuthorName').value = '';
  document.querySelectorAll('#reviewStarPicker span').forEach(s => s.classList.remove('sel'));
  openModal('modalReview');
};

document.querySelectorAll('#reviewStarPicker span').forEach(sp => {
  sp.addEventListener('click', () => {
    reviewStarValue = parseInt(sp.dataset.v);
    document.querySelectorAll('#reviewStarPicker span').forEach(s =>
      s.classList.toggle('sel', parseInt(s.dataset.v) <= reviewStarValue)
    );
  });
  sp.addEventListener('mouseover', () => {
    const v = parseInt(sp.dataset.v);
    document.querySelectorAll('#reviewStarPicker span').forEach(s =>
      s.classList.toggle('sel', parseInt(s.dataset.v) <= v)
    );
  });
  sp.addEventListener('mouseout', () => {
    document.querySelectorAll('#reviewStarPicker span').forEach(s =>
      s.classList.toggle('sel', parseInt(s.dataset.v) <= reviewStarValue)
    );
  });
});

document.getElementById('submitReviewBtn').onclick = async () => {
  const text = document.getElementById('reviewText').value.trim();
  if (!text) { showToast('Напишіть текст відгуку', 'error'); return; }
  if (!reviewStarValue) { showToast('Оберіть оцінку (зірки)', 'error'); return; }
  const authorName = document.getElementById('reviewAuthorName').value.trim() || 'Анонім';
  const btn = document.getElementById('submitReviewBtn');
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Надсилання...';
  btn.disabled = true;
  try {
    await addDoc(collection(db, 'reviews'), {
      postId: reviewTargetPostId,
      authorId: currentUser?.uid || getSessionId(),
      authorName,
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
  } catch (e) {
    showToast('Помилка: ' + e.message, 'error');
  } finally {
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Надіслати відгук';
    btn.disabled = false;
  }
};

// ========== RATINGS ==========
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
    showToast(`Оцінку ${value} зірок збережено!`, 'success');
  } catch (e) {
    showToast('Помилка: ' + e.message, 'error');
  }
};

async function refreshRatingHtml(postId) {
  const snap = await getDoc(doc(db, 'posts', postId));
  const d = snap.data();
  const avg = d.ratingCount > 0 ? (d.ratingSum / d.ratingCount).toFixed(1) : 0;
  return `
    <div class="stars-display">${starsHtml(avg)}</div>
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
  } catch (e) {
    showToast(e.message, 'error');
  }
};

// ========== MASTERS ==========
async function renderMasters() {
  const container = document.getElementById('mastersList');
  container.innerHTML = '<div class="loading-wrap"><div class="spinner"></div><div>Завантаження...</div></div>';
  try {
    const [mastersSnap, allPostsSnap] = await Promise.all([
      getDocs(query(collection(db, 'users'), where('role', 'in', ['master', 'admin']))),
      getDocs(collection(db, 'posts'))
    ]);

    if (mastersSnap.empty) {
      container.innerHTML = '<div class="empty-state"><h3>Майстрів поки немає</h3><p>Зареєструйтесь як майстер</p></div>';
      return;
    }

    const postsByAuthor = {};
    allPostsSnap.forEach(p => {
      const d = p.data();
      if (!postsByAuthor[d.authorId]) postsByAuthor[d.authorId] = { count: 0, rSum: 0, rCount: 0 };
      postsByAuthor[d.authorId].count++;
      postsByAuthor[d.authorId].rSum += d.ratingSum || 0;
      postsByAuthor[d.authorId].rCount += d.ratingCount || 0;
    });

    container.innerHTML = mastersSnap.docs.map(docSnap => {
      const u = docSnap.data();
      const stats = postsByAuthor[docSnap.id] || { count: 0, rSum: 0, rCount: 0 };
      const avg = stats.rCount > 0 ? (stats.rSum / stats.rCount).toFixed(1) : 0;
      return `
        <div class="master-card animate-on-scroll" onclick="navigate('profile','${docSnap.id}')">
          <div class="master-card-photo">
            ${u.photoURL
              ? `<img src="${esc(u.photoURL)}" loading="lazy">`
              : '<i class="fas fa-user-tie" style="font-size:3rem;color:var(--gray-mid)"></i>'}
          </div>
          <div class="master-card-info">
            <div class="master-card-name">${esc(u.name || u.email)}</div>
            <div class="master-card-role">
              <i class="fas fa-${u.role === 'admin' ? 'crown' : 'cut'}"></i>
              ${u.role === 'admin' ? 'Адміністратор' : 'Майстер'}
              ${u.status ? '· ' + (u.status === 'student' ? 'Учень' : 'Майстер') : ''}
            </div>
            <div class="master-card-stats">
              <span><i class="far fa-image"></i> ${stats.count} робіт</span>
              ${u.phone ? '<span><i class="fas fa-phone-alt"></i> ' + esc(u.phone) + '</span>' : ''}
            </div>
            <div class="master-card-rating-row">
              <div class="stars-display">${starsHtml(avg)}</div>
              <span class="rating-avg">${avg > 0 ? avg : '—'}</span>
              <span class="rating-count">${stats.rCount} оцінок</span>
            </div>
          </div>
        </div>`;
    }).join('');

    initScrollAnimation();
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><h3>Помилка</h3><p>${esc(e.message)}</p></div>`;
  }
}

// ========== PROFILE ==========
async function renderProfile(userId) {
  const container = document.getElementById('profileContainer');
  if (!userId) {
    container.innerHTML = `
      <div style="padding:160px 48px;text-align:center">
        <p style="font-size:.9rem;color:var(--gray-mid)">Увійдіть, щоб переглянути профіль</p>
        <button class="btn-primary" style="margin-top:24px" onclick="openAuthModal()">
          <i class="fas fa-sign-in-alt"></i> Увійти
        </button>
      </div>`;
    return;
  }
  container.innerHTML = '<div class="loading-wrap" style="padding:160px"><div class="spinner"></div></div>';

  try {
    const userSnap = await getDoc(doc(db, 'users', userId));
    if (!userSnap.exists()) {
      container.innerHTML = '<div style="padding:120px;text-align:center">Користувача не знайдено</div>';
      return;
    }
    const user = userSnap.data();

    const [postsSnap, reviewsSnap] = await Promise.all([
      getDocs(query(collection(db, 'posts'), where('authorId', '==', userId))),
      getDocs(query(collection(db, 'reviews'), orderBy('createdAt', 'desc')))
    ]);

    let posts = postsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    posts.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));

    let rSum = 0, rCount = 0;
    posts.forEach(p => { rSum += p.ratingSum || 0; rCount += p.ratingCount || 0; });
    const avg = rCount > 0 ? (rSum / rCount).toFixed(1) : 0;

    const postIds = new Set(posts.map(p => p.id));
    const allReviews = reviewsSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(r => postIds.has(r.postId));

    const isOwn = currentUser && currentUser.uid === userId;
    const isMaster = user.role === 'master' || user.role === 'admin';
    const statusLabel = user.status === 'student' ? 'Учень' : 'Майстер';
    const roleIcon = user.role === 'admin' ? 'fa-crown' : 'fa-scissors';

    const socialLinks = user.socialLinks || {};
    const platforms = {
      instagram: 'fab fa-instagram', tiktok: 'fab fa-tiktok',
      facebook: 'fab fa-facebook-f', telegram: 'fab fa-telegram',
      youtube: 'fab fa-youtube', other: 'fas fa-link'
    };
    const socialIcons = Object.entries(socialLinks)
      .filter(([, url]) => url && url.trim())
      .map(([p, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${p}"><i class="${platforms[p] || 'fas fa-link'}"></i></a>`)
      .join('');

    const avgNum = parseFloat(avg) || 0;
    const sidebarStars = [1, 2, 3, 4, 5].map(i => {
      if (i <= Math.floor(avgNum)) return '<i class="fas fa-star star-icon filled"></i>';
      if (avgNum > 0 && i - avgNum < 1) return '<i class="fas fa-star-half-stroke star-icon filled"></i>';
      return '<i class="fas fa-star star-icon empty"></i>';
    }).join('');

    const avatarInner = user.photoURL
      ? `<img src="${esc(user.photoURL)}" alt="${esc(user.name || '')}">`
      : '<div class="profile-avatar-placeholder"><i class="fas fa-user-circle"></i></div>';

    const nameParts = (user.name || (user.email ? user.email.split('@')[0] : '') || 'Користувач').split(' ');
    const nameHtml = nameParts.length >= 2
      ? esc(nameParts[0]) + '<br>' + esc(nameParts.slice(1).join(' '))
      : esc(nameParts[0]);

    const postsGridHtml = posts.length
      ? '<div class="profile-posts-grid">' + posts.map(p => {
          const media = getPostMediaArray(p);
          const firstMedia = media[0];
          const pAvg = p.ratingCount > 0 ? (p.ratingSum / p.ratingCount).toFixed(1) : '—';
          return '<div class="profile-post-item" onclick="navigate(\'home\',null,\'' + p.id + '\')">'
            + (firstMedia
              ? firstMedia.type === 'video'
                ? '<video src="' + esc(firstMedia.url) + '" muted preload="metadata" style="width:100%;height:100%;object-fit:cover"></video>'
                : '<img src="' + esc(firstMedia.url) + '" loading="lazy">'
              : '<div style="width:100%;height:100%;background:var(--gray-light)"></div>')
            + '<div class="profile-post-overlay"><span class="overlay-stat"><i class="fas fa-star"></i> ' + pAvg + '</span></div>'
            + '</div>';
        }).join('') + '</div>'
      : '<p style="color:var(--gray-mid);font-size:.82rem;padding:16px 0">Ще немає опублікованих робіт</p>';

    const reviewsHtml = allReviews.length === 0
      ? '<p style="color:var(--gray-mid);font-size:.82rem;padding:16px 0">Відгуків ще немає</p>'
      : '<div class="profile-reviews-list">' + allReviews.map(r => {
          const dateStr = r.createdAt
            ? new Date(r.createdAt.toDate()).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' })
            : '';
          const stars = [1, 2, 3, 4, 5].map(i =>
            '<i class="fas fa-star star-icon' + (i <= (r.rating || 0) ? ' filled' : ' empty') + '"></i>'
          ).join('');
          return '<div class="profile-review-card">'
            + '<div class="review-meta">'
            + '<div class="review-author">' + esc(r.authorName || 'Анонім') + '</div>'
            + '<div class="review-date">' + dateStr + '</div>'
            + '</div>'
            + '<div class="review-stars" style="margin-bottom:10px">' + stars + '</div>'
            + '<p class="review-text">' + esc(r.text) + '</p>'
            + '</div>';
        }).join('') + '</div>';

    const sortedByRating = [...posts].sort((a, b) => {
      const aAvg = a.ratingCount ? a.ratingSum / a.ratingCount : 0;
      const bAvg = b.ratingCount ? b.ratingSum / b.ratingCount : 0;
      return bAvg - aAvg;
    });

    const ratingsHtml = sortedByRating.length === 0
      ? '<p style="color:var(--gray-mid);font-size:.82rem;padding:16px 0">Ще немає публікацій</p>'
      : '<div class="haircut-ratings-list">' + sortedByRating.map(p => {
          const pAvg = p.ratingCount > 0 ? (p.ratingSum / p.ratingCount).toFixed(1) : null;
          const stars = [1, 2, 3, 4, 5].map(i =>
            '<i class="fas fa-star star-icon' + (pAvg && i <= Math.round(pAvg) ? ' filled' : '') + '"></i>'
          ).join('');
          const media = getPostMediaArray(p);
          const thumbUrl = media.length ? media[0].url : '';
          return '<div class="haircut-rating-item">'
            + (thumbUrl
              ? '<img class="haircut-thumb" src="' + esc(thumbUrl) + '" loading="lazy">'
              : '<div class="haircut-thumb" style="display:flex;align-items:center;justify-content:center"><i class="fas fa-image" style="font-size:1.5rem;color:var(--gray-mid)"></i></div>')
            + '<div class="haircut-info">'
            + '<div class="haircut-caption">' + esc(p.caption || 'Без опису') + '</div>'
            + '<div class="haircut-stats">'
            + '<span class="haircut-avg">' + (pAvg || '—') + '</span>'
            + '<div class="haircut-mini-stars">' + stars + '</div>'
            + '<span class="haircut-count">' + (p.ratingCount || 0) + ' оцінок</span>'
            + '</div></div></div>';
        }).join('') + '</div>';

    container.innerHTML = `
      <div class="profile-layout">
        <aside class="profile-sidebar">
          <div class="avatar-wrap">
            <div class="profile-avatar">${avatarInner}</div>
            <div class="avatar-text">
              <div class="profile-name">${nameHtml}</div>
              <div class="profile-badges">
                <span class="badge badge-gold"><i class="fas ${roleIcon}"></i> ${statusLabel}</span>
              </div>
              <div class="stars-row" style="justify-content:flex-start;margin-top:6px;">
                ${sidebarStars}
                <span class="avg-label">${avgNum > 0 ? avg : '—'} · ${allReviews.length} відгуків</span>
              </div>
            </div>
          </div>
          <div class="profile-stats">
            <div class="profile-stat">
              <span class="stat-value">${posts.length}</span>
              <span class="stat-label">Постів</span>
            </div>
            <div class="profile-stat">
              <span class="stat-value">${rCount}</span>
              <span class="stat-label">Оцінок</span>
            </div>
            <div class="profile-stat">
              <span class="stat-value">${allReviews.length}</span>
              <span class="stat-label">Відгуків</span>
            </div>
          </div>
          ${user.bio ? '<p class="profile-bio">' + esc(user.bio) + '</p>' : ''}
          ${isMaster && user.phone ? '<div class="profile-phone"><i class="fas fa-phone-alt"></i> ' + esc(user.phone) + '</div>' : ''}
          ${socialIcons ? '<div class="profile-social-links">' + socialIcons + '</div>' : ''}
          ${isOwn ? `
            <button class="btn-edit-profile" onclick="openEditProfileModal()">
              <i class="far fa-pen-to-square"></i> Редагувати профіль
            </button>
            ${isMaster ? `
              <button class="btn-primary" style="width:100%" onclick="openCreatePost()">
                <i class="fas fa-plus-circle"></i> Нова робота
              </button>` : ''}
            <button class="btn-secondary"
              style="width:100%;background:transparent;color:rgba(255,255,255,.5);border-color:rgba(255,255,255,.2)"
              onclick="doLogout()">
              <i class="fas fa-sign-out-alt"></i> Вийти
            </button>
          ` : ''}
        </aside>
        <main class="profile-main">
          <div class="profile-tabs" id="profileTabs">
            <button class="profile-tab active" data-ptab="posts"><i class="fas fa-th"></i> Пости</button>
            <button class="profile-tab" data-ptab="reviews"><i class="far fa-star"></i> Відгуки</button>
            <button class="profile-tab" data-ptab="ratings"><i class="fas fa-chart-bar"></i> Рейтинг</button>
          </div>
          <div class="profile-tab-pane active" id="ptab-posts">${postsGridHtml}</div>
          <div class="profile-tab-pane" id="ptab-reviews">${reviewsHtml}</div>
          <div class="profile-tab-pane" id="ptab-ratings">${ratingsHtml}</div>
        </main>
      </div>`;

    document.querySelectorAll('#profileTabs .profile-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#profileTabs .profile-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.profile-tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('ptab-' + btn.dataset.ptab).classList.add('active');
      });
    });
  } catch (e) {
    container.innerHTML = '<div style="padding:120px;text-align:center;color:var(--gray-mid)">' + esc(e.message) + '</div>';
    console.error('renderProfile error:', e);
  }
}

// ========== EDIT PROFILE ==========
window.openEditProfileModal = () => {
  pendingProfilePhotoFile = null;
  document.getElementById('editProfileName').value = currentUserDoc?.name || '';
  document.getElementById('editProfileBio').value = currentUserDoc?.bio || '';
  const isMaster = ['master', 'admin'].includes(currentUserDoc?.role);
  document.getElementById('editPhoneGroup').style.display = isMaster ? 'block' : 'none';
  document.getElementById('editProfilePhone').value = currentUserDoc?.phone || '';
  document.getElementById('editStatusGroup').style.display = isMaster ? 'block' : 'none';
  document.getElementById('editProfileStatus').value = currentUserDoc?.status || 'master';
  const social = currentUserDoc?.socialLinks || {};
  ['instagram', 'tiktok', 'facebook', 'telegram', 'youtube', 'other'].forEach(key => {
    const el = document.getElementById('edit' + key.charAt(0).toUpperCase() + key.slice(1));
    if (el) el.value = social[key] || '';
  });
  const area = document.getElementById('editProfilePhotoArea');
  area.style.backgroundImage = currentUserDoc?.photoURL ? 'url(' + currentUserDoc.photoURL + ')' : '';
  area.style.backgroundSize = 'cover';
  area.style.backgroundPosition = 'center';
  openModal('modalEditProfile');
};

document.getElementById('editProfilePhotoInput').onchange = e => {
  pendingProfilePhotoFile = e.target.files[0];
  if (pendingProfilePhotoFile) {
    const area = document.getElementById('editProfilePhotoArea');
    area.style.backgroundImage = 'url(' + URL.createObjectURL(pendingProfilePhotoFile) + ')';
    area.style.backgroundSize = 'cover';
    area.style.backgroundPosition = 'center';
  }
};

document.getElementById('saveProfileBtn').onclick = async () => {
  if (!currentUser) return;
  const isMaster = ['master', 'admin'].includes(currentUserDoc?.role);
  const socialLinks = {};
  ['instagram', 'tiktok', 'facebook', 'telegram', 'youtube', 'other'].forEach(key => {
    const el = document.getElementById('edit' + key.charAt(0).toUpperCase() + key.slice(1));
    const val = el ? el.value.trim() : '';
    if (val) socialLinks[key] = val;
  });

  try {
    const updates = {
      name: document.getElementById('editProfileName').value.trim(),
      bio: document.getElementById('editProfileBio').value.trim(),
      socialLinks
    };
    if (isMaster) {
      updates.phone = document.getElementById('editProfilePhone').value.trim();
      updates.status = document.getElementById('editProfileStatus').value;
    }
    if (pendingProfilePhotoFile) {
      const uploadResult = await uploadToCloudinary(pendingProfilePhotoFile, 'avatars/' + currentUser.uid);
      updates.photoURL = uploadResult.url;
    }
    await updateDoc(doc(db, 'users', currentUser.uid), updates);
    currentUserDoc = Object.assign({}, currentUserDoc, updates);
    closeModal('modalEditProfile');
    showToast('Профіль оновлено', 'success');
    renderProfile(currentUser.uid);
  } catch (e) {
    showToast(e.message, 'error');
  }
};

// ========== CREATE POST ==========
window.openCreatePost = () => {
  if (!currentUser) { openAuthModal(); return; }
  if (!['master', 'admin'].includes(currentUserDoc?.role)) {
    showToast('Тільки майстри можуть публікувати роботи', 'error');
    return;
  }
  pendingPostFiles = [];
  postMediaType = null;
  document.getElementById('postCaption').value = '';
  document.getElementById('mediaPreviewGrid').innerHTML = '';
  document.getElementById('mediaHint').textContent = 'Підтримуються лише фото або лише відео в одному пості';
  document.getElementById('addPhotosBtn').disabled = false;
  document.getElementById('addVideosBtn').disabled = false;
  openModal('modalPost');
};

function updateMediaPreview() {
  const grid = document.getElementById('mediaPreviewGrid');
  grid.innerHTML = '';
  pendingPostFiles.forEach((file, idx) => {
    const url = URL.createObjectURL(file);
    const isVideo = file.type.startsWith('video/');
    const div = document.createElement('div');
    div.className = 'media-preview-item';
    div.innerHTML = isVideo
      ? '<video src="' + url + '" muted></video><button class="remove-btn" data-idx="' + idx + '">&times;</button>'
      : '<img src="' + url + '"><button class="remove-btn" data-idx="' + idx + '">&times;</button>';
    grid.appendChild(div);
  });
  grid.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingPostFiles.splice(parseInt(btn.dataset.idx), 1);
      if (pendingPostFiles.length === 0) postMediaType = null;
      updateMediaPreview();
    });
  });
}

document.getElementById('addPhotosBtn').addEventListener('click', () => {
  if (postMediaType === 'video') return;
  const input = document.getElementById('mediaInput');
  input.accept = 'image/*';
  input.multiple = true;
  input.click();
});

document.getElementById('addVideosBtn').addEventListener('click', () => {
  if (postMediaType === 'image') return;
  const input = document.getElementById('mediaInput');
  input.accept = 'video/*';
  input.multiple = true;
  input.click();
});

document.getElementById('mediaInput').addEventListener('change', e => {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  const isImage = !files[0].type.startsWith('video/');
  const type = isImage ? 'image' : 'video';
  const maxFiles = isImage ? 10 : 3;
  if (postMediaType && postMediaType !== type) {
    showToast('Не можна додавати фото та відео одночасно', 'error');
    return;
  }
  if (pendingPostFiles.length + files.length > maxFiles) {
    showToast('Максимум ' + maxFiles + ' файлів для ' + (isImage ? 'фото' : 'відео'), 'error');
    return;
  }
  if (files.some(f => f.type.startsWith('video/') !== !isImage)) {
    showToast('Виберіть лише фото або лише відео', 'error');
    return;
  }
  postMediaType = type;
  pendingPostFiles.push(...files);
  updateMediaPreview();
  e.target.value = '';
});

document.getElementById('submitPostBtn').onclick = async () => {
  if (!pendingPostFiles.length) { showToast('Додайте хоча б одне фото або відео', 'error'); return; }
  const btn = document.getElementById('submitPostBtn');
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Завантаження...';
  btn.disabled = true;
  try {
    const media = await Promise.all(
      pendingPostFiles.map(file => uploadToCloudinary(file, 'posts/' + currentUser.uid))
    );
    await addDoc(collection(db, 'posts'), {
      authorId: currentUser.uid,
      authorStatus: currentUserDoc?.status || 'master',
      media,
      caption: document.getElementById('postCaption').value.trim(),
      ratingSum: 0,
      ratingCount: 0,
      createdAt: Timestamp.now()
    });
    closeModal('modalPost');
    showToast('Роботу опубліковано!', 'success');
    navigate('home');
  } catch (e) {
    showToast('Помилка: ' + e.message, 'error');
  } finally {
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Опублікувати';
    btn.disabled = false;
    pendingPostFiles = [];
    postMediaType = null;
  }
};

// ========== AUTH ==========
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
        role: 'master',
        status: 'master',
        createdAt: Timestamp.now()
      });
    } else if (!userDoc.data().role || userDoc.data().role === 'user') {
      await updateDoc(doc(db, 'users', user.uid), { role: 'master' });
    }
    closeModal('modalAuth');
    showToast('Ласкаво просимо, майстре!', 'success');
  } catch (e) {
    const msg = e.message.includes('auth/unauthorized-domain')
      ? 'Домен не додано в Firebase Console.'
      : e.message;
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
    await setDoc(doc(db, 'users', cred.user.uid), {
      email, name, role: 'master', status: 'master', createdAt: Timestamp.now()
    });
    closeModal('modalAuth');
    showToast('Реєстрація успішна! Ви увійшли як майстер.', 'success');
  } catch (e) {
    errDiv.textContent = e.message;
    errDiv.style.display = 'block';
  }
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
  } catch (e) {
    errEl.textContent = 'Невірний email або пароль';
    errEl.style.display = 'block';
  }
}

function initAuthTabs() {
  const tabs = document.querySelectorAll('.auth-tab');
  const clientPanel = document.getElementById('authClientPanel');
  const masterPanel = document.getElementById('authMasterPanel');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const isClient = tab.dataset.tab === 'client';
      clientPanel.style.display = isClient ? 'block' : 'none';
      masterPanel.style.display = isClient ? 'none' : 'block';
    });
  });
  document.getElementById('showMasterRegisterBtn').onclick = e => {
    e.preventDefault();
    document.getElementById('masterLoginForm').style.display = 'none';
    document.getElementById('masterRegisterForm').style.display = 'block';
  };
  document.getElementById('showMasterLoginBtn').onclick = e => {
    e.preventDefault();
    document.getElementById('masterRegisterForm').style.display = 'none';
    document.getElementById('masterLoginForm').style.display = 'block';
  };
}

window.openAuthModal = () => {
  document.querySelector('.auth-tab[data-tab="client"]').click();
  ['masterAuthEmail', 'masterAuthPassword', 'masterRegName', 'masterRegEmail',
    'masterRegPassword', 'masterRegPasswordConfirm'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('masterAuthError').style.display = 'none';
  document.getElementById('masterRegError').style.display = 'none';
  document.getElementById('masterLoginForm').style.display = 'block';
  document.getElementById('masterRegisterForm').style.display = 'none';
  openModal('modalAuth');
};

document.getElementById('googleSignInBtn').onclick = handleGoogleSignIn;
document.getElementById('masterSignInBtn').onclick = handleMasterSignIn;
document.getElementById('masterRegisterBtn').onclick = handleMasterRegister;

window.doLogout = () => { signOut(auth); showToast('Ви вийшли'); navigate('home'); };

// ========== AUTH STATE ==========
onAuthStateChanged(auth, async user => {
  currentUser = user;
  if (user) {
    const snap = await getDoc(doc(db, 'users', user.uid));
    currentUserDoc = snap.exists() ? snap.data() : null;
    const isMaster = ['master', 'admin'].includes(currentUserDoc?.role);
    document.getElementById('authBtn').innerHTML = '<i class="fas fa-user-circle"></i> ' + esc(currentUserDoc?.name || 'Профіль');
    document.getElementById('authBtn').onclick = () => navigate('profile');
    document.getElementById('mobileAuthBtn').innerHTML = '<i class="fas fa-user-circle"></i> Профіль';
    document.getElementById('mobileAuthBtn').onclick = () => navigate('profile');
    if (isMaster) document.getElementById('createPostFab').classList.add('visible');
    else document.getElementById('createPostFab').classList.remove('visible');
  } else {
    currentUserDoc = null;
    document.getElementById('authBtn').innerHTML = '<i class="fas fa-sign-in-alt"></i> Увійти';
    document.getElementById('authBtn').onclick = () => openAuthModal();
    document.getElementById('mobileAuthBtn').innerHTML = '<i class="fas fa-sign-in-alt"></i> Увійти';
    document.getElementById('mobileAuthBtn').onclick = () => openAuthModal();
    document.getElementById('createPostFab').classList.remove('visible');
  }

  ['adminNavLink', 'mobileAdminLink'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  const activePage = document.querySelector('.page.active');
  if (activePage?.id === 'page-home') renderHome();
  else if (activePage?.id === 'page-profile') renderProfile(user?.uid);
  else if (activePage?.id === 'page-masters') renderMasters();
});

// ========== MOBILE MENU ==========
window.closeMobileMenu = () => {
  document.getElementById('mobileMenu').classList.remove('open');
  document.getElementById('menuOverlay').classList.remove('open');
  document.getElementById('hamburgerBtn').classList.remove('open');
  document.body.style.overflow = '';
};

document.getElementById('hamburgerBtn').onclick = () => {
  const menu = document.getElementById('mobileMenu');
  const overlay = document.getElementById('menuOverlay');
  const hamburger = document.getElementById('hamburgerBtn');
  const isOpen = menu.classList.contains('open');
  [menu, overlay, hamburger].forEach(el => el.classList.toggle('open', !isOpen));
  document.body.style.overflow = isOpen ? '' : 'hidden';
};

document.getElementById('menuOverlay').onclick = closeMobileMenu;

// ========== SCROLL ==========
window.addEventListener('scroll', () =>
  document.getElementById('navbar').classList.toggle('scrolled', window.scrollY > 40)
);

// ========== CURSOR (тільки десктоп) ==========
if (window.innerWidth > 1024) {
  const cur = document.getElementById('cursor');
  const ring = document.getElementById('cursorRing');
  let mx = 0, my = 0, rx = 0, ry = 0;
  document.addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; });
  (function anim() {
    cur.style.left = mx + 'px';
    cur.style.top = my + 'px';
    rx += (mx - rx) * 0.15;
    ry += (my - ry) * 0.15;
    ring.style.left = rx + 'px';
    ring.style.top = ry + 'px';
    requestAnimationFrame(anim);
  })();
}

// ========== ПРАЙС-ЛИСТ ==========
window.openPriceList = () => document.getElementById('modalPriceList').classList.add('open');

window.togglePriceCategory = headerEl => {
  const items = headerEl.nextElementSibling;
  const arrow = headerEl.querySelector('.price-cat-arrow i');
  const isOpen = items.classList.contains('open');
  items.classList.toggle('open', !isOpen);
  arrow.className = isOpen ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
  headerEl.classList.toggle('open', !isOpen);
};

// ========== НАЛАШТУВАННЯ ==========
function applySettings(s) {
  if (s.heroDesc) document.getElementById('heroDescription').textContent = s.heroDesc;
  if (s.address) document.getElementById('footerAddress').innerHTML = '<i class="fas fa-map-marker-alt"></i> ' + s.address;
  if (s.phone) document.getElementById('footerPhone').innerHTML = '<i class="fas fa-phone-alt"></i> ' + s.phone;
  if (s.email) document.getElementById('footerEmail').innerHTML = '<i class="fas fa-envelope"></i> ' + s.email;
}

// ========== ІНІЦІАЛІЗАЦІЯ ==========
(function init() {
  const s = JSON.parse(localStorage.getItem('siteSettings') || '{}');
  applySettings(s);
  initAuthTabs();
})();

window.renderMasters = renderMasters;
window.renderHome = renderHome;
