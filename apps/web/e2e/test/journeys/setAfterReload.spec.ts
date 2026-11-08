// Journey — a set you just saved is in the Parts panel after a reload.
//
//   The catalog used to be kept by the browser for a minute, so a set saved
//   (or renamed) within that minute could miss from the Parts panel, live
//   and after a reload, until the list was fetched again. It only showed
//   live when the live hint came through and fetched past that copy. Here
//   the live hints are held back, the way a dropped connection would:
//   Save selection as set… → the set is in the Parts panel → reload → still
//   there → Rename set… → reload → there under its new name → a set sent
//   from elsewhere (the desktop, another tab) → reload → it's there.

import { test, expect } from '@playwright/test';
import { mapMenu, signIn } from '../../helpers';

const ts = Date.now();
const PART = 'ts_narrowgauge_straight.8';
const SET = `Reload set ${ts}`;
const RENAMED = `Reloaded yard ${ts}`;
const ELSEWHERE = `Desktop set ${ts}`;

test('a new or renamed set is in the Parts panel live and after a reload, without the live hints', async ({ page }) => {
  test.setTimeout(180_000);
  // No live hints: the Parts panel must not depend on one to show the set.
  // (An EventSource that never connects, not page.route: routing a request
  // turns the browser's HTTP cache off, and the cache is what's tested.)
  await page.addInitScript(() => {
    class Silent extends EventTarget {
      readyState = 0;
      onopen = null;
      onmessage = null;
      onerror = null;
      close() {}
    }
    (window as unknown as { EventSource: unknown }).EventSource = Silent;
  });
  await signIn(page, `j-set-reload-${ts}@example.com`, 'Reload Rae');
  const res = await page.request.post('/api/layouts', { data: { title: 'Set reload journey' } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  const filter = page.getByPlaceholder('Search parts (name or number)').first();
  await filter.fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
  await expect(page.locator('footer')).toContainText('1 piece');

  // ── Save it as a set. ──
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+a');
  await mapMenu(page, 'Modules & sets', 'Save selection as set…');
  const dialog = page.getByRole('dialog', { name: 'Save selection as set' });
  await dialog.getByLabel('Set name').fill(SET);
  await dialog.getByRole('button', { name: 'Save set' }).click();
  await expect(dialog).toHaveCount(0);
  const tile = (name: string) => page.locator('aside li button[draggable="true"]').filter({ hasText: name }).first();
  const inParts = async (name: string) => {
    await page.getByPlaceholder('Search parts (name or number)').first().fill(name);
    await expect(tile(name)).toBeVisible({ timeout: 15000 });
  };
  await inParts(SET);

  // ── Reload: it's still there. ──
  await page.reload();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await inParts(SET);

  // ── Rename it, then reload: it's there under the new name. ──
  await tile(SET).click({ button: 'right' });
  await page.getByRole('button', { name: 'Rename set…' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename set' });
  await rename.getByLabel('Name').fill(RENAMED);
  await rename.getByRole('button', { name: 'Rename' }).click();
  await expect(rename).toHaveCount(0);
  await inParts(RENAMED);
  await page.reload();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await inParts(RENAMED);
  await page.getByPlaceholder('Search parts (name or number)').first().fill(SET);
  await expect(tile(SET)).toHaveCount(0);

  // ── A set sent from somewhere else (the desktop, another tab) while this
  //    page had the list: a reload brings it. ──
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n<group>\n\t<Description><en>${ELSEWHERE}</en></Description>\n\t<SubPartList>\n\t\t<SubPart id="${PART}"><position><x>0</x><y>0</y></position><angle>0</angle></SubPart>\n\t</SubPartList>\n</group>\n`;
  const sent = await page.request.post('/api/custom-parts', {
    data: { partNumber: ELSEWHERE, displayName: ELSEWHERE, xmlBase64: Buffer.from(xml).toString('base64') },
  });
  expect(sent.status()).toBe(201);
  await page.reload();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await inParts(ELSEWHERE);
});
