// Module versions: each save is a version with an optional "What changed"
// note; the history on Home's ⋯ menu shows them, restores one (as a new
// version) and downloads one. Save to Module library… can update an
// existing module instead of making a new one.

import { test, expect, type Page } from '@playwright/test';
import { ensureUser, signIn, confirmInDialog, makeModule } from '../helpers';

const ts = Date.now();
let seq = 0;
const PART = 'ts_narrowgauge_straight.8';

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}

async function placePart(page: Page): Promise<void> {
  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
}

async function newModule(page: Page, title: string): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New module' }).click();
  const dialog = page.getByRole('dialog', { name: 'New module' });
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByRole('button', { name: 'Create and open' }).click();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  return /\/modules\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
}

async function saveWithNote(page: Page, note: string): Promise<void> {
  await page.getByLabel('What changed (optional)').fill(note);
  await page.getByRole('button', { name: 'Save module' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
  await expect(page.getByLabel('What changed (optional)')).toHaveValue('');
}

async function openHistory(page: Page, title: string) {
  await page.goto('/');
  const row = page.getByTestId('module-row').filter({ hasText: title });
  await row.getByRole('button', { name: `More for ${title}` }).click();
  await page.getByRole('menuitem', { name: 'Version history…' }).click();
  return page.getByRole('dialog', { name: `Versions of ${title}` });
}

test.describe('module versions', () => {
  test('each save is a version; restore and download one from the history', async ({ page }) => {
    await signIn(page, `ver-${ts}-${seq++}@example.com`, 'Version Keeper');
    const id = await newModule(page, 'Engine shed');
    await placePart(page);
    await expect.poll(() => brickCount(page)).toBe(1);
    await saveWithNote(page, 'One track');
    await placePart(page);
    await expect.poll(() => brickCount(page)).toBe(2);
    await saveWithNote(page, 'Added a second track');

    let history = await openHistory(page, 'Engine shed');
    const rows = history.getByTestId('module-version');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Version 2');
    await expect(rows.nth(0)).toContainText('Current');
    await expect(rows.nth(0)).toContainText('Added a second track');
    await expect(rows.nth(1)).toContainText('One track');
    await expect(rows.nth(1)).toContainText('Version Keeper');
    // Preview shows that version's picture.
    await rows.nth(1).getByRole('button', { name: 'Preview' }).click();
    await expect.poll(() => history.getByTestId('version-preview').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    // Download version 1 as a .bbm.
    const [download] = await Promise.all([page.waitForEvent('download'), history.getByRole('button', { name: 'Download version 1' }).click()]);
    expect(download.suggestedFilename()).toMatch(/Engine shed v1\.bbm$/);
    const fs = await import('node:fs/promises');
    const xml = await fs.readFile((await download.path())!, 'utf8');
    expect(xml.match(/<Brick /g)?.length).toBe(1);

    // Restore version 1: it becomes version 3.
    await history.getByRole('button', { name: 'Restore version 1' }).click();
    await confirmInDialog(page);
    await expect(history.getByRole('status')).toContainText('saved as version 3');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Restored version 1');
    await history.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('module-row').filter({ hasText: 'Engine shed' })).toContainText('version 3');
    await page.goto(`/modules/${id}`);
    await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(1);

    // Someone who can only view it sees the history, without Restore.
    const viewer = `ver-viewer-${ts}-${seq++}@example.com`;
    await ensureUser(viewer, 'Viewer');
    const invited = await page.request.post(`/api/modules/${id}/invites`, { data: { email: viewer, role: 'viewer' } });
    expect(invited.ok()).toBe(true);
    await page.context().clearCookies();
    await signIn(page, viewer, 'Viewer');
    expect((await page.request.post(`/api/module-invites/${((await invited.json()) as { token: string }).token}`)).ok()).toBe(true);
    history = await openHistory(page, 'Engine shed');
    await expect(history.getByTestId('module-version')).toHaveCount(3);
    await expect(history.getByRole('button', { name: /^Restore/ })).toHaveCount(0);
    await expect(history.getByRole('button', { name: 'Download version 2' })).toBeVisible();
  });

  test('Save to Module library… can save a module as a new version of a library module', async ({ page }) => {
    await signIn(page, `ver-upd-${ts}-${seq++}@example.com`, 'Updater');
    const id = await newModule(page, 'Passing loop');
    await placePart(page);
    await expect.poll(() => brickCount(page)).toBe(1);
    await saveWithNote(page, 'Start');

    // A layout with three parts, made a module; save it over the Module library module.
    const res = await page.request.post('/api/layouts', { data: { title: 'Club layout' } });
    const { id: layoutId } = (await res.json()) as { id: string };
    await page.goto(`/editor/${layoutId}`);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    for (let i = 0; i < 3; i++) await placePart(page);
    await expect.poll(() => brickCount(page)).toBe(3);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Control+a');
    await makeModule(page, 'Loop');
    await page.getByRole('button', { name: 'Panels', exact: true }).click();
    await page.getByLabel('Modules', { exact: true }).check();
    await page.mouse.click(400, 400);
    await page.getByRole('button', { name: 'More for Loop' }).click();
    await page.getByRole('button', { name: 'Save to Module library…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save “Loop” to the Module library' });
    await dialog.getByLabel(/New version of a module in the Module library/).check();
    await dialog.getByRole('radiogroup', { name: 'Module to update' }).getByText('Passing loop').click();
    await dialog.getByLabel('What changed? (optional)').fill('Longer loop');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved “Passing loop” to the Module library as version 2')).toBeVisible({ timeout: 15000 });

    const v = (await (await page.request.get(`/api/modules/${id}/versions`)).json()) as { versions: { version: number; note: string; hasThumbnail: boolean }[] };
    expect(v.versions[0]).toMatchObject({ version: 2, note: 'Longer loop', hasThumbnail: true });
    await page.goto(`/modules/${id}`);
    await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(3);
  });
});
