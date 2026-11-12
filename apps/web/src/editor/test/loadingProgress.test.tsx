// The loading counter in the sprite cache and the loading card over the map.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BbmMap } from '@cld/model';
import {
  _resetSpriteCacheForTests,
  ensureSprite,
  getSpriteProgress,
  onSpriteReady,
  resetSpriteProgress,
  retryFailedSprites,
  wantSprites,
} from '../render/spriteCache';
import { layoutSpriteUrls, layoutSpriteUrlsKept } from '../render/layoutSprites';
import { LATER_BATCH_DELAY_MS, LoadingCard, MapLoadingCard } from '../LoadingCard';
import type { PartWire } from '../../api';

// A stand-in Image whose loads the test finishes by hand.
const pending = new Map<string, FakeImage[]>();
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  crossOrigin = '';
  naturalWidth = 8;
  naturalHeight = 8;
  set src(url: string) {
    const list = pending.get(url) ?? [];
    list.push(this);
    pending.set(url, list);
  }
}
function finish(url: string, ok = true) {
  for (const img of pending.get(url) ?? []) (ok ? img.onload : img.onerror)?.();
  pending.delete(url);
}
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  vi.stubGlobal('Image', FakeImage);
  pending.clear();
  _resetSpriteCacheForTests();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sprite loading counter', () => {
  it('counts wanted, loaded and failed pictures', async () => {
    wantSprites(['/a.png', '/b.png', '/c.png', '/a.png']);
    expect(getSpriteProgress()).toMatchObject({ wanted: 3, loaded: 0, failed: 0, initial: true });
    finish('/a.png');
    finish('/b.png', false);
    await settle();
    expect(getSpriteProgress()).toMatchObject({ wanted: 3, loaded: 1, failed: 1 });
    finish('/c.png');
    await settle();
    expect(getSpriteProgress()).toMatchObject({ wanted: 3, loaded: 2, failed: 1 });
  });

  it('does not count a picture that is already loaded', async () => {
    wantSprites(['/a.png']);
    finish('/a.png');
    await settle();
    resetSpriteProgress();
    wantSprites(['/a.png']);
    await ensureSprite('/a.png');
    expect(getSpriteProgress()).toMatchObject({ wanted: 0, loaded: 0 });
  });

  it('starts a fresh batch once the last one finished cleanly', async () => {
    wantSprites(['/a.png', '/b.png']);
    finish('/a.png');
    finish('/b.png');
    await settle();
    expect(getSpriteProgress()).toMatchObject({ wanted: 2, loaded: 2, initial: true });
    wantSprites(['/c.png']);
    expect(getSpriteProgress()).toMatchObject({ wanted: 1, loaded: 0, initial: false });
  });

  it('retries the failed pictures and tells the bricks waiting on them', async () => {
    wantSprites(['/a.png', '/b.png']);
    finish('/a.png');
    finish('/b.png', false);
    await settle();
    const ready = vi.fn();
    onSpriteReady('/b.png', ready);
    retryFailedSprites();
    expect(getSpriteProgress()).toMatchObject({ wanted: 2, loaded: 1, failed: 0 });
    finish('/b.png');
    await settle();
    expect(getSpriteProgress()).toMatchObject({ wanted: 2, loaded: 2, failed: 0 });
    expect(ready).toHaveBeenCalledTimes(1);
  });
});

describe('layoutSpriteUrls', () => {
  it('lists each distinct picture on the visible brick layers', () => {
    const part = (key: string, spritePath: string) => ({ key, partNumber: key.split('.')[0], spritePath, source: 'bundled', customPartId: null }) as unknown as PartWire;
    const parts = new Map<string, PartWire>([
      ['3001.1', part('3001.1', '3001.1.gif')],
      ['3002.1', part('3002.1', '3002.1.gif')],
      ['3003.1', part('3003.1', '3003.1.gif')],
    ]);
    const map = {
      layers: [
        { type: 'brick', visible: true, bricks: [{ partNumber: '3001.1' }, { partNumber: '3001.1' }, { partNumber: '3002.1' }, { partNumber: 'nope.1' }] },
        { type: 'brick', visible: false, bricks: [{ partNumber: '3003.1' }] },
        { type: 'text', visible: true },
      ],
    } as unknown as BbmMap;
    expect([...layoutSpriteUrls(map, parts)]).toEqual(['/parts/3001.1.gif', '/parts/3002.1.gif']);
  });
});

