// A big layout with a mouse: how much drawing a pan, a turn of the wheel and
// a box-select do, counted (not timed, so it holds on any machine).
//
//  - Panning with the middle button and zooming with the wheel draw the hit
//    canvas (what a click lands on) once when the view stops, not on every
//    frame; a click straight after the wheel still picks the part under it.
//  - While the view moves, the map is one picture that moves with it
//    (viewBitmap.ts): a 60-frame pan draws no part, the parts are drawn
//    sharp again when it stops, an edit during the pan shows during the pan,
//    and a click straight after the pan picks the part under it.
//  - And while it moves, the canvases themselves are moved by CSS: a
//    60-frame pan commits nothing in React (it rendered the map's canvas on
//    every frame), and Konva's stage stays put until the pan ends.
//  - 40 notches of the wheel commit next to nothing in React: the zoom
//    readout is written straight from the store, and the stage catches up
//    to the picture without a render. The readout, the zoom buttons and the
//    keyboard still show the right zoom.
//  - Dragging a box redraws no part: only the box. It used to redraw every
//    part (and the grid) on each mouse move, as the rulers and grid lines
//    came along with new point arrays.
//  - Export as image gives a real PNG of the size asked for.
//  - A press in the very task the view stops in (no frame between, as a
//    fast click lands in a production build) picks the part under it, after
//    a pan, a turn of the wheel and a pinch: the hit canvas isn't drawn
//    while the view moves, and was only drawn again on the next frame.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn, mapMenu } from '../helpers';

const FORDYCE_BBM = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures/fordyce-2026.bbm'),
  'utf-8',
);

type Counts = { hits: number; partsScene: number; otherScene: number };

/** Counts hit-canvas shape draws, and scene draws on the parts sheet and elsewhere, from now. */
async function count(page: Page): Promise<() => Promise<Counts>> {
  await page.evaluate(() => {
    type S = { drawHit: (...a: unknown[]) => unknown; drawScene: (...a: unknown[]) => unknown; __hit?: (...a: unknown[]) => unknown; __scene?: (...a: unknown[]) => unknown; getLayer: () => { name: () => string } | null };
    const w = window as unknown as { Konva: { Shape: { prototype: S } }; __n: Counts };
    w.__n = { hits: 0, partsScene: 0, otherScene: 0 };
    const p = w.Konva.Shape.prototype;
    p.__hit ??= p.drawHit;
    p.__scene ??= p.drawScene;
    const hit = p.__hit;
    const scene = p.__scene;
    p.drawHit = function (this: S, ...a: unknown[]) {
      w.__n.hits++;
      return hit.apply(this, a);
    };
    p.drawScene = function (this: S, ...a: unknown[]) {
      if (this.getLayer()?.name() === 'parts-layer') w.__n.partsScene++;
      else w.__n.otherScene++;
      return scene.apply(this, a);
    };
  });
  return () => page.evaluate(() => ({ ...(window as unknown as { __n: Counts }).__n }));
}

/** Draws every listening layer's hit canvas once; how many shapes that is. */
async function oneHitDraw(page: Page): Promise<number> {
  const done = await count(page);
  await page.evaluate(() => {
    const st = (window as unknown as { Konva: { stages: { getLayers: () => { isListening: () => boolean; drawHit: () => void }[] }[] } }).Konva.stages[0]!;
    for (const l of st.getLayers()) if (l.isListening()) l.drawHit();
  });
  return (await done()).hits;
}

/** The screen point of a part near the view's centre, big enough to click (run in the page). */
function findPartNearCentre(): { x: number; y: number; name: string } | null {
  {
    type N = { name: () => string; getClassName: () => string; getClientRect: () => { x: number; y: number; width: number; height: number } };
    const st = (window as unknown as { Konva: { stages: { container: () => HTMLElement; find: (f: (n: N) => boolean) => N[] }[] } }).Konva.stages[0]!;
    const b = st.container().getBoundingClientRect();
    let best: { x: number; y: number; d: number } | null = null;
    for (const n of st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-'))) {
      const r = n.getClientRect();
      if (r.width < 12 || r.height < 12) continue;
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      if (x < 40 || y < 40 || x > b.width - 40 || y > b.height - 40) continue;
      const d = Math.hypot(x - b.width / 2, y - b.height / 2);
      if (!best || d < best.d) best = { x: b.left + x, y: b.top + y, d, name: n.name() };
    }
    return best;
  }
}

