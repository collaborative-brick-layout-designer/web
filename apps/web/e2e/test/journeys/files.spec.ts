// Journey 8 — files a member takes away and brings back.
//
//   Build a layout (two parts, a saved view, a budget) → Download Layout
//   (.bld-layout) and open it as a new layout: parts and view come back →
//   Download As .bbm and open that: the parts come back → Save the budget
//   (.bbb) and Open it in the copy: the limit comes back → upload a venue
//   file made by the desktop app, download it again, and start a layout
//   from it.
//
// The desktop side reads the web's files in its own tests (fixtures/layouts
// web-made*.bld-layout); this checks the web's own round trips.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn, mapMenu } from '../../helpers';

const ts = Date.now();
const TITLE = `Files ${ts}`;
const PART = 'ts_narrowgauge_straight.8';
const VENUE_FILE = join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures/grand-lobby.bld-venue');

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}

/** Home → New layout, opening `file`; the editor is open on it. */
async function openAsNewLayout(page: Page, file: string, name: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New layout', exact: true }).first().click();
  await page.getByRole('dialog', { name: 'New layout' }).locator('input[type=file][accept*=".bld-layout"]').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: readFileSync(file) });
  await page.getByRole('dialog', { name: 'New layout' }).getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/editor\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
}

async function openBudget(page: Page) {
  await mapMenu(page, 'Budget', 'Edit budget…');
}

test('a layout, a budget and a venue go out as files and come back', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, `j-files-${ts}@example.com`, 'File Fan');

  // ── Build it: two parts, a view, a budget of 5 for the track. ──
  const res = await page.request.post('/api/layouts', { data: { title: TITLE } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  for (let i = 0; i < 2; i++) {
    await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
    await page.locator(`[title*="(${PART})"]`).first().dblclick();
  }
  await expect.poll(() => brickCount(page)).toBe(2);
  await page.getByRole('group', { name: 'Tasks' }).getByRole('button', { name: 'Build' }).click();
  const views = page.getByRole('region', { name: 'Views' });
  await views.getByRole('button', { name: '+ Add view' }).click();
  await views.getByLabel('Name the view').fill('Overview');
  await views.getByRole('button', { name: 'Add view', exact: true }).click();
  await openBudget(page);
  await page.getByLabel(`Budget for ${PART}`).fill('5');
  const bbbDl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save…' }).click();
  const bbb = await (await bbbDl).path();
  await openBudget(page); // close the panel
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15000 });

  // ── Download Layout, and open it as a new layout. ──
  const layoutDl = page.waitForEvent('download');
  await mapMenu(page, 'Download & export', 'Download layout (.bld-layout)');
  const layoutFile = await (await layoutDl).path();
  await openAsNewLayout(page, layoutFile, `${TITLE}.bld-layout`);
  await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(2);
  await page.getByRole('group', { name: 'Tasks' }).getByRole('button', { name: 'Build' }).click();
  await expect(page.getByRole('region', { name: 'Views' }).getByRole('button', { name: /^Overview/ })).toBeVisible();

  // ── Download As .bbm, and open that. ──
  await mapMenu(page, 'Download & export', 'Download as…');
  const as = page.getByRole('dialog', { name: 'Download As' });
  await as.getByLabel('BlueBrick map (.bbm)').check();
  const bbmDl = page.waitForEvent('download');
  await as.getByRole('button', { name: 'Download', exact: true }).click();
  const bbmFile = await (await bbmDl).path();
  await openAsNewLayout(page, bbmFile, `${TITLE}.bbm`);
  await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(2);

  // ── Open the budget file here: the limit comes back. ──
  await openBudget(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open…' }).click();
  await (await chooser).setFiles(bbb);
  await expect(page.getByLabel(`Budget for ${PART}`)).toHaveValue('5');

  // ── A venue file from the desktop app: upload, download, start a layout. ──
  await page.goto('/');
  await page.getByLabel('Venue file').setInputFiles(VENUE_FILE);
  const venueRow = page.locator('li', { hasText: 'Grand Lobby' }).first();
  await expect(venueRow).toBeVisible({ timeout: 15000 });
  await venueRow.getByRole('button', { name: /^More for/ }).click();
  const venueDl = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Download' }).click();
  expect((await venueDl).suggestedFilename()).toMatch(/\.bld-venue$/);
  await venueRow.getByRole('link', { name: 'Start layout' }).click();
  await page.getByRole('dialog', { name: 'New layout' }).getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/editor\/[0-9a-f-]{36}$/);
  const newId = /\/editor\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  await expect
    .poll(async () => {
      const r = await page.request.get(`/api/layouts/${newId}/export.bbm.bld`);
      return r.ok() ? ((await r.json()) as { venue?: { name?: string } }).venue?.name ?? '' : '';
    }, { timeout: 15000 })
    .toContain('Grand Lobby');
});
