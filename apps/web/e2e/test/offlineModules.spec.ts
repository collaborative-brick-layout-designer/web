// Show Wi-Fi drops. With the browser offline:
// - Make a module makes it at once (the dialog closes, no "Saving…" forever),
//   and it reaches the server when the Wi-Fi comes back.
// - Make and save makes it, and says plainly that the Module library copy
//   waits for the Wi-Fi.
// - Save to Module library… says "You're offline" and works once back online.

import { test, expect, type Page } from '@playwright/test';
import { signIn, makeModule, mapMenu } from '../helpers';

const PART = 'ts_narrowgauge_straight.8';

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: { name: () => string; getClassName: () => string }) => boolean) => unknown[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}

async function moduleNames(page: Page, id: string): Promise<string[]> {
  const r = await page.request.get(`/api/layouts/${id}/export.bbm.bld`);
  return r.ok() ? (((await r.json()) as { modules?: { name: string }[] }).modules ?? []).map((m) => m.name).sort() : [];
}

async function libraryTitles(page: Page): Promise<string[]> {
  const r = await page.request.get('/api/modules');
  return ((await r.json()) as { modules: { title: string }[] }).modules.map((m) => m.title);
}

test('offline: Make a module closes at once and reaches the server when back online', async ({ page, context }) => {
  test.setTimeout(120_000);
  const ts = Date.now();
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `offline-mod-${ts}@example.com`, 'Offline Builder');
  const res = await page.request.post('/api/layouts', { data: { title: 'Offline modules' } });
  const { id } = (await res.json()) as { id: string };
  // The editor fetches its panels and dialogs once open, while the Wi-Fi is up.
  const preloaded = page.waitForResponse((r) => r.url().includes('ModulesPanel'), { timeout: 30000 });
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  for (let i = 0; i < 2; i++) {
    await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
    await page.locator(`[title*="(${PART})"]`).first().dblclick();
  }
  await expect.poll(() => brickCount(page)).toBe(2);
  await preloaded;
  await page.waitForLoadState('networkidle');
  await context.setOffline(true);

  // Make a module: the dialog closes and says where its library entry is.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+a');
  await makeModule(page, `Siding ${ts}`);
  await expect(page.getByText(`“Siding ${ts}” is a module in this layout`)).toBeVisible();

  // Make and save: made here; the library copy says plainly it needs the Wi-Fi.
  await page.mouse.click(1000, 700);
  await page.keyboard.press('Escape');
  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
  await expect.poll(() => brickCount(page)).toBe(3);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await mapMenu(page, 'Modules & sets', 'Make a module…');
  const dialog = page.getByRole('dialog', { name: 'Make a module' });
  await dialog.getByLabel('Module name').fill(`Spur ${ts}`);
  await dialog.getByTestId('make-module-also-save').check();
  await dialog.getByRole('button', { name: 'Make and save' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 15000 });
  await expect(page.getByText(`“Spur ${ts}” is a module in this layout, but it couldn’t be saved to the Module library: You're offline.`)).toBeVisible();

  // Save to Module library… while offline: says so, and stays open to try again.
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel('Modules', { exact: true }).check();
  await page.mouse.click(1000, 700);
  await page.getByText(`Siding ${ts}`, { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Save to Module library…' }).click();
  const save = page.getByRole('dialog', { name: `Save “Siding ${ts}” to the Module library` });
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(save).toContainText("You're offline. Check the Wi-Fi and try again.", { timeout: 10000 });
  await expect(save.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();

  // Back online: both modules reach the server, and Save now works.
  await context.setOffline(false);
  await expect.poll(() => moduleNames(page, id), { timeout: 20000 }).toEqual([`Siding ${ts}`, `Spur ${ts}`].sort());
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(`Saved “Siding ${ts}” to the Module library`)).toBeVisible({ timeout: 15000 });
  expect(await libraryTitles(page)).toContain(`Siding ${ts}`);
});