/** The screen point of a part near the view's centre, big enough to click. */
function partNearCentre(page: Page): Promise<{ x: number; y: number; name: string } | null> {
  return page.evaluate(findPartNearCentre);
}

/**
 * In one task of the page, with no frame between: `stop` ends the move
 * (or waits, task by task, until the view has stopped), then the part near
 * the centre is pressed and let go, with the mouse or a finger. Gives the
 * part pressed, or null when there was none.
 */
function pressRightAfter(page: Page, how: { stop: 'pan' | 'wheel' | 'pinch'; at: { x: number; y: number } }): Promise<string | null> {
  return page.evaluate(
    async ([src, how]) => {
      const find = new Function(`return (${src})`)() as () => { x: number; y: number; name: string } | null;
      type St = { content: HTMLElement; container: () => HTMLElement };
      const st = (window as unknown as { Konva: { stages: St[] } }).Konva.stages[0]!;
      // The view counts as still once its hits are back (render/viewMoving.ts).
      const still = () => !('viewMoving' in st.container().dataset);
      const el = st.content;
      const mouse = (type: string, p: { x: number; y: number }, button: number) => {
        const init = { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, button, buttons: type.endsWith('down') ? 1 << (button === 1 ? 2 : 0) : 0 };
        el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...init, pointerType: 'mouse', isPrimary: true }) : new MouseEvent(type, init));
      };
      let id = 0;
      const touch = (type: string, pts: { x: number; y: number }[]) => {
        const touches = pts.map((p, i) => new Touch({ identifier: id + i, target: el, clientX: p.x, clientY: p.y }));
        const ev = new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches: type === 'touchend' ? [] : touches, targetTouches: type === 'touchend' ? [] : touches, changedTouches: touches });
        el.dispatchEvent(ev);
      };
      const { x, y } = how.at;
      if (how.stop === 'pan') {
        // The middle button was held down and moved; it's let go here.
        mouse('pointerup', how.at, 1);
        mouse('mouseup', how.at, 1);
      } else if (how.stop === 'wheel') {
        for (let i = 0; i < 4; i++) el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: -100 }));
        // The wheel has no "let go": the view stops a moment after the last
        // notch. The press comes in the first task after that.
        const tick = () => new Promise<void>((r) => {
          const ch = new MessageChannel();
          ch.port1.onmessage = () => r();
          ch.port2.postMessage(null);
        });
        while (!still()) await tick();
        const t0 = performance.now();
        while (still() && performance.now() - t0 < 50) await tick();
        while (!still()) await tick();
      } else {
        touch('touchstart', [{ x: x - 20, y }, { x: x + 20, y }]);
        for (let d = 30; d <= 60; d += 10) touch('touchmove', [{ x: x - d, y }, { x: x + d, y }]);
        touch('touchend', [{ x: x - 60, y }, { x: x + 60, y }]);
      }
      const part = find();
      if (!part) return null;
      id = 10;
      if (how.stop === 'pinch') {
        touch('touchstart', [part]);
        touch('touchend', [part]);
      } else {
        mouse('pointerdown', part, 0);
        mouse('mousedown', part, 0);
        mouse('pointerup', part, 0);
        mouse('mouseup', part, 0);
      }
      return part.name;
    },
    [findPartNearCentre.toString(), how] as const,
  );
}

