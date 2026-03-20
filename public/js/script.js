// ─── Dark Mode ───────────────────────────────────────────────────
const toggleBtn = document.getElementById('toggleMode');

const enableDarkMode = () => {
  document.body.classList.add('dark-mode');
  localStorage.setItem('darkMode', 'enabled');
  if (toggleBtn) toggleBtn.innerHTML = '☀️ &nbsp;Light mode';
};

const disableDarkMode = () => {
  document.body.classList.remove('dark-mode');
  localStorage.setItem('darkMode', null);
  if (toggleBtn) toggleBtn.innerHTML = '🌙 &nbsp;Dark mode';
};

// Apply saved preference immediately (before paint)
if (localStorage.getItem('darkMode') === 'enabled') {
  enableDarkMode();
} else {
  disableDarkMode();
}

if (toggleBtn) {
  toggleBtn.addEventListener('click', () => {
    if (localStorage.getItem('darkMode') === 'enabled') {
      disableDarkMode();
    } else {
      enableDarkMode();
    }
  });
}

// ─── Active nav link ─────────────────────────────────────────────
(function markActiveLink() {
  const links = document.querySelectorAll('.sidebar-nav a');
  const current = window.location.pathname + window.location.search;

  links.forEach(link => {
    const href = link.getAttribute('href');
    if (!href) return;

    // Exact match or query-param match for section
    if (href === current) {
      link.classList.add('active');
    } else if (href.includes('section=') && current.includes(href.split('?')[1])) {
      link.classList.add('active');
    } else if (href === '/history' && current.startsWith('/history')) {
      link.classList.add('active');
    }
  });
})();

// ─── Form loading state ──────────────────────────────────────────
document.querySelectorAll('.manual-form, .chat-form').forEach(form => {
  form.addEventListener('submit', function () {
    const btn = this.querySelector('button[type="submit"]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Searching…';
    }
  });
});