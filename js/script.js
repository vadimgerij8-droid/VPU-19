import { initializeApp } from “firebase/app”;
import {
getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
onAuthStateChanged, signOut, GoogleAuthProvider, signInWithPopup
} from “firebase/auth”;
import {
getFirestore, collection, doc, setDoc, getDoc, getDocs, addDoc,
updateDoc, deleteDoc, query, orderBy, where, Timestamp,
increment, runTransaction, writeBatch, limit
} from “firebase/firestore”;

// ========== КОНФІГУРАЦІЯ ==========
const firebaseConfig = {
apiKey: “AIzaSyAoYoOeKo3zbpQxrP-6DjP94uMfMRsXxGo”,
authDomain: “vpu-19.firebaseapp.com”,
projectId: “vpu-19”,
storageBucket: “vpu-19.firebasestorage.app”,
messagingSenderId: “1021666755140”,
appId: “1:1021666755140:web:a9ad8540f1de8ea0527211”
};

const CLOUDINARY_CLOUD_NAME = “dv6ehoqiq”;
const CLOUDINARY_UPLOAD_PRESET = “VPU19VB”;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

// –– State ––
let currentUser = null;
let currentUserDoc = null;
let pendingProfilePhotoFile = null;
let pendingPostFiles = [];
let postMediaType = null;
let reviewTargetPostId = null;
let reviewStarValue = 0;
let currentFeedFilter = ‘all’;
let authInitialized = false;