test('a big layout: pan, zoom and box-select draw what changed, and the export is a real PNG', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `big-work-${Date.now()}@example.com`, 'Big Work');
  const res = await page.request.post('/api/layouts', { data: { title: 'Big work', bbm: FORDYCE_BBM } });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.getByTestId('loading-card')).toBeHidden({ timeout: 60000 });
  await expect(page.getByText('940 pieces').first()).toBeVisible();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(800);
  const area = (await page.locator('.konvajs-content').first().boundingBox())!;
  const c = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  const once = await oneHitDraw(page);
  expect(once).toBeGreaterThan(900);

  // ── Pan with the middle button: the hit canvas once, at the end. ──
  let done = await count(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down({ button: 'middle' });
  for (let i = 1; i <= 20; i++) await page.mouse.move(c.x + i * 5, c.y + i * 3);
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(300);
  const pan = await done();
  // One picture of the map when it starts moving and one sharp draw when it
  // stops; it was every part on every one of the 20 frames.
  expect(pan.partsScene, 'the parts draw once for the picture and once when the pan ends').toBeLessThanOrEqual(2.5 * 940);
  expect(pan.partsScene, 'and are drawn sharp again when it ends').toBeGreaterThan(900);
  expect(pan.hits, 'the hit canvas: once when the pan ends (it was every frame)').toBeLessThanOrEqual(1.5 * once);

  // ── The wheel: the same, and a click straight after picks the part under it. ──
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(500);
  done = await count(page);
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, i < 4 ? -100 : 100);
    await page.waitForTimeout(30);
  }
  const part = await partNearCentre(page);
  expect(part).not.toBeNull();
  await page.mouse.click(part!.x, part!.y);
  await expect(page.locator('footer')).toContainText(/selected: 1\b/);
  await page.waitForTimeout(400);
  const zoom = await done();
  expect(zoom.hits, 'the hit canvas: once or twice, not on every turn of the wheel').toBeLessThanOrEqual(2.5 * once);
  await page.keyboard.press('Escape');

  // ── A box-select drag: the box moves, the parts don't redraw. ──
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(500);
  await page.mouse.move(area.x + 3, area.y + 3);
  await page.mouse.down();
  await page.mouse.move(area.x + 10, area.y + 10);
  await page.waitForTimeout(100);
  done = await count(page);
  for (let i = 1; i <= 15; i++) await page.mouse.move(area.x + 10 + (area.width * 0.45 * i) / 15, area.y + 10 + ((area.height - 20) * i) / 15);
  await page.waitForTimeout(100);
  const drag = await done();
  await page.mouse.up();
  await expect(page.locator('footer')).toContainText(/selected: \d{2,}/);
  expect(drag.partsScene, 'no part redraws while the box moves (it was every part, every move)').toBeLessThan(50);
  expect(drag.otherScene, 'nor the grid').toBeLessThan(15 * 30);

  // ── Export as image: a real PNG, the size asked for. ──
  await mapMenu(page, 'Download & export', 'Export as image…');
  const dialog = page.getByRole('dialog', { name: 'Export / Print' });
  await dialog.getByLabel('Width (px)').fill('1200');
  const height = Number(await dialog.getByLabel('Height (px)').inputValue());
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export PNG' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('Big work.png');
  const png = readFileSync((await file.path())!);
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, height]);
});

/** Pans with the middle button, `frames` moves of a few pixels; leaves the button down. */
async function panHeld(page: Page, from: { x: number; y: number }, frames: number, step = { x: 4, y: 2 }): Promise<void> {
  for (let i = 1; i <= frames; i++) {
    await page.mouse.move(from.x + i * step.x, from.y + i * step.y);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  }
}

