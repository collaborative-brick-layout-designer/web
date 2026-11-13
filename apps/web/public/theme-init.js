// Runs before the app loads (a plain script, not a module, so it blocks
// first paint): applies the last-known theme, color and text size so a
// dark-theme user never sees a flash of light. Mirrors applyTheme() in
// src/theme/theme.ts; the React provider takes over once it mounts.
(function () {
  var p = {};
  try {
    p = JSON.parse(localStorage.getItem('bld.prefs') || '{}') || {};
  } catch (e) {}
  var choice = p.theme === 'light' || p.theme === 'dark' ? p.theme : 'system';
  var dark = false;
  try {
    dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (e) {}
  var mode = choice === 'system' ? (dark ? 'dark' : 'light') : choice;
  var accents = ['brick', 'ocean', 'forest', 'plum', 'sunny', 'teal', 'orange', 'rose', 'indigo', 'slate'];
  var root = document.documentElement;
  root.setAttribute('data-theme', mode);
  root.setAttribute('data-theme-choice', choice);
  root.setAttribute('data-accent', accents.indexOf(p.accent) >= 0 ? p.accent : 'brick');
  root.setAttribute('data-text', p.largeText === true ? 'large' : 'normal');
  if (p.largeText === true) root.style.fontSize = '112.5%';
  root.style.colorScheme = mode;
  // A LEGO color and "Color the whole app" are worked out by the app
  // (src/theme/colorTheme.ts), which keeps the results for both modes here.
  if (typeof p.legoColor === 'number') root.setAttribute('data-accent', 'lego');
  // The whole app is the default; "Just the highlights" only for someone
  // who picked it in Settings (colorStyleChosen; src/theme/theme.ts).
  root.setAttribute('data-color-style', p.colorStyle === 'original' && p.colorStyleChosen === true ? 'original' : 'full');
  try {
    var vars = (JSON.parse(localStorage.getItem('bld.themeVars') || '{}') || {})[mode] || {};
    for (var k in vars) if (/^--[a-z-]+$/.test(k) && /^#[0-9A-Fa-f]{6}$/.test(vars[k])) root.style.setProperty(k, vars[k]);
  } catch (e) {}
})();
