// E2E: importing LDraw, Studio and LDD models on the website. The server
// runs the desktop's converter (here the e2e stand-in, e2e/fakeImportServer.mjs;
// the real one is checked against the desktop app in the desktop repo).
//   - a model dropped on Home: preview with the desktop's choices, a custom
//     part and a new layout with it, what was missing and where to fix it;
//   - the editor's Map › File › Import a model…: an LDraw layout's parts
//     placed in the open layout by the editor itself, on the sheet picked,
//     and selected; a collaborator sees them at once; one Undo takes the
//     whole import back and Redo brings it back;
//   - a custom part from a model where parts are managed: Home's Custom
//     parts (saved only, listed at once) and the Parts panel (saved and
//     placed here, undoable);
//   - Cancel deletes it; with import off, the desktop app's steps and why;
//   - Admin › Model import: the switch, the libraries, the limits.
// No step may 4xx (the WAF bans bursts of them).

import { test, expect, type Page } from '@playwright/test';
import { signIn, mapMenu, adminSection } from '../helpers';
import { makeGlobalAdmin } from '../dbHelpers';
import { watch4xx } from '../quietNetwork';

const EMAIL = `import-e2e-${Date.now()}@example.com`;
const LDR = Buffer.from('0 Two straights\r\n0 Author: Robin\r\n1 7 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\r\n1 7 80 0 0 1 0 0 0 1 0 0 0 1 3001.dat\r\n');

async function dropFile(page: Page, name: string, data: Buffer) {
  const dt = await page.evaluateHandle(
    ({ name, bytes }) => {
      const t = new DataTransfer();
      t.items.add(new File([new Uint8Array(bytes)], name));
      return t;
    },
    { name, bytes: [...data] },
  );
  await page.dispatchEvent('body', 'dragenter', { dataTransfer: dt });
  await page.dispatchEvent('body', 'dragover', { dataTransfer: dt });
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
}

async function importSwitch(page: Page, on: boolean) {
  const res = await page.request.patch('/api/admin/imports', { data: { enabled: on } });
  expect(res.ok(), await res.text()).toBe(true);
}