test('a big layout: while the view moves the map is one moving picture, kept up to date', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `big-pan-${Date.now()}@example.com`, 'Big Pan');
  const res = await page.request.post('/api/layouts', { data: { title: 'Big pan', bbm: FORDYCE_BBM } });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.getByTestId('loading-card')).toBeHidden({ timeout: 60000 });
  await expect(page.getByText('940 pieces').first()).toBeVisible();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(800);
  const area = (await page.locator('.konvajs-content').first().boundingBox())!;
  const c = { x: area.x + area.width / 2, y: area.y + area.height / 2 };

  // A first short pan; when it stops, the picture for the next one is
  // taken while the page is idle.
  await page.mouse.move(c.x, c.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(c.x + 10, c.y + 5);
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(2000);

  // ── 60 frames of panning: no part is drawn. ──
  let done = await count(page);
  await page.mouse.down({ button: 'middle' });
  await panHeld(page, { x: c.x + 10, y: c.y + 5 }, 60);
  const moving = await done();
  expect(moving.partsScene, 'no part draws while the view moves (it was every part, every frame)').toBeLessThan(50);
  expect(moving.hits, 'nor the hit canvas').toBeLessThan(50);
  done = await count(page);
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(300);
  const stopped = await done();
  // (Those the pan moved off screen aren't drawn: render/cullOffscreen.ts.)
  expect(stopped.partsScene, 'the parts are drawn sharp again when the view stops').toBeGreaterThan(700);

  // ── A click straight after the pan picks the part under it. ──
  const part = await partNearCentre(page);
  expect(part).not.toBeNull();
  await page.mouse.click(part!.x, part!.y);
  await expect(page.locator('footer')).toContainText(/selected: 1\b/);
  await page.waitForTimeout(2000);

  // ── An edit during a pan shows during the pan: the picture is drawn
  // again where the part was, not taken afresh from every part. ──
  const pieces = page.getByText('939 pieces').first();
  const at = { x: area.x + area.width / 2 - 200, y: area.y + area.height / 2 - 100 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: 'middle' });
  await panHeld(page, at, 10);
  /** The moving picture's pixels: kept (`keep`), or how many differ from those kept, and over how wide and tall a box. */
  const picture = (keep: boolean) =>
    page.evaluate((keep) => {
      const el = document.querySelector<HTMLCanvasElement>('canvas[data-view-bitmap]')!;
      const data = el.getContext('2d')!.getImageData(0, 0, el.width, el.height).data;
      const w = window as unknown as { __pic?: Uint8ClampedArray };
      if (keep) {
        w.__pic = data.slice();
        return { differ: 0, w: 0, h: 0, of: el.width * el.height };
      }
      const was = w.__pic!;
      let differ = 0;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -1;
      let y1 = -1;
      for (let i = 0; i < data.length; i += 4) {
        if (Math.abs(data[i]! - was[i]!) + Math.abs(data[i + 1]! - was[i + 1]!) + Math.abs(data[i + 2]! - was[i + 2]!) + Math.abs(data[i + 3]! - was[i + 3]!) <= 8) continue;
        differ++;
        const x = (i / 4) % el.width;
        const y = Math.floor(i / 4 / el.width);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
      return { differ, w: x1 - x0 + 1, h: y1 - y0 + 1, of: el.width * el.height };
    }, keep);
  await picture(true);
  done = await count(page);
  await page.keyboard.press('Delete');
  await expect(pieces).toBeVisible();
  await panHeld(page, { x: at.x + 40, y: at.y + 20 }, 20);
  const edited = await done();
  const changed = await picture(false);
  await page.mouse.up({ button: 'middle' });
  expect(changed.differ, 'the picture shows the part gone').toBeGreaterThan(0);
  expect(changed.w * changed.h, 'only around where it was').toBeLessThan(changed.of / 20);
  // (A patch for the part gone and one for its halo, some 50 parts each: 109 on the dev build.)
  expect(edited.partsScene, 'only the parts around it are drawn for the picture (it was every part)').toBeLessThan(940 / 4);
});

/** Counts React commits (both renderers: the page and the map's react-konva) through the devtools hook, from page load. */
async function countReactCommits(page: Page): Promise<() => Promise<number>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __commits: number; __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown };
    w.__commits = 0;
    let id = 0;
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      isDisabled: false,
      renderers: new Map(),
      inject: () => ++id,
      checkDCE: () => {},
      onScheduleFiberRoot: () => {},
      onCommitFiberRoot: () => {
        w.__commits++;
      },
      onPostCommitFiberRoot: () => {},
      onCommitFiberUnmount: () => {},
    };
  });
  return () => page.evaluate(() => (window as unknown as { __commits: number }).__commits);
}