// –– Helpers ––
function esc(str) {
if (!str) return ‘’;
return String(str)
.replace(/&/g, ‘&’)
.replace(/</g, ‘<’)
.replace(/>/g, ‘>’)
.replace(/”/g, ‘"’);
}

function openModal(id) {
const el = document.getElementById(id);
if (el) el.classList.add(‘open’);
}

window.closeModal = id => {
const el = document.getElementById(id);
if (el) el.classList.remove(‘open’);
};

document.querySelectorAll(’.modal-overlay’).forEach(o =>
o.addEventListener(‘click’, e => { if (e.target === o) o.classList.remove(‘open’); })
);

let toastTimer;
function showToast(msg, type = ‘’) {
const t = document.getElementById(‘toast’);
if (!t) return;
t.textContent = msg;
t.className = ‘toast show’ + (type ? ’ ’ + type : ‘’);
clearTimeout(toastTimer);
toastTimer = setTimeout(() => t.classList.remove(‘show’), 3200);
}

function starsHtml(avg, interactive = false, postId = ‘’) {
const full = Math.round(Number(avg) || 0);
if (interactive) {
return [1,2,3,4,5].map(i =>
`<span class="star-icon${i <= full ? ' filled' : ''}" data-val="${i}" data-post="${postId}" onmouseover="hoverStars(${i},'${postId}')" onmouseout="unhoverStars('${postId}')" onclick="submitRating('${postId}',${i})"><i class="fas fa-star"></i></span>`
).join(’’);
}
return [1,2,3,4,5].map(i =>
`<span class="star-icon${i <= full ? ' filled' : ''}"><i class="fas fa-star"></i></span>`
).join(’’);
}

window.hoverStars = (val, postId) => {
document.querySelectorAll(`.stars-interactive [data-post="${postId}"]`).forEach(s => {
s.classList.toggle(‘hovered’, parseInt(s.dataset.val) <= val);
});
};

window.unhoverStars = postId => {
document.querySelectorAll(`.stars-interactive [data-post="${postId}"]`).forEach(s =>
s.classList.remove(‘hovered’)
);
};

function getSessionId() {
let sid = localStorage.getItem(‘ratingSession’);
if (!sid) {
sid = ‘anon_’ + Math.random().toString(36).slice(2, 11);
localStorage.setItem(‘ratingSession’, sid);
}
return sid;
}

// –– Cloudinary upload з прогресом ––
async function uploadToCloudinary(file, folder = ‘’, onProgress = null) {
const formData = new FormData();
formData.append(‘file’, file);
formData.append(‘upload_preset’, CLOUDINARY_UPLOAD_PRESET);
if (folder) formData.append(‘folder’, folder);

const isVideo = file.type.startsWith(‘video/’);
const endpoint = isVideo ? ‘video’ : ‘image’;
const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${endpoint}/upload`;

return new Promise((resolve, reject) => {
const xhr = new XMLHttpRequest();
xhr.open(‘POST’, url);

```
if (onProgress) {
  xhr.upload.onprogress = e => {
    if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
  };
}

xhr.onload = () => {
  if (xhr.status >= 200 && xhr.status < 300) {
    const data = JSON.parse(xhr.responseText);
    resolve({ url: data.secure_url, type: isVideo ? 'video' : 'image' });
  } else {
    try {
      const err = JSON.parse(xhr.responseText);
      reject(new Error(err.error?.message || 'Помилка завантаження'));
    } catch {
      reject(new Error('Помилка завантаження на Cloudinary'));
    }
  }
};

xhr.onerror = () => reject(new Error('Мережева помилка при завантаженні'));
xhr.send(formData);
```

});
}

// –– Navigate ––
window.navigate = async (page, userId = null, scrollToPost = null) => {
document.querySelectorAll(’.page’).forEach(p => {
p.classList.remove(‘active’);
p.style.opacity = ‘0’;
p.style.transform = ‘translateY(20px)’;
});

const el = document.getElementById(`page-${page}`);
if (!el) return;
el.classList.add(‘active’);
setTimeout(() => {
el.style.opacity = ‘1’;
el.style.transform = ‘translateY(0)’;
}, 10);

if (page === ‘home’) {
await renderHome();
if (scrollToPost) setTimeout(() => scrollToPostById(scrollToPost), 400);
} else if (page === ‘masters’) {
renderMasters();
} else if (page === ‘profile’) {
renderProfile(userId || currentUser?.uid);
}

window.scrollTo({ top: 0, behavior: ‘smooth’ });
window.closeMobileMenu();
};

function scrollToPostById(postId) {
const el = document.getElementById(`post-${postId}`);
if (el) {
el.scrollIntoView({ behavior: ‘smooth’, block: ‘center’ });
el.classList.add(‘highlight-flash’);
setTimeout(() => el.classList.remove(‘highlight-flash’), 2000);
}
}

function getPostMediaArray(post) {
if (post.media && Array.isArray(post.media) && post.media.length > 0) return post.media;
if (post.mediaURL) return [{ url: post.mediaURL, type: post.mediaType || ‘image’ }];
if (post.imageURL) return [{ url: post.imageURL, type: ‘image’ }];
return [];
}

// –– Кеш авторів ––
const authorCache = new Map();

async function getAuthor(authorId) {
if (authorCache.has(authorId)) return authorCache.get(authorId);
try {
const snap = await getDoc(doc(db, ‘users’, authorId));
const data = snap.exists() ? snap.data() : { name: ‘Невідомий’, photoURL: null };
authorCache.set(authorId, data);
return data;
} catch {
return { name: ‘Невідомий’, photoURL: null };
}
}

// –– RENDER HOME ––
async function renderHome() {
const feedEl = document.getElementById(‘feedContainer’);
if (!feedEl) return;
feedEl.innerHTML = ‘<div class="loading-wrap"><div class="spinner"></div><div>Завантаження…</div></div>’;

try {
const [mastersSnap, postsSnap] = await Promise.all([
getDocs(query(collection(db, ‘users’), where(‘role’, ‘in’, [‘master’, ‘admin’]))),
getDocs(query(collection(db, ‘posts’), orderBy(‘createdAt’, ‘desc’)))
]);

```
// Stats
const statMasters = document.getElementById('statMasters');
const statWorks = document.getElementById('statWorks');
const statRating = document.getElementById('statRating');

if (statMasters) statMasters.textContent = mastersSnap.size;
if (statWorks) statWorks.textContent = postsSnap.size;

let totalRatingSum = 0, totalRatingCount = 0;
postsSnap.forEach(d => {
  totalRatingSum += d.data().ratingSum || 0;
  totalRatingCount += d.data().ratingCount || 0;
});
const globalAvg = totalRatingCount > 0
  ? (totalRatingSum / totalRatingCount).toFixed(1)
  : '—';
if (statRating) statRating.textContent = globalAvg;

let allPosts = postsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

// Фільтр
if (currentFeedFilter !== 'all') {
  allPosts = allPosts.filter(post => post.authorStatus === currentFeedFilter);
}

if (allPosts.length === 0) {
  feedEl.innerHTML = `
    <div class="empty-state">
      <i class="fas fa-images" style="font-size:2.5rem;color:var(--gray-mid);margin-bottom:12px"></i>
      <h3>Немає робіт</h3>
      <p>Публікації з'являться тут</p>
    </div>`;
  return;
}

const ratedPosts = new Set(JSON.parse(localStorage.getItem('ratedPosts') || '[]'));

// Отримати кількість відгуків пакетом
const reviewsSnap = await getDocs(collection(db, 'reviews'));
const reviewCountByPost = {};
reviewsSnap.forEach(r => {
  const pid = r.data().postId;
  if (pid) reviewCountByPost[pid] = (reviewCountByPost[pid] || 0) + 1;
});

// Отримати унікальних авторів
const uniqueAuthorIds = [...new Set(allPosts.map(p => p.authorId).filter(Boolean))];
await Promise.all(uniqueAuthorIds.map(id => getAuthor(id)));

let html = '';
for (const post of allPosts) {
  const author = await getAuthor(post.authorId);
  const avg = post.ratingCount > 0
    ? (post.ratingSum / post.ratingCount).toFixed(1)
    : 0;
  const hasRated = ratedPosts.has(post.id);
  const isOwn = currentUser && currentUser.uid === post.authorId;
  const reviewCount = reviewCountByPost[post.id] || 0;
  const dateStr = post.createdAt
    ? new Date(post.createdAt.toDate()).toLocaleDateString('uk-UA', {
        day: 'numeric', month: 'long', year: 'numeric'
      })
    : '';

  const media = getPostMediaArray(post);
  let mediaHtml = '';
  if (media.length === 1) {
    const m = media[0];
    if (m.type === 'video') {
      mediaHtml = `<div class="single-media">
        <video class="post-video" controls muted loop playsinline preload="metadata" src="${esc(m.url)}"></video>
      </div>`;
    } else {
      mediaHtml = `<div class="single-media">
        <img class="post-image" src="${esc(m.url)}" alt="Робота" loading="lazy">
      </div>`;
    }
  } else if (media.length > 1) {
    mediaHtml = renderCarousel(post.id, media);
  }

  const authorPhotoHtml = author.photoURL
    ? `<img src="${esc(author.photoURL)}" loading="lazy" alt="${esc(author.name || '')}"`  +
      ` onerror="this.parentElement.innerHTML='<i class=\\'fas fa-user-circle\\'></i>'">`
    : '<i class="fas fa-user-circle" style="font-size:2rem;color:var(--gray-mid)"></i>';

  html += `
    <div class="post-card animate-on-scroll" id="post-${post.id}">
      <div class="post-header">
        <div class="post-avatar">${authorPhotoHtml}</div>
        <div class="post-header-info">
          <div class="post-author" onclick="navigate('profile','${esc(post.authorId)}')">${esc(author.name || author.email || 'Майстер')}</div>
          <div class="post-date">${dateStr}</div>
        </div>
        ${isOwn
          ? `<button class="post-menu-btn" onclick="togglePostMenu('${post.id}', event)">
              <i class="fas fa-ellipsis-v"></i>
            </button>
            <div class="post-menu" id="post-menu-${post.id}">
              <button onclick="deletePost('${post.id}')"><i class="far fa-trash-alt"></i> Видалити</button>
            </div>`
          : ''}
      </div>
      ${mediaHtml}
      ${post.caption ? `<div class="post-caption">${esc(post.caption)}</div>` : ''}
      <div class="post-rating-row" id="rating-row-${post.id}">
        <div class="stars-display">${starsHtml(avg)}</div>
        <span class="rating-avg">${avg > 0 ? avg : '—'}</span>
        <span class="rating-count">${post.ratingCount || 0} оцінок</span>
        ${hasRated
          ? `<span class="rated-badge" style="margin-left:auto"><i class="fas fa-check-circle"></i> Оцінено</span>`
          : `<span class="rate-label">Оцінити:</span>
             <div class="stars-interactive" id="rate-${post.id}">${starsHtml(0, true, post.id)}</div>`
        }
      </div>
      <div class="post-actions-row">
        <button class="btn-write-review" onclick="openWriteReview('${post.id}')">
          <i class="far fa-comment-dots"></i> Написати відгук
        </button>
        <button class="post-reviews-toggle" onclick="toggleReviews('${post.id}', this)">
          <i class="far fa-comments"></i>
          <span class="reviews-count-badge" id="rev-count-${post.id}">${reviewCount}</span>
          <i class="fas fa-chevron-down toggle-arrow" id="rev-arrow-${post.id}"></i>
        </button>
      </div>
      <div class="post-reviews-list" id="reviews-list-${post.id}"></div>
    </div>`;
}

feedEl.innerHTML = html;
initScrollAnimation();
initCarousels();
initVideoAutoplay();

// Закрити меню при кліку поза ним
document.addEventListener('click', closeAllPostMenus, { once: false });
```

} catch (e) {
console.error(‘renderHome error:’, e);
feedEl.innerHTML = ` <div class="empty-state"> <i class="fas fa-exclamation-triangle" style="font-size:2rem;color:#e74c3c;margin-bottom:12px"></i> <h3>Помилка завантаження</h3> <p>${esc(e.message)}</p> <button class="btn-primary" style="margin-top:16px" onclick="renderHome()"> <i class="fas fa-redo"></i> Спробувати знову </button> </div>`;
}
}

// –– Post Menu ––
window.togglePostMenu = (postId, event) => {
event.stopPropagation();
const menu = document.getElementById(`post-menu-${postId}`);
if (!menu) return;
const isOpen = menu.classList.contains(‘open’);
closeAllPostMenus();
if (!isOpen) menu.classList.add(‘open’);
};

function closeAllPostMenus() {
document.querySelectorAll(’.post-menu.open’).forEach(m => m.classList.remove(‘open’));
}

// –– Carousel ––
function renderCarousel(postId, media) {
const slides = media.map((m, idx) => {
if (m.type === ‘video’) {
return `<div class="carousel-slide"> <video src="${esc(m.url)}" muted loop playsinline preload="metadata" class="carousel-video"></video> <div class="video-play-overlay" onclick="toggleCarouselVideo(this)"> <i class="fas fa-play"></i> </div> </div>`;
}
return `<div class="carousel-slide"> <img src="${esc(m.url)}" alt="Фото ${idx + 1}" loading="${idx === 0 ? 'eager' : 'lazy'}"> </div>`;
}).join(’’);

const dots = media.map((_, idx) =>
`<span class="carousel-dot${idx === 0 ? ' active' : ''}" data-idx="${idx}"></span>`
).join(’’);

return ` <div class="post-media-carousel" data-post-id="${postId}"> <div class="carousel-track-wrap"> <div class="carousel-track">${slides}</div> </div> <button class="carousel-nav carousel-prev" aria-label="Попередній"> <i class="fas fa-chevron-left"></i> </button> <button class="carousel-nav carousel-next" aria-label="Наступний"> <i class="fas fa-chevron-right"></i> </button> <div class="carousel-dots">${dots}</div> <div class="carousel-counter">1 / ${media.length}</div> </div>`;
}

window.toggleCarouselVideo = (overlay) => {
const video = overlay.previousElementSibling;
if (!video) return;
if (video.paused) {
video.play();
overlay.style.opacity = ‘0’;
} else {
video.pause();
overlay.style.opacity = ‘1’;
}
};

function initCarousels() {
document.querySelectorAll(’.post-media-carousel’).forEach(carousel => {
const track = carousel.querySelector(’.carousel-track’);
const slides = track.querySelectorAll(’.carousel-slide’);
const prevBtn = carousel.querySelector(’.carousel-prev’);
const nextBtn = carousel.querySelector(’.carousel-next’);
const dots = carousel.querySelectorAll(’.carousel-dot’);
const counter = carousel.querySelector(’.carousel-counter’);
let currentIndex = 0;
let isAnimating = false;

```
function updateCarousel(index) {
  if (isAnimating) return;
  if (index < 0) index = slides.length - 1;
  if (index >= slides.length) index = 0;
  if (index === currentIndex && slides.length > 1) return;

  isAnimating = true;

  // Зупинити відео на поточному слайді
  const currentVideo = slides[currentIndex]?.querySelector('video');
  if (currentVideo) {
    currentVideo.pause();
    const overlay = slides[currentIndex].querySelector('.video-play-overlay');
    if (overlay) overlay.style.opacity = '1';
  }

  currentIndex = index;
  track.style.transform = `translateX(-${index * 100}%)`;

  dots.forEach((d, i) => d.classList.toggle('active', i === index));
  counter.textContent = `${index + 1} / ${slides.length}`;

  setTimeout(() => { isAnimating = false; }, 350);
}

prevBtn.addEventListener('click', () => updateCarousel(currentIndex - 1));
nextBtn.addEventListener('click', () => updateCarousel(currentIndex + 1));
dots.forEach(dot =>
  dot.addEventListener('click', () => updateCarousel(parseInt(dot.dataset.idx)))
);

// Свайп
let startX = 0, startY = 0, isDragging = false;
carousel.addEventListener('touchstart', e => {
  startX = e.touches[0].clientX;
  startY = e.touches[0].clientY;
  isDragging = false;
}, { passive: true });

carousel.addEventListener('touchmove', e => {
  const dx = Math.abs(e.touches[0].clientX - startX);
  const dy = Math.abs(e.touches[0].clientY - startY);
  if (dx > dy && dx > 10) isDragging = true;
}, { passive: true });

carousel.addEventListener('touchend', e => {
  if (!isDragging) return;
  const delta = e.changedTouches[0].clientX - startX;
  if (Math.abs(delta) > 50) {
    updateCarousel(delta > 0 ? currentIndex - 1 : currentIndex + 1);
  }
});

// Клавіатура
carousel.setAttribute('tabindex', '0');
carousel.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') updateCarousel(currentIndex - 1);
  if (e.key === 'ArrowRight') updateCarousel(currentIndex + 1);
});