test.describe('Import a model', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, EMAIL, 'Import Tester');
  });

  test('Home: a dropped model becomes a custom part in a new layout, as the desktop makes it', async ({ page }) => {
    const net = watch4xx(page);
    await page.goto('/');
    await dropFile(page, 'Loop.ldr', LDR);
    const dialog = page.getByRole('dialog', { name: 'Import a model' });
    await expect(dialog.getByTestId('import-preview')).toBeVisible({ timeout: 30000 });
    await expect(dialog).toContainText('Preview: LDraw import');
    await expect(dialog.getByTestId('import-size')).toHaveText('8 × 2 studs, 2 connection points');
    await expect(dialog.getByTestId('import-stats')).toContainText('Parts missing:1');
    await expect(dialog.getByLabel('Designed by')).toHaveValue('Robin');

    // The desktop preview's choices.
    await dialog.getByRole('button', { name: 'Turn ⟳' }).click();
    await expect(dialog.getByTestId('import-size')).toHaveText('2 × 8 studs, 2 connection points');
    await dialog.getByTestId('import-connections').getByRole('checkbox').first().uncheck();
    await expect(dialog.getByTestId('import-size')).toHaveText('2 × 8 studs, 1 connection point');
    await dialog.getByLabel('Align to').selectOption('box');
    await dialog.getByLabel('Save as').fill('E2E Loop');
    await dialog.getByRole('button', { name: 'Save as Custom Part' }).click();

    const summary = dialog.getByTestId('import-summary');
    await expect(summary).toContainText('Made the custom part “E2E Loop” (2 × 8 studs, 1 connection point) and put it in a new layout.', { timeout: 30000 });
    await expect(dialog.getByTestId('import-misses')).toContainText('1 part was missing from the picture');
    await dialog.getByTestId('import-open-layout').click();
    await expect(page).toHaveURL(/\/editor\/[^/]+$/);
    // The part is the user's, and the layout holds it.
    const parts = (await (await page.request.get('/api/custom-parts')).json()) as { parts: { partNumber: string }[] };
    expect(parts.parts.map((p) => p.partNumber)).toContain('E2E_Loop');
    net.expectQuiet();
  });

  test('the editor: an LDraw layout’s parts go into the open layout, live for others, and one Undo takes them back', async ({ page, context }) => {
    const net = watch4xx(page);
    const created = (await (await page.request.post('/api/layouts', { data: { title: 'Import host' } })).json()) as { id: string };
    await page.goto(`/editor/${created.id}`);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    // Someone else with the layout open (the same account, another tab).
    const other = await context.newPage();
    await other.goto(`/editor/${created.id}`);
    await expect(other.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    const piecesOther = other.getByTestId('piece-count').first();
    const pieces = page.getByTestId('piece-count').first();
    await expect(pieces).toHaveText('0 pieces');
    const undoButton = page.getByRole('button', { name: 'Undo', exact: true });
    const redoButton = page.getByRole('button', { name: 'Redo', exact: true });
    await expect(undoButton).toBeDisabled();
    const chooser = page.waitForEvent('filechooser');
    await mapMenu(page, 'File', 'Import a model (LDraw, Studio, LDD)…');
    await (await chooser).setFiles({ name: 'Yard.mpd', mimeType: 'application/octet-stream', buffer: LDR });
    const dialog = page.getByRole('dialog', { name: 'Import a model' });
    await expect(dialog.getByTestId('import-preview')).toBeVisible({ timeout: 30000 });
    await dialog.getByLabel(/Its parts, one by one/).check();
    await expect(dialog.getByTestId('import-layout-summary')).toContainText('300 parts on 4 sheets');
    await expect(dialog.getByLabel('This layout, on')).toBeChecked();
    await dialog.getByRole('button', { name: 'Place the parts' }).click();
    await expect(dialog.getByTestId('import-summary')).toContainText('in this layout', { timeout: 30000 });
    await expect(dialog.getByTestId('import-undo-hint')).toContainText('Edit › Undo takes the whole import back in one step.');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
    // Selected, as placed.
    const footer = page.locator('footer');
    await expect(footer).toContainText(/selected: [1-9]\d*/);
    const placed = /selected: (\d+)/.exec(await footer.innerText())![1]!;
    await expect(pieces).toHaveText(`${placed} pieces`);
    // The collaborator has them already, without reloading.
    await expect(piecesOther).toHaveText(`${placed} pieces`, { timeout: 15000 });

    // One Undo step: the whole import, and nothing before it.
    await expect(undoButton).toBeEnabled();
    await undoButton.click();
    await expect(undoButton).toBeDisabled();
    await expect(pieces).toHaveText('0 pieces');
    await expect(piecesOther).toHaveText('0 pieces', { timeout: 15000 });
    await expect(redoButton).toBeEnabled();
    await redoButton.click();
    await expect(pieces).toHaveText(`${placed} pieces`);
    await expect(piecesOther).toHaveText(`${placed} pieces`, { timeout: 15000 });
    await expect(undoButton).toBeEnabled();
    await other.close();
    net.expectQuiet();
  });

  test('Home’s Custom parts: Import from a model file saves a part, listed at once, with no layout', async ({ page }) => {
    const net = watch4xx(page);
    await page.goto('/');
    const layoutsBefore = ((await (await page.request.get('/api/layouts')).json()) as { layouts: unknown[] }).layouts.length;
    const section = page.locator('#parts');
    const chooser = page.waitForEvent('filechooser');
    await section.getByRole('button', { name: 'Import from a model file (LDraw, Studio, LDD)' }).click();
    await (await chooser).setFiles({ name: 'Bridge.ldr', mimeType: 'application/octet-stream', buffer: LDR });
    const dialog = page.getByRole('dialog', { name: 'Import a model' });
    await expect(dialog.getByTestId('import-preview')).toBeVisible({ timeout: 30000 });
    // One part only: no placing its parts, no new layout.
    await expect(dialog.getByLabel(/Its parts, one by one/)).toHaveCount(0);
    await expect(dialog.getByLabel('A new layout')).toHaveCount(0);
    await dialog.getByLabel('Save as').fill('E2E Home Bridge');
    await dialog.getByRole('button', { name: 'Save as Custom Part' }).click();
    await expect(dialog.getByTestId('import-summary')).toContainText('and saved it to your custom parts.', { timeout: 30000 });
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
    // Listed without a reload, and no layout was made.
    await expect(section.getByText('E2E Home Bridge')).toBeVisible({ timeout: 15000 });
    expect(((await (await page.request.get('/api/layouts')).json()) as { layouts: unknown[] }).layouts.length).toBe(layoutsBefore);
    // Upload part points to the import, not the desktop app.
    await section.getByRole('button', { name: 'Upload part' }).click();
    const upload = page.getByRole('dialog', { name: 'Upload custom part' });
    await expect(upload.getByTestId('upload-part-import')).toBeVisible();
    await expect(upload.getByText('Making a part from an LDraw, Studio or LDD model?', { exact: true })).toHaveCount(0);
    await upload.getByRole('button', { name: 'Cancel' }).click();
    net.expectQuiet();
  });

  test('the Parts panel: Save and place it here puts the new part down, and Undo takes it off', async ({ page }) => {
    const net = watch4xx(page);
    const created = (await (await page.request.post('/api/layouts', { data: { title: 'Part host' } })).json()) as { id: string };
    await page.goto(`/editor/${created.id}`);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('parts-import-model').click();
    await (await chooser).setFiles({ name: 'Station.ldr', mimeType: 'application/octet-stream', buffer: LDR });
    const dialog = page.getByRole('dialog', { name: 'Import a model' });
    await expect(dialog.getByTestId('import-preview')).toBeVisible({ timeout: 30000 });
    await expect(dialog.getByLabel('Save to my parts')).toBeChecked();
    await dialog.getByLabel(/Save and place it here/).check();
    await dialog.getByLabel('Save as').fill('E2E Panel Station');
    await dialog.getByRole('button', { name: 'Save and place it' }).click();
    await expect(dialog.getByTestId('import-summary')).toContainText('and put it in the middle of your view.', { timeout: 30000 });
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('footer')).toContainText('selected: 1');
    await expect(page.getByTestId('piece-count').first()).toHaveText('1 piece');
    // In the Parts panel at once.
    await page.getByPlaceholder('Search parts (name or number)').fill('E2E_Panel_Station');
    await expect(page.locator('aside li button[draggable="true"]').filter({ hasText: /E2E.Panel.Station/ }).first()).toBeVisible({ timeout: 15000 });
    // Off the map with one Undo; the part stays saved.
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await undo.click();
    await expect(undo).toBeDisabled();
    await expect(page.getByTestId('piece-count').first()).toHaveText('0 pieces');
    const parts = (await (await page.request.get('/api/custom-parts')).json()) as { parts: { partNumber: string }[] };
    expect(parts.parts.map((p) => p.partNumber)).toContain('E2E_Panel_Station');
    net.expectQuiet();
  });

  test('Cancel deletes the upload; with import off, the desktop app’s steps say why', async ({ page }) => {
    const net = watch4xx(page);
    await page.goto('/');
    await dropFile(page, 'City.io', Buffer.from('PK\x03\x04'));
    const dialog = page.getByRole('dialog', { name: 'Import a model' });
    await expect(dialog.getByTestId('import-preview')).toBeVisible({ timeout: 30000 });
    await expect(dialog).toContainText('Preview: Studio import');
    await dialog.getByTestId('import-cancel').click();
    await expect(dialog).toHaveCount(0);

    makeGlobalAdmin(EMAIL);
    await importSwitch(page, false);
    try {
      await page.reload();
      await dropFile(page, 'House.lxf', Buffer.from('PK\x03\x04'));
      const message = page.getByRole('dialog', { name: 'Import this in the desktop app' });
      await expect(message).toContainText('House.lxf is a LEGO Digital Designer (LDD) file');
      await expect(message.getByTestId('import-off-reason')).toHaveText('An admin has turned importing off on this site.');
      await expect(message.getByRole('link', { name: 'Get the desktop app' })).toHaveAttribute('href', /github\.com/);
      await message.getByRole('button', { name: 'OK' }).click();
    } finally {
      await importSwitch(page, true);
    }
    net.expectQuiet();
  });

  test('Admin › Model import: the switch, the libraries and the limits', async ({ page }) => {
    makeGlobalAdmin(EMAIL);
    const net = watch4xx(page);
    await page.goto('/admin');
    await adminSection(page, 'imports');
    const tab = page.getByTestId('admin-imports');
    await expect(tab.getByTestId('admin-imports-state')).toHaveText('People can import LDraw, BrickLink Studio and LDD files on this site.');
    await expect(tab).toContainText('version 2.1.11');
    for (const id of ['lib-ldraw', 'lib-ldd', 'lib-mapping', 'lib-studio']) await expect(tab.getByTestId(id)).toBeVisible();
    await expect(tab.getByTestId('lib-ldd')).toContainText('never served to anyone');
    // A limit, saved and put back.
    const perHour = tab.getByLabel('Imports per person per hour');
    const save = perHour.locator('xpath=..').getByRole('button', { name: 'Save' });
    const other = (await perHour.inputValue()) === '31' ? '32' : '31';
    await perHour.fill(other);
    await save.click();
    await expect(save).toBeDisabled();
    expect(((await (await page.request.get('/api/admin/imports')).json()) as { limits: { key: string; value: number }[] }).limits.find((l) => l.key === 'perHour')?.value).toBe(Number(other));
    await perHour.fill('30');
    await save.click();
    await expect(save).toBeDisabled();
    net.expectQuiet();
  });
});
