// Journey — the demo, a private demo space per visitor.
//
//   1. An admin turns on Admin › Settings › Demo account; "Try the demo"
//      appears on the sign-in page (it isn't there while the demo is off).
//      The page shows the most demo spaces at once, with ⓘ, and how many
//      are in use, live.
//   2. A visitor tries the demo: no sign-up, a banner says it resets, and
//      their own copy of the sample layout is there. A second visitor gets
//      a space of their own, with another name, and can't open the first
//      one's layout. The first adds a part to their copy and makes a layout.
//   3. A link to the sample itself opens the visitor's own copy.
//   4. The admin presses Reset now while the visitor has their copy open.
//      The reset signs every visitor out: the live layout closes and the
//      page says "The demo was reset. Start again?" instead of an error.
//      One click brings them back in, to a Home with a fresh copy of the
//      sample and their layout gone; the sample's link still works.
//   5. With the most spaces at once at 1, another visitor is told "The demo
//      is busy right now".
//   6. Turning the demo off signs the visitor out and hides Try the demo;
//      their page says the demo has ended.

import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { signIn, adminSection } from '../../helpers';
import { makeGlobalAdmin } from '../../dbHelpers';

const ts = Date.now();
const ADMIN = `j-demo-admin-${ts}@example.com`;
const PART = 'ts_narrowgauge_straight.8';
const SAMPLE = 'Sample layout';

