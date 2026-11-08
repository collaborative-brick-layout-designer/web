// The Modules panel, as a club member uses it: make some parts a module in
// this layout, then save it to the Module library from its menu. The save says
// so, the row says it's in the Module library, and the module is on Home where it
// opens with its parts.

import { test, expect, type Page } from '@playwright/test';
import { signIn, makeModule } from '../helpers';

const ts = Date.now();
const PART = 'ts_narrowgauge_straight.8';

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}

test('make a module, save it to the Module library, find it on Home', async ({ page }) => {
  await signIn(page, `modpanel-${ts}@example.com`, 'Panel User');
  const res = await page.request.post('/api/layouts', { data: { title: 'Panel layout' } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  for (let i = 0; i < 2; i++) {
    await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
    await page.locator(`[title*="(${PART})"]`).first().dblclick();
  }
  await expect.poll(() => brickCount(page)).toBe(2);

  // Map > Make a module: in this layout only.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+a');
  await makeModule(page, `Siding ${ts}`);
  await expect(page.getByText(`“Siding ${ts}” is a module in this layout`)).toBeVisible();
  expect(((await (await page.request.get('/api/modules')).json()) as { modules: { title: string }[] }).modules.some((m) => m.title === `Siding ${ts}`)).toBe(false);

  // Modules panel: right-click it > Save to Module library…
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel('Modules', { exact: true }).check();
  await page.mouse.click(400, 400);
  await page.getByText(`Siding ${ts}`, { exact: true }).click({ button: 'right' });
  await expect(page.getByText(`Siding ${ts}`, { exact: true }).locator('..')).toContainText('2 parts');
  await expect(page.getByRole('button', { name: 'Ungroup (keep the parts)' })).toBeVisible();
  await page.getByRole('button', { name: 'Save to Module library…' }).click();
  await page.getByRole('dialog', { name: `Save “Siding ${ts}” to the Module library` }).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(`Saved “Siding ${ts}” to the Module library`)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(`Siding ${ts}`, { exact: true }).locator('..')).toContainText('in the Module library v1');

  // Home lists it; it opens with both parts.
  await page.goto('/');
  const row = page.getByTestId('module-row').filter({ hasText: `Siding ${ts}` });
  await row.getByRole('link', { name: `Open Siding ${ts}` }).click();
  await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(2);
});
