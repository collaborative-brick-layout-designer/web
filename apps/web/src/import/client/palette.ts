// LDraw color codes → colors: LDConfig.ldr from the site's library, then the
// desktop's bundled table for codes it doesn't have (src/import/ldraw/
// LDrawPalette.cpp and LDrawColors.cpp).

/** RGBA, 0–255 each, not premultiplied (QColor). */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

// { code, r, g, b, transparent }: the desktop's kColors.
const BUNDLED: [number, number, number, number, boolean][] = [
  [0, 27, 42, 52, false], [1, 0, 85, 191, false], [2, 0, 124, 64, false], [3, 6, 125, 156, false],
  [4, 201, 26, 9, false], [5, 211, 83, 156, false], [6, 84, 51, 36, false], [7, 138, 146, 141, false],
  [8, 100, 103, 97, false], [9, 180, 210, 227, false], [10, 120, 252, 120, false], [11, 8, 153, 157, false],
  [12, 246, 108, 64, false], [13, 253, 195, 175, false], [14, 245, 205, 47, false], [15, 255, 255, 255, false],
  [16, 180, 180, 180, false], [17, 197, 225, 204, false], [18, 253, 232, 158, false], [19, 215, 197, 153, false],
  [20, 193, 202, 223, false], [22, 129, 68, 138, false], [23, 13, 105, 171, false], [25, 214, 121, 35, false],
  [26, 146, 57, 120, false], [27, 164, 189, 70, false], [28, 149, 138, 115, false], [29, 253, 217, 228, false],
  [30, 160, 110, 185, false], [31, 205, 164, 222, false],
  [32, 0, 0, 0, true], [33, 0, 32, 160, true], [34, 35, 120, 65, true], [35, 86, 230, 70, true],
  [36, 201, 26, 9, true], [37, 100, 20, 100, true], [38, 255, 128, 0, true], [40, 99, 95, 82, true],
  [41, 174, 239, 236, true], [42, 192, 255, 0, true], [43, 174, 255, 255, true], [44, 192, 80, 192, true],
  [45, 252, 151, 172, true], [46, 240, 196, 0, true], [47, 252, 252, 252, true], [54, 218, 176, 10, true],
  [57, 247, 133, 0, true],
  [70, 105, 64, 39, false], [71, 163, 162, 164, false], [72, 99, 95, 98, false], [73, 110, 153, 201, false],
  [74, 192, 255, 147, false], [77, 254, 204, 204, false], [78, 246, 215, 179, false], [84, 160, 110, 60, false],
  [85, 68, 26, 145, false], [86, 123, 93, 65, false], [89, 28, 88, 167, false], [92, 204, 142, 105, false],
  [100, 238, 196, 182, false], [110, 38, 51, 140, false],
  [151, 204, 202, 200, false], [176, 135, 84, 112, false], [191, 248, 187, 61, false], [212, 156, 209, 223, false],
  [216, 105, 49, 39, false], [226, 255, 242, 171, false], [272, 32, 58, 86, false], [288, 39, 70, 44, false],
  [308, 53, 33, 0, false], [320, 114, 14, 14, false], [321, 70, 155, 195, false], [322, 104, 195, 226, false],
  [323, 189, 199, 180, false], [326, 226, 249, 154, false], [330, 119, 119, 78, false],
];

const bundled = new Map<number, Rgba>(BUNDLED.map(([code, r, g, b, t]) => [code, { r, g, b, a: t ? 160 : 255 }]));
const UNKNOWN: Rgba = { r: 180, g: 180, b: 180, a: 255 };

/** The desktop's ldrawColor: the bundled table, light grey for an unknown code. */
export function bundledColor(code: number): Rgba {
  return bundled.get(code) ?? UNKNOWN;
}

/** "#RRGGBB" or "#AARRGGBB"; null when it isn't one. */
function parseHex(s: string): Rgba | null {
  const t = s.trim();
  if (!t.startsWith('#')) return null;
  const hex = t.slice(1);
  if (!/^[0-9A-Fa-f]+$/.test(hex)) return null;
  const v = parseInt(hex, 16);
  if (t.length === 7) return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: 255 };
  if (t.length === 9) return { r: (v >>> 16) & 255, g: (v >>> 8) & 255, b: v & 255, a: (v >>> 24) & 255 };
  return null;
}

/** Qt's QString::toInt: optional sign, decimal digits only. */
export function qtInt(s: string): number | null {
  return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : null;
}

/** LDConfig's color line keyword, in LDraw's own (British) spelling. */
const COLOR_KEYWORD = '!COL' + 'OUR';

export class Palette {
  private readonly entries = new Map<number, Rgba>();

  /** LDConfig.ldr's color lines (`0 !COL…`, LDraw's keyword): CODE, VALUE and ALPHA by name, in any order. */
  static fromLDConfig(text: string | null): Palette {
    const p = new Palette();
    if (!text) return p;
    const next = new Map<number, Rgba>();
    for (const line of text.split(/\r?\n/)) {
      const toks = line.split(/\s+/).filter(Boolean);
      if (toks.length < 2 || toks[0] !== '0' || toks[1]!.toUpperCase() !== COLOR_KEYWORD) continue;
      let code = -1;
      let rgb: Rgba | null = null;
      let alpha = 255;
      for (let i = 2; i + 1 < toks.length; i++) {
        const key = toks[i]!.toUpperCase();
        const val = toks[i + 1]!;
        if (key === 'CODE') {
          const c = qtInt(val);
          if (c !== null) code = c;
        } else if (key === 'VALUE') rgb = parseHex(val);
        else if (key === 'ALPHA') {
          const a = qtInt(val);
          if (a !== null) alpha = Math.max(0, Math.min(255, a));
        }
      }
      if (code < 0 || !rgb) continue;
      next.set(code, { ...rgb, a: alpha });
    }
    for (const [k, v] of next) p.entries.set(k, v);
    return p;
  }

  color(code: number): Rgba {
    return this.entries.get(code) ?? bundledColor(code);
  }
}