updateCarousel(0);
```

});
}

function initScrollAnimation() {
const observer = new IntersectionObserver(entries => {
entries.forEach(entry => {
if (entry.isIntersecting) {
entry.target.classList.add(‘visible’);
observer.unobserve(entry.target);
}
});
}, { threshold: 0.08, rootMargin: ‘0px 0px -40px 0px’ });

document.querySelectorAll(’.animate-on-scroll’).forEach(el => observer.observe(el));
}

function initVideoAutoplay() {
const observer = new IntersectionObserver(entries => {
entries.forEach(entry => {
const video = entry.target;
if (entry.isIntersecting) {
video.play().catch(() => {});
} else {
video.pause();
}
});
}, { threshold: 0.6 });

// Тільки відео без overlay (не в каруселі) автоматично відтворюються
document.querySelectorAll(’.post-video’).forEach(v => observer.observe(v));
}

// –– FEED TABS ––
document.addEventListener(‘DOMContentLoaded’, () => {
document.querySelectorAll(’.feed-tab’).forEach(tab => {
tab.addEventListener(‘click’, () => {
document.querySelectorAll(’.feed-tab’).forEach(t => t.classList.remove(‘active’));
tab.classList.add(‘active’);
currentFeedFilter = tab.dataset.filter || ‘all’;
renderHome();
});
});
});

// –– Toggle Reviews ––
window.toggleReviews = async (postId, btn) => {
const listEl = document.getElementById(`reviews-list-${postId}`);
const arrowEl = document.getElementById(`rev-arrow-${postId}`);
if (!listEl) return;

if (listEl.classList.contains(‘open’)) {
listEl.classList.remove(‘open’);
if (arrowEl) {
arrowEl.classList.remove(‘fa-chevron-up’);
arrowEl.classList.add(‘fa-chevron-down’);
}
return;
}

listEl.classList.add(‘open’);
if (arrowEl) {
arrowEl.classList.remove(‘fa-chevron-down’);
arrowEl.classList.add(‘fa-chevron-up’);
}
listEl.innerHTML = ‘<div class="reviews-loading"><div class="spinner-sm"></div></div>’;

try {
const snap = await getDocs(
query(collection(db, ‘reviews’), where(‘postId’, ‘==’, postId), orderBy(‘createdAt’, ‘desc’))
);

```
if (snap.empty) {
  listEl.innerHTML = '<div class="reviews-empty">Відгуків ще немає. Будьте першим!</div>';
  return;
}

const sessionId = getSessionId();
const userId = currentUser?.uid || sessionId;
const reviewIds = snap.docs.map(d => d.id);

// Отримати лайки
let likeMap = {};
if (reviewIds.length > 0) {
  // Firebase обмежує 'in' до 30 елементів
  const chunks = [];
  for (let i = 0; i < reviewIds.length; i += 30) chunks.push(reviewIds.slice(i, i + 30));

  for (const chunk of chunks) {
    const likesSnap = await getDocs(
      query(collection(db, 'reviewLikes'), where('reviewId', 'in', chunk))
    );
    likesSnap.forEach(d => {
      const l = d.data();
      if (!likeMap[l.reviewId]) likeMap[l.reviewId] = { likes: 0, dislikes: 0, userVote: null, docId: null };
      if (l.type === 'like') likeMap[l.reviewId].likes++;
      else likeMap[l.reviewId].dislikes++;
      if (l.userId === userId) {
        likeMap[l.reviewId].userVote = l.type;
        likeMap[l.reviewId].docId = d.id;
      }
    });
  }
}

let html = '';
snap.docs.forEach(d => {
  const r = d.data();
  const dateStr = r.createdAt
    ? new Date(r.createdAt.toDate()).toLocaleDateString('uk-UA', {
        day: 'numeric', month: 'long', year: 'numeric'
      })
    : '';
  const stars = [1,2,3,4,5].map(i =>
    `<span class="star-icon${i <= (r.rating || 0) ? ' filled' : ''}"><i class="fas fa-star"></i></span>`
  ).join('');
  const likeData = likeMap[d.id] || { likes: 0, dislikes: 0, userVote: null };
  const initials = (r.authorName || 'А').slice(0, 2).toUpperCase();

  html += `
    <div class="review-item" id="review-${d.id}">
      <div class="review-avatar">${initials}</div>
      <div class="review-content">
        <div class="review-meta">
          <span class="review-author">${esc(r.authorName || 'Анонім')}</span>
          <div class="review-stars">${stars}</div>
          <span class="review-date">${dateStr}</span>
        </div>
        <div class="review-text">${esc(r.text)}</div>
        <div class="review-actions">
          <button class="like-btn ${likeData.userVote === 'like' ? 'active' : ''}"
            onclick="handleReviewLike('${d.id}', 'like', '${postId}')">
            <i class="far fa-thumbs-up"></i>
            <span id="like-count-${d.id}">${likeData.likes}</span>
          </button>
          <button class="dislike-btn ${likeData.userVote === 'dislike' ? 'active' : ''}"
            onclick="handleReviewLike('${d.id}', 'dislike', '${postId}')">
            <i class="far fa-thumbs-down"></i>
            <span id="dislike-count-${d.id}">${likeData.dislikes}</span>
          </button>
        </div>
      </div>
    </div>`;
});

listEl.innerHTML = html;
```

} catch (e) {
console.error(‘toggleReviews error:’, e);
listEl.innerHTML = `<div class="reviews-error"><i class="fas fa-exclamation-circle"></i> ${esc(e.message)}</div>`;
}
};

// –– Review Likes (виправлено баг з doc(likesRef)) ––
window.handleReviewLike = async (reviewId, type, postId) => {
const userId = currentUser?.uid || getSessionId();

const likeBtn = document.querySelector(`#review-${reviewId} .like-btn`);
const dislikeBtn = document.querySelector(`#review-${reviewId} .dislike-btn`);
const likeSpan = document.getElementById(`like-count-${reviewId}`);
const dislikeSpan = document.getElementById(`dislike-count-${reviewId}`);

if (likeBtn) likeBtn.disabled = true;
if (dislikeBtn) dislikeBtn.disabled = true;

try {
const likesRef = collection(db, ‘reviewLikes’);
const q = query(likesRef, where(‘reviewId’, ‘==’, reviewId), where(‘userId’, ‘==’, userId));
const snap = await getDocs(q);

```
const batch = writeBatch(db);
let likeDelta = 0, dislikeDelta = 0;
let newVote = type;

if (!snap.empty) {
  const existing = snap.docs[0];
  const existingType = existing.data().type;

  if (existingType === type) {
    // Зняти голос
    batch.delete(existing.ref);
    if (type === 'like') likeDelta = -1;
    else dislikeDelta = -1;
    newVote = null;
  } else {
    // Змінити голос
    batch.update(existing.ref, { type });
    if (type === 'like') { likeDelta = 1; dislikeDelta = -1; }
    else { likeDelta = -1; dislikeDelta = 1; }
  }
} else {
  // Новий голос — правильно використовуємо doc() з унікальним ID
  batch.set(doc(db, 'reviewLikes', `${reviewId}_${userId}`), {
    reviewId, userId, type, createdAt: Timestamp.now()
  });
  if (type === 'like') likeDelta = 1;
  else dislikeDelta = 1;
}

await batch.commit();

if (likeSpan) likeSpan.textContent = Math.max(0, parseInt(likeSpan.textContent || '0') + likeDelta);
if (dislikeSpan) dislikeSpan.textContent = Math.max(0, parseInt(dislikeSpan.textContent || '0') + dislikeDelta);

if (likeBtn) likeBtn.classList.toggle('active', newVote === 'like');
if (dislikeBtn) dislikeBtn.classList.toggle('active', newVote === 'dislike');
```

} catch (e) {
console.error(‘handleReviewLike error:’, e);
showToast(’Помилка: ’ + e.message, ‘error’);
} finally {
if (likeBtn) likeBtn.disabled = false;
if (dislikeBtn) dislikeBtn.disabled = false;
}
};

// –– Write Review ––
window.openWriteReview = postId => {
reviewTargetPostId = postId;
reviewStarValue = 0;
const textEl = document.getElementById(‘reviewText’);
const nameEl = document.getElementById(‘reviewAuthorName’);
if (textEl) textEl.value = ‘’;
if (nameEl) nameEl.value = currentUserDoc?.name || ‘’;
document.querySelectorAll(’#reviewStarPicker span’).forEach(s => s.classList.remove(‘sel’));
openModal(‘modalReview’);
};

document.querySelectorAll(’#reviewStarPicker span’).forEach(sp => {
sp.addEventListener(‘click’, () => {
reviewStarValue = parseInt(sp.dataset.v);
updateReviewStars(reviewStarValue);
});
sp.addEventListener(‘mouseover’, () => updateReviewStars(parseInt(sp.dataset.v), true));
sp.addEventListener(‘mouseout’, () => updateReviewStars(reviewStarValue));
});

