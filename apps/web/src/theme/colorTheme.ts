// A whole theme from any one color: the accent (buttons, focus rings, the
// selected item), its soft tint and accent text, and for "Color the whole
// app" the tinted header, toolbars and panel headers and the page tint.
//
// Every value is worked out so it reads, whatever the color (WCAG 2.1):
// - the accent stands out from the panel (at least 3:1, as a control's
//   edge must), so in dark mode a dark color is lightened and in light
//   mode a pale one darkened; and the text on it, white or dark ink,
//   whichever reads better, is at least 4.5:1 (the color moves further
//   until one does);
// - accent text is at least 4.5:1 on every surface it sits on;
// - the header, toolbar and page tints keep the normal and the muted text
//   at 4.5:1 or better (the tint gets fainter until they do).
// Warning and error colors (danger, ok) never change.
//
// The desktop app does the same sums (src/ui/theme/ColorTheme.cpp); the
// tests in both pin the same results for White, Black, Bright Yellow and
// Earth Blue, so the two apps agree.

import { NEUTRALS, type Mode } from './tokens';

export type Rgb = [number, number, number];

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
/** The dark ink used on light accents (the light theme's text color). */
const DARK_INK = '#1E2124';

export function parseHex(hex: string): Rgb {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function toHex(c: Rgb): string {
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
export function luminance(c: Rgb): number {
  return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: Rgb | string, b: Rgb | string): number {
  const la = luminance(typeof a === 'string' ? parseHex(a) : a);
  const lb = luminance(typeof b === 'string' ? parseHex(b) : b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `pct` percent of the way from `a` to `b`, each channel rounded. */
export function mix(a: Rgb, b: Rgb, pct: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i]! + ((b[i]! - a[i]!) * pct) / 100)) as Rgb;
}

export interface ColorTheme {
  /** Filled buttons, the selected tool, focus rings, ticked boxes. */
  main: string;
  /** Text and icons on `main`: white or dark ink. */
  onMain: string;
  /** The pale (light) or deep (dark) tint behind a selected item. */
  soft: string;
  /** Accent-colored text on panels (links, the active tab). */
  text: string;
}

export interface ChromeTheme {
  /** Header, toolbars and panel headers. */
  chrome: string;
  /** Their bottom edge. */
  chromeLine: string;
  /** The page behind the cards. */
  bg: string;
  /** The page's top, fading into `bg`. */
  pageTop: string;
}

/** The accent colors for `base` in one mode. */
export function colorTheme(base: string, mode: Mode): ColorTheme {
  const n = NEUTRALS[mode];
  const panel = parseHex(n.panel);
  const ink = parseHex(DARK_INK);
  const c0 = parseHex(base);
  // Away from the panel first: darker in light mode, lighter in dark mode.
  const away = mode === 'light' ? BLACK : WHITE;
  const toward = mode === 'light' ? WHITE : BLACK;
  let main = c0;
  search: for (let pct = 0; pct <= 100; pct++) {
    for (const target of [away, toward]) {
      const c = mix(c0, target, pct);
      if (contrast(c, panel) >= 3 && Math.max(contrast(c, WHITE), contrast(c, ink)) >= 4.5) {
        main = c;
        break search;
      }
    }
  }
  const onMain = contrast(main, WHITE) >= contrast(main, ink) ? '#FFFFFF' : DARK_INK;
  const soft = mix(panel, main, mode === 'light' ? 12 : 20);
  const surfaces = [n.bg, n.panel, n.soft, toHex(soft)].map(parseHex);
  return { main: toHex(main), onMain, soft: toHex(soft), text: toHex(readableOn(main, surfaces, away)) };
}

/**
 * The first color from `c` toward `target` that is at least 4.5:1 on every
 * one of `surfaces`.
 */
function readableOn(c: Rgb, surfaces: Rgb[], target: Rgb): Rgb {
  for (let pct = 0; pct <= 100; pct++) {
    const t = mix(c, target, pct);
    if (surfaces.every((s) => contrast(t, s) >= 4.5)) return t;
  }
  return target;
}

/**
 * The strongest tint of `surface` toward `color`, up to `maxPct` percent,
 * that keeps the normal and the muted text at 4.5:1.
 */
function tint(surface: Rgb, color: Rgb, maxPct: number, texts: Rgb[]): Rgb {
  for (let pct = maxPct; pct > 0; pct--) {
    const t = mix(surface, color, pct);
    if (texts.every((x) => contrast(x, t) >= 4.5)) return t;
  }
  return surface;
}

/** "Color the whole app": the header, toolbars and page in `main`'s color. */
export function chromeTheme(main: string, mode: Mode): ChromeTheme {
  const n = NEUTRALS[mode];
  const c = parseHex(main);
  const texts = [parseHex(n.ink), parseHex(n.muted)];
  const light = mode === 'light';
  const chrome = tint(parseHex(n.panel), c, light ? 16 : 22, texts);
  return {
    chrome: toHex(chrome),
    chromeLine: toHex(mix(parseHex(n.line), c, light ? 30 : 35)),
    bg: toHex(tint(parseHex(n.bg), c, light ? 6 : 8, texts)),
    pageTop: toHex(tint(parseHex(n.bg), c, light ? 22 : 24, texts)),
  };
}
