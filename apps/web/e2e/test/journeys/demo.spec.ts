// Journey — the demo account.
//
//   1. An admin turns on Admin › Settings › Demo account; "Try the demo"
//      appears on the sign-in page (it isn't there while the demo is off).
//   2. A visitor tries the demo: no sign-up, a banner says it resets, and
//      the sample layout is there. They add a part to it and make a layout
//      of their own.
//   3. The admin presses Reset now while the visitor has the sample open in
//      the editor. The reset signs every visitor out: the live layout
//      closes and the page says "The demo was reset. Start again?" instead
//      of an error. One click brings them back in, to a Home where their
//      layout is gone and the sample is back, unedited.
//   4. Turning the demo off signs the visitor out and hides Try the demo;
//      their page says the demo has ended.

import { test, expect, type Page } from '@playwright/test';
import { signIn, adminSection } from '../../helpers';
import { makeGlobalAdmin } from '../../dbHelpers';

const ts = Date.now();
const ADMIN = `j-demo-admin-${ts}@example.com`;
const PART = 'ts_narrowgauge_straight.8';
const SAMPLE = 'Sample layout';

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}

/** The visitor's layouts, from the server. */
async function myLayouts(page: Page): Promise<{ id: string; title: string }[]> {
  const res = await page.request.get('/api/layouts');
  return ((await res.json()) as { layouts: { id: string; title: string }[] }).layouts;
}

/** How many parts the server has for a layout (its .bbm export). */
async function savedBricks(page: Page, id: string): Promise<number> {
  const bbm = await (await page.request.get(`/api/layouts/${id}/export.bbm`)).text();
  return bbm.split('<Brick ').length - 1;
}