test('a big layout: a pan renders nothing in React and moves the canvas, not the stage', async ({ page }) => {
  test.setTimeout(180_000);
  const commits = await countReactCommits(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `big-css-${Date.now()}@example.com`, 'Big CSS');
  const res = await page.request.post('/api/layouts', { data: { title: 'Big CSS pan', bbm: FORDYCE_BBM } });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.getByTestId('loading-card')).toBeHidden({ timeout: 60000 });
  await expect(page.getByText('940 pieces').first()).toBeVisible();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(1500);
  expect(await commits(), 'the hook sees React commit').toBeGreaterThan(10);
  const area = (await page.locator('.konvajs-content').first().boundingBox())!;
  const c = { x: area.x + area.width / 2, y: area.y + area.height / 2 };

  const stageAt = () =>
    page.evaluate(() => {
      const st = (window as unknown as { Konva: { stages: { x: () => number; y: () => number }[] } }).Konva.stages[0]!;
      const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.konvajs-content canvas')];
      return {
        x: st.x(),
        y: st.y(),
        moved: canvases.filter((el) => !('viewBitmap' in el.dataset) && el.style.transform !== '' && el.style.transform !== 'none').length,
        picture: canvases.filter((el) => 'viewBitmap' in el.dataset && el.style.display !== 'none').length,
      };
    });
  const before = await stageAt();

  // ── 60 frames of panning with the middle button. ──
  await page.mouse.move(c.x, c.y);
  await page.mouse.down({ button: 'middle' });
  await panHeld(page, c, 2);
  const start = await commits();
  await panHeld(page, { x: c.x + 8, y: c.y + 4 }, 60);
  const during = (await commits()) - start;
  const mid = await stageAt();
  expect(during, 'React commits during a 60-frame pan (it was one or more every frame)').toBeLessThanOrEqual(3);
  expect(mid.x, 'the stage stays where it was drawn').toBe(before.x);
  expect(mid.moved, 'the canvases are moved by CSS instead').toBeGreaterThan(2);
  expect(mid.picture, 'with the picture of the map under them').toBe(1);
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(400);

  // ── When it stops, the stage is where the view went, and the CSS is gone. ──
  const after = await stageAt();
  expect(after.x - before.x).toBeCloseTo(8 + 60 * 4, 0);
  expect(after.y - before.y).toBeCloseTo(4 + 60 * 2, 0);
  expect(after.moved, 'no canvas is left moved').toBe(0);
  expect(after.picture, 'and the picture is hidden').toBe(0);
  const view = await page.evaluate(() => {
    const st = (window as unknown as { Konva: { stages: { x: () => number }[] } }).Konva.stages[0]!;
    return st.x();
  });
  expect(view).toBe(after.x);

  // ── A pan further than the picture's margin: the stage catches up now and then, not every frame. ──
  await page.mouse.move(c.x, c.y);
  await page.mouse.down({ button: 'middle' });
  const farStart = await commits();
  await panHeld(page, c, 60, { x: -25, y: 0 });
  const far = (await commits()) - farStart;
  await page.mouse.up({ button: 'middle' });
  expect(far, 'a 1,500 px pan catches up a few times (a 700 px margin each side)').toBeLessThanOrEqual(12);
  await page.waitForTimeout(400);
  expect((await stageAt()).moved).toBe(0);

  // ── A click straight after picks the part under it. ──
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(500);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down({ button: 'middle' });
  await panHeld(page, c, 10);
  await page.mouse.up({ button: 'middle' });
  const part = await partNearCentre(page);
  expect(part).not.toBeNull();
  await page.mouse.click(part!.x, part!.y);
  await expect(page.locator('footer')).toContainText(/selected: 1\b/);

  // ── And a click in the very task the pan ends in. ──
  // (A fast click landed before the frame that draws the hit canvas
  // again: it hit nothing and its box picked the two parts under it.)
  await page.keyboard.press('Escape');
  await expect(page.locator('footer')).not.toContainText(/selected: \d/);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down({ button: 'middle' });
  await panHeld(page, c, 10);
  expect(await pressRightAfter(page, { stop: 'pan', at: { x: c.x + 40, y: c.y + 20 } })).not.toBeNull();
  await expect(page.locator('footer')).toContainText(/selected: 1\b/);

  // ── Or the task the wheel stops in. ──
  await page.keyboard.press('Escape');
  await expect(page.locator('footer')).not.toContainText(/selected: \d/);
  expect(await pressRightAfter(page, { stop: 'wheel', at: c })).not.toBeNull();
  await expect(page.locator('footer')).toContainText(/selected: 1\b/);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });

  test('a big layout: a tap in the very task a pinch ends in picks the part under it', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1400, height: 900 });
    await signIn(page, `big-pinch-${Date.now()}@example.com`, 'Big Pinch');
    const res = await page.request.post('/api/layouts', { data: { title: 'Big pinch', bbm: FORDYCE_BBM } });
    expect(res.ok()).toBe(true);
    const { id } = (await res.json()) as { id: string };
    await page.goto(`/editor/${id}`);
    await expect(page.getByTestId('loading-card')).toBeHidden({ timeout: 60000 });
    await expect(page.getByText('940 pieces').first()).toBeVisible();
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await page.waitForTimeout(1500);
    const area = (await page.locator('.konvajs-content').first().boundingBox())!;
    const c = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
    const zoom = () => page.evaluate(() => (window as unknown as { Konva: { stages: { scaleX: () => number }[] } }).Konva.stages[0]!.scaleX());
    const before = await zoom();
    expect(await pressRightAfter(page, { stop: 'pinch', at: c })).not.toBeNull();
    expect(await zoom(), 'the pinch zoomed in').toBeGreaterThan(before);
    await expect(page.locator('footer')).toContainText(/selected: 1\b/);
  });
});