function updateReviewStars(val, hover = false) {
document.querySelectorAll(’#reviewStarPicker span’).forEach(s => {
const sv = parseInt(s.dataset.v);
s.classList.toggle(‘sel’, sv <= val);
});
}

const submitReviewBtn = document.getElementById(‘submitReviewBtn’);
if (submitReviewBtn) {
submitReviewBtn.addEventListener(‘click’, async () => {
const text = document.getElementById(‘reviewText’)?.value.trim();
if (!text) { showToast(‘Напишіть текст відгуку’, ‘error’); return; }
if (!reviewStarValue) { showToast(‘Оберіть оцінку (зірки)’, ‘error’); return; }

```
const authorName = document.getElementById('reviewAuthorName')?.value.trim()
  || currentUserDoc?.name
  || 'Анонім';

submitReviewBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
submitReviewBtn.disabled = true;

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
  showToast('✅ Відгук надіслано!', 'success');

  const countEl = document.getElementById(`rev-count-${reviewTargetPostId}`);
  if (countEl) countEl.textContent = parseInt(countEl.textContent || '0') + 1;

  // Оновити список якщо відкритий
  const listEl = document.getElementById(`reviews-list-${reviewTargetPostId}`);
  if (listEl?.classList.contains('open')) {
    listEl.classList.remove('open');
    setTimeout(() => toggleReviews(reviewTargetPostId, null), 100);
  }
} catch (e) {
  showToast('Помилка: ' + e.message, 'error');
} finally {
  submitReviewBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Надіслати відгук';
  submitReviewBtn.disabled = false;
}
```

});
}

// –– Rating ––
window.submitRating = async (postId, value) => {
const ratedPosts = new Set(JSON.parse(localStorage.getItem(‘ratedPosts’) || ‘[]’));
if (ratedPosts.has(postId)) {
showToast(‘Ви вже оцінили цю роботу’, ‘error’);
return;
}

// Візуальний feedback
const rateEl = document.getElementById(`rate-${postId}`);
if (rateEl) {
rateEl.querySelectorAll(’.star-icon’).forEach((s, i) => {
s.classList.toggle(‘filled’, i < value);
});
}

try {
await runTransaction(db, async tx => {
const postRef = doc(db, ‘posts’, postId);
const postSnap = await tx.get(postRef);
if (!postSnap.exists()) throw new Error(‘Публікацію не знайдено’);
tx.update(postRef, {
ratingSum: increment(value),
ratingCount: increment(1)
});
});

```
ratedPosts.add(postId);
localStorage.setItem('ratedPosts', JSON.stringify([...ratedPosts]));

const rowEl = document.getElementById(`rating-row-${postId}`);
if (rowEl) rowEl.innerHTML = await refreshRatingHtml(postId);

showToast(`⭐ Оцінку ${value} збережено!`, 'success');
```

} catch (e) {
console.error(‘submitRating error:’, e);
showToast(’Помилка: ’ + e.message, ‘error’);
}
};

async function refreshRatingHtml(postId) {
const snap = await getDoc(doc(db, ‘posts’, postId));
if (!snap.exists()) return ‘’;
const d = snap.data();
const avg = d.ratingCount > 0 ? (d.ratingSum / d.ratingCount).toFixed(1) : 0;
return ` <div class="stars-display">${starsHtml(avg)}</div> <span class="rating-avg">${avg > 0 ? avg : '—'}</span> <span class="rating-count">${d.ratingCount || 0} оцінок</span> <span class="rated-badge" style="margin-left:auto"><i class="fas fa-check-circle"></i> Оцінено</span>`;
}

window.deletePost = async postId => {
if (!confirm(‘Видалити цю роботу?’)) return;
try {
await deleteDoc(doc(db, ‘posts’, postId));
const postEl = document.getElementById(`post-${postId}`);
if (postEl) {
postEl.style.opacity = ‘0’;
postEl.style.transform = ‘scale(0.95)’;
postEl.style.transition = ‘all 0.3s ease’;
setTimeout(() => postEl.remove(), 300);
}
showToast(‘Роботу видалено’, ‘success’);
const worksSpan = document.getElementById(‘statWorks’);
if (worksSpan) worksSpan.textContent = Math.max(0, parseInt(worksSpan.textContent || ‘0’) - 1);
} catch (e) {
showToast(e.message, ‘error’);
}
};

// –– MASTERS LIST ––
async function renderMasters() {
const container = document.getElementById(‘mastersList’);
if (!container) return;
container.innerHTML = ‘<div class="loading-wrap"><div class="spinner"></div><div>Завантаження…</div></div>’;

try {
const snap = await getDocs(
query(collection(db, ‘users’), where(‘role’, ‘in’, [‘master’, ‘admin’]))
);

```
if (snap.empty) {
  container.innerHTML = `
    <div class="empty-state">
      <i class="fas fa-user-tie" style="font-size:2.5rem;color:var(--gray-mid);margin-bottom:12px"></i>
      <h3>Майстрів поки немає</h3>
      <p>Зареєструйтесь як майстер</p>
    </div>`;
  return;
}

// Отримати пости всіх майстрів паралельно
const masterIds = snap.docs.map(d => d.id);
const postsPerMaster = await Promise.all(
  masterIds.map(id =>
    getDocs(query(collection(db, 'posts'), where('authorId', '==', id)))
  )
);

let html = '';
snap.docs.forEach((docSnap, idx) => {
  const u = docSnap.data();
  const postsSnap = postsPerMaster[idx];
  let rSum = 0, rCount = 0;
  postsSnap.forEach(p => {
    rSum += p.data().ratingSum || 0;
    rCount += p.data().ratingCount || 0;
  });
  const avg = rCount > 0 ? (rSum / rCount).toFixed(1) : 0;
  const statusLabel = u.status === 'student' ? 'Учень' : 'Майстер';

  html += `
    <div class="master-card animate-on-scroll" onclick="navigate('profile','${docSnap.id}')">
      <div class="master-card-photo">
        ${u.photoURL
          ? `<img src="${esc(u.photoURL)}" loading="lazy" alt="${esc(u.name || '')}">`
          : `<div class="master-photo-placeholder"><i class="fas fa-user-tie"></i></div>`}
      </div>
      <div class="master-card-info">
        <div class="master-card-name">${esc(u.name || u.email || 'Майстер')}</div>
        <div class="master-card-role">
          <i class="fas fa-${u.role === 'admin' ? 'crown' : 'cut'}"></i>
          ${statusLabel}
        </div>
        <div class="master-card-stats">
          <span><i class="far fa-image"></i> ${postsSnap.size} робіт</span>
          ${u.phone ? `<span><i class="fas fa-phone-alt"></i> ${esc(u.phone)}</span>` : ''}
        </div>
        <div class="master-card-rating-row">
          <div class="stars-display">${starsHtml(avg)}</div>
          <span class="rating-avg">${avg > 0 ? avg : '—'}</span>
          <span class="rating-count">${rCount} оцінок</span>
        </div>
      </div>
      <div class="master-card-arrow"><i class="fas fa-chevron-right"></i></div>
    </div>`;
});

container.innerHTML = html;
initScrollAnimation();
```

} catch (e) {
container.innerHTML = ` <div class="empty-state"> <h3>Помилка</h3> <p>${esc(e.message)}</p> </div>`;
}
}