test('an admin turns on the demo, a visitor tries it, Reset now signs them out and Start again brings them back', async ({ page: admin, browser }) => {
  test.setTimeout(240_000);
  await signIn(admin, ADMIN, 'Demo Admin');
  makeGlobalAdmin(ADMIN);
  const visitorCtx = await browser.newContext();
  const visitor = await visitorCtx.newPage();

  // Off: the sign-in page has no Try the demo.
  await visitor.goto('/login');
  await expect(visitor.getByRole('heading', { name: /Sign in/ })).toBeVisible();
  await expect(visitor.getByRole('button', { name: 'Try the demo' })).toHaveCount(0);

  try {
    // ── 1. The admin turns it on. ──
    await admin.goto('/admin');
    await adminSection(admin, 'settings');
    const enable = admin.getByLabel('Enable the demo account');
    await expect(enable).not.toBeChecked();
    await enable.click(); // saved, then shown from the server
    await expect(enable).toBeChecked();
    await expect(admin.getByLabel('Daily')).toBeChecked();
    await expect(admin.getByRole('button', { name: 'Reset now' })).toBeEnabled();
    await expect(admin.getByTestId('demo-last-reset')).toContainText('Last reset');
    await expect(admin.getByTestId('demo-last-reset')).toContainText('3 things in it now');

    // ── 2. A visitor tries it. ──
    await visitor.goto('/login');
    await visitor.getByRole('button', { name: 'Try the demo' }).click();
    await expect(visitor.getByTestId('demo-banner')).toContainText(/This is a demo\. Everything resets every day \(next reset in \d+ h( \d+ min)?\)\./);
    await expect(visitor.getByText(SAMPLE, { exact: true }).first()).toBeVisible();
    const [sample] = await myLayouts(visitor);
    expect(sample!.title).toBe(SAMPLE);
    const original = await savedBricks(visitor, sample!.id);
    expect(original).toBeGreaterThan(100);

    // They add a part to the sample in the editor, and it saves.
    await visitor.goto(`/editor/${sample!.id}`);
    await expect(visitor.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    await expect.poll(() => brickCount(visitor), { timeout: 15000 }).toBe(original);
    await visitor.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
    await visitor.locator(`[title*="(${PART})"]`).first().dblclick();
    await expect.poll(() => brickCount(visitor)).toBe(original + 1);
    await expect.poll(() => savedBricks(visitor, sample!.id), { timeout: 15000 }).toBe(original + 1);

    // …and a layout of their own.
    expect((await visitor.request.post('/api/layouts', { data: { title: `Visitor layout ${ts}` } })).ok()).toBe(true);
    await expect(admin.getByTestId('demo-sign-in-note')).toContainText('Demo sign-ins end at each demo reset (at most 24 hours)');

    // ── 3. The admin resets it while the visitor has the layout open. ──
    const lastBefore = await admin.getByTestId('demo-last-reset').textContent();
    await admin.getByRole('button', { name: 'Reset now' }).click();
    const notice = visitor.getByRole('alertdialog', { name: 'The demo was reset. Start again?' });
    await expect(notice).toBeVisible({ timeout: 15000 });
    await expect(notice).toContainText('Everything in the demo went back to the start');
    // The editor behind it says so in the same words, not "this layout isn't here".
    await expect(visitor.getByText('The demo was reset, so this layout went back to the start.')).toBeVisible();
    await expect(visitor.getByText(/This layout isn't here/)).toHaveCount(0);
    expect(((await (await visitor.request.get('/api/auth/me')).json()) as { user: unknown }).user).toBeNull();
    await expect(admin.getByTestId('demo-last-reset')).not.toHaveText(lastBefore ?? '');

    // One click back in: Home, with the sample back and their layout gone.
    await notice.getByRole('button', { name: 'Start again' }).click();
    await expect(visitor).toHaveURL(/\/$/);
    await expect(visitor.getByTestId('demo-banner')).toBeVisible();
    await expect(visitor.getByText(SAMPLE, { exact: true }).first()).toBeVisible();
    await expect(visitor.getByText(`Visitor layout ${ts}`)).toHaveCount(0);
    await expect(visitor.getByRole('alertdialog')).toHaveCount(0);

    // The sample is back as it was: a fresh copy, without the added part.
    const after = await myLayouts(visitor);
    expect(after.map((l) => l.title)).toEqual([SAMPLE]);
    expect(after[0]!.id).not.toBe(sample!.id);
    expect(await savedBricks(visitor, after[0]!.id)).toBe(original);

    // The demo can't share: the server says so in plain words.
    const share = await visitor.request.post(`/api/layouts/${after[0]!.id}/public-share`);
    expect(share.status()).toBe(403);
    // …and the pages don't offer what it would refuse: Share… says why and
    // keeps only the picture; Clubs explains instead of a failing Ask to join.
    await visitor.getByRole('button', { name: `More for ${SAMPLE}` }).click();
    await visitor.getByRole('menuitem', { name: 'Share…' }).click();
    const dialog = visitor.getByRole('dialog', { name: `Share ${SAMPLE}` });
    await expect(dialog).toContainText('The demo account can’t invite people or make a share link.');
    await expect(dialog.getByPlaceholder(/email/i)).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await visitor.goto('/orgs');
    await expect(visitor.getByText(/The demo account can’t make or join clubs\./)).toBeVisible();
  } finally {
    // ── 4. Off again (the journeys share one server). ──
    await admin.request.patch('/api/admin/settings', { data: { demoEnabled: false } });
  }
  const me = (await (await visitor.request.get('/api/auth/me')).json()) as { user: unknown };
  expect(me.user).toBeNull();
  await visitor.goto('/login');
  await expect(visitor.getByRole('heading', { name: /Sign in/ })).toBeVisible();
  await expect(visitor.getByRole('button', { name: 'Try the demo' })).toHaveCount(0);
  // Their page says the demo has ended, and Sign in closes that.
  const ended = visitor.getByRole('alertdialog', { name: 'The demo has ended' });
  await expect(ended).toBeVisible();
  await ended.getByRole('button', { name: 'Sign in' }).click();
  await expect(visitor.getByRole('alertdialog')).toHaveCount(0);
  await visitorCtx.close();
});