test('a big layout: a turn of the wheel renders next to nothing in React, and the zoom readout keeps up', async ({ page }) => {
  test.setTimeout(180_000);
  const commits = await countReactCommits(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `big-wheel-${Date.now()}@example.com`, 'Big Wheel');
  const res = await page.request.post('/api/layouts', { data: { title: 'Big wheel zoom', bbm: FORDYCE_BBM } });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.getByTestId('loading-card')).toBeHidden({ timeout: 60000 });
  await expect(page.getByText('940 pieces').first()).toBeVisible();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(1500);
  const area = (await page.locator('.konvajs-content').first().boundingBox())!;
  const c = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  const readout = page.getByTestId('zoom-readout');
  /** The zoom the map is drawn at, as the readout shows it. */
  const stageZoom = () =>
    page.evaluate(() => `${Math.round((window as unknown as { Konva: { stages: { scaleX: () => number }[] } }).Konva.stages[0]!.scaleX() * 100)}%`);
  const atStart = await readout.textContent();
  expect(atStart).toBe(await stageZoom());

  // ── 40 notches of the wheel in one go: 20 in, 20 out. ──
  await page.mouse.move(c.x, c.y);
  const start = await commits();
  let midReadout = '';
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, i < 20 ? -100 : 100);
    await page.waitForTimeout(30);
    if (i === 19) midReadout = (await readout.textContent()) ?? '';
  }
  const during = (await commits()) - start;
  expect(midReadout, 'the readout follows the wheel while it turns').not.toBe(atStart);
  expect(during, 'React commits during 40 notches of the wheel (it was about 50)').toBeLessThanOrEqual(5);
  await page.waitForTimeout(500);
  expect(await readout.textContent(), 'the readout shows the zoom the wheel stopped at').toBe(await stageZoom());

  // ── The zoom buttons and the keyboard still zoom, and the readout says so. ──
  const before = await readout.textContent();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.waitForTimeout(400);
  const afterButton = await readout.textContent();
  expect(afterButton).not.toBe(before);
  expect(afterButton).toBe(await stageZoom());
  await page.mouse.click(area.x + 5, area.y + 5);
  await page.keyboard.press('Control+-');
  await page.waitForTimeout(400);
  const afterKey = await readout.textContent();
  expect(afterKey).not.toBe(afterButton);
  expect(afterKey).toBe(await stageZoom());
});
