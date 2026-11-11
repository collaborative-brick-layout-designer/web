// A theme from any color: every LEGO color reads in both modes, and the
// extremes (White, Black, Bright Yellow, Earth Blue) give the exact colors
// the desktop's ColorThemeTest pins too, so the two apps agree.

import { describe, expect, it } from 'vitest';
import { LEGO_COLORS, legoColor } from '@cld/model';
import { chromeTheme, colorTheme, contrast } from '../colorTheme';
import { NEUTRALS, type Mode } from '../tokens';

const MODES: Mode[] = ['light', 'dark'];

describe('colorTheme', () => {
  it('pins the extremes (the desktop pins the same values)', () => {
    const hex = (id: number) => legoColor(id)!.hex;
    expect(colorTheme(hex(1), 'light')).toEqual({ main: '#929292', onMain: '#1E2124', soft: '#F2F2F2', text: '#6C6C6C' });
    expect(colorTheme(hex(1), 'dark')).toEqual({ main: '#F4F4F4', onMain: '#1E2124', soft: '#4A4C4F', text: '#F4F4F4' });
    expect(colorTheme(hex(26), 'light')).toEqual({ main: '#1B2A34', onMain: '#FFFFFF', soft: '#E4E5E7', text: '#1B2A34' });
    expect(colorTheme(hex(26), 'dark')).toEqual({ main: '#646E75', onMain: '#FFFFFF', soft: '#2D3136', text: '#939A9E' });
    expect(colorTheme(hex(24), 'light')).toEqual({ main: '#B49007', onMain: '#1E2124', soft: '#F6F2E1', text: '#836905' });
    expect(colorTheme(hex(24), 'dark')).toEqual({ main: '#FAC80A', onMain: '#1E2124', soft: '#4B4320', text: '#FAC80A' });
    expect(colorTheme(hex(140), 'light')).toEqual({ main: '#19325A', onMain: '#FFFFFF', soft: '#E3E6EB', text: '#19325A' });
    expect(colorTheme(hex(140), 'dark')).toEqual({ main: '#5C6D8A', onMain: '#FFFFFF', soft: '#2B313A', text: '#8D99AD' });
    expect(chromeTheme('#B49007', 'light')).toEqual({ chrome: '#F3EDD7', chromeLine: '#D6C899', bg: '#F2EEE1', pageTop: '#E7DEBC' });
    expect(chromeTheme('#5C6D8A', 'dark')).toEqual({ chrome: '#2C333C', chromeLine: '#3F4856', bg: '#1C1F24', pageTop: '#272C36' });
  });

  it('lightens a dark color in dark mode and deepens a pale one in light mode', () => {
    const black = legoColor(26)!.hex;
    expect(contrast(colorTheme(black, 'dark').main, NEUTRALS.dark.panel)).toBeGreaterThanOrEqual(3);
    expect(colorTheme(black, 'dark').main).not.toBe(black);
    const white = legoColor(1)!.hex;
    expect(contrast(colorTheme(white, 'light').main, NEUTRALS.light.panel)).toBeGreaterThanOrEqual(3);
    expect(colorTheme(white, 'light').main).not.toBe(white);
  });

  for (const mode of MODES) {
    it(`keeps every LEGO color readable in ${mode} mode`, () => {
      const n = NEUTRALS[mode];
      for (const c of LEGO_COLORS) {
        const t = colorTheme(c.hex, mode);
        const what = `${c.lego} (${c.id}) ${mode}`;
        expect(contrast(t.onMain, t.main), `${what}: text on the accent`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t.main, n.panel), `${what}: the accent on the panel`).toBeGreaterThanOrEqual(3);
        for (const s of [n.bg, n.panel, n.soft, t.soft]) expect(contrast(t.text, s), `${what}: accent text on ${s}`).toBeGreaterThanOrEqual(4.5);
        const ch = chromeTheme(t.main, mode);
        for (const s of [ch.chrome, ch.bg, ch.pageTop]) {
          expect(contrast(n.ink, s), `${what}: text on ${s}`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(n.muted, s), `${what}: muted text on ${s}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }

  it('offers no see-through, glitter or chrome colors', () => {
    const names = LEGO_COLORS.map((c) => c.lego.toLowerCase());
    for (const word of ['trans', 'glitter', 'chrome', 'speckle', 'opal', 'glow']) {
      expect(names.filter((n) => n.includes(word)), word).toEqual([]);
    }
    expect(new Set(LEGO_COLORS.map((c) => c.id)).size).toBe(LEGO_COLORS.length);
  });

  it('names each color as LEGO and BrickLink do', () => {
    expect(legoColor(24)).toMatchObject({ lego: 'Bright Yellow', bl: 'Yellow', blId: 3, hex: '#FAC80A' });
    expect(legoColor(140)).toMatchObject({ lego: 'Earth Blue', bl: 'Dark Blue', blId: 63 });
    expect(legoColor(194)).toMatchObject({ lego: 'Medium Stone Grey', bl: 'Light Bluish Gray', blId: 86 });
    expect(legoColor(1)).toMatchObject({ lego: 'White', bl: 'White', blId: 1 });
    expect(legoColor(26)).toMatchObject({ lego: 'Black', bl: 'Black', blId: 11 });
  });
});