describe('layoutSpriteUrlsKept', () => {
  it('gives what layoutSpriteUrls does, looking only at the parts that changed', () => {
    const part = (key: string) => ({ key, partNumber: key, spritePath: `${key}.gif`, source: 'bundled', customPartId: null }) as unknown as PartWire;
    const parts = new Map<string, PartWire>(['a', 'b', 'c', 'd'].map((k) => [k, part(k)]));
    let looks = 0;
    const counted = new Map(parts);
    const get = counted.get.bind(counted);
    counted.get = (k: string) => {
      looks++;
      return get(k);
    };
    const names = ['a', 'b', 'c', 'd', 'nope'];
    let seed = 3;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const brick = () => ({ partNumber: names[Math.floor(rnd() * names.length)]! });
    let sheets = [
      { type: 'brick', id: 'L1', visible: true, bricks: Array.from({ length: 500 }, brick) },
      { type: 'brick', id: 'L2', visible: true, bricks: Array.from({ length: 30 }, brick) },
    ];
    const urls = layoutSpriteUrlsKept();
    const asMap = () => ({ layers: sheets }) as unknown as BbmMap;
    expect(urls(asMap(), counted)).toEqual(layoutSpriteUrls(asMap(), parts));
    for (let round = 0; round < 60; round++) {
      const r = rnd();
      const l = sheets[r < 0.8 ? 0 : 1]!;
      const bricks = [...l.bricks];
      if (r < 0.6) bricks[Math.floor(rnd() * bricks.length)] = brick(); // a part changed
      else if (r < 0.75) bricks.splice(Math.floor(rnd() * bricks.length), 1); // taken out
      else if (r < 0.9) bricks.push(brick()); // put in
      sheets = sheets.map((s) => (s === l ? { ...l, bricks, visible: r < 0.95 ? l.visible : !l.visible } : s));
      looks = 0;
      const got = urls(asMap(), counted);
      expect(new Set(got)).toEqual(layoutSpriteUrls(asMap(), parts));
      // A part changed in place: it alone (and the part it replaced).
      if (r < 0.6) expect(looks).toBeLessThanOrEqual(2);
    }
  });
});

describe('LoadingCard', () => {
  it('is an accessible progress bar with a counter', () => {
    render(<LoadingCard title="Loading part pictures…" done={132} total={1480} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('132');
    expect(bar.getAttribute('aria-valuemax')).toBe('1480');
    expect(screen.getByRole('status').textContent).toContain('132 of 1,480');
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
  });

  it('runs as busy with no number while the total is unknown', () => {
    render(<LoadingCard title="Opening layout…" />);
    expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
    expect(screen.queryByTestId('loading-count')).toBeNull();
  });
});

describe('MapLoadingCard', () => {
  it('says the layout is opening while the parts list loads', () => {
    render(<MapLoadingCard catalogLoading />);
    expect(screen.getByRole('status').textContent).toContain('Opening layout…');
  });

  it('shows the count on first open, then goes away', async () => {
    render(<MapLoadingCard catalogLoading={false} />);
    act(() => wantSprites(['/a.png', '/b.png', '/c.png']));
    expect(screen.getByTestId('loading-card').textContent).toContain('Loading part pictures…');
    expect(screen.getByTestId('loading-count').textContent).toBe('0 of 3');
    finish('/a.png');
    await settle();
    expect(screen.getByTestId('loading-count').textContent).toBe('1 of 3');
    finish('/b.png');
    finish('/c.png');
    await settle();
    expect(screen.queryByTestId('loading-card')).toBeNull();
    expect(screen.queryByTestId('loading-failed')).toBeNull();
  });

  it('says plainly what failed and retries it', async () => {
    render(<MapLoadingCard catalogLoading={false} />);
    act(() => wantSprites(['/a.png', '/b.png']));
    finish('/a.png', false);
    finish('/b.png', false);
    await settle();
    expect(screen.getByTestId('loading-failed').textContent).toContain("2 pictures couldn't load");
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.queryByTestId('loading-failed')).toBeNull();
    expect(screen.getByTestId('loading-count').textContent).toBe('0 of 2');
    finish('/a.png');
    finish('/b.png');
    await settle();
    expect(screen.queryByTestId('loading-card')).toBeNull();
    expect(screen.queryByTestId('loading-failed')).toBeNull();
  });

  it('hides the failure message when asked', async () => {
    render(<MapLoadingCard catalogLoading={false} />);
    act(() => wantSprites(['/a.png']));
    finish('/a.png', false);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Hide this message' }));
    expect(screen.queryByTestId('loading-failed')).toBeNull();
  });

  it('waits a moment before showing a later batch', async () => {
    render(<MapLoadingCard catalogLoading={false} />);
    act(() => wantSprites(['/a.png']));
    finish('/a.png');
    await settle();
    vi.useFakeTimers();
    act(() => wantSprites(['/b.png']));
    expect(screen.queryByTestId('loading-card')).toBeNull();
    act(() => vi.advanceTimersByTime(LATER_BATCH_DELAY_MS + 10));
    expect(screen.getByTestId('loading-count').textContent).toBe('0 of 1');
  });
});

describe('pictures left out of the counter', () => {
  it('does not count the parts panel thumbnails', async () => {
    const p = ensureSprite('/thumb.png', { count: false });
    expect(getSpriteProgress()).toMatchObject({ wanted: 0 });
    finish('/thumb.png');
    await p;
    expect(getSpriteProgress()).toMatchObject({ wanted: 0, loaded: 0 });
  });
});