// –– PROFILE ––
async function renderProfile(userId) {
const container = document.getElementById(‘profileContainer’);
if (!container) return;

if (!userId) {
container.innerHTML = ` <div class="profile-empty-auth"> <i class="fas fa-user-lock"></i> <p>Увійдіть, щоб переглянути профіль</p> <button class="btn-primary" onclick="openAuthModal()"> <i class="fas fa-sign-in-alt"></i> Увійти </button> </div>`;
return;
}

container.innerHTML = ‘<div class="loading-wrap" style="padding:160px"><div class="spinner"></div></div>’;

try {
const userSnap = await getDoc(doc(db, ‘users’, userId));
if (!userSnap.exists()) {
container.innerHTML = ‘<div class="profile-not-found"><i class="fas fa-user-slash"></i><p>Користувача не знайдено</p></div>’;
return;
}

```
const user = userSnap.data();
const postsSnap = await getDocs(
  query(collection(db, 'posts'), where('authorId', '==', userId), orderBy('createdAt', 'desc'))
);
const posts = postsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

let rSum = 0, rCount = 0;
posts.forEach(p => { rSum += p.ratingSum || 0; rCount += p.ratingCount || 0; });
const avg = rCount > 0 ? (rSum / rCount).toFixed(1) : 0;
const avgNum = parseFloat(avg) || 0;

const isOwn = currentUser && currentUser.uid === userId;
const isMaster = ['master', 'admin'].includes(user.role);
const statusLabel = user.status === 'student' ? 'Учень' : 'Майстер';

// Відгуки
const postIds = posts.map(p => p.id);
let allReviews = [];
if (postIds.length > 0) {
  const reviewsSnap = await getDocs(
    query(collection(db, 'reviews'), orderBy('createdAt', 'desc'))
  );
  reviewsSnap.forEach(d => {
    const r = { id: d.id, ...d.data() };
    if (postIds.includes(r.postId)) allReviews.push(r);
  });
}

// Соцмережі
const socialLinks = user.socialLinks || {};
const socialPlatforms = {
  instagram: { icon: 'fab fa-instagram', label: 'Instagram' },
  tiktok: { icon: 'fab fa-tiktok', label: 'TikTok' },
  facebook: { icon: 'fab fa-facebook-f', label: 'Facebook' },
  telegram: { icon: 'fab fa-telegram', label: 'Telegram' },
  youtube: { icon: 'fab fa-youtube', label: 'YouTube' },
  other: { icon: 'fas fa-link', label: 'Посилання' }
};
const socialIcons = Object.entries(socialLinks)
  .filter(([, url]) => url?.trim())
  .map(([p, url]) => {
    const meta = socialPlatforms[p] || socialPlatforms.other;
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer"
      class="social-link social-link-${p}" title="${meta.label}">
      <i class="${meta.icon}"></i>
    </a>`;
  })
  .join('');

// Зірки
const sidebarStars = [1,2,3,4,5].map(i => {
  if (i <= Math.floor(avgNum)) return `<i class="fas fa-star star-icon filled"></i>`;
  if (avgNum > 0 && i - avgNum < 1) return `<i class="fas fa-star-half-stroke star-icon filled"></i>`;
  return `<i class="fas fa-star star-icon"></i>`;
}).join('');

// Аватар
const avatarHtml = user.photoURL
  ? `<img src="${esc(user.photoURL)}" alt="${esc(user.name || '')}"
       onerror="this.parentElement.innerHTML='<i class=\\'fas fa-user-circle\\'></i>'">`
  : '<i class="fas fa-user-circle"></i>';

// Пости grid
const postsGridHtml = posts.length
  ? `<div class="profile-posts-grid">${posts.map(p => {
      const media = getPostMediaArray(p);
      const thumb = media[0];
      const pAvg = p.ratingCount > 0 ? (p.ratingSum / p.ratingCount).toFixed(1) : '—';
      const hasMultiple = media.length > 1;
      return `<div class="profile-post-item" onclick="navigate('home', null, '${p.id}')">
        ${thumb
          ? thumb.type === 'video'
            ? `<video src="${esc(thumb.url)}" muted preload="metadata"></video>`
            : `<img src="${esc(thumb.url)}" loading="lazy" alt="Робота">`
          : '<div class="post-thumb-empty"><i class="fas fa-image"></i></div>'}
        ${hasMultiple ? '<div class="multi-badge"><i class="fas fa-clone"></i></div>' : ''}
        <div class="profile-post-overlay">
          <span><i class="fas fa-star"></i> ${pAvg}</span>
        </div>
      </div>`;
    }).join('')}</div>`
  : '<p class="profile-empty-tab">Ще немає опублікованих робіт</p>';

// Відгуки tab
const reviewsHtml = allReviews.length === 0
  ? '<p class="profile-empty-tab">Відгуків ще немає</p>'
  : `<div class="profile-reviews-list">${allReviews.map(r => {
      const dateStr = r.createdAt
        ? new Date(r.createdAt.toDate()).toLocaleDateString('uk-UA', {
            day: 'numeric', month: 'long', year: 'numeric'
          })
        : '';
      const stars = [1,2,3,4,5].map(i =>
        `<i class="fas fa-star star-icon${i <= (r.rating || 0) ? ' filled' : ''}"></i>`
      ).join('');
      const initials = (r.authorName || 'А').slice(0, 2).toUpperCase();
      return `<div class="profile-review-card">
        <div class="review-avatar">${initials}</div>
        <div class="review-content">
          <div class="review-meta">
            <span class="review-author">${esc(r.authorName || 'Анонім')}</span>
            <span class="review-date">${dateStr}</span>
          </div>
          <div class="review-stars">${stars}</div>
          <p class="review-text">${esc(r.text)}</p>
        </div>
      </div>`;
    }).join('')}</div>`;

// Рейтинг tab
const sortedPosts = [...posts].sort((a, b) => {
  const aA = a.ratingCount ? a.ratingSum / a.ratingCount : 0;
  const bA = b.ratingCount ? b.ratingSum / b.ratingCount : 0;
  return bA - aA;
});

const ratingsHtml = sortedPosts.length === 0
  ? '<p class="profile-empty-tab">Ще немає публікацій</p>'
  : `<div class="haircut-ratings-list">${sortedPosts.map((p, idx) => {
      const pAvg = p.ratingCount > 0 ? (p.ratingSum / p.ratingCount).toFixed(1) : null;
      const stars = [1,2,3,4,5].map(i =>
        `<i class="fas fa-star star-icon${pAvg && i <= Math.round(pAvg) ? ' filled' : ''}"></i>`
      ).join('');
      const media = getPostMediaArray(p);
      const thumb = media[0];
      const thumbHtml = thumb
        ? thumb.type === 'video'
          ? `<video class="haircut-thumb" src="${esc(thumb.url)}" muted preload="metadata"></video>`
          : `<img class="haircut-thumb" src="${esc(thumb.url)}" loading="lazy">`
        : `<div class="haircut-thumb haircut-thumb-empty"><i class="fas fa-image"></i></div>`;

      return `<div class="haircut-rating-item" onclick="navigate('home', null, '${p.id}')">
        <div class="haircut-rank">#${idx + 1}</div>
        ${thumbHtml}
        <div class="haircut-info">
          <div class="haircut-caption">${esc(p.caption || 'Без опису')}</div>
          <div class="haircut-stats">
            <span class="haircut-avg">${pAvg || '—'}</span>
            <div class="haircut-mini-stars">${stars}</div>
            <span class="haircut-count">${p.ratingCount || 0} оцінок</span>
          </div>
        </div>
      </div>`;
    }).join('')}</div>`;

container.innerHTML = `
  <div class="profile-layout">
    <aside class="profile-sidebar">
      <div class="profile-avatar-wrap">
        <div class="profile-avatar">${avatarHtml}</div>
        ${isOwn ? `
          <button class="avatar-edit-btn" onclick="document.getElementById('profilePhotoInputTrigger').click()">
            <i class="fas fa-camera"></i>
          </button>
          <input type="file" id="profilePhotoInputTrigger" accept="image/*" style="display:none"
            onchange="quickUpdatePhoto(this)">
        ` : ''}
      </div>
      <div class="profile-name-wrap">
        <h2 class="profile-name">${esc(user.name || user.email?.split('@')[0] || 'Користувач')}</h2>
        <div class="profile-badges">
          <span class="badge badge-gold">
            <i class="fas fa-${user.role === 'admin' ? 'crown' : 'scissors'}"></i>
            ${statusLabel}
          </span>
        </div>
        <div class="profile-rating-mini">
          ${sidebarStars}
          <span class="avg-label">${avgNum > 0 ? avg : '—'}</span>
          <span class="review-count-label">· ${allReviews.length} відгуків</span>
        </div>
      </div>

      <div class="profile-stats-row">
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

      ${user.bio ? `<p class="profile-bio">${esc(user.bio)}</p>` : ''}

      ${isMaster && user.phone
        ? `<a class="profile-phone" href="tel:${esc(user.phone)}">
            <i class="fas fa-phone-alt"></i> ${esc(user.phone)}
           </a>`
        : ''}

      ${socialIcons ? `<div class="profile-social">${socialIcons}</div>` : ''}

      ${isOwn ? `
        <div class="profile-actions">
          <button class="btn-edit-profile" onclick="openEditProfileModal()">
            <i class="far fa-pen-to-square"></i> Редагувати профіль
          </button>
          ${isMaster ? `
            <button class="btn-primary" onclick="openCreatePost()">
              <i class="fas fa-plus-circle"></i> Нова робота
            </button>` : ''}
          <button class="btn-logout" onclick="doLogout()">
            <i class="fas fa-sign-out-alt"></i> Вийти
          </button>
        </div>
      ` : ''}
    </aside>

    <main class="profile-main">
      <div class="profile-tabs" id="profileTabs">
        <button class="profile-tab active" data-ptab="posts">
          <i class="fas fa-th"></i> Пости
        </button>
        <button class="profile-tab" data-ptab="reviews">
          <i class="far fa-star"></i> Відгуки
        </button>
        <button class="profile-tab" data-ptab="ratings">
          <i class="fas fa-chart-bar"></i> Рейтинг
        </button>
      </div>
      <div class="profile-tab-pane active" id="ptab-posts">${postsGridHtml}</div>
      <div class="profile-tab-pane" id="ptab-reviews">${reviewsHtml}</div>
      <div class="profile-tab-pane" id="ptab-ratings">${ratingsHtml}</div>
    </main>
  </div>`;

