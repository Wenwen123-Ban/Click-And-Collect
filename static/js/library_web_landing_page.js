(function () {
  const state = { cards: [], news: [] };

  const homeCardsGrid = document.getElementById('homeCardsGrid');
  const newsDesktopList = document.getElementById('newsDesktopList');
  const newsMobileStrip = document.getElementById('newsMobileStrip');
  const newsReadModal = document.getElementById('newsReadModal');
  const imageLightboxModal = document.getElementById('imageLightboxModal');

  let aboutModalEscHandler = null;

  function openAboutModal() {
    const backdrop = document.getElementById('aboutModalBackdrop');
    if (!backdrop) return;
    backdrop.classList.add('active');
    backdrop.setAttribute('aria-hidden', 'false');
    if (!aboutModalEscHandler) {
      aboutModalEscHandler = function (event) {
        if (event.key === 'Escape') {
          closeAboutModal();
        }
      };
    }
    document.addEventListener('keydown', aboutModalEscHandler);
  }

  function closeAboutModal() {
    const backdrop = document.getElementById('aboutModalBackdrop');
    if (!backdrop) return;
    backdrop.classList.remove('active');
    backdrop.setAttribute('aria-hidden', 'true');
    if (aboutModalEscHandler) {
      document.removeEventListener('keydown', aboutModalEscHandler);
    }
  }

  window.openAboutModal = openAboutModal;
  window.closeAboutModal = closeAboutModal;

  function safe(v) {
    return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function toggleModal(id, show) {
    const node = document.getElementById(id);
    if (!node) return;
    node.classList.toggle('show', !!show);
    node.setAttribute('aria-hidden', show ? 'false' : 'true');
    document.body.style.overflow = show ? 'hidden' : '';
  }


  async function loadCoursesIntoSelect() {
    try {
      const res = await fetch('/api/courses');
      const data = await res.json();
      const courses = data.courses || [];
      const select = document.getElementById('signUpCourse');
      if (!select) return;
      select.innerHTML = '<option value="">Select Course</option>' + courses.map((c) => `<option value="${c}">${c}</option>`).join('');
    } catch (_e) {
      console.warn('Could not load courses');
    }
  }

  function handleSignUpLevelChange() {
    const isHS = document.getElementById('signUpLevelHS')?.checked;
    const yearSelect = document.getElementById('signUpYear');
    const courseSelect = document.getElementById('signUpCourse');
    const fgCourse = document.getElementById('fgSignUpCourse');
    if (!yearSelect) return;
    if (isHS) {
      yearSelect.innerHTML = '<option value="">Select Grade</option>' + [7, 8, 9, 10].map((g) => `<option value="${g}">Grade ${g}</option>`).join('');
      if (courseSelect) courseSelect.innerHTML = '<option value="N/A">N/A</option>';
      if (fgCourse) {
        fgCourse.style.opacity = '0.5';
        fgCourse.style.pointerEvents = 'none';
      }
    } else {
      yearSelect.innerHTML = '<option value="">Select Year</option>' + [1, 2, 3, 4].map((y) => `<option value="${y}">${y === 1 ? '1st' : y === 2 ? '2nd' : y === 3 ? '3rd' : '4th'} Year</option>`).join('');
      loadCoursesIntoSelect();
      if (fgCourse) {
        fgCourse.style.opacity = '1';
        fgCourse.style.pointerEvents = 'auto';
      }
    }
  }

  function truncate(text, max = 110) {
    const raw = String(text || '').trim();
    return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
  }

  function renderHomeCards() {
    if (!homeCardsGrid) return;
    if (!state.cards.length) {
      homeCardsGrid.innerHTML = '<p class="placeholder-text">No cards yet.</p>';
      return;
    }

    homeCardsGrid.innerHTML = state.cards.map((card) => {
      const title = String(card.title || '').trim();
      const body = String(card.body || '').trim();
      const empty = !title && !body;
      return `
        <article class="home-info-card ${empty ? 'placeholder' : ''}">
          <h4>${safe(title || `Card ${card.id}`)}</h4>
          <p>${safe(body || 'No content yet. Admin can update this card from dashboard.')}</p>
        </article>
      `;
    }).join('');
  }

  function openNewsModal(post) {
    document.getElementById('newsModalTitle').textContent = post.title || 'Untitled';
    document.getElementById('newsModalMeta').textContent = `${post.date || ''} • ${post.author || 'Admin'}`;
    document.getElementById('newsModalBody').textContent = post.body || '';

    const img = document.getElementById('newsModalImage');
    if (post.image_filename) {
      img.src = `/Profile/${encodeURIComponent(post.image_filename)}`;
      img.style.display = 'block';
      img.onclick = () => {
        const lightbox = document.getElementById('lightboxImage');
        lightbox.src = img.src;
        toggleModal('imageLightboxModal', true);
      };
    } else {
      img.removeAttribute('src');
      img.style.display = 'none';
      img.onclick = null;
    }

    toggleModal('newsReadModal', true);
  }

  function renderNewsDesktop() {
    if (!newsDesktopList) return;
    if (!state.news.length) {
      newsDesktopList.innerHTML = '<p class="placeholder-text">No news posts yet.</p>';
      return;
    }

    newsDesktopList.innerHTML = state.news.map((post, idx) => {
      const hasImage = !!post.image_filename;
      const imageMarkup = hasImage
        ? `<div class="news-post-image-wrap"><img class="news-post-image" src="/Profile/${encodeURIComponent(post.image_filename)}" alt="${safe(post.title)}"></div>`
        : '';
      const textMarkup = `
        <div class="news-post-text-wrap">
          <h4 class="news-post-title">${safe(post.title || 'Untitled')}</h4>
          <div class="news-post-date">${safe(post.date || '')}</div>
          <p class="news-post-summary">${safe(post.summary || '')}</p>
          <button type="button" class="read-more-btn" data-post-id="${safe(post.id)}">Read More</button>
        </div>
      `;
      if (!hasImage) return `<article class="news-post-row no-image">${textMarkup}</article>`;
      return idx % 2 === 0
        ? `<article class="news-post-row">${imageMarkup}${textMarkup}</article>`
        : `<article class="news-post-row">${textMarkup}${imageMarkup}</article>`;
    }).join('');

    newsDesktopList.querySelectorAll('.read-more-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const post = state.news.find((row) => String(row.id) === String(btn.dataset.postId));
        if (post) openNewsModal(post);
      });
    });
  }

  function renderNewsMobile() {
    if (!newsMobileStrip) return;
    if (!state.news.length) {
      newsMobileStrip.innerHTML = '<p class="placeholder-text">No news posts yet.</p>';
      return;
    }

    newsMobileStrip.innerHTML = state.news.map((post) => `
      <article class="news-mobile-card" data-post-id="${safe(post.id)}">
        ${post.image_filename ? `<img class="news-mobile-thumb" src="/Profile/${encodeURIComponent(post.image_filename)}" alt="${safe(post.title)}">` : ''}
        <div class="news-mobile-title">${safe(post.title || 'Untitled')}</div>
        <div class="news-mobile-date">${safe(post.date || '')}</div>
        <p class="news-mobile-summary">${safe(truncate(post.summary || ''))}</p>
      </article>
    `).join('');

    newsMobileStrip.querySelectorAll('.news-mobile-card').forEach((card) => {
      card.addEventListener('click', () => {
        const post = state.news.find((row) => String(row.id) === String(card.dataset.postId));
        if (post) openNewsModal(post);
      });
    });
  }


  function updateAuthMenus() {
    const token = localStorage.getItem('lbas_token');
    const isLoggedIn = !!token;

    const landingToggle = document.getElementById('landingAuthToggle');
    const landingAdminItem = document.getElementById('landingAdminLoginItem');
    const landingAction = document.getElementById('landingAuthAction');

    if (landingToggle) landingToggle.textContent = isLoggedIn ? 'Account' : 'Log in';
    if (landingAdminItem) landingAdminItem.style.display = '';
    if (landingAction) {
      landingAction.textContent = isLoggedIn ? 'Log out' : 'Log in';
      landingAction.href = isLoggedIn ? '#' : '/student-management';
      landingAction.onclick = isLoggedIn
        ? async function (event) {
            event.preventDefault();
            try {
              await fetch('/api/logout', { method: 'POST', headers: { Authorization: token } });
            } catch (_e) {
              console.warn('Logout request failed.');
            }
            localStorage.removeItem('lbas_id');
            localStorage.removeItem('lbas_token');
            updateAuthMenus();
          }
        : null;
    }
  }

  function renderLeaderboard(rows) {
    const tbody = document.querySelector('#catalogLeaderboardTable tbody');
    if (!tbody) return;
    tbody.innerHTML = rows.map((row, idx) => `
      <tr><td>${idx + 1}</td><td>${safe(row.name)}</td><td>${safe(row.school_id)}</td><td>${safe(row.total_borrowed)}</td></tr>
    `).join('') || '<tr><td colspan="4" class="text-center">No data yet.</td></tr>';
  }

  async function loadLandingContent() {
    try {
      const [cardRes, newsRes, lbRes] = await Promise.all([
        fetch('/api/home_cards'),
        fetch('/api/news_posts'),
        fetch('/api/monthly_leaderboard')
      ]);
      const cards = await cardRes.json();
      const news = await newsRes.json();
      const lbData = await lbRes.json();

      state.cards = Array.isArray(cards) ? cards : [];
      state.news = Array.isArray(news) ? news : [];

      renderHomeCards();
      renderNewsDesktop();
      renderNewsMobile();
      renderLeaderboard(Array.isArray(lbData.top_borrowers) ? lbData.top_borrowers : []);
    } catch (error) {
      console.error(error);
    }
  }

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => toggleModal(btn.dataset.close, false));
  });

  newsReadModal?.addEventListener('click', (e) => {
    if (e.target === newsReadModal) toggleModal('newsReadModal', false);
  });
  imageLightboxModal?.addEventListener('click', (e) => {
    if (e.target === imageLightboxModal) toggleModal('imageLightboxModal', false);
  });

  document.getElementById('signUpLevelCollege')?.addEventListener('change', handleSignUpLevelChange);
  document.getElementById('signUpLevelHS')?.addEventListener('change', handleSignUpLevelChange);
  loadLandingContent();
  updateAuthMenus();


  document.addEventListener('DOMContentLoaded', function () {
    const footer = document.querySelector('footer');
    const trigger = document.getElementById('aboutTriggerBtn');
    if (!footer || !trigger || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          trigger.classList.toggle('footer-overlap', entry.isIntersecting);
        });
      },
      { threshold: 0.1 }
    );

    observer.observe(footer);
  });
})();
