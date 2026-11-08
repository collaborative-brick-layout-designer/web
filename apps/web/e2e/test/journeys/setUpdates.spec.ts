// Journey — a placed set says when its set changed, and updates in place.
//
//   Sam places his custom set "Yard" (two of his parts) → the set gets a
//   third part (sent from elsewhere: another tab, the desktop) → the layout
//   says "Update available" without a reload, and so does the set's
//   right-click menu → Update puts the new parts where the set is, in one
//   step → Undo puts the old ones back → after Redo and a reload, it's
//   up to date and says nothing → a duplicate of it keeps track too, and
//   Update all brings both up to date.
// A set inside a set: Sam places "Depot", which holds his set "Yard" → Yard
//   changes → Depot says "Update available" → Update brings in the whole new
//   Yard inside it, in one undo step.

import { test, expect, type Page } from '@playwright/test';
import { signIn } from '../../helpers';

const ts = Date.now();
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const XML = Buffer.from('<?xml version="1.0"?><part><Author>e2e</Author></part>').toString('base64');
const SHED = `SHED${ts}`;
const LAMP = `LAMP${ts}`;
const YARD = `Yard ${ts}`;
const setXml = (ids: string[], name = YARD) =>
  Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>\n<group>\n\t<Description><en>${name}</en></Description>\n\t<SubPartList>\n` +
      ids.map((id, i) => `\t\t<SubPart id="${id}"><position><x>${i * 8}</x><y>0</y></position><angle>0</angle></SubPart>\n`).join('') +
      '\t</SubPartList>\n</group>\n',
  ).toString('base64');

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}

test('a placed set says Update available when its set changes, and updates in place', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, `j-setupd-${ts}@example.com`, 'Sam');
  for (const n of [SHED, LAMP]) {
    const r = await page.request.post('/api/custom-parts', { data: { partNumber: n, displayName: n, xmlBase64: XML, spriteBase64: PNG, spriteMime: 'image/png' } });
    expect(r.status()).toBe(201);
  }
  const made = await page.request.post('/api/custom-parts', { data: { partNumber: YARD, displayName: YARD, xmlBase64: setXml([SHED, LAMP]) } });
  expect(made.status()).toBe(201);
  const setId = ((await made.json()) as { id: string }).id;
  const layout = (await (await page.request.post('/api/layouts', { data: { title: 'Set updates' } })).json()) as { id: string };
  await page.goto(`/editor/${layout.id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('html')).toHaveAttribute('data-live', 'open', { timeout: 15000 });

  // ── Sam places the yard: no update to offer. ──
  await page.getByPlaceholder('Search parts (name or number)').first().fill(YARD);
  const tile = page.locator('aside li button[draggable="true"]').filter({ hasText: YARD }).first();
  await expect(tile).toBeVisible({ timeout: 15000 });
  await tile.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('footer')).toContainText(`Placed set: ${YARD} (2 parts)`);
  await expect.poll(() => brickCount(page)).toBe(2);
  const bar = page.getByTestId('set-updates');
  await expect(bar).toHaveCount(0);

  // ── The set gets a third part, from elsewhere: Update available, without a reload. ──
  const put = await page.request.put(`/api/custom-parts/${setId}`, { data: { partNumber: YARD, displayName: YARD, xmlBase64: setXml([SHED, LAMP, LAMP]) } });
  expect(put.ok()).toBe(true);
  await expect(bar).toContainText(`Update available: the set “${YARD}” changed since it was placed.`, { timeout: 15000 });
  await expect(bar.getByRole('button', { name: /help/i })).toBeVisible();
  // Its right-click menu says so too (the set is still picked).
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await expect(page.getByRole('button', { name: `Update set “${YARD}”` })).toBeVisible();
  await page.keyboard.press('Escape');

  // ── Update: the new parts, where the set is, and the bar goes. ──
  await bar.getByRole('button', { name: 'Update', exact: true }).click();
  await expect.poll(() => brickCount(page)).toBe(3);
  await expect(page.getByTestId('notice')).toContainText(`Updated “${YARD}” to its newest version.`);
  await expect(bar).toHaveCount(0);
  const bbm = async () => (await (await page.request.get(`/api/layouts/${layout.id}/export.bbm`)).text());
  await expect.poll(async () => [...(await bbm()).matchAll(/<Group id="/g)].length).toBe(1);
  // The .bbm stays what BlueBrick reads: the set's version is in the sidecar only.
  const catalog = (await (await page.request.get('/api/parts/catalog')).json()) as { parts: { key: string; setVersion?: string }[] };
  const version = catalog.parts.find((p) => p.key === `custom:${setId}`)?.setVersion;
  expect(version).toMatch(/^[0-9a-f]{16}$/);
  expect(await bbm()).not.toContain(version!);

  // ── Undo puts the old parts back (and the update on offer); Redo brings the new ones. ──
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+z');
  await expect.poll(() => brickCount(page)).toBe(2);
  await expect(bar).toBeVisible();
  await page.keyboard.press('Control+y');
  await expect.poll(() => brickCount(page)).toBe(3);
  await expect(bar).toHaveCount(0);

  // ── After a reload it's up to date. ──
  await expect.poll(async () => [...(await bbm()).matchAll(/<Brick id="/g)].length, { timeout: 15000 }).toBe(3);
  await page.reload();
  await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(3);
  await expect(page.getByTestId('set-updates')).toHaveCount(0);

  // ── A duplicate of the placed set keeps track too: the next change offers both. ──
  await expect(page.locator('html')).toHaveAttribute('data-live', 'open', { timeout: 15000 });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+d');
  await expect.poll(() => brickCount(page)).toBe(6);
  const again = await page.request.put(`/api/custom-parts/${setId}`, { data: { partNumber: YARD, displayName: YARD, xmlBase64: setXml([SHED, LAMP]) } });
  expect(again.ok()).toBe(true);
  await expect(bar).toContainText(`“${YARD}” (2 placed) changed since it was placed.`, { timeout: 15000 });
  await bar.getByRole('button', { name: 'Update all 2' }).click();
  await expect.poll(() => brickCount(page)).toBe(4);
  await expect(bar).toHaveCount(0);
});

test('a set inside a set: a change to the inner set offers an update for the outer one', async ({ page }) => {
  test.setTimeout(180_000);
  const t = `${ts}n`;
  const shed = `SHED${t}`;
  const lamp = `LAMP${t}`;
  const yard = `Yard ${t}`;
  const depot = `Depot ${t}`;
  await signIn(page, `j-setnest-${ts}@example.com`, 'Sam');
  for (const n of [shed, lamp]) {
    const r = await page.request.post('/api/custom-parts', { data: { partNumber: n, displayName: n, xmlBase64: XML, spriteBase64: PNG, spriteMime: 'image/png' } });
    expect(r.status()).toBe(201);
  }
  const inner = await page.request.post('/api/custom-parts', { data: { partNumber: yard, displayName: yard, xmlBase64: setXml([shed, lamp], yard) } });
  expect(inner.status()).toBe(201);
  const yardId = ((await inner.json()) as { id: string }).id;
  const outer = await page.request.post('/api/custom-parts', { data: { partNumber: depot, displayName: depot, xmlBase64: setXml([yard, lamp], depot) } });
  expect(outer.status()).toBe(201);
  const layout = (await (await page.request.post('/api/layouts', { data: { title: 'Nested set updates' } })).json()) as { id: string };
  await page.goto(`/editor/${layout.id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('html')).toHaveAttribute('data-live', 'open', { timeout: 15000 });

  // ── Sam places the depot: Yard's two parts and a lamp. ──
  await page.getByPlaceholder('Search parts (name or number)').first().fill(depot);
  const tile = page.locator('aside li button[draggable="true"]').filter({ hasText: depot }).first();
  await expect(tile).toBeVisible({ timeout: 15000 });
  await tile.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => brickCount(page)).toBe(3);
  const bar = page.getByTestId('set-updates');
  await expect(bar).toHaveCount(0);

  // ── Yard, inside it, gets a third part: the depot offers an update, without a reload. ──
  const put = await page.request.put(`/api/custom-parts/${yardId}`, { data: { partNumber: yard, displayName: yard, xmlBase64: setXml([shed, lamp, lamp], yard) } });
  expect(put.ok()).toBe(true);
  await expect(bar).toContainText(`Update available: the set “${depot}” changed since it was placed.`, { timeout: 15000 });

  // ── Update brings in the whole new structure; one Undo takes it all back. ──
  await bar.getByRole('button', { name: 'Update', exact: true }).click();
  await expect.poll(() => brickCount(page)).toBe(4);
  await expect(bar).toHaveCount(0);
  const bbm = async () => (await (await page.request.get(`/api/layouts/${layout.id}/export.bbm`)).text());
  // The depot's group and Yard's inside it.
  await expect.poll(async () => [...(await bbm()).matchAll(/<Group id="/g)].length, { timeout: 15000 }).toBe(2);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+z');
  await expect.poll(() => brickCount(page)).toBe(3);
  await expect(bar).toBeVisible();
});
