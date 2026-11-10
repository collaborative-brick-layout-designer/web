// Switching layouts inside the app never mixes them (an old desktop did:
// desktop #171, web #340). Open A and edit it, go to B through the app:
// B, here and on the server, has none of A's parts. Then edit A offline,
// leave it for B, come back online: A's edit lands in A only.

import { test, expect, type Page } from '@playwright/test';
import { signIn } from '../helpers';

const PART = 'ts_narrowgauge_straight.8';

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: { name: () => string; getClassName: () => string }) => boolean) => unknown[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}

/** How many of the part the server's copy of a layout holds. */
async function onServer(page: Page, id: string): Promise<number> {
  const r = await page.request.get(`/api/layouts/${id}/export.bbm`);
  expect(r.ok()).toBe(true);
  return ((await r.text()).match(new RegExp(PART.replace('.', '\\.'), 'gi')) ?? []).length;
}

async function placePart(page: Page): Promise<void> {
  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
}

async function openFromList(page: Page, id: string): Promise<void> {
  await page.locator(`a[href="/editor/${id}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/editor/${id}$`));
}

test('switching layouts in the app keeps each layout to itself, online and offline', async ({ page, context }) => {
  test.setTimeout(150_000);
  const ts = Date.now();
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `switch-${ts}@example.com`, 'Switch Builder');
  const make = async (title: string) => ((await (await page.request.post('/api/layouts', { data: { title } })).json()) as { id: string }).id;
  const a = await make(`Layout A ${ts}`);
  const b = await make(`Layout B ${ts}`);

  // Open A from the layouts list and place a part.
  await page.goto('/');
  await openFromList(page, a);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await placePart(page);
  await expect.poll(() => brickCount(page)).toBe(1);
  await expect.poll(() => onServer(page, a)).toBe(1);

  // Back to the list, open B: none of A's parts, here or on the server.
  await page.goBack();
  await openFromList(page, b);
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(500);
  expect(await brickCount(page)).toBe(0);
  expect(await onServer(page, b)).toBe(0);

  // Back to A, then offline: the edit waits on this computer.
  await page.goBack();
  await openFromList(page, a);
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect.poll(() => brickCount(page)).toBe(1);
  await page.waitForLoadState('networkidle');
  await context.setOffline(true);
  await expect(page.getByText(/^(Reconnecting…|Offline.*)$/)).toBeVisible({ timeout: 45000 });
  await placePart(page);
  await expect.poll(() => brickCount(page)).toBe(2);

  // Leave A for B while still offline (Back, then B from the list).
  await page.goBack();
  await openFromList(page, b);
  // (The API calls here come from the test, not the offline page.)
  expect(await onServer(page, a)).toBe(1);

  // Online again: B opens with nothing of A's; A's edit reaches A only.
  await context.setOffline(false);
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 45000 });
  await expect.poll(() => onServer(page, a), { timeout: 30000 }).toBe(2);
  expect(await onServer(page, b)).toBe(0);
  expect(await brickCount(page)).toBe(0);

  // And A, opened again, has both parts.
  await page.goBack();
  await openFromList(page, a);
  await expect.poll(() => brickCount(page)).toBe(2);
});
