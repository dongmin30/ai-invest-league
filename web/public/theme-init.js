// Runs before first paint (loaded from <head>) so dark mode never flashes white.
// External file because the server CSP forbids inline scripts. Keep in sync with src/lib/theme.ts.
(function () {
  var theme = 'system';
  try {
    var saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch (e) {}
  var dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
})();
