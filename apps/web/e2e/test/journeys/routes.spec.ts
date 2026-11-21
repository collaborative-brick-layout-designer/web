// Named routes (trains design Phase 2): draw a route by clicking two places
// on the track, name and save it; it is still there after a reload, and a
// second browser sees it live. The eye hides it on your map only. Taking a
// piece of track out from under it turns it Broken (dashed red, kept);
// Find a new way finds the way round the other side of the loop. Set
// switches sets its switches; delete asks first. A .bbm download says
// routes are left out. Go the other way sends the train the whole loop
// round instead (it never turns around on the spot), arrows showing which
// way it runs.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { mapMenu, signIn } from '../../helpers';

const BBM = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures/tight-corner.bbm'), 'utf-8');

/** The monorail straights in the fixture (loose parts, not in sets), with their centres in studs. */
const STRAIGHTS = [...BBM.matchAll(/<Brick id="([^"]+)">[\s\S]*?<DisplayArea>\s*<X>([^<]*)<\/X>\s*<Y>([^<]*)<\/Y>\s*<Width>([^<]*)<\/Width>\s*<Height>([^<]*)<\/Height>\s*<\/DisplayArea>\s*<MyGroup \/>\s*<PartNumber>267[01]\.7<\/PartNumber>/g)].map((m) => ({
  id: m[1]!,
  x: Number(m[2]) + Number(m[4]) / 2,
  y: Number(m[3]) + Number(m[5]) / 2,
}));

/** Where a point in studs is on the page now. */
function onPage(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([sx, sy]) => {
      type St = { getAbsoluteTransform: () => { point: (p: { x: number; y: number }) => { x: number; y: number } }; container: () => HTMLElement };
      const st = (window as unknown as { Konva: { stages: St[] } }).Konva.stages[0]!;
      const p = st.getAbsoluteTransform().point({ x: sx! * 8, y: sy! * 8 });
      const box = st.container().getBoundingClientRect();
      return { x: box.left + p.x, y: box.top + p.y };
    },
    [x, y],
  );
}

/** How the route is drawn on the map: its lines' colors and whether they are dashed; empty when not drawn. */
function drawn(page: Page, id: string): Promise<{ stroke: string; dashed: boolean }[]> {
  return page.evaluate((rid) => {
    type N = { name: () => string; getClassName: () => string; getAttr: (k: string) => unknown; find: (f: (n: N) => boolean) => N[] };
    const st = (window as unknown as { Konva: { stages: N[] } }).Konva.stages[0]!;
    return st
      .find((n) => n.name() === `route-${rid}`)
      .flatMap((g) => g.find((n) => n.name() === 'route-line'))
      .map((l) => ({ stroke: String(l.getAttr('stroke')), dashed: Array.isArray(l.getAttr('dash')) }));
  }, id);
}

async function serverRoutes(page: Page, id: string): Promise<{ id: string; name: string; steps: { brick: string }[] }[]> {
  const r = await page.request.get(`/api/layouts/${id}/export.bbm.bld`);
  return r.ok() ? (((await r.json()) as { routes?: { id: string; name: string; steps: { brick: string }[] }[] }).routes ?? []) : [];
}

