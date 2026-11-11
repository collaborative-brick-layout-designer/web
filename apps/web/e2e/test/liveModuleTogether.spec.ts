// Two people editing one module at once (the full review's area 4 left it
// out). Sam and Alex both open Edit module on the same module of a shared
// layout and change it, in turn and at the same instant. After each
// exchange both browsers and the server must show the same parts in the
// same places and the same module: nobody's change lost, nothing there
// twice, and nobody left editing a module that is gone.
// SHOTS=<dir> saves light and dark pictures of the notice at the end.

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureUser, signIn, makeModule, confirmInDialog } from '../helpers';

const ts = Date.now();
const SAM = `modboth-sam-${ts}@example.com`;
const ALEX = `modboth-alex-${ts}@example.com`;
const PART = 'ts_narrowgauge_straight.8';
const NAME = `Yard ${ts % 10000}`;
const SHOTS = process.env.SHOTS;

/** Light and dark pictures of the page, once every part has its picture. */
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const missing = await page.evaluate(() => {
    type N = { name: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.name() === 'unresolved-part' || n.name() === 'brick-loading').length : -1;
  });
  expect(missing, 'parts without their picture').toBe(0);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

interface Brick {
  id: string;
  x: number;
  y: number;
  sx: number;
  sy: number;
}

function bricks(page: Page): Promise<Brick[]> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string; x: () => number; y: () => number; getAbsolutePosition: () => { x: number; y: number } };
    const st = (window as unknown as { Konva?: { stages: { container: () => HTMLElement; find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    if (!st) return [];
    const box = st.container().getBoundingClientRect();
    return st
      .find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-'))
      .map((n) => {
        const a = n.getAbsolutePosition();
        return { id: n.name().slice(6), x: Math.round(n.x() * 100) / 800, y: Math.round(n.y() * 100) / 800, sx: box.left + a.x, sy: box.top + a.y };
      });
  });
}

/** The part a click at this point of the page would pick (the one on top there), or null. */
function partAt(page: Page, at: { sx: number; sy: number }): Promise<string | null> {
  return page.evaluate((at) => {
    type N = { name: () => string; getClassName: () => string; getParent: () => N | null };
    const st = (window as unknown as { Konva?: { stages: { container: () => HTMLElement; getIntersection: (p: { x: number; y: number }) => N | null }[] } }).Konva?.stages[0];
    if (!st) return null;
    const box = st.container().getBoundingClientRect();
    let n = st.getIntersection({ x: at.sx - box.left, y: at.sy - box.top });
    while (n && !(n.getClassName() === 'Group' && n.name().startsWith('brick-'))) n = n.getParent();
    return n ? n.name().slice(6) : null;
  }, at);
}

/** Every part's place by id, for comparing two browsers. */
async function places(page: Page): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const b of await bricks(page)) {
    expect(out[b.id], `part ${b.id} is drawn twice`).toBeUndefined();
    out[b.id] = `${b.x},${b.y}`;
  }
  return out;
}

interface Mod {
  id: string;
  name: string;
  members: string[];
}
/** The layout's modules as the server has them. */
async function modules(page: Page, id: string): Promise<Mod[]> {
  const r = await page.request.get(`/api/layouts/${id}/export.bbm.bld`);
  return r.ok() ? (((await r.json()) as { modules?: Mod[] }).modules ?? []) : [];
}

/** Places one more straight piece from the Parts panel (it joins the module being edited). */
async function placePart(page: Page): Promise<void> {
  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
}

async function openModulesPanel(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel('Modules', { exact: true }).check();
  // (Esc closes the Panels list, and only that.)
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Modules', { exact: true })).toBeHidden();
}