// Таби
container.querySelectorAll('.profile-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    container.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
    container.querySelectorAll('.profile-tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    container.querySelector(`#ptab-${btn.dataset.ptab}`)?.classList.add('active');
  });
});
```

} catch (e) {
console.error(‘renderProfile error:’, e);
container.innerHTML = `<div class="profile-error"><p>${esc(e.message)}</p></div>`;
}
}

// –– Quick Photo Update ––
window.quickUpdatePhoto = async (input) => {
const file = input.files[0];
if (!file || !currentUser) return;
try {
showToast(‘Завантаження фото…’, ‘’);
const result = await uploadToCloudinary(file, `avatars/${currentUser.uid}`);
await updateDoc(doc(db, ‘users’, currentUser.uid), { photoURL: result.url });
currentUserDoc = { …currentUserDoc, photoURL: result.url };
authorCache.delete(currentUser.uid);
showToast(‘Фото оновлено!’, ‘success’);
renderProfile(currentUser.uid);
} catch (e) {
showToast(’Помилка: ’ + e.message, ‘error’);
}
};

// –– EDIT PROFILE MODAL ––
window.openEditProfileModal = () => {
pendingProfilePhotoFile = null;

const fields = {
editProfileName: currentUserDoc?.name || ‘’,
editProfileBio: currentUserDoc?.bio || ‘’,
editProfilePhone: currentUserDoc?.phone || ‘’,
editInstagram: currentUserDoc?.socialLinks?.instagram || ‘’,
editTiktok: currentUserDoc?.socialLinks?.tiktok || ‘’,
editFacebook: currentUserDoc?.socialLinks?.facebook || ‘’,
editTelegram: currentUserDoc?.socialLinks?.telegram || ‘’,
editYoutube: currentUserDoc?.socialLinks?.youtube || ‘’,
editOtherLink: currentUserDoc?.socialLinks?.other || ‘’,
editProfileStatus: currentUserDoc?.status || ‘master’,
};

Object.entries(fields).forEach(([id, val]) => {
const el = document.getElementById(id);
if (el) el.value = val;
});

const isMaster = [‘master’, ‘admin’].includes(currentUserDoc?.role);
const phoneGroup = document.getElementById(‘editPhoneGroup’);
const statusGroup = document.getElementById(‘editStatusGroup’);
if (phoneGroup) phoneGroup.style.display = isMaster ? ‘block’ : ‘none’;
if (statusGroup) statusGroup.style.display = isMaster ? ‘block’ : ‘none’;

const area = document.getElementById(‘editProfilePhotoArea’);
if (area) {
if (currentUserDoc?.photoURL) {
area.style.backgroundImage = `url(${currentUserDoc.photoURL})`;
area.style.backgroundSize = ‘cover’;
area.style.backgroundPosition = ‘center’;
} else {
area.style.backgroundImage = ‘’;
}
}

openModal(‘modalEditProfile’);
};

const editProfilePhotoInput = document.getElementById(‘editProfilePhotoInput’);
if (editProfilePhotoInput) {
editProfilePhotoInput.addEventListener(‘change’, e => {
pendingProfilePhotoFile = e.target.files[0];
if (pendingProfilePhotoFile) {
const url = URL.createObjectURL(pendingProfilePhotoFile);
const area = document.getElementById(‘editProfilePhotoArea’);
if (area) {
area.style.backgroundImage = `url(${url})`;
area.style.backgroundSize = ‘cover’;
area.style.backgroundPosition = ‘center’;
}
}
});
}

const saveProfileBtn = document.getElementById(‘saveProfileBtn’);
if (saveProfileBtn) {
saveProfileBtn.addEventListener(‘click’, async () => {
if (!currentUser) return;

```
const name = document.getElementById('editProfileName')?.value.trim();
const bio = document.getElementById('editProfileBio')?.value.trim();
const isMaster = ['master', 'admin'].includes(currentUserDoc?.role);
const phone = isMaster ? document.getElementById('editProfilePhone')?.value.trim() : undefined;
const status = isMaster ? document.getElementById('editProfileStatus')?.value : undefined;

const socialLinks = {};
const socials = ['instagram', 'tiktok', 'facebook', 'telegram', 'youtube', 'other'];
const ids = ['editInstagram', 'editTiktok', 'editFacebook', 'editTelegram', 'editYoutube', 'editOtherLink'];
socials.forEach((key, i) => {
  const val = document.getElementById(ids[i])?.value.trim();
  if (val) socialLinks[key] = val;
});

saveProfileBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
saveProfileBtn.disabled = true;

try {
  const updates = { name, bio, socialLinks };
  if (isMaster && phone !== undefined) updates.phone = phone;
  if (isMaster && status) updates.status = status;

  if (pendingProfilePhotoFile) {
    const result = await uploadToCloudinary(pendingProfilePhotoFile, `avatars/${currentUser.uid}`);
    updates.photoURL = result.url;
  }

  await updateDoc(doc(db, 'users', currentUser.uid), updates);
  currentUserDoc = { ...currentUserDoc, ...updates };
  authorCache.delete(currentUser.uid);

  closeModal('modalEditProfile');
  showToast('✅ Профіль оновлено', 'success');
  renderProfile(currentUser.uid);
} catch (e) {
  showToast('Помилка: ' + e.message, 'error');
} finally {
  saveProfileBtn.innerHTML = '<i class="fas fa-save"></i> Зберегти';
  saveProfileBtn.disabled = false;
}
```

});
}

// –– CREATE POST ––
window.openCreatePost = () => {
if (!currentUser) { openAuthModal(); return; }
if (![‘master’, ‘admin’].includes(currentUserDoc?.role)) {
showToast(‘Тільки майстри можуть публікувати роботи’, ‘error’);
return;
}

pendingPostFiles = [];
postMediaType = null;

const captionEl = document.getElementById(‘postCaption’);
const previewGrid = document.getElementById(‘mediaPreviewGrid’);
const hint = document.getElementById(‘mediaHint’);
const addPhotos = document.getElementById(‘addPhotosBtn’);
const addVideos = document.getElementById(‘addVideosBtn’);

if (captionEl) captionEl.value = ‘’;
if (previewGrid) previewGrid.innerHTML = ‘’;
if (hint) hint.textContent = ‘Підтримуються лише фото або лише відео в одному пості’;
if (addPhotos) addPhotos.disabled = false;
if (addVideos) addVideos.disabled = false;

openModal(‘modalPost’);
};

function updateMediaPreview() {
const grid = document.getElementById(‘mediaPreviewGrid’);
if (!grid) return;

grid.innerHTML = ‘’;
pendingPostFiles.forEach((file, idx) => {
const url = URL.createObjectURL(file);
const isVideo = file.type.startsWith(‘video/’);
const div = document.createElement(‘div’);
div.className = ‘media-preview-item’;
div.innerHTML = isVideo
? `<video src="${url}" muted preload="metadata"></video> <button class="remove-btn" data-idx="${idx}"><i class="fas fa-times"></i></button> <div class="media-type-badge"><i class="fas fa-video"></i></div>`
: `<img src="${url}" alt="Preview"> <button class="remove-btn" data-idx="${idx}"><i class="fas fa-times"></i></button>`;
grid.appendChild(div);
});

grid.querySelectorAll(’.remove-btn’).forEach(btn => {
btn.addEventListener(‘click’, () => {
const idx = parseInt(btn.dataset.idx);
pendingPostFiles.splice(idx, 1);
if (pendingPostFiles.length === 0) {
postMediaType = null;
const addPhotos = document.getElementById(‘addPhotosBtn’);
const addVideos = document.getElementById(‘addVideosBtn’);
if (addPhotos) addPhotos.disabled = false;
if (addVideos) addVideos.disabled = false;
}
updateMediaPreview();
});
});

// Оновити стан кнопок
const addPhotos = document.getElementById(‘addPhotosBtn’);
const addVideos = document.getElementById(‘addVideosBtn’);
if (addPhotos) addPhotos.disabled = postMediaType === ‘video’;
if (addVideos) addVideos.disabled = postMediaType === ‘image’;
}

const addPhotosBtn = document.getElementById(‘addPhotosBtn’);
const addVideosBtn = document.getElementById(‘addVideosBtn’);
const mediaInput = document.getElementById(‘mediaInput’);

if (addPhotosBtn) {
addPhotosBtn.addEventListener(‘click’, () => {
if (postMediaType === ‘video’) return;
if (mediaInput) { mediaInput.accept = ‘image/*’; mediaInput.multiple = true; mediaInput.click(); }
});
}

if (addVideosBtn) {
addVideosBtn.addEventListener(‘click’, () => {
if (postMediaType === ‘image’) return;
if (mediaInput) { mediaInput.accept = ‘video/*’; mediaInput.multiple = false; mediaInput.click(); }
});
}

if (mediaInput) {
mediaInput.addEventListener(‘change’, e => {
const files = Array.from(e.target.files);
if (!files.length) return;

```
const isImage = !files[0].type.startsWith('video/');
const type = isImage ? 'image' : 'video';
const maxFiles = isImage ? 10 : 3;

