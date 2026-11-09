// Journey: the text's Size and a big print, from the area 3 review.
//
//   Ada adds "Station" at 12 pt and again at 48 pt: the second is four
//   times as big. On Fordyce (hundreds
//   of pages at actual size) Print says how many pages and how much, offers
//   a PDF instead, and asks before it starts; on a small layout the print
//   window gets one picture per page.
//
// SHOTS=<dir> saves light and dark pictures of each step.

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn, mapMenu } from '../../helpers';

const ts = Date.now();
const ADA = `j-textprint-ada-${ts}@example.com`;
const SHOTS = process.env.SHOTS;
const FORDYCE_BBM = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures/fordyce-2026.bbm'), 'utf8');

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
  }
}

async function open(page: Page, data: object): Promise<string> {
  const res = await page.request.post('/api/layouts', { data });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30000 });
  return id;
}

/** The text cells' boxes, from the saved layout. */
async function textBoxes(page: Page, id: string): Promise<{ text: string; w: number; h: number }[]> {
  const xml = await (await page.request.get(`/api/layouts/${id}/export.bbm`)).text();
  return [...xml.matchAll(/<TextCell>[\s\S]*?<Width>([^<]+)<\/Width>\s*<Height>([^<]+)<\/Height>[\s\S]*?<Text>([^<]*)<\/Text>[\s\S]*?<\/TextCell>/g)].map((m) => ({
    w: Number(m[1]),
    h: Number(m[2]),
    text: m[3]!,
  }));
}

async function addText(page: Page, text: string, size: number): Promise<void> {
  await mapMenu(page, 'Insert', 'Text…');
  const dialog = page.getByRole('dialog', { name: 'Add text' });
  await dialog.getByLabel('Text:').fill(text);
  await dialog.getByLabel('Size (pt):').fill(String(size));
  await dialog.getByRole('button', { name: /^(OK|Add)/ }).click();
  await expect(dialog).toHaveCount(0);
}

test.describe('text size and print', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the Size field decides how big text is, and the box follows it', async ({ page }) => {
    await signIn(page, ADA, 'Ada Text');
    const id = await open(page, { title: `Text ${ts}` });
    await addText(page, 'Station', 12);
    await addText(page, 'Station', 48);
    await expect.poll(async () => (await textBoxes(page, id)).length).toBe(2);
    const [small, big] = await textBoxes(page, id);
    expect(big!.h / small!.h).toBeCloseTo(4, 1);
    expect(big!.w / small!.w).toBeCloseTo(4, 0);
    await shot(page, 'text-sizes');

    // (Editing re-fits the box the same way: unit-tested in textCells.test.tsx.)
  });

  test('a print of hundreds of pages says so, offers a PDF, and asks first', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, ADA, 'Ada Text');
    await open(page, { title: `Big print ${ts}`, bbm: FORDYCE_BBM });
    await mapMenu(page, 'Download & export', 'Export as image…');
    const dialog = page.getByRole('dialog', { name: 'Export / Print' });
    await dialog.getByRole('button', { name: 'Print (1:1)' }).click();
    await expect(dialog.getByTestId('print-pages')).toContainText(/pages at actual size \(1 stud = 8 mm\), about [\d,.]+ MB of pictures/);
    await expect(dialog.getByTestId('print-many')).toContainText('PDF (A3)');
    await shot(page, 'print-many');
    let popups = 0;
    page.context().on('page', () => (popups += 1));
    await dialog.getByRole('button', { name: 'Open Print Preview' }).click();
    const ask = page.getByRole('alertdialog', { name: /^Print [\d,]+ pages\?$/ });
    await expect(ask).toBeVisible();
    await shot(page, 'print-ask');
    await ask.getByRole('button', { name: 'Not now' }).click();
    await page.waitForTimeout(500);
    expect(popups).toBe(0);
    // The PDF instead.
    await dialog.getByTestId('print-many').getByRole('button', { name: 'PDF (A3)' }).click();
    await expect(dialog.getByRole('button', { name: 'Export PDF' })).toBeVisible();
  });

  test('a small print window gets one picture per page', async ({ page }) => {
    await signIn(page, ADA, 'Ada Text');
    await open(page, { title: `Small print ${ts}` });
    await addText(page, 'Yard', 24);
    await mapMenu(page, 'Download & export', 'Export as image…');
    const dialog = page.getByRole('dialog', { name: 'Export / Print' });
    await dialog.getByRole('button', { name: 'Print (1:1)' }).click();
    const pages = Number(/= ([\d,]+) page/.exec((await dialog.getByTestId('print-pages').textContent()) ?? '')?.[1]?.replace(/,/g, ''));
    expect(pages).toBeGreaterThan(0);
    const [popup] = await Promise.all([page.waitForEvent('popup'), dialog.getByRole('button', { name: 'Open Print Preview' }).click()]);
    await expect.poll(() => popup.locator('img').count(), { timeout: 30000 }).toBe(pages);
    expect(await popup.locator('img').first().getAttribute('src')).toMatch(/^blob:/);
    await popup.close();
  });
});