/** The sample layout's own id (the server's DEMO_SAMPLE_IDS.layout: UUIDv5, the same after every reset). */
function sampleLayoutId(): string {
  const ns = Buffer.from('6f0c2d1e9a4b5c3d8e7f0a1b2c3d4e5f', 'hex');
  const hash = createHash('sha1').update(ns).update('demo-account:layout', 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const h = hash.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
const SAMPLE_ID = sampleLayoutId();

/** Who the page is signed in as. */
async function whoAmI(page: Page): Promise<{ id: string; displayName: string } | null> {
  return ((await (await page.request.get('/api/auth/me')).json()) as { user: { id: string; displayName: string } | null }).user;
}

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

test('an admin turns on the demo, each visitor gets a private space, Reset now signs them out and Start again brings them back', async ({ page: admin, browser }) => {
  test.setTimeout(300_000);
  await signIn(admin, ADMIN, 'Demo Admin');
  makeGlobalAdmin(ADMIN);
  const visitorCtx = await browser.newContext();
  const visitor = await visitorCtx.newPage();
  const otherCtx = await browser.newContext();
  const other = await otherCtx.newPage();

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
    await expect(admin.getByLabel('Most demo spaces at once')).toHaveValue('100');
    await expect(admin.getByTestId('demo-live-spaces')).toHaveText('0 demo spaces in use now');
    await admin.getByTestId('demo-max-spaces').getByRole('button', { name: /help/i }).click();
    await expect(admin.getByText(/A space and everything in it is deleted when its sign-in ends/).first()).toBeVisible();
    await admin.keyboard.press('Escape');

    // ── 2. A visitor tries it. ──
    await visitor.goto('/login');
    await visitor.getByRole('button', { name: 'Try the demo' }).click();
    await expect(visitor.getByTestId('demo-banner')).toContainText(/This is a demo\. Everything resets every day \(next reset in \d+ h( \d+ min)?\)\./);
    await expect(visitor.getByText(SAMPLE, { exact: true }).first()).toBeVisible();
    const [sample] = await myLayouts(visitor);
    expect(sample!.title).toBe(SAMPLE);
    // Their own copy, not the sample itself.
    expect(sample!.id).not.toBe(SAMPLE_ID);
    const original = await savedBricks(visitor, sample!.id);
    expect(original).toBeGreaterThan(100);
    // The admin's count goes up without a reload.
    await expect(admin.getByTestId('demo-live-spaces')).toHaveText('1 demo space in use now', { timeout: 15000 });

    // A second visitor: a space of their own, another name, and no way into the first's.
    await other.goto('/login');
    await other.getByRole('button', { name: 'Try the demo' }).click();
    await expect(other.getByTestId('demo-banner')).toBeVisible();
    const [one, two] = [await whoAmI(visitor), await whoAmI(other)];
    expect(one!.id).not.toBe(two!.id);
    expect(one!.displayName).toMatch(/^Demo builder [0-9a-f]{4}$/);
    expect(two!.displayName).toMatch(/^Demo builder [0-9a-f]{4}$/);
    expect(one!.displayName).not.toBe(two!.displayName);
    const theirs = await myLayouts(other);
    expect(theirs.map((l) => l.title)).toEqual([SAMPLE]);
    expect(theirs[0]!.id).not.toBe(sample!.id);
    expect((await other.request.get(`/api/layouts/${sample!.id}`)).status()).toBe(404);
    await expect(admin.getByTestId('demo-live-spaces')).toHaveText('2 demo spaces in use now', { timeout: 15000 });

    // They add a part to the sample in the editor, and it saves.
    await visitor.goto(`/editor/${sample!.id}`);
    await expect(visitor.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    await expect.poll(() => brickCount(visitor), { timeout: 15000 }).toBe(original);
    await visitor.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
    await visitor.locator(`[title*="(${PART})"]`).first().dblclick();
    await expect.poll(() => brickCount(visitor)).toBe(original + 1);
    await expect.poll(() => savedBricks(visitor, sample!.id), { timeout: 15000 }).toBe(original + 1);

    // …and a layout of their own. The other visitor's copy has none of it.
    expect((await visitor.request.post('/api/layouts', { data: { title: `Visitor layout ${ts}` } })).ok()).toBe(true);
    expect(await savedBricks(other, theirs[0]!.id)).toBe(original);
    expect((await myLayouts(other)).map((l) => l.title)).toEqual([SAMPLE]);

    // ── 3. A link to the sample itself opens their own copy. ──
    await visitor.goto(`/editor/${SAMPLE_ID}`);
    await expect(visitor).toHaveURL(new RegExp(`/editor/${sample!.id}$`));
    await expect(visitor.getByText('This is your own copy of the demo sample. Change anything you like.')).toBeVisible({ timeout: 15000 });
    await expect.poll(() => brickCount(visitor), { timeout: 15000 }).toBe(original + 1);
    await expect(admin.getByTestId('demo-sign-in-note')).toContainText('Demo sign-ins end at each demo reset (at most 24 hours)');

    // ── 4. The admin resets it while the visitor has the layout open. ──
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

    // A fresh copy of the sample, without the added part, in a new space;
    // the sample's own link still opens it.
    const after = await myLayouts(visitor);
    expect(after.map((l) => l.title)).toEqual([SAMPLE]);
    expect(after[0]!.id).not.toBe(sample!.id);
    expect(await savedBricks(visitor, after[0]!.id)).toBe(original);
    await visitor.goto(`/editor/${SAMPLE_ID}`);
    await expect(visitor).toHaveURL(new RegExp(`/editor/${after[0]!.id}$`));
    await expect(visitor.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    await expect.poll(() => brickCount(visitor), { timeout: 15000 }).toBe(original);
    await expect(visitor.getByText(/This layout isn't here/)).toHaveCount(0);
    await visitor.goto('/');
    // The reset took the other visitor's space too.
    expect(await whoAmI(other)).toBeNull();
    await expect(admin.getByTestId('demo-live-spaces')).toHaveText('1 demo space in use now', { timeout: 15000 });

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

    // ── 5. At the most spaces at once, the next visitor is told the demo is busy. ──
    const most = admin.getByLabel('Most demo spaces at once');
    await most.fill('1');
    await admin.getByTestId('demo-max-spaces').getByRole('button', { name: 'Save' }).click();
    await expect(most).toHaveValue('1');
    await expect(admin.getByTestId('demo-max-spaces').getByRole('button', { name: 'Save' })).toHaveCount(0);
    // (A new visitor: the second one's page is showing "The demo was reset".)
    const lateCtx = await browser.newContext();
    const late = await lateCtx.newPage();
    await late.goto('/login');
    await late.getByRole('button', { name: 'Try the demo' }).click();
    await expect(late.getByText('The demo is busy right now. Try again in a few minutes.')).toBeVisible();
    expect(await whoAmI(late)).toBeNull();
    await lateCtx.close();
  } finally {
    // ── 4. Off again (the journeys share one server). ──
    await admin.request.patch('/api/admin/settings', { data: { demoEnabled: false, demoMaxSpaces: 100 } });
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
  await otherCtx.close();
});
