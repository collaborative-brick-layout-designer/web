// Journey — the site keeps itself up to date, without reloading.
//
//   1. In the editor, Make a module with "Also save to my Module library" and the
//      Modules panel's Save to Module library… both show the module in the open Module
//      library panel straight away (this tab's own change; the live
//      stream is blocked here, so it isn't what makes it work).
//   2. Two members of a club, each in their own browser: what one adds to
//      the club shows on the other's Home and in their editor's Module
//      library, through the live stream.
//   3. Someone outside the club gets no hint of it, and sees nothing new.

import { test, expect, type Page, type BrowserContext, type Browser } from '@playwright/test';
import { signIn, makeModule } from '../../helpers';

const ts = Date.now();
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

const libraryRow = (page: Page, title: string) => page.getByTestId('module-library-row').filter({ hasText: title });

async function openModuleLibrary(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel('Module library').check();
  await page.mouse.click(400, 400);
}

/** Record the live hints this page receives (LiveUpdates fires one window event each). */
async function recordHints(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __hints: unknown[] };
    w.__hints = [];
    window.addEventListener('cld-live-hint', (e) => w.__hints.push((e as CustomEvent).detail));
  });
}
const hints = (page: Page) => page.evaluate(() => (window as unknown as { __hints: Array<{ kind: string; id?: string }> }).__hints);
const streamOpen = (page: Page) => expect(page.locator('html')).toHaveAttribute('data-live', 'open', { timeout: 15000 });

async function member(browser: Browser, email: string, name: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, email, name);
  return { ctx, page };
}

test('saving a module shows it in the open Module library at once', async ({ page }) => {
  // No live stream: this tab's own save has to refresh its lists by itself.
  await page.route('**/api/events', (r) => r.abort());
  await signIn(page, `live-self-${ts}@example.com`, 'Self');
  const res = await page.request.post('/api/layouts', { data: { title: 'Live layout' } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await openModuleLibrary(page);
  await expect(page.getByText('No saved modules yet.')).toBeVisible();
  for (let i = 0; i < 2; i++) await placePart(page);
  await expect.poll(() => brickCount(page)).toBe(2);

  // Map > Make a module, and save it to the Module library in one go.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+a');
  await makeModule(page, `Crossing ${ts}`, { alsoSave: true });
  await expect(libraryRow(page, `Crossing ${ts}`)).toBeVisible({ timeout: 10000 });

  // New parts: Map > Make a module, then Modules panel > Save to Module library…
  await page.keyboard.press('Delete');
  await expect.poll(() => brickCount(page)).toBe(0);
  for (let i = 0; i < 2; i++) await placePart(page);
  await expect.poll(() => brickCount(page)).toBe(2);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+a');
  await makeModule(page, `Siding ${ts}`);
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel('Modules', { exact: true }).check();
  await page.mouse.click(400, 400);
  await page.getByText(`Siding ${ts}`, { exact: true }).first().click({ button: 'right' });
  await page.getByRole('button', { name: 'Save to Module library…' }).click();
  await page.getByRole('dialog', { name: `Save “Siding ${ts}” to the Module library` }).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(`Saved “Siding ${ts}” to the Module library`)).toBeVisible({ timeout: 15000 });
  await expect(libraryRow(page, `Siding ${ts}`)).toBeVisible({ timeout: 10000 });
  // Still the same page: nothing reloaded it.
  await expect(page).toHaveURL(new RegExp(`/editor/${id}$`));
});

test('what one club member adds shows for the others, and for nobody outside the club', async ({ browser }) => {
  const a = await member(browser, `live-a-${ts}@example.com`, 'Member A');
  const b = await member(browser, `live-b-${ts}@example.com`, 'Member B');
  const c = await member(browser, `live-c-${ts}@example.com`, 'Outsider C');
  try {
    // A starts a club anyone can join; B joins it. C doesn't.
    const club = (await (await a.page.request.post('/api/orgs', { data: { name: `Live club ${ts}` } })).json()) as { slug: string };
    expect((await a.page.request.patch(`/api/orgs/${club.slug}`, { data: { joinPolicy: 'open', listed: true } })).ok()).toBe(true);
    expect((await b.page.request.post(`/api/orgs/${club.slug}/join`, { data: {} })).ok()).toBe(true);

    // B: Home, and an editor with the Module library open (a second tab).
    await b.page.goto('/');
    await streamOpen(b.page);
    await recordHints(b.page);
    const bEditor = await b.ctx.newPage();
    const own = (await (await bEditor.request.post('/api/layouts', { data: { title: 'B layout' } })).json()) as { id: string };
    await bEditor.goto(`/editor/${own.id}`);
    await expect(bEditor.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    await openModuleLibrary(bEditor);
    await streamOpen(bEditor);
    // C: Home.
    await c.page.goto('/');
    await streamOpen(c.page);
    await recordHints(c.page);
    await expect(c.page.getByText(`Club module ${ts}`)).toHaveCount(0);

    // A adds a module and a layout to the club.
    expect((await a.page.request.post('/api/modules', { data: { title: `Club module ${ts}`, orgSlug: club.slug } })).ok()).toBe(true);
    expect((await a.page.request.post('/api/layouts', { data: { title: `Club layout ${ts}`, orgSlug: club.slug } })).ok()).toBe(true);

    // B sees both on Home and the module in the editor's library, without a reload.
    await expect(b.page.getByTestId('module-row').filter({ hasText: `Club module ${ts}` })).toBeVisible({ timeout: 10000 });
    await expect(b.page.getByText(`Club layout ${ts}`).first()).toBeVisible({ timeout: 10000 });
    await expect(libraryRow(bEditor, `Club module ${ts}`)).toBeVisible({ timeout: 10000 });
    expect((await hints(b.page)).map((h) => h.kind)).toEqual(expect.arrayContaining(['module', 'layout']));

    // C got no hint at all, and their Home shows nothing new.
    await b.page.waitForTimeout(500);
    expect(await hints(c.page)).toEqual([]);
    await expect(c.page.getByText(`Club module ${ts}`)).toHaveCount(0);
    await expect(c.page.getByText(`Club layout ${ts}`)).toHaveCount(0);
  } finally {
    await a.ctx.close();
    await b.ctx.close();
    await c.ctx.close();
  }
});