if (postMediaType && postMediaType !== type) {
  showToast('Не можна додавати фото та відео одночасно', 'error');
  e.target.value = '';
  return;
}

const mixed = files.some(f => f.type.startsWith('video/') !== !isImage);
if (mixed) {
  showToast('Виберіть лише фото або лише відео', 'error');
  e.target.value = '';
  return;
}

const totalAfter = pendingPostFiles.length + files.length;
if (totalAfter > maxFiles) {
  showToast(`Максимум ${maxFiles} файлів`, 'error');
  e.target.value = '';
  return;
}

// Перевірка розміру файлів (100MB для відео, 10MB для фото)
const maxSize = isImage ? 10 * 1024 * 1024 : 100 * 1024 * 1024;
const tooBig = files.filter(f => f.size > maxSize);
if (tooBig.length > 0) {
  showToast(`Файл ${tooBig[0].name} занадто великий`, 'error');
  e.target.value = '';
  return;
}

postMediaType = type;
pendingPostFiles.push(...files);
updateMediaPreview();
e.target.value = '';
```

});
}

const submitPostBtn = document.getElementById(‘submitPostBtn’);
if (submitPostBtn) {
submitPostBtn.addEventListener(‘click’, async () => {
if (pendingPostFiles.length === 0) {
showToast(‘Додайте хоча б одне фото або відео’, ‘error’);
return;
}

```
submitPostBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Завантаження...';
submitPostBtn.disabled = true;

// Прогрес
const progressWrap = document.getElementById('uploadProgressWrap');
const progressBar = document.getElementById('uploadProgressBar');
const progressText = document.getElementById('uploadProgressText');
if (progressWrap) progressWrap.style.display = 'block';

try {
  const caption = document.getElementById('postCaption')?.value.trim() || '';
  const media = [];
  let uploaded = 0;

  for (const file of pendingPostFiles) {
    const result = await uploadToCloudinary(
      file,
      `posts/${currentUser.uid}`,
      pct => {
        const overall = Math.round((uploaded / pendingPostFiles.length + pct / 100 / pendingPostFiles.length) * 100);
        if (progressBar) progressBar.style.width = overall + '%';
        if (progressText) progressText.textContent = `${overall}%`;
      }
    );
    media.push({ url: result.url, type: result.type });
    uploaded++;
  }

  if (progressBar) progressBar.style.width = '100%';

  await addDoc(collection(db, 'posts'), {
    authorId: currentUser.uid,
    authorStatus: currentUserDoc?.status || 'master',
    media,
    caption,
    ratingSum: 0,
    ratingCount: 0,
    createdAt: Timestamp.now()
  });

  closeModal('modalPost');
  showToast('✅ Роботу опубліковано!', 'success');
  navigate('home');
} catch (e) {
  showToast('Помилка: ' + e.message, 'error');
} finally {
  submitPostBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Опублікувати';
  submitPostBtn.disabled = false;
  if (progressWrap) progressWrap.style.display = 'none';
  pendingPostFiles = [];
  postMediaType = null;
}
```

});
}

// –– AUTH ––
async function handleGoogleSignIn() {
const btn = document.getElementById(‘googleSignInBtn’);
if (btn) { btn.disabled = true; btn.innerHTML = ‘<i class="fas fa-spinner fa-spin"></i> Вхід…’; }

try {
const result = await signInWithPopup(auth, googleProvider);
const user = result.user;
const userDoc = await getDoc(doc(db, ‘users’, user.uid));

```
if (!userDoc.exists()) {
  await setDoc(doc(db, 'users', user.uid), {
    email: user.email,
    name: user.displayName || user.email?.split('@')[0] || 'Майстер',
    photoURL: user.photoURL || null,
    role: 'master',
    status: 'master',
    createdAt: Timestamp.now()
  });
} else if (!userDoc.data().role || userDoc.data().role === 'user') {
  await updateDoc(doc(db, 'users', user.uid), { role: 'master' });
}

closeModal('modalAuth');
showToast('Ласкаво просимо!', 'success');
```

} catch (e) {
let msg = e.message;
if (msg.includes(‘auth/unauthorized-domain’)) {
msg = ‘Домен не додано в Firebase Console. Зверніться до адміністратора.’;
} else if (msg.includes(‘auth/popup-closed-by-user’)) {
msg = ‘Вікно входу закрито’;
}
showToast(’Помилка: ’ + msg, ‘error’);
} finally {
if (btn) {
btn.disabled = false;
btn.innerHTML = ‘<i class="fab fa-google"></i> Увійти через Google’;
}
}
}

async function handleMasterRegister() {
const name = document.getElementById(‘masterRegName’)?.value.trim();
const email = document.getElementById(‘masterRegEmail’)?.value.trim();
const password = document.getElementById(‘masterRegPassword’)?.value;
const confirm = document.getElementById(‘masterRegPasswordConfirm’)?.value;
const errDiv = document.getElementById(‘masterRegError’);

if (errDiv) errDiv.style.display = ‘none’;

if (!name || !email || !password) {
if (errDiv) { errDiv.textContent = ‘Заповніть усі поля’; errDiv.style.display = ‘block’; }
return;
}
if (password !== confirm) {
if (errDiv) { errDiv.textContent = ‘Паролі не співпадають’; errDiv.style.display = ‘block’; }
return;
}
if (password.length < 6) {
if (errDiv) { errDiv.textContent = ‘Пароль має бути не менше 6 символів’; errDiv.style.display = ‘block’; }
return;
}

const btn = document.getElementById(‘masterRegisterBtn’);
if (btn) { btn.disabled = true; btn.innerHTML = ‘<i class="fas fa-spinner fa-spin"></i>’; }

try {
const cred = await createUserWithEmailAndPassword(auth, email, password);
await setDoc(doc(db, ‘users’, cred.user.uid), {
email, name,
role: ‘master’,
status: ‘master’,
createdAt: Timestamp.now()
});
closeModal(‘modalAuth’);
showToast(‘✅ Реєстрація успішна! Ви увійшли як майстер.’, ‘success’);
} catch (e) {
let msg = e.message;
if (msg.includes(‘auth/email-already-in-use’)) msg = ‘Цей email вже використовується’;
if (msg.includes(‘auth/invalid-email’)) msg = ‘Невірний формат email’;
if (errDiv) { errDiv.textContent = msg; errDiv.style.display = ‘block’; }
} finally {
if (btn) { btn.disabled = false; btn.innerHTML = ‘Зареєструватися’; }
}
}

async function handleMasterSignIn() {
const email = document.getElementById(‘masterAuthEmail’)?.value.trim();
const password = document.getElementById(‘masterAuthPassword’)?.value;
const errEl = document.getElementById(‘masterAuthError’);

if (errEl) errEl.style.display = ‘none’;
if (!email || !password) {
if (errEl) { errEl.textContent = ‘Заповніть усі поля’; errEl.style.display = ‘block’; }
return;
}

const btn = document.getElementById(‘masterSignInBtn’);
if (btn) { btn.disabled = true; btn.innerHTML = ‘<i class="fas fa-spinner fa-spin"></i>’; }

try {
await signInWithEmailAndPassword(auth, email, password);
closeModal(‘modalAuth’);
showToast(‘✅ Вітаємо!’, ‘success’);
} catch (e) {
if (errEl) { errEl.textContent = ‘Невірний email або пароль’; errEl.style.display = ‘block’; }
} finally {
if (btn) { btn.disabled = false; btn.innerHTML = ‘Увійти’; }
}
}

function initAuthTabs() {
const tabs = document.querySelectorAll(’.auth-tab’);
const clientPanel = document.getElementById(‘authClientPanel’);
const masterPanel = document.getElementById(‘authMasterPanel’);

tabs.forEach(tab => {
tab.addEventListener(‘click’, () => {
tabs.forEach(t => t.classList.remove(‘active’));
tab.classList.add(‘active’);
if (tab.dataset.tab === ‘client’) {
if (clientPanel) clientPanel.style.display = ‘block’;
if (masterPanel) masterPanel.style.display = ‘none’;
} else {
if (clientPanel) clientPanel.style.display = ‘none’;
if (masterPanel) masterPanel.style.display = ‘block’;
}
});
});

const showRegBtn = document.getElementById(‘showMasterRegisterBtn’);
const showLoginBtn = document.getElementById(‘showMasterLoginBtn’);
const loginForm = document.getElementById(‘masterLoginForm’);
const registerForm = document.getElementById(‘masterRegisterForm’);

if (showRegBtn) showRegBtn.addEventListener(‘click’, e => {
e.preventDefault();
if (loginForm) loginForm.style.display = ‘none’;
if (registerForm) registerForm.style.display = ‘block’;
});

if (showLoginBtn) showLoginBtn.addEventListener(‘click’, e => {
e.preventDefault();
if (registerForm) registerForm.style.display = ‘none’;
if (loginForm) loginForm.style.display = ‘block’;
});
}

window.openAuthModal = () => {
const clientTab = document.querySelector(’.auth-tab[data-tab=“client”]’);
if (clientTab) clientTab.click();

[‘masterAuthEmail’, ‘masterAuthPassword’, ‘masterRegName’, ‘masterRegEmail’,
‘masterRegPassword’, ‘masterRegPasswordConfirm’].forEach(id => {
const el = document.getElementById(id);
if (el) el.value = ‘’;
});

[‘masterAuthError’, ‘masterRegError’].forEach(id => {
const el = document.getElementById(id);
if (el) el.style.display = ‘none’;
});

const loginForm = document.getElementById(‘masterLoginForm’);
const registerForm = document.getElementById(‘masterRegisterForm’);
if (loginForm) loginForm.style.display = ‘block’;
if (registerForm) registerForm.style.display = ‘none’;

openModal(‘modalAuth’);
};

const googleSignInBtn = document.getElementById(‘googleSignInBtn’);
const masterSignInBtn = document.getElementById(‘masterSignInBtn’);
const masterRegisterBtn = document.getElementById(‘masterRegisterBtn’);

if (googleSignInBtn) googleSignInBtn.addEventListener(‘click’, handleGoogleSignIn);
if (masterSignInBtn) masterSignInBtn.addEventListener(‘click’, handleMasterSignIn);
if (masterRegisterBtn) masterRegisterBtn.addEventListener(‘click’, handleMasterRegister);

// Enter для форм авторизації
document.getElementById(‘masterAuthPassword’)?.addEventListener(‘keydown’, e => {
if (e.key === ‘Enter’) handleMasterSignIn();
});
document.getElementById(‘masterRegPasswordConfirm’)?.addEventListener(‘keydown’, e => {
if (e.key === ‘Enter’) handleMasterRegister();
});

window.doLogout = async () => {
try {
await signOut(auth);
authorCache.clear();
showToast(‘Ви вийшли’, ‘’);
navigate(‘home’);
} catch (e) {
showToast(‘Помилка виходу’, ‘error’);
}
};

// –– AUTH STATE ––
onAuthStateChanged(auth, async user => {
currentUser = user;
authorCache.clear(); // Скинути кеш при зміні авторизації

if (user) {
try {
const snap = await getDoc(doc(db, ‘users’, user.uid));
currentUserDoc = snap.exists() ? snap.data() : null;
} catch {
currentUserDoc = null;
}

```
const isMaster = ['master', 'admin'].includes(currentUserDoc?.role);
const displayName = currentUserDoc?.name || user.displayName || 'Профіль';

