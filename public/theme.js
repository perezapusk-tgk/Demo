/* RapidLink — переключение темы (тёмная / светлая) */
(function() {
  // Применяем тему сразу, до отрисовки (чтобы не мигало)
  const saved = localStorage.getItem('rapidlink_theme');
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  const initial = saved || (prefersLight ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', initial);

  // Ставим кнопку после загрузки DOM
  document.addEventListener('DOMContentLoaded', function() {
    const btn = document.createElement('button');
    btn.className = 'theme-toggle';
    btn.setAttribute('aria-label', 'Переключить тему');
    btn.title = 'Тёмная / светлая тема';
    function setIcon() {
      const current = document.documentElement.getAttribute('data-theme');
      btn.textContent = current === 'light' ? '🌙' : '☀️';
    }
    setIcon();
    btn.addEventListener('click', function() {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('rapidlink_theme', next);
      setIcon();
    });
    document.body.appendChild(btn);
  });
})();
