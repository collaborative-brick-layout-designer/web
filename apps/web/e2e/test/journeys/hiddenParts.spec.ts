// Journey — parts that are only used inside their sets.
//
//   A library set's buildings (BlueBrick's NotListedInLibrary) and Sam's
//   flex halves (one marked in its XML, one marked from his parts list with
//   "Only used inside sets") aren't in the Parts panel → "Show hidden parts"
//   shows them, greyed, and double-clicking one doesn't place it → "Show its
//   parts" on the set opens them → the set itself still places whole.

import { test, expect, type Page } from '@playwright/test';
import { signIn } from '../../helpers';

const ts = Date.now();
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const b64 = (s: string) => Buffer.from(s).toString('base64');
const HALF_A = `HALFA${ts}`;
const HALF_B = `HALFB${ts}`;
const WHOLE = `WHOLE${ts}`;
const FLEX = `Flex ${ts}`;

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}

test('parts only used inside sets are hidden from the Parts panel and never placed alone', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, `j-hidden-${ts}@example.com`, 'Sam');
  const upload = async (partNumber: string, xml: string) => {
    const r = await page.request.post('/api/custom-parts', { data: { partNumber, displayName: partNumber, xmlBase64: b64(xml), spriteBase64: PNG, spriteMime: 'image/png' } });
    expect(r.status()).toBe(201);
  };
  await upload(HALF_A, '<part><NotListedInLibrary>true</NotListedInLibrary></part>');
  await upload(HALF_B, '<part></part>');
  await upload(WHOLE, '<part></part>');
  const set = await page.request.post('/api/custom-parts', {
    data: {
      partNumber: FLEX,
      displayName: FLEX,
      xmlBase64: b64(`<group><Description><en>${FLEX}</en></Description><SubPartList><SubPart id="${HALF_A}"><position><x>0</x><y>0</y></position><angle>0</angle></SubPart><SubPart id="${HALF_B}"><position><x>8</x><y>0</y></position><angle>0</angle></SubPart></SubPartList></group>`),
    },
  });
  expect(set.status()).toBe(201);

  // ── From his parts list, Sam marks the second half too. ──
  await page.goto('/#parts');
  await page.getByRole('button', { name: `More for ${HALF_B}` }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Only used inside sets' }).click();
  const rowB = page.getByRole('listitem').filter({ hasText: HALF_B });
  await expect(rowB.getByTestId('only-in-sets')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('listitem').filter({ hasText: HALF_A }).getByTestId('only-in-sets')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: WHOLE }).getByTestId('only-in-sets')).toHaveCount(0);

  // ── In the editor, the halves (and a library set's buildings) aren't listed. ──
  const layout = (await (await page.request.post('/api/layouts', { data: { title: 'Hidden parts' } })).json()) as { id: string };
  await page.goto(`/editor/${layout.id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  const filter = page.getByPlaceholder('Search parts (name or number)').first();
  const tile = (key: string) => page.locator('aside li button').filter({ hasText: key });
  await filter.fill(String(ts));
  await expect(tile(FLEX)).toBeVisible({ timeout: 15000 });
  await expect(tile(WHOLE)).toBeVisible();
  await expect(tile(HALF_A)).toHaveCount(0);
  await expect(tile(HALF_B)).toHaveCount(0);
  await filter.fill('10193-1.tree');
  await expect(page.locator('[data-part-key="10193-1.tree"]')).toHaveCount(0);

  // ── "Show hidden parts" shows them, greyed; double-clicking one doesn't place it. ──
  const show = page.getByLabel(/Show hidden parts/);
  await expect(page.getByRole('button', { name: /help/i }).first()).toBeVisible();
  await show.check();
  await expect(page.locator('[data-part-key="10193-1.tree"]')).toBeVisible();
  await filter.fill(String(ts));
  await expect(tile(HALF_A)).toBeVisible();
  await expect(tile(HALF_A)).toContainText('Only in sets');
  await expect(tile(HALF_A)).toHaveAttribute('draggable', 'false');
  await tile(HALF_A).dblclick();
  await expect(page.getByTestId('notice')).toContainText('is only used inside a set, so it isn’t placed by itself');
  expect(await brickCount(page)).toBe(0);
  // It's remembered in this browser.
  await page.reload();
  await expect(page.getByLabel(/Show hidden parts/)).toBeChecked({ timeout: 15000 });
  await page.getByLabel(/Show hidden parts/).uncheck();

  // ── "Show its parts" on the set opens them. ──
  await page.getByPlaceholder('Search parts (name or number)').first().fill(String(ts));
  await tile(FLEX).click({ button: 'right' });
  await page.getByRole('button', { name: 'Show its parts' }).click();
  await expect(page.getByTestId('open-set')).toContainText(`Parts in the set “${FLEX}”`);
  await expect(tile(HALF_A)).toBeVisible();
  await expect(tile(HALF_B)).toBeVisible();
  await expect(tile(WHOLE)).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to all parts' }).click();
  await expect(tile(HALF_A)).toHaveCount(0);

  // ── The set itself places whole, as before. ──
  await tile(FLEX).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('footer')).toContainText(`Placed set: ${FLEX} (2 parts)`);
  await expect.poll(() => brickCount(page)).toBe(2);
});
