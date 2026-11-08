// The logo and icons: every icon the manifest and index.html name exists at
// the size it claims, the favicon is the logo's SVG first (then an ICO with
// 16, 32 and 48 px and a 32 px PNG), and the icons a platform rounds or
// masks itself are full bleed.
// Rebuild them with assets/logo/build-icons.sh.

import { describe, expect, it } from 'vitest';

import manifestText from '../../../public/manifest.webmanifest?raw';
import indexHtml from '../../../index.html?raw';
import logoSvg from '../../../../../assets/logo/logo.svg?raw';

const binaries = import.meta.glob<string>('../../../public/*.{png,ico}', { query: '?inline', import: 'default', eager: true });
const svgs = import.meta.glob<string>('../../../public/*.svg', { query: '?raw', import: 'default', eager: true });

const byPath = (files: Record<string, string>) =>
  new Map(Object.entries(files).map(([p, v]) => [p.replace('../../../public', ''), v]));
const binaryFiles = byPath(binaries);
const svgFiles = byPath(svgs);

function bytes(path: string): Uint8Array {
  const url = binaryFiles.get(path);
  if (!url) throw new Error(`${path} is missing from public/`);
  const b64 = url.slice(url.indexOf(',') + 1);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** A PNG's width, height and whether it has an alpha channel (IHDR). */
function png(path: string) {
  const b = bytes(path);
  expect([...b.slice(1, 4)].map((c) => String.fromCharCode(c)).join(''), path).toBe('PNG');
  const v = new DataView(b.buffer, b.byteOffset);
  const colorType = b[25];
  return { w: v.getUint32(16), h: v.getUint32(20), alpha: colorType === 4 || colorType === 6 };
}

/** The sizes of the images in an ICO file (a width byte of 0 means 256). */
function icoSizes(path: string): string[] {
  const b = bytes(path);
  const v = new DataView(b.buffer, b.byteOffset);
  expect(v.getUint16(2, true), `${path} type`).toBe(1);
  const n = v.getUint16(4, true);
  return Array.from({ length: n }, (_, i) => {
    const w = b[6 + i * 16] || 256;
    const h = b[7 + i * 16] || 256;
    return `${w}x${h}`;
  });
}

function svgSize(path: string): string {
  const text = svgFiles.get(path);
  if (!text) throw new Error(`${path} is missing from public/`);
  const m = /viewBox="0 0 (\d+) (\d+)"/.exec(text);
  expect(m, `${path} viewBox`).not.toBeNull();
  return `${m![1]}x${m![2]}`;
}

/** The sizes a file really holds, whatever its type (an SVG scales: "any"). */
function sizesOf(path: string): string[] {
  if (path.endsWith('.svg')) return svgSize(path) ? ['any'] : [];
  if (path.endsWith('.ico')) return icoSizes(path);
  const { w, h } = png(path);
  return [`${w}x${h}`];
}

const iconLinks = [...indexHtml.matchAll(/<link\s+rel="(icon|apple-touch-icon)"([^>]*)>/g)].map((m) => {
  const attrs = m[2] ?? '';
  const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1];
  return { rel: m[1], href: attr('href') ?? '', sizes: attr('sizes'), type: attr('type') };
});

describe('logo and icons', () => {
  it('has every manifest icon at the size it claims', () => {
    const m = JSON.parse(manifestText) as { icons: { src: string; sizes: string; type: string; purpose: string }[] };
    expect(m.icons.length).toBeGreaterThan(0);
    for (const icon of m.icons) {
      expect(sizesOf(icon.src), icon.src).toEqual([icon.sizes]);
      expect(icon.type, icon.src).toBe(icon.src.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
    }
  });

  it('has every icon link in index.html at the sizes it claims', () => {
    expect(iconLinks.map((l) => l.href)).toEqual(['/favicon.svg', '/favicon.ico', '/favicon.png', '/apple-touch-icon.png']);
    for (const link of iconLinks) {
      if (link.href.endsWith('.svg')) continue; // scalable: no sizes to claim
      expect(link.sizes, link.href).toBeTruthy();
      expect(sizesOf(link.href), link.href).toEqual(link.sizes!.split(' '));
    }
  });

  it('serves the logo as the favicon: the SVG first, then the ICO and PNG', () => {
    expect(iconLinks[0]).toMatchObject({ rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' });
    // One source: the favicon and the manifest's SVG are assets/logo/logo.svg,
    // drawn on a 32-unit grid so brick edges stay on whole pixels.
    expect(svgFiles.get('/favicon.svg')).toBe(logoSvg);
    expect(svgFiles.get('/icon.svg')).toBe(logoSvg);
    expect(svgSize('/favicon.svg')).toBe('32x32');
    expect(logoSvg).toContain('shape-rendering="crispEdges"');
    expect(icoSizes('/favicon.ico')).toEqual(['16x16', '32x32', '48x48']);
    expect(png('/favicon.png')).toMatchObject({ w: 32, h: 32 });
  });

  it('makes the icons a platform masks or rounds itself full bleed', () => {
    const m = JSON.parse(manifestText) as { icons: { src: string; purpose: string }[] };
    const masked = m.icons.filter((i) => i.purpose === 'maskable').map((i) => i.src);
    expect(masked.length).toBeGreaterThan(0);
    for (const src of [...masked, '/apple-touch-icon.png']) expect(png(src).alpha, src).toBe(false);
    // The in-app logo keeps its rounded tile.
    expect(png('/logo.png').alpha).toBe(true);
  });
});
