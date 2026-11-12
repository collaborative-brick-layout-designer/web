// Theme logic with no React in it: which mode "system" means right now,
// the CSS variables an accent sets, and applying the preferences to the
// <html> element. index.html runs a copy of `applyCached` before the app
// loads so a dark-theme user never sees a flash of light.

import { ACCENTS, ACCENT_IDS, LARGE_TEXT_SCALE, NEUTRALS, type AccentId, type Mode } from './tokens';
import { isSnapStrength, type SnapStrength } from '../editor/snapFeel';
import { isLegoColorId, legoColor } from '@cld/model';
import { chromeTheme, colorTheme } from './colorTheme';

export type ThemeChoice = 'light' | 'dark' | 'system';
export const THEME_CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system'];

/**
 * How far the color reaches: the whole app (the default) or just the
 * highlights (the original look, for people who choose it).
 */
export type ColorStyle = 'original' | 'full';
export const COLOR_STYLES: readonly ColorStyle[] = ['original', 'full'];

/** The settings stored on the account (GET/PUT /api/me/preferences). */
export interface Preferences {
  theme: ThemeChoice;
  accent: AccentId;
  /** A LEGO color (LEGO's number, see @cld/model's LEGO_COLORS) used instead of `accent`; null or absent for the preset. */
  legoColor?: number | null;
  /** Absent means the whole app (the default); 'original' is kept only when someone chose it. */
  colorStyle?: ColorStyle;
  largeText: boolean;
  expertMode: boolean;
  helpIcons: boolean;
  toursSeen: string[];
  /** Picture size in the editor's parts and module lists (32–160 px); absent until set. */
  partsIconSize?: number;
  /** Connection Snap strength (off / gentle / strong); absent until set, which means gentle. */
  connectionSnap?: SnapStrength;
  /** Whether the people who run your clubs see roughly when you were last active; absent means yes. */
  shareLastActive?: boolean;
  /** Whether to email you when someone asks to join a club where your roles answer requests; absent means yes. */
  emailJoinRequests?: boolean;
}

export const PARTS_ICON_MIN = 32;
export const PARTS_ICON_MAX = 160;

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  accent: 'brick',
  largeText: false,
  expertMode: false,
  helpIcons: true,
  toursSeen: [],
};

/** localStorage key for the last-known preferences (signed out, and pre-paint). */
export const PREFS_CACHE_KEY = 'bld.prefs';
/** localStorage key for the worked-out color variables per mode (public/theme-init.js paints with them). */
export const THEME_VARS_CACHE_KEY = 'bld.themeVars';

/** "system" follows the computer; light and dark are fixed. */
export function resolveMode(choice: ThemeChoice, systemDark: boolean): Mode {
  if (choice === 'system') return systemDark ? 'dark' : 'light';
  return choice;
}

