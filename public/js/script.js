// ── Dark Mode ────────────────────────────────────────────────────────
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

// Apply saved preference on load
if (localStorage.getItem('darkMode') === 'enabled') {
  enableDarkMode();
} else {
  disableDarkMode();
}

if (toggleBtn) {
  toggleBtn.addEventListener('click', () => {
    localStorage.getItem('darkMode') === 'enabled' ? disableDarkMode() : enableDarkMode();
  });
}

// ── Active nav link ──────────────────────────────────────────────────
(function markActiveLink() {
  const links   = document.querySelectorAll('.sidebar-nav a');
  const current = window.location.pathname + window.location.search;
  links.forEach(link => {
    const href = link.getAttribute('href');
    if (!href) return;
    if (href === current) {
      link.classList.add('active');
    } else if (href.includes('section=') && current.includes(href.split('?')[1])) {
      link.classList.add('active');
    } else if (href === '/history' && current.startsWith('/history')) {
      link.classList.add('active');
    }
  });
})();

// ── Form loading state ───────────────────────────────────────────────
document.querySelectorAll('.manual-form, .chat-form').forEach(form => {
  form.addEventListener('submit', function () {
    const btn = this.querySelector('button[type="submit"]');
    if (btn) {
      btn.disabled    = true;
      btn.textContent = 'Searching…';
    }
  });
});

// ── Expandable other-match cards ─────────────────────────────────────
function toggleMatch(btn) {
  const card   = btn.closest('.other-match-card');
  const detail = card.querySelector('.match-detail');
  const chev   = btn.querySelector('.match-chevron');
  const open   = detail.style.display === 'none';

  detail.style.display = open ? 'block' : 'none';
  chev.style.transform = open ? 'rotate(180deg)' : 'rotate(0deg)';
  btn.style.background = open ? 'var(--bg-hover)' : 'var(--bg-subtle)';
}

// ── Drug name autocomplete ───────────────────────────────────────────
document.querySelectorAll('input[name="query"]').forEach(input => {
  let box       = null;
  let debounce  = null;

  input.addEventListener('input', function () {
    clearTimeout(debounce);
    const q = this.value.trim();
    if (q.length < 2) { if (box) { box.remove(); box = null; } return; }

    debounce = setTimeout(async () => {
      try {
        const res   = await fetch(`/suggest?q=${encodeURIComponent(q)}`);
        const names = await res.json();
        if (box) { box.remove(); box = null; }
        if (!names.length) return;

        box = document.createElement('ul');
        box.style.cssText = [
          'position:absolute', 'z-index:999', 'list-style:none', 'padding:4px',
          'background:var(--bg-surface)', 'border:1px solid var(--border)',
          'border-radius:var(--radius-md)', 'box-shadow:var(--shadow-md)',
          'min-width:240px', 'max-height:200px', 'overflow-y:auto'
        ].join(';');

        names.forEach(name => {
          const li       = document.createElement('li');
          li.textContent = name;
          li.style.cssText = 'padding:8px 12px;cursor:pointer;font-size:14px;border-radius:6px;color:var(--text-primary)';
          li.addEventListener('mouseover', () => li.style.background = 'var(--bg-hover)');
          li.addEventListener('mouseout',  () => li.style.background = '');
          li.addEventListener('click',     () => { input.value = name; box.remove(); box = null; });
          box.appendChild(li);
        });

        input.parentElement.style.position = 'relative';
        input.parentElement.appendChild(box);
      } catch (e) {}
    }, 280);
  });

  document.addEventListener('click', e => {
    if (box && !box.contains(e.target) && e.target !== input) {
      box.remove(); box = null;
    }
  });
});