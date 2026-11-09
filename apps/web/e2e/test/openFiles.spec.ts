// E2E: opening a file is easy to find. Home's "Open a file…" button and a
// file dropped on the page (with its overlay) open a layout and say what
// came in; the editor's Map › File › Open a file… shows the same picker;
// LDraw, Studio and LDD files get the desktop app's steps, never a dead
// end; a cut-off .bbm is refused in the browser, saying where. No step may
// 4xx (the WAF bans bursts of them).

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn, mapMenu } from '../helpers';
import { watch4xx } from '../quietNetwork';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures');
const EMAIL = `openfiles-e2e-${Date.now()}@example.com`;
const BBM = readFileSync(join(FIXTURES, 'tight-corner.bbm'));
const TDL = readFileSync(join(FIXTURES, 'oracle/tight-corner.tdl'));
const bricks = (bbm: string) => bbm.split('<Brick ').length - 1;
// tight-corner.bbm's 16 + 16 "TB CT R24/R32" curves aren't in the parts library.
const FIXTURE_MISSING = 32;

/** Drag `name` over the page (overlay up), then drop it. */
async function dropFile(page: Page, name: string, data: Buffer, opts: { checkOverlay?: boolean } = {}) {
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
  if (opts.checkOverlay) await expect(page.getByTestId('drop-overlay')).toContainText('Drop a layout file to open it');
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0);
}

async function pickFromHome(page: Page, name: string, data: Buffer) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open a file…' }).click();
  await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer: data });
}

test.describe('Open a file', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, EMAIL, 'Open Files Tester');
  });

  test('Home: the button and a drop open a .bbm and a .tdl, and say how many parts came in', async ({ page }) => {
    const net = watch4xx(page);
    const vanillaBricks = bricks(readFileSync(join(FIXTURES, 'oracle/tight-corner.from-tdl.bbm'), 'utf-8'));
    await page.goto('/');
    await expect(page.getByTestId('open-formats')).toContainText('BlueBrick (.bbm)');
    await expect(page.getByTestId('open-formats')).toContainText('LDraw, BrickLink Studio and LDD models are imported in the desktop app');

    net.stage('button: .bbm');
    await pickFromHome(page, 'Corner.bbm', BBM);
    await expect(page).toHaveURL(/\/editor\/[^/]+$/, { timeout: 15000 });
    await expect(page.getByTestId('opened-summary-line')).toHaveText(`Opened Corner.bbm: ${bricks(BBM.toString('utf-8'))} parts, ${FIXTURE_MISSING} not in the library`, { timeout: 15000 });
    await page.getByTestId('opened-summary').getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('opened-summary')).toHaveCount(0);

    net.stage('button: .tdl');
    await page.goto('/');
    await pickFromHome(page, 'Corner.tdl', TDL);
    await expect(page).toHaveURL(/\/editor\/[^/]+$/, { timeout: 15000 });
    await expect(page.getByTestId('opened-summary-line')).toHaveText(new RegExp(`^Opened Corner\\.tdl: ${vanillaBricks} parts`), { timeout: 15000 });

    net.stage('drop: .bbm');
    await page.goto('/');
    await dropFile(page, 'Dropped.bbm', BBM, { checkOverlay: true });
    await expect(page).toHaveURL(/\/editor\/[^/]+$/, { timeout: 15000 });
    await expect(page.getByTestId('opened-summary-line')).toContainText('Opened Dropped.bbm:', { timeout: 15000 });

    net.stage('drop: .tdl');
    await page.goto('/');
    await dropFile(page, 'Dropped.tdl', TDL);
    await expect(page).toHaveURL(/\/editor\/[^/]+$/, { timeout: 15000 });
    await expect(page.getByTestId('opened-summary-line')).toContainText(`Opened Dropped.tdl: ${vanillaBricks} parts`, { timeout: 15000 });
    net.expectQuiet();
  });

  test('a layout with parts the library lacks lists them', async ({ page }) => {
    const net = watch4xx(page);
    const bbm = BBM.toString('utf-8').replace(/<PartNumber>[^<]+<\/PartNumber>/, '<PartNumber>NOSUCHPART.1</PartNumber>');
    await page.goto('/');
    await pickFromHome(page, 'Odd.bbm', Buffer.from(bbm));
    await expect(page.getByTestId('opened-summary-line')).toContainText(`${FIXTURE_MISSING + 1} not in the library`, { timeout: 15000 });
    await page.getByTestId('opened-summary').getByRole('button', { name: '(list)' }).click();
    const list = page.getByTestId('missing-parts');
    await expect(list.getByRole('listitem')).toHaveText([/^TB CT R24\.8\s*× 16$/, /^TB CT R32\.8\s*× 16$/, /^NOSUCHPART\.1\s*× 1$/]);
    net.expectQuiet();
  });

  test('an empty editor takes a dropped file, and Map › File › Open a file… shows the picker', async ({ page }) => {
    const net = watch4xx(page);
    const res = await page.request.post('/api/layouts', { data: { title: 'Empty' } });
    const { id } = (await res.json()) as { id: string };
    await page.goto(`/editor/${id}`);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });

    const chooser = page.waitForEvent('filechooser');
    await mapMenu(page, 'File', 'Open a file…');
    await (await chooser).setFiles({ name: 'FromMenu.bbm', mimeType: 'application/octet-stream', buffer: BBM });
    await expect(page).not.toHaveURL(new RegExp(`/editor/${id}$`), { timeout: 15000 });
    await expect(page.getByTestId('opened-summary-line')).toContainText('Opened FromMenu.bbm:', { timeout: 15000 });

    await page.goto(`/editor/${id}`);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    await dropFile(page, 'OnEditor.bbm', BBM, { checkOverlay: true });
    await expect(page).not.toHaveURL(new RegExp(`/editor/${id}$`), { timeout: 15000 });
    await expect(page.getByTestId('opened-summary-line')).toContainText('Opened OnEditor.bbm:', { timeout: 15000 });
    net.expectQuiet();
  });

  test('a cut-off .bbm is refused, saying where, and nothing is made', async ({ page }) => {
    const net = watch4xx(page);
    await page.goto('/');
    await dropFile(page, 'Cut.bbm', BBM.subarray(0, Math.floor(BBM.length / 2)));
    const message = page.getByRole('dialog', { name: 'The file couldn’t be opened' });
    await expect(message).toContainText('Cut.bbm', { timeout: 15000 });
    await expect(message).toContainText(/cut off at line \d+: it ends before the layout does/);
    await message.getByRole('button', { name: 'OK' }).click();
    await expect(page).toHaveURL(/\/$/);
    const list = (await (await page.request.get('/api/layouts')).json()) as { layouts: { title: string }[] };
    expect(list.layouts.map((l) => l.title)).not.toContain('Cut');
    net.expectQuiet();
  });

  test('Studio, LDD and LDraw files explain the desktop app, picked or dropped', async ({ page }) => {
    const net = watch4xx(page);
    await page.goto('/');
    const message = page.getByRole('dialog', { name: 'Open this in the desktop app' });

    await dropFile(page, 'ninjago.io', Buffer.from('PK\x03\x04'));
    await expect(message).toContainText('ninjago.io is a BrickLink Studio file');
    await expect(message).toContainText('Tools › Import › Studio');
    await expect(message.getByRole('link', { name: 'Get the desktop app' })).toHaveAttribute('href', /github\.com/);
    await message.getByRole('button', { name: 'OK' }).click();
    await expect(message).toHaveCount(0);

    await pickFromHome(page, 'house.lxf', Buffer.from('PK\x03\x04'));
    await expect(message).toContainText('house.lxf is a LEGO Digital Designer (LDD) file');
    await expect(message).toContainText('Upload to server…');
    await page.keyboard.press('Escape');
    await expect(message).toHaveCount(0);

    await dropFile(page, 'train.ldr', Buffer.from('0 train\r\n'));
    await expect(message).toContainText('train.ldr is an LDraw file');
    await expect(message).toContainText('File › Save to Server…');
    await message.getByRole('button', { name: 'OK' }).click();

    // Nothing was made.
    await expect(page).toHaveURL(/\/$/);
    const list = (await (await page.request.get('/api/layouts')).json()) as { layouts: { title: string }[] };
    expect(list.layouts.map((l) => l.title)).not.toContain('ninjago');
    net.expectQuiet();
  });
});