test('two people editing one module at once keep each other’s changes', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await ensureUser(SAM, 'Sam');
  await ensureUser(ALEX, 'Alex');
  await signIn(page, SAM, 'Sam');
  const res = await page.request.post('/api/layouts', { data: { title: 'One module, two people' } });
  const { id } = (await res.json()) as { id: string };
  const invite = await page.request.post(`/api/layouts/${id}/invites`, { data: { email: ALEX, role: 'editor' } });
  const { token } = (await invite.json()) as { token: string };

  // Sam lays three pieces and makes them a module.
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  for (let i = 0; i < 3; i++) await placePart(page);
  await expect.poll(async () => (await bricks(page)).length).toBe(3);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+a');
  await makeModule(page, NAME);
  await expect.poll(async () => (await modules(page, id)).map((m) => m.members.length), { timeout: 10000 }).toEqual([3]);
  await page.keyboard.press('Escape');
  const first = await bricks(page);

  // Alex opens the layout.
  const alexCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const alex = await alexCtx.newPage();
  await signIn(alex, ALEX, 'Alex');
  await alex.request.post(`/api/invites/${token}`);
  await alex.goto(`/editor/${id}`);
  await expect(alex.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => (await bricks(alex)).length, { timeout: 15000 }).toBe(3);

  /** Both browsers and the server show the same parts and the same module members. */
  const settled = async (parts: number, members: number) => {
    await expect.poll(async () => (await bricks(page)).length, { timeout: 10000 }).toBe(parts);
    await expect.poll(async () => (await bricks(alex)).length, { timeout: 10000 }).toBe(parts);
    await expect.poll(async () => JSON.stringify(await places(alex)) === JSON.stringify(await places(page)), { timeout: 10000 }).toBe(true);
    await expect
      .poll(async () => (await modules(page, id)).map((m) => m.members.length), { timeout: 10000, message: 'parts in the module, on the server' })
      .toEqual([members]);
    // Every member is a part on the map, once.
    const mod = (await modules(page, id))[0]!;
    const onMap = new Set(Object.keys(await places(page)));
    expect(new Set(mod.members).size).toBe(mod.members.length);
    for (const m of mod.members) expect(onMap.has(m), `module member ${m} is a part on the map`).toBe(true);
  };

  // Both open Edit module on it: each bar says the other is there.
  await page.mouse.dblclick(first[1]!.sx, first[1]!.sy);
  await expect(page.getByTestId('module-edit-bar')).toContainText(`Editing module ${NAME}`);
  const alexFirst = await bricks(alex);
  await alex.mouse.dblclick(alexFirst[1]!.sx, alexFirst[1]!.sy);
  await expect(alex.getByTestId('module-edit-bar')).toContainText(`Editing module ${NAME}`);
  await expect(page.getByTestId('module-edit-others')).toHaveText('Alex is here too', { timeout: 10000 });
  await expect(alex.getByTestId('module-edit-others')).toHaveText('Sam is here too', { timeout: 10000 });

  // ── In turn ──
  // Sam nudges the part he picked: Alex sees it move.
  const nudged = first[1]!;
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await bricks(page)).find((b) => b.id === nudged.id)!.x).not.toBe(nudged.x);
  await settled(3, 3);
  // Alex adds a part: it joins the module, for both.
  await placePart(alex);
  await settled(4, 4);

  // ── At the same instant ──
  // Each adds a part: both parts are there, and both are in the module.
  await Promise.all([placePart(page), placePart(alex)]);
  await settled(6, 6);
  // Sam deletes one part while Alex nudges another. (The new parts lie on
  // top of each other, so each picks whatever is on top where they click.)
  const samSpot = (await bricks(page)).find((b) => b.id === nudged.id)!;
  const sams = await partAt(page, samSpot);
  expect(sams).not.toBeNull();
  await page.mouse.click(samSpot.sx, samSpot.sy);
  await expect(page.locator('footer')).toContainText('selected: 1');
  let hers: string | null = null;
  for (const b of await bricks(alex)) {
    const top = await partAt(alex, b);
    if (!top || top === sams) continue;
    hers = top;
    await alex.mouse.click(b.sx, b.sy);
    break;
  }
  expect(hers, 'a part for Alex that isn’t the one Sam picked').not.toBeNull();
  await expect(alex.locator('footer')).toContainText('selected: 1');
  const wereAt = await places(alex);
  await Promise.all([page.keyboard.press('Delete'), alex.keyboard.press('ArrowDown')]);
  await settled(5, 5);
  const areAt = await places(page);
  expect(areAt[sams!]).toBeUndefined();
  // The part Alex nudged moved, for Sam too; the rest stayed.
  expect(Object.keys(areAt).filter((p) => areAt[p] !== wereAt[p])).toEqual([hers]);
  // Both are still editing the module.
  await expect(page.getByTestId('module-edit-bar')).toBeVisible();
  await expect(alex.getByTestId('module-edit-bar')).toBeVisible();

  // ── A new name from one shows on the other's bar ──
  await openModulesPanel(alex);
  await alex.getByRole('button', { name: `More for ${NAME}` }).click();
  await alex.getByRole('menuitem', { name: 'Rename…' }).click();
  const RENAMED = `${NAME} east`;
  await alex.keyboard.press('Control+a');
  await alex.keyboard.type(RENAMED);
  await alex.keyboard.press('Enter');
  await expect(page.getByTestId('module-edit-bar')).toContainText(`Editing module ${RENAMED}`, { timeout: 10000 });
  await settled(5, 5);

  // ── The module is ungrouped by one while the other is still in it ──
  // (The note from making the module has gone by now.)
  await expect(page.getByText('is a module in this layout')).toBeHidden({ timeout: 15000 });
  await alex.getByRole('button', { name: `More for ${RENAMED}` }).click();
  await alex.getByRole('menuitem', { name: 'Ungroup (keep the parts)' }).click();
  await confirmInDialog(alex);
  await expect.poll(async () => (await modules(page, id)).length, { timeout: 10000 }).toBe(0);
  // Sam isn't left in Edit module for a module that is gone, and is told why.
  await expect(page.getByTestId('module-edit-bar')).toBeHidden({ timeout: 10000 });
  await shot(page, 'module-ungrouped');
  await expect(page.getByText(`“${RENAMED}” isn’t a module any more`)).toBeVisible();
  await expect(alex.getByTestId('module-edit-bar')).toBeHidden();
  // The parts are all still there, for both.
  await expect.poll(async () => (await bricks(page)).length).toBe(5);
  await expect.poll(async () => JSON.stringify(await places(alex)) === JSON.stringify(await places(page)), { timeout: 10000 }).toBe(true);

  await alexCtx.close();
});