export function systemPrefersDark(win: Pick<Window, 'matchMedia'> | undefined = globalThis.window): boolean {
  try {
    return !!win?.matchMedia?.('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/** The CSS custom properties one accent sets in one mode. */
export function accentVars(accent: AccentId, mode: Mode): Record<string, string> {
  const a = ACCENTS[accent] ?? ACCENTS.brick;
  return {
    '--accent': a.main,
    '--accent-ink': a.onMain,
    '--accent-soft': a.soft[mode],
    '--accent-text': a.text[mode],
  };
}

/** Every variable `themeVars` may set, so a change of color can clear the old ones. */
export const THEME_VAR_NAMES = ['--accent', '--accent-ink', '--accent-soft', '--accent-text', '--chrome', '--chrome-line', '--bg', '--page-top'] as const;

/** The style in use: 'original' only when someone chose it, the whole app otherwise. */
export function effectiveColorStyle(style: ColorStyle | undefined): ColorStyle {
  return style === 'original' ? 'original' : 'full';
}

type ThemePrefs = Pick<Preferences, 'accent' | 'legoColor' | 'colorStyle'>;

/**
 * The variables set on <html> itself for a color and style in one mode:
 * a LEGO color's accent (worked out by colorTheme), and for the whole-app
 * style the header, toolbar and page tints. Empty for a preset with the
 * original look (chosen in Settings), whose colors are styles.css's
 * hand-tuned ones.
 */
export function themeVars(prefs: ThemePrefs, mode: Mode): Record<string, string> {
  const out: Record<string, string> = {};
  const lego = legoColor(prefs.legoColor);
  let main = (ACCENTS[prefs.accent] ?? ACCENTS.brick).main;
  if (lego) {
    const t = colorTheme(lego.hex, mode);
    Object.assign(out, { '--accent': t.main, '--accent-ink': t.onMain, '--accent-soft': t.soft, '--accent-text': t.text });
    main = t.main;
  }
  if (effectiveColorStyle(prefs.colorStyle) === 'full') {
    const c = chromeTheme(main, mode);
    Object.assign(out, { '--chrome': c.chrome, '--chrome-line': c.chromeLine, '--bg': c.bg, '--page-top': c.pageTop });
  }
  return out;
}

/** The CSS custom properties one mode sets (`--bg`, `--panel`, ... from the tokens). */
export function neutralVars(mode: Mode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(NEUTRALS[mode])) out[`--${kebab(k)}`] = v;
  return out;
}

export function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Root font size as a percentage of the browser default. */
export function rootFontSize(largeText: boolean): string {
  return largeText ? `${LARGE_TEXT_SCALE * 100}%` : '';
}

/**
 * Put the preferences on <html>: `data-theme` (the resolved mode),
 * `data-accent`, `data-text`, the root font size and `color-scheme`.
 * The colors themselves live in styles.css keyed on these attributes.
 */
export function applyTheme(
  root: HTMLElement,
  prefs: Pick<Preferences, 'theme' | 'accent' | 'largeText' | 'legoColor' | 'colorStyle'>,
  systemDark: boolean,
): Mode {
  const mode = resolveMode(prefs.theme, systemDark);
  root.dataset.theme = mode;
  root.dataset.themeChoice = prefs.theme;
  const preset = (ACCENT_IDS as readonly string[]).includes(prefs.accent) ? prefs.accent : 'brick';
  root.dataset.accent = legoColor(prefs.legoColor) ? 'lego' : preset;
  root.dataset.colorStyle = effectiveColorStyle(prefs.colorStyle);
  const vars = themeVars({ ...prefs, accent: preset as AccentId }, mode);
  for (const name of THEME_VAR_NAMES) {
    if (vars[name]) root.style.setProperty(name, vars[name]);
    else root.style.removeProperty(name);
  }
  root.dataset.text = prefs.largeText ? 'large' : 'normal';
  root.style.fontSize = rootFontSize(prefs.largeText);
  root.style.colorScheme = mode;
  return mode;
}

/** Keep only well-formed keys; anything else falls back to the default. */
export function sanitizePreferences(input: unknown): Preferences {
  const out: Preferences = { ...DEFAULT_PREFERENCES, toursSeen: [] };
  if (typeof input !== 'object' || input === null) return out;
  const o = input as Record<string, unknown>;
  if ((THEME_CHOICES as readonly unknown[]).includes(o.theme)) out.theme = o.theme as ThemeChoice;
  if ((ACCENT_IDS as readonly unknown[]).includes(o.accent)) out.accent = o.accent as AccentId;
  for (const k of ['largeText', 'expertMode', 'helpIcons'] as const) {
    if (typeof o[k] === 'boolean') out[k] = o[k] as boolean;
  }
  if (Array.isArray(o.toursSeen)) out.toursSeen = o.toursSeen.filter((t): t is string => typeof t === 'string');
  if (typeof o.partsIconSize === 'number' && Number.isFinite(o.partsIconSize)) {
    out.partsIconSize = Math.round(Math.min(PARTS_ICON_MAX, Math.max(PARTS_ICON_MIN, o.partsIconSize)));
  }
  if (isSnapStrength(o.connectionSnap)) out.connectionSnap = o.connectionSnap;
  if (typeof o.shareLastActive === 'boolean') out.shareLastActive = o.shareLastActive;
  if (typeof o.emailJoinRequests === 'boolean') out.emailJoinRequests = o.emailJoinRequests;
  if (o.legoColor === null || isLegoColorId(o.legoColor)) out.legoColor = o.legoColor;
  if ((COLOR_STYLES as readonly unknown[]).includes(o.colorStyle)) out.colorStyle = o.colorStyle as ColorStyle;
  return out;
}

export function readCachedPreferences(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): Preferences {
  try {
    const raw = storage?.getItem(PREFS_CACHE_KEY);
    return sanitizePreferences(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_PREFERENCES, toursSeen: [] };
  }
}

export function writeCachedPreferences(prefs: Preferences, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try {
    storage?.setItem(PREFS_CACHE_KEY, JSON.stringify(prefs));
  } catch {
    // Private windows and blocked storage: the account copy still holds.
  }
}

/**
 * Keep both modes' variables for public/theme-init.js, so the next visit
 * paints in the right color before the app loads (and "system" can switch
 * mode on the spot).
 */
export function writeCachedThemeVars(prefs: ThemePrefs, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try {
    storage?.setItem(THEME_VARS_CACHE_KEY, JSON.stringify({ light: themeVars(prefs, 'light'), dark: themeVars(prefs, 'dark') }));
  } catch {
    // Without storage the first paint uses the preset colors for a moment.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