updateNavForUser(displayName, isMaster);
```

} else {
currentUserDoc = null;
updateNavForGuest();
}

// Перерендерити активну сторінку
const activePage = document.querySelector(’.page.active’);
if (!activePage) return;

const pageId = activePage.id.replace(‘page-’, ‘’);
if (pageId === ‘home’) renderHome();
else if (pageId === ‘profile’) renderProfile(user?.uid);
else if (pageId === ‘masters’) renderMasters();
});

function updateNavForUser(name, isMaster) {
const authBtn = document.getElementById(‘authBtn’);
const mobileAuthBtn = document.getElementById(‘mobileAuthBtn’);
const fab = document.getElementById(‘createPostFab’);

if (authBtn) {
authBtn.innerHTML = `<i class="fas fa-user-circle"></i> ${esc(name)}`;
authBtn.onclick = () => navigate(‘profile’);
}
if (mobileAuthBtn) {
mobileAuthBtn.innerHTML = ‘<i class="fas fa-user-circle"></i> Профіль’;
mobileAuthBtn.onclick = () => navigate(‘profile’);
}
if (fab) fab.classList.toggle(‘visible’, isMaster);
}

function updateNavForGuest() {
const authBtn = document.getElementById(‘authBtn’);
const mobileAuthBtn = document.getElementById(‘mobileAuthBtn’);
const fab = document.getElementById(‘createPostFab’);

if (authBtn) {
authBtn.innerHTML = ‘<i class="fas fa-sign-in-alt"></i> Увійти’;
authBtn.onclick = () => openAuthModal();
}
if (mobileAuthBtn) {
mobileAuthBtn.innerHTML = ‘<i class="fas fa-sign-in-alt"></i> Увійти’;
mobileAuthBtn.onclick = () => openAuthModal();
}
if (fab) fab.classList.remove(‘visible’);
}

// –– MOBILE MENU ––
window.closeMobileMenu = () => {
document.getElementById(‘mobileMenu’)?.classList.remove(‘open’);
document.getElementById(‘menuOverlay’)?.classList.remove(‘open’);
document.getElementById(‘hamburgerBtn’)?.classList.remove(‘open’);
document.body.style.overflow = ‘’;
};

const hamburgerBtn = document.getElementById(‘hamburgerBtn’);
if (hamburgerBtn) {
hamburgerBtn.addEventListener(‘click’, () => {
const menu = document.getElementById(‘mobileMenu’);
const overlay = document.getElementById(‘menuOverlay’);
const isOpen = menu?.classList.contains(‘open’);

```
if (isOpen) {
  closeMobileMenu();
} else {
  menu?.classList.add('open');
  overlay?.classList.add('open');
  hamburgerBtn.classList.add('open');
  document.body.style.overflow = 'hidden';
}
```

});
}

document.getElementById(‘menuOverlay’)?.addEventListener(‘click’, closeMobileMenu);

// –– SCROLL ––
let scrollTicking = false;
window.addEventListener(‘scroll’, () => {
if (!scrollTicking) {
requestAnimationFrame(() => {
const navbar = document.getElementById(‘navbar’);
if (navbar) navbar.classList.toggle(‘scrolled’, window.scrollY > 40);
scrollTicking = false;
});
scrollTicking = true;
}
});

// –– CURSOR (тільки для десктопу) ––
if (window.innerWidth > 1024 && !window.matchMedia(’(pointer: coarse)’).matches) {
const cur = document.getElementById(‘cursor’);
const ring = document.getElementById(‘cursorRing’);
if (cur && ring) {
let mx = 0, my = 0, rx = 0, ry = 0;
document.addEventListener(‘mousemove’, e => { mx = e.clientX; my = e.clientY; });
(function anim() {
cur.style.left = mx + ‘px’;
cur.style.top = my + ‘px’;
rx += (mx - rx) * 0.15;
ry += (my - ry) * 0.15;
ring.style.left = rx + ‘px’;
ring.style.top = ry + ‘px’;
requestAnimationFrame(anim);
})();
}
}

// –– PRICE LIST ––
window.openPriceList = () => {
document.getElementById(‘modalPriceList’)?.classList.add(‘open’);
};

window.togglePriceCategory = headerEl => {
const items = headerEl.nextElementSibling;
const arrow = headerEl.querySelector(’.price-cat-arrow i’);
if (!items) return;
const isOpen = items.classList.contains(‘open’);
items.classList.toggle(‘open’, !isOpen);
if (arrow) arrow.className = isOpen ? ‘fas fa-chevron-down’ : ‘fas fa-chevron-up’;
headerEl.classList.toggle(‘open’, !isOpen);
};

// –– SETTINGS ––
window.saveSettings = () => {
const settings = {
salonName: document.getElementById(‘settingsName’)?.value || ‘’,
heroDesc: document.getElementById(‘settingsDesc’)?.value || ‘’,
address: document.getElementById(‘settingsAddress’)?.value || ‘’,
phone: document.getElementById(‘settingsPhone’)?.value || ‘’,
email: document.getElementById(‘settingsEmail’)?.value || ‘’
};
localStorage.setItem(‘siteSettings’, JSON.stringify(settings));
applySettings(settings);
showToast(‘✅ Налаштування збережено’, ‘success’);
};

function applySettings(s) {
if (!s) return;
const heroDesc = document.getElementById(‘heroDescription’);
const footerAddress = document.getElementById(‘footerAddress’);
const footerPhone = document.getElementById(‘footerPhone’);
const footerEmail = document.getElementById(‘footerEmail’);
if (s.heroDesc && heroDesc) heroDesc.textContent = s.heroDesc;
if (s.address && footerAddress) footerAddress.innerHTML = `<i class="fas fa-map-marker-alt"></i> ${esc(s.address)}`;
if (s.phone && footerPhone) footerPhone.innerHTML = `<i class="fas fa-phone-alt"></i> ${esc(s.phone)}`;
if (s.email && footerEmail) footerEmail.innerHTML = `<i class="fas fa-envelope"></i> ${esc(s.email)}`;
}

// –– INIT ––
(function init() {
try {
const s = JSON.parse(localStorage.getItem(‘siteSettings’) || ‘{}’);
applySettings(s);
} catch { /* ignore */ }

initAuthTabs();
})();

// Expose needed functions globally
window.renderMasters = renderMasters;
window.renderHome = renderHome;
