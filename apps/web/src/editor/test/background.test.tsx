// Map background: color with alpha (MainWindowMapMenu.cpp:48-60,
// XmlPrimitives.cpp:174-180) and image placement (MapViewPaint.cpp:41-67).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createDefaultLayoutDoc, docToBbm, writeSidecarCache } from '@cld/ydoc';
import { writeBbm } from '@cld/bbm';
import { argbSpec, backgroundImageRectPx, hexAlpha, sameOriginImageUrl } from '../background';
import { localLayoutContents } from '../localLayoutFile';
import { BackgroundColorDialog } from '../BackgroundColorDialog';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('backgroundImageRectPx', () => {
  it('draws an image without a rect at native size at the origin (regression: was stretched to the bricks)', () => {
    expect(backgroundImageRectPx({}, { width: 640, height: 480 })).toEqual({ x: 0, y: 0, width: 640, height: 480 });
  });
  it('uses a stored rect (studs → 8 px/stud)', () => {
    expect(backgroundImageRectPx({ rect: { x: 1, y: -2, w: 10, h: 5 } }, { width: 640, height: 480 }))
      .toEqual({ x: 8, y: -16, width: 80, height: 40 });
  });
});

describe('background color alpha', () => {
  it('writes lowercase aarrggbb like desktop', () => {
    expect(argbSpec('#6495ED', 128)).toEqual({ kind: 'argb', argb: '806495ed' });
    expect(argbSpec('00ff00', 300)).toEqual({ kind: 'argb', argb: 'ff00ff00' });
  });
  it('reads picker state back, known colors opaque', () => {
    expect(hexAlpha({ kind: 'argb', argb: '40112233' })).toEqual({ hex: '#112233', alpha: 64 });
    expect(hexAlpha({ kind: 'known', name: 'White' })).toEqual({ hex: '#ffffff', alpha: 255 });
  });

  it('the dialog saves the alpha into the doc and the .bbm', () => {
    const doc = createDefaultLayoutDoc();
    render(<BackgroundColorDialog current={docToBbm(doc).backgroundColor} doc={doc} onClose={() => {}} />);
    fireEvent.change(document.querySelector('input[type="color"]')!, { target: { value: '#102030' } });
    fireEvent.change(screen.getByLabelText('Alpha'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    const map = docToBbm(doc);
    expect(map.backgroundColor).toEqual({ kind: 'argb', argb: '64102030' });
    expect(writeBbm(map)).toMatch(/<BackgroundColor>\s*<IsKnownColor>false<\/IsKnownColor>\s*<Name>64102030<\/Name>/);
  });
});

describe('background image address', () => {
  const origin = 'https://layouts.example.org';
  it("loads this server's own picture", () => {
    expect(sameOriginImageUrl('/api/layouts/abc/background-image', origin)).toBe('/api/layouts/abc/background-image');
  });
  it('never loads an address on another host', () => {
    for (const url of [
      'https://tracker.example.net/pixel.png',
      'http://layouts.example.org/api/x',
      '//tracker.example.net/pixel.png',
      '/\\tracker.example.net/pixel.png',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
      'api/layouts/abc/background-image',
      '',
      undefined,
      42,
    ]) {
      expect(sameOriginImageUrl(url, origin)).toBeNull();
    }
  });
  it("a download of the layout doesn't fetch a picture from another host", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const doc = createDefaultLayoutDoc();
    doc.transact(() => writeSidecarCache(doc, { schemaVersion: 1, bbmHashSha256: '', backgroundImage: { url: 'https://tracker.example.net/pixel.png', opacity: 0.5 } }));
    const out = await localLayoutContents(doc);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.background).toBeUndefined();
  });
});