async function openRoutesPanel(page: Page) {
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel('Routes', { exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('routes-panel')).toBeVisible();
}

test('draw a route, keep it, share it, hide it, break it and mend it', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `routes-${Date.now()}@example.com`, 'Route Maker');
  const created = await page.request.post('/api/layouts', { data: { title: 'Routes', bbm: BBM } });
  const { id } = (await created.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.keyboard.press('f');
  await openRoutesPanel(page);
  await expect(page.getByTestId('routes-panel')).toContainText('No routes yet');

  // Two loose straights (a part in a set goes with its set) on the longest such run, well apart.
  const loose = new Set([...BBM.matchAll(/<Brick id="([^"]+)">\s*<DisplayArea>[\s\S]*?<\/DisplayArea>\s*<MyGroup \/>/g)].map((m) => m[1]!));
  const rows = new Map<number, typeof STRAIGHTS>();
  for (const s of STRAIGHTS.filter((t) => loose.has(t.id))) rows.set(Math.round(s.y), [...(rows.get(Math.round(s.y)) ?? []), s]);
  const bottom = [...rows.values()].sort((p, q) => q.length - p.length)[0]!.sort((p, q) => p.x - q.x);
  expect(bottom.length).toBeGreaterThan(6);
  const a = bottom[1]!;
  const b = bottom[bottom.length - 2]!;

  // New route: click its start, then its end, on the track.
  await page.getByTestId('route-new').click();
  const banner = page.getByTestId('route-draft-banner');
  await expect(banner).toContainText('where it starts');
  let p = await onPage(page, a.x, a.y);
  await page.mouse.click(p.x, p.y);
  await expect(banner).toContainText('where it ends');
  p = await onPage(page, b.x, b.y);
  await page.mouse.click(p.x, p.y);
  await expect(banner).toContainText('along the track');
  await banner.getByLabel('Route name').fill('Bottom run');
  await banner.getByRole('button', { name: 'Save route' }).click();
  await expect(banner).toHaveCount(0);
  const row = page.getByRole('list', { name: 'Routes' }).getByRole('listitem').filter({ hasText: 'Bottom run' });
  await expect(row.getByTestId('route-status')).toHaveText('OK');
  await expect(row.getByTestId('route-length')).toBeVisible();
  await expect.poll(async () => (await serverRoutes(page, id)).map((r) => r.name)).toEqual(['Bottom run']);
  const route = (await serverRoutes(page, id))[0]!;
  await expect.poll(async () => (await drawn(page, route.id)).length).toBeGreaterThan(0);

  // A second browser sees it, live, and keeps its own eye.
  const other = await browser.newContext();
  const theirs = await other.newPage();
  await theirs.setViewportSize({ width: 1400, height: 900 });
  await theirs.context().addCookies(await page.context().cookies());
  await theirs.goto(`/editor/${id}`);
  await expect(theirs.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await openRoutesPanel(theirs);
  await expect(theirs.getByRole('list', { name: 'Routes' })).toContainText('Bottom run');
  await expect.poll(async () => (await drawn(theirs, route.id)).length).toBeGreaterThan(0);

  // Hidden on my map only; kept hidden after a reload.
  await row.getByRole('button', { name: 'Hide Bottom run on your map' }).click();
  await expect.poll(async () => (await drawn(page, route.id)).length).toBe(0);
  await expect.poll(async () => (await drawn(theirs, route.id)).length).toBeGreaterThan(0);
  await page.reload();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('list', { name: 'Routes' })).toContainText('Bottom run');
  await page.waitForTimeout(800);
  expect((await drawn(page, route.id)).length).toBe(0);
  await page.getByRole('button', { name: 'Show Bottom run on your map' }).click();
  await expect.poll(async () => (await drawn(page, route.id)).length).toBeGreaterThan(0);

  // Take a piece out from under it (on the other browser): Broken, live, drawn dashed red, and kept.
  const middle = route.steps.slice(1, -1).map((s) => s.brick).filter((bid) => loose.has(bid) && STRAIGHTS.some((t) => t.id === bid));
  expect(middle.length).toBeGreaterThan(0);
  const victim = middle[Math.floor(middle.length / 2)]!;
  await theirs.evaluate((bid) => {
    type N = { name: () => string; fire: (t: string, e: unknown, bubble: boolean) => void; find: (f: (n: N) => boolean) => N[] };
    const st = (window as unknown as { Konva: { stages: N[] } }).Konva.stages[0]!;
    const g = st.find((n) => n.name() === `brick-${bid}`)[0]!;
    g.fire('click', { evt: new MouseEvent('click', { button: 0 }) }, true);
  }, victim);
  await theirs.keyboard.press('Delete');
  const row2 = page.getByRole('list', { name: 'Routes' }).getByRole('listitem').filter({ hasText: 'Bottom run' });
  await expect(row2.getByTestId('route-status')).toHaveText('Broken', { timeout: 15000 });
  await expect.poll(async () => (await drawn(page, route.id)).every((l) => l.dashed && l.stroke === '#DC2626')).toBe(true);

  // Find a new way: round the other side of the monorail loop.
  await row2.getByRole('button', { name: 'Find a new way' }).click();
  await expect(page.getByText('Found a new way for “Bottom run”.')).toBeVisible();
  await expect(row2.getByTestId('route-status')).not.toHaveText('Broken');
  await expect(theirs.getByRole('list', { name: 'Routes' }).getByTestId('route-status')).not.toHaveText('Broken', { timeout: 15000 });
  await other.close();

  // A .bbm download says BlueBrick leaves routes out.
  await mapMenu(page, 'Download & export', 'Download as…');
  const dialog = page.getByRole('dialog', { name: 'Download As' });
  await dialog.getByLabel('BlueBrick map (.bbm)').check();
  await expect(dialog.getByText(/routes/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Delete asks first; Undo brings it back.
  await row2.getByRole('button', { name: 'Delete', exact: true }).click();
  await row2.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByTestId('routes-panel')).toContainText('No routes yet');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(page.getByRole('list', { name: 'Routes' })).toContainText('Bottom run');
});

/** How many direction arrows are drawn: on the route being drawn, or on a saved one. */
function arrows(page: Page, group: string): Promise<number> {
  return page.evaluate((g) => {
    type N = { name: () => string; find: (f: (n: N) => boolean) => N[] };
    const st = (window as unknown as { Konva: { stages: N[] } }).Konva.stages[0]!;
    return st.find((n) => n.name() === g).flatMap((x) => x.find((n) => n.name() === 'route-arrow' || n.name() === 'route-draft-arrow')).length;
  }, group);
}

test('go the other way: the train runs the whole loop round, arrows showing the way', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `routes-loop-${Date.now()}@example.com`, 'Route Maker');
  const { id } = (await (await page.request.post('/api/layouts', { data: { title: 'Routes loop', bbm: BBM } })).json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.keyboard.press('f');
  await openRoutesPanel(page);

  const loose = new Set([...BBM.matchAll(/<Brick id="([^"]+)">\s*<DisplayArea>[\s\S]*?<\/DisplayArea>\s*<MyGroup \/>/g)].map((m) => m[1]!));
  const rows = new Map<number, typeof STRAIGHTS>();
  for (const s of STRAIGHTS.filter((t) => loose.has(t.id))) rows.set(Math.round(s.y), [...(rows.get(Math.round(s.y)) ?? []), s]);
  const bottom = [...rows.values()].sort((p, q) => q.length - p.length)[0]!.sort((p, q) => p.x - q.x);
  const a = bottom[2]!;
  const b = bottom[4]!;
  const between = new Set(bottom.slice(3, 4).map((t) => t.id));

  // Two places close together: the shortest way runs straight between them.
  await page.getByTestId('route-new').click();
  const banner = page.getByTestId('route-draft-banner');
  let p = await onPage(page, a.x, a.y);
  await page.mouse.click(p.x, p.y);
  p = await onPage(page, b.x, b.y);
  await page.mouse.click(p.x, p.y);
  await expect(banner).toContainText('the way the arrows point');
  await expect.poll(() => arrows(page, 'route-draft')).toBeGreaterThan(0);
  const shortText = await banner.textContent();

  // Go the other way: the whole loop round, and back to the end from the other side.
  await banner.getByTestId('route-flip').click();
  await expect(banner).not.toHaveText(shortText ?? '');
  await expect(banner).toContainText('the way the arrows point');
  await expect.poll(() => arrows(page, 'route-draft')).toBeGreaterThan(1);
  await banner.getByLabel('Route name').fill('Long way round');
  await banner.getByRole('button', { name: 'Save route' }).click();
  await expect(banner).toHaveCount(0);
  await expect.poll(async () => (await serverRoutes(page, id)).map((r) => r.name)).toEqual(['Long way round']);
  const route = (await serverRoutes(page, id))[0]!;
  // It runs round the loop (far more track than between the two), and not across the piece between them.
  expect(route.steps.length).toBeGreaterThan(bottom.length);
  expect(route.steps.slice(1, -1).some((s) => between.has(s.brick))).toBe(false);
  const row = page.getByRole('list', { name: 'Routes' }).getByRole('listitem').filter({ hasText: 'Long way round' });
  await expect(row.getByTestId('route-status')).toHaveText('OK');
  await expect.poll(() => arrows(page, `route-${route.id}`)).toBeGreaterThan(1);
});

test('a click off the track asks again, and Esc stops drawing', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `routes-none-${Date.now()}@example.com`, 'Route Maker');
  const { id } = (await (await page.request.post('/api/layouts', { data: { title: 'Routes none', bbm: BBM } })).json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.keyboard.press('f');
  await openRoutesPanel(page);
  await page.getByTestId('route-new').click();
  const banner = page.getByTestId('route-draft-banner');
  // Off the track: it asks again.
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(box.x + 12, box.y + box.height - 12);
  await expect(page.getByText('Click on the track.')).toBeVisible();
  await expect(banner).toContainText('where it starts');
  await page.keyboard.press('Escape');
  await expect(banner).toHaveCount(0);
});
