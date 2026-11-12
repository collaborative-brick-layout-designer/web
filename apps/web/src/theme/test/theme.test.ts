// Theme logic: "system" resolution, the variables each accent sets,
// bigger text, the cached copy, and that styles.css carries exactly the
// token values (the CSS is what actually paints).

import { describe, expect, it } from 'vitest';
import {
  accentVars,
  applyTheme,
  effectiveColorStyle,
  DEFAULT_PREFERENCES,
  neutralVars,
  PREFS_CACHE_KEY,
  readCachedPreferences,
  resolveMode,
  rootFontSize,
  sanitizePreferences,
  THEME_VAR_NAMES,
  THEME_VARS_CACHE_KEY,
  writeCachedPreferences,
  writeCachedThemeVars,
} from '../theme';
import { ACCENTS, ACCENT_IDS, NEUTRALS, type Mode } from '../tokens';
import css from '../../styles.css?raw';



/** Declarations inside the first rule whose selector list starts with `selector`. */
function block(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`) >= 0 ? css.indexOf(`${selector} {`) : css.indexOf(`${selector},`);
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  const out: Record<string, string> = {};
  for (const m of css.slice(open + 1, close).matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

describe('resolveMode', () => {
  it('system follows the computer; light and dark are fixed', () => {
    expect(resolveMode('system', true)).toBe('dark');
    expect(resolveMode('system', false)).toBe('light');
    expect(resolveMode('light', true)).toBe('light');
    expect(resolveMode('dark', false)).toBe('dark');
  });
});

describe('applyTheme', () => {
  it('puts the resolved mode, accent and text size on <html>', () => {
    const root = document.createElement('html');
    expect(applyTheme(root, { theme: 'system', accent: 'ocean', largeText: true }, true)).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(root.dataset.themeChoice).toBe('system');
    expect(root.dataset.accent).toBe('ocean');
    expect(root.dataset.text).toBe('large');
    expect(root.style.fontSize).toBe('112.5%');
    expect(root.style.colorScheme).toBe('dark');

    applyTheme(root, { theme: 'system', accent: 'sunny', largeText: false }, false);
    expect(root.dataset.theme).toBe('light');
    expect(root.dataset.accent).toBe('sunny');
    expect(root.dataset.text).toBe('normal');
    expect(root.style.fontSize).toBe('');
  });

  it('falls back to brick for an unknown accent', () => {
    const root = document.createElement('html');
    applyTheme(root, { theme: 'light', accent: 'neon' as never, largeText: false }, false);
    expect(root.dataset.accent).toBe('brick');
  });

  it('a LEGO color sets readable accent colors on <html>, and a preset clears them', () => {
    const root = document.createElement('html');
    applyTheme(root, { theme: 'dark', accent: 'ocean', largeText: false, legoColor: 26, colorStyle: 'original' }, false);
    expect(root.dataset.accent).toBe('lego');
    expect(root.dataset.colorStyle).toBe('original');
    // Black is lightened in dark mode so it stands out from the panel.
    expect(root.style.getPropertyValue('--accent')).toBe('#646E75');
    expect(root.style.getPropertyValue('--accent-ink')).toBe('#FFFFFF');
    expect(root.style.getPropertyValue('--chrome')).toBe('');
    applyTheme(root, { theme: 'dark', accent: 'ocean', largeText: false, legoColor: null, colorStyle: 'original' }, false);
    expect(root.dataset.accent).toBe('ocean');
    expect(root.style.getPropertyValue('--accent')).toBe('');
  });

  it('"The whole app" tints the header, toolbars and page, for a preset or a LEGO color', () => {
    const root = document.createElement('html');
    applyTheme(root, { theme: 'light', accent: 'brick', largeText: false, colorStyle: 'full' }, false);
    expect(root.dataset.colorStyle).toBe('full');
    expect(root.style.getPropertyValue('--accent')).toBe(''); // the preset keeps its own
    expect(root.style.getPropertyValue('--chrome')).toMatch(/^#[0-9A-F]{6}$/);
    expect(root.style.getPropertyValue('--bg')).not.toBe('');
    applyTheme(root, { theme: 'light', accent: 'brick', largeText: false, colorStyle: 'full', legoColor: 24 }, false);
    expect(root.style.getPropertyValue('--accent')).toBe('#B49007');
    expect(root.style.getPropertyValue('--chrome')).toBe('#F3EDD7');
    applyTheme(root, { theme: 'light', accent: 'brick', largeText: false, colorStyle: 'original', legoColor: 24 }, false);
    expect(root.style.getPropertyValue('--chrome')).toBe('');
    expect(root.style.getPropertyValue('--bg')).toBe('');
  });

  it('the whole app is the default: no choice tints it, only a chosen "original" keeps the highlights', () => {
    const root = document.createElement('html');
    applyTheme(root, { theme: 'light', accent: 'brick', largeText: false }, false);
    expect(root.dataset.colorStyle).toBe('full');
    expect(root.style.getPropertyValue('--chrome')).toMatch(/^#[0-9A-F]{6}$/);
    expect(effectiveColorStyle(undefined)).toBe('full');
    expect(effectiveColorStyle('full')).toBe('full');
    expect(effectiveColorStyle('original')).toBe('original');
    applyTheme(root, { theme: 'light', accent: 'brick', largeText: false, colorStyle: 'original' }, false);
    expect(root.dataset.colorStyle).toBe('original');
    expect(root.style.getPropertyValue('--chrome')).toBe('');
  });

  it('keeps both modes\' worked-out colors for the pre-paint script', () => {
    const store = new Map<string, string>();
    writeCachedThemeVars({ accent: 'brick', legoColor: 140, colorStyle: 'full' }, { setItem: (k, v) => void store.set(k, v) });
    const vars = JSON.parse(store.get(THEME_VARS_CACHE_KEY)!);
    expect(vars.light['--accent']).toBe('#19325A');
    expect(vars.dark['--accent']).toBe('#5C6D8A');
    expect(vars.dark['--chrome']).toBe('#2C333C');
    expect(Object.keys(vars.light).every((k) => (THEME_VAR_NAMES as readonly string[]).includes(k))).toBe(true);
  });

  it('bigger text scales the root font size', () => {
    expect(rootFontSize(true)).toBe('112.5%');
    expect(rootFontSize(false)).toBe('');
  });
});

describe('accent variables', () => {
  it('each accent sets main, ink, soft and text for the mode', () => {
    expect(accentVars('ocean', 'dark')).toEqual({
      '--accent': '#2459C4',
      '--accent-ink': '#FFFFFF',
      '--accent-soft': '#1C2940',
      '--accent-text': '#93B4F0',
    });
    expect(accentVars('brick', 'light')['--accent-soft']).toBe('#FBE9E5');
    expect(accentVars('sunny', 'light')['--accent-ink']).toBe('#1E2124');
  });

  it('styles.css carries the same values as tokens.ts', () => {
    for (const mode of ['light', 'dark'] as Mode[]) {
      const rule = block(mode === 'light' ? ':root' : ":root[data-theme='dark']");
      for (const [name, value] of Object.entries(neutralVars(mode))) expect(rule[name], `${mode} ${name}`).toBe(value);
    }
    for (const id of ACCENT_IDS) {
      const light = id === 'brick' ? block(':root, :root[data-accent=\'brick\']') : block(`:root[data-accent='${id}']`);
      const dark = id === 'brick' ? block(":root[data-theme='dark'], :root[data-theme='dark'][data-accent='brick']") : block(`:root[data-theme='dark'][data-accent='${id}']`);
      const lv = accentVars(id, 'light');
      const dv = accentVars(id, 'dark');
      expect(light['--accent'], id).toBe(lv['--accent']);
      expect(light['--accent-ink'], id).toBe(lv['--accent-ink']);
      expect(light['--accent-soft'], id).toBe(lv['--accent-soft']);
      expect(light['--accent-text'], id).toBe(lv['--accent-text']);
      expect(dark['--accent-soft'], id).toBe(dv['--accent-soft']);
      expect(dark['--accent-text'], id).toBe(dv['--accent-text']);
    }
  });
});

describe('contrast (WCAG AA)', () => {
  it('body and secondary text pass 4.5:1 on every surface in both modes', () => {
    for (const mode of ['light', 'dark'] as Mode[]) {
      const n = NEUTRALS[mode];
      for (const surface of [n.bg, n.panel, n.soft]) {
        expect(contrast(n.ink, surface), `${mode} ink`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(n.muted, surface), `${mode} muted`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(n.ok, n.okSoft)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(n.danger, n.panel)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(n.tourInk, n.tourBg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('every accent: button text on the fill, accent text on panels, fill against light panels', () => {
    for (const id of ACCENT_IDS) {
      const a = ACCENTS[id];
      expect(contrast(a.onMain, a.main), `${id} onMain`).toBeGreaterThanOrEqual(4.5);
      for (const mode of ['light', 'dark'] as Mode[]) {
        const n = NEUTRALS[mode];
        for (const surface of [n.bg, n.panel, a.soft[mode]]) {
          expect(contrast(a.text[mode], surface), `${id} ${mode} text`).toBeGreaterThanOrEqual(4.5);
        }
      }
      // Non-text UI (selected borders, switches) needs 3:1 on light panels.
      expect(contrast(a.main, NEUTRALS.light.panel), `${id} main`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('cached preferences', () => {
  it('round-trips through storage and ignores junk', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readCachedPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
    writeCachedPreferences({ ...DEFAULT_PREFERENCES, theme: 'dark', accent: 'plum', largeText: true }, storage);
    expect(readCachedPreferences(storage)).toMatchObject({ theme: 'dark', accent: 'plum', largeText: true });
    store.set(PREFS_CACHE_KEY, '{not json');
    expect(readCachedPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
    expect(sanitizePreferences({ theme: 'neon', accent: 'chartreuse', helpIcons: 'no', toursSeen: ['a', 3] })).toEqual({
      ...DEFAULT_PREFERENCES,
      toursSeen: ['a'],
    });
  });

  it('keeps a known Snap strength and drops anything else', () => {
    expect(sanitizePreferences({ connectionSnap: 'strong' }).connectionSnap).toBe('strong');
    expect(sanitizePreferences({ legoColor: 24, colorStyle: 'full' })).toMatchObject({ legoColor: 24, colorStyle: 'full' });
    expect(sanitizePreferences({ legoColor: null }).legoColor).toBeNull();
    expect(sanitizePreferences({ legoColor: 41, colorStyle: 'loud' })).not.toHaveProperty('legoColor');
    expect(sanitizePreferences({ colorStyle: 'loud' })).not.toHaveProperty('colorStyle');
    expect(sanitizePreferences({ connectionSnap: 'off' }).connectionSnap).toBe('off');
    expect('connectionSnap' in sanitizePreferences({ connectionSnap: 'medium' })).toBe(false);
    expect('connectionSnap' in sanitizePreferences({})).toBe(false);
  });
});
