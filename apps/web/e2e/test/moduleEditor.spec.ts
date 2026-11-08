// Modules you can open, change and see: New module opens the module
// editor, Save module keeps the parts and makes the module's picture, and
// the picture shows wherever modules are listed. People who can only view
// a module (invited by a link they accept) see it without the Save button.

import { test, expect, type Page } from '@playwright/test';
import { ensureUser, signIn } from '../helpers';
import { clearModuleThumbnail, setOldModuleThumbnail } from '../dbHelpers';

const ts = Date.now();
let seq = 0;
const PART = 'ts_narrowgauge_straight.8';

/** The parts drawn on the canvas. */
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

/** A picture that really loaded (not a broken image). */
async function expectLoadedPicture(row: ReturnType<Page['locator']>): Promise<void> {
  const img = row.getByTestId('module-thumb');
  await expect(img).toBeVisible({ timeout: 15000 });
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10000 }).toBeGreaterThan(0);
}

/** New module → build it → Save module; returns its id. */
async function buildModule(page: Page, title: string): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New module' }).click();
  const dialog = page.getByRole('dialog', { name: 'New module' });
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByRole('button', { name: 'Create and open' }).click();
  await expect(page).toHaveURL(/\/modules\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('module-editor-title')).toHaveText(`Editing module: ${title}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await placePart(page);
  await expect.poll(() => brickCount(page)).toBe(1);
  await expect(page.getByTestId('save-status')).toHaveText('Not saved yet');
  await page.getByRole('button', { name: 'Save module' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
  return /\/modules\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
}

test.describe('module editor', () => {
  test('New module opens the editor; build, save, and it shows on Home with its picture', async ({ page }) => {
    await signIn(page, `mod-build-${ts}-${seq++}@example.com`, 'Module Builder');
    const id = await buildModule(page, 'Station siding');
    // Only what a module needs: no venue, views or layout sharing.
    await expect(page.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    const map = page.getByRole('menu', { name: 'Map' });
    await expect(map.getByRole('menuitem', { name: 'Find…' })).toBeVisible();
    await expect(map.getByRole('menuitem', { name: 'Find…' })).toContainText('Ctrl+F');
    await expect(map.getByRole('menuitem', { name: 'Venue' })).toHaveCount(0);
    await expect(map.getByRole('menuitem', { name: 'Budget' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Build tools' }).getByRole('button', { name: 'Select' })).toBeVisible();
    await page.keyboard.press('Escape');

    // Home: the module, with its picture and Open.
    await page.getByRole('button', { name: 'Home' }).click();
    await expect(page).toHaveURL(/\/$/);
    const row = page.getByTestId('module-row').filter({ hasText: 'Station siding' });
    await expectLoadedPicture(row);
    const pic = await page.request.get(`/api/modules/${id}/thumbnail`);
    expect(pic.headers()['content-type']).toBe('image/webp');
    // 1024 px on its longest side; the list shows the 256 px copy.
    const listed = (await (await page.request.get('/api/modules')).json()) as { modules: { id: string; thumbnailSide: number }[] };
    expect(listed.modules.find((m) => m.id === id)?.thumbnailSide).toBe(1024);
    await expect(row.getByTestId('module-thumb')).toHaveAttribute('src', /size=small/);
    expect(await row.getByTestId('module-thumb').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeLessThanOrEqual(256);
    await expect(row.getByTestId('low-res-picture')).toHaveCount(0);

    // Open it again: the part is still there; change it and save again.
    await row.getByRole('link', { name: 'Open Station siding' }).click();
    await expect(page).toHaveURL(new RegExp(`/modules/${id}$`));
    await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(1);
    await placePart(page);
    await expect.poll(() => brickCount(page)).toBe(2);
    await page.keyboard.press('Control+s');
    await expect(page.getByTestId('save-status')).toHaveText('Saved');
    await page.reload();
    await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(2);
  });

  test('an old, low-resolution picture says so to its editors, and Refresh picture redraws it at 1024 px', async ({ page }) => {
    await signIn(page, `mod-lowres-${ts}-${seq++}@example.com`, 'Module Pictures');
    // How big the picture's request is (for the site's firewall).
    const sizes: number[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT' && /\/api\/modules\/[^/]+\/thumbnail$/.test(r.url())) sizes.push(r.postDataBuffer()?.length ?? 0);
    });
    const id = await buildModule(page, 'Old bridge');
    await expect.poll(() => sizes.length, { timeout: 15000 }).toBeGreaterThan(0);
    test.info().annotations.push({ type: 'thumbnail PUT body bytes', description: sizes.join(', ') });
    // An old 256 px PNG.
    const old = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 256;
      c.height = 128;
      const g = c.getContext('2d')!;
      g.fillStyle = '#c33';
      g.fillRect(0, 0, 256, 128);
      const b = await new Promise<Blob>((r) => c.toBlob((x) => r(x!), 'image/png'));
      return Array.from(new Uint8Array(await b.arrayBuffer()));
    });
    setOldModuleThumbnail(id, Buffer.from(old));
    await page.goto('/');
    const row = page.getByTestId('module-row').filter({ hasText: 'Old bridge' });
    await expect(row.getByTestId('low-res-picture')).toContainText('Picture is low resolution.');
    // ⋯ › Refresh picture opens it, redraws the picture and says so.
    await row.getByRole('button', { name: 'More for Old bridge' }).click();
    await page.getByRole('menuitem', { name: 'Refresh picture' }).click();
    await expect(page).toHaveURL(new RegExp(`/modules/${id}\\?refresh=picture$`));
    await expect(page.getByText('Picture refreshed')).toBeVisible({ timeout: 20000 });
    await page.goto('/');
    await expect(page.getByTestId('module-row').filter({ hasText: 'Old bridge' }).getByTestId('low-res-picture')).toHaveCount(0);
    const listed = (await (await page.request.get('/api/modules')).json()) as { modules: { id: string; thumbnailSide: number }[] };
    expect(listed.modules.find((m) => m.id === id)?.thumbnailSide).toBe(1024);
  });

  test('a module without a picture gets one when opened, and pictures show when inserting into a layout', async ({ page }) => {
    await signIn(page, `mod-pic-${ts}-${seq++}@example.com`, 'Module Pictures');
    const id = await buildModule(page, 'Old crossing');
    clearModuleThumbnail(id);
    await page.goto('/');
    const row = page.getByTestId('module-row').filter({ hasText: 'Old crossing' });
    await expect(row.getByTestId('module-thumb-placeholder')).toBeVisible();
    // Opening it makes the picture.
    await row.getByRole('link', { name: 'Open Old crossing' }).click();
    await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(1);
    await expect
      .poll(async () => (await page.request.get(`/api/modules/${id}/thumbnail`)).status(), { timeout: 15000 })
      .toBe(200);
    await page.goto('/');
    await expectLoadedPicture(page.getByTestId('module-row').filter({ hasText: 'Old crossing' }));

    // A layout's Insert module dialog and Module library show it too.
    const res = await page.request.post('/api/layouts', { data: { title: 'Host layout' } });
    const { id: layoutId } = (await res.json()) as { id: string };
    await page.goto(`/editor/${layoutId}`);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Insert module' }).click();
    const insertRow = page.locator('li', { hasText: 'Old crossing' }).filter({ has: page.getByRole('button', { name: 'Insert' }) });
    await expectLoadedPicture(insertRow);
    await insertRow.getByRole('button', { name: 'Insert' }).click();
    await expect.poll(() => brickCount(page)).toBe(1);
    await page.getByRole('button', { name: 'Panels', exact: true }).click();
    await page.getByLabel('Module library').check();
    await page.mouse.click(400, 400);
    const libRow = page.locator('li[draggable="true"]', { hasText: 'Old crossing' });
    await expectLoadedPicture(libRow);
    // A plain "Add to layout" button, and the rest in its ⋯ menu.
    await expect(libRow.getByRole('button', { name: 'Add to layout' })).toBeVisible();
    await libRow.getByRole('button', { name: 'More for Old crossing' }).click();
    await expect(libRow.getByRole('menuitem', { name: 'Open to change it (new tab)' })).toHaveAttribute('href', `/modules/${id}`);
    await page.keyboard.press('Escape');

    // In the module editor, the module being edited is marked and can't go into itself.
    await page.goto(`/modules/${id}`);
    await expect(page.getByTestId('module-editor-title')).toHaveText('Editing module: Old crossing');
    // The Module library panel is still open from before (panels are remembered).
    const self = page.getByTestId('module-library-row').filter({ hasText: 'Old crossing' });
    await expect(self.getByTestId('editing-now')).toBeVisible();
    await expect(self.getByRole('button', { name: /Add to/ })).toHaveCount(0);
    await expect(self.getByRole('button', { name: /^More for/ })).toHaveCount(0);
  });

  test('someone who can only view a module sees it without Save', async ({ page, browser }) => {
    const viewerEmail = `mod-viewer-${ts}-${seq++}@example.com`;
    await ensureUser(viewerEmail, 'Module Viewer');
    await signIn(page, `mod-owner-${ts}-${seq++}@example.com`, 'Module Owner');
    const id = await buildModule(page, 'Shared turntable');
    // Share with people: an invite link for the viewer, waiting until they accept.
    await page.goto('/');
    const ownerRow = page.getByTestId('module-row').filter({ hasText: 'Shared turntable' });
    await ownerRow.getByRole('button', { name: 'More for Shared turntable' }).click();
    await page.getByRole('menuitem', { name: 'Share with people…' }).click();
    const share = page.getByRole('dialog', { name: 'Share Shared turntable' });
    await share.getByPlaceholder('alice@example.com').fill(viewerEmail);
    await share.getByRole('button', { name: 'Invite' }).click();
    const sent = share.getByRole('status');
    await expect(sent).toContainText('/module-invite/');
    await expect(share.getByTestId('module-invites')).toContainText(viewerEmail);
    const invitePath = /\/module-invite\/[0-9a-f]+/.exec((await sent.textContent()) ?? '')![0];
    await share.getByRole('button', { name: 'Close' }).click();

    const ctx = await browser.newContext();
    const vp = await ctx.newPage();
    await signIn(vp, viewerEmail, 'Module Viewer');
    // Not theirs until they accept.
    await vp.goto('/');
    await expect(vp.getByTestId('module-row').filter({ hasText: 'Shared turntable' })).toHaveCount(0);
    await vp.goto(invitePath);
    await expect(vp).toHaveURL(new RegExp(`/modules/${id}$`), { timeout: 15000 });
    await vp.goto('/');
    const row = vp.getByTestId('module-row').filter({ hasText: 'Shared turntable' });
    await expectLoadedPicture(row);
    await row.getByRole('link', { name: 'Open Shared turntable' }).click();
    await expect(vp.getByTestId('module-editor-title')).toHaveText('Editing module: Shared turntable');
    await expect.poll(() => brickCount(vp), { timeout: 15000 }).toBe(1);
    await expect(vp.getByTestId('view-only')).toBeVisible();
    await expect(vp.getByRole('button', { name: 'Save module' })).toHaveCount(0);
    await ctx.close();

    // A stranger can't open it at all.
    const ctx2 = await browser.newContext();
    const sp = await ctx2.newPage();
    await signIn(sp, `mod-stranger-${ts}-${seq++}@example.com`, 'Stranger');
    await sp.goto(`/modules/${id}`);
    await expect(sp.getByTestId('module-editor-title')).toHaveCount(0);
    await expect(sp.getByText(/could not be found|not found/i).first()).toBeVisible({ timeout: 15000 });
    await ctx2.close();
  });

  test('the club page shows the club’s modules with their pictures, and opens them', async ({ page }) => {
    await signIn(page, `mod-club-${ts}-${seq++}@example.com`, 'Club Modules');
    const slug = `modclub-${ts}-${seq++}`;
    expect((await page.request.post('/api/orgs', { data: { name: 'Module Club', slug } })).ok()).toBe(true);
    await page.goto(`/?owner=${slug}`);
    await page.getByRole('button', { name: 'New module' }).click();
    const dialog = page.getByRole('dialog', { name: 'New module' });
    await dialog.getByLabel('Title').fill('Club yard');
    await dialog.getByRole('button', { name: 'Create and open' }).click();
    await expect(page.getByTestId('module-editor-title')).toHaveText('Editing module: Club yard');
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    await placePart(page);
    await expect.poll(() => brickCount(page)).toBe(1);
    await page.getByRole('button', { name: 'Save module' }).click();
    await expect(page.getByTestId('save-status')).toHaveText('Saved');
    const id = /\/modules\/([0-9a-f-]{36})$/.exec(page.url())![1]!;

    await page.goto(`/orgs/${slug}`);
    const tile = page.getByRole('list', { name: 'Module Club’s modules' }).getByRole('link', { name: 'Open Club yard' });
    await expectLoadedPicture(tile);
    await tile.click();
    await expect(page).toHaveURL(new RegExp(`/modules/${id}$`));
    await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(1);
  });
});
