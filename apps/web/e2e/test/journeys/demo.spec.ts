// Journey — the demo, a private demo space per visitor.
//
//   1. An admin turns on Admin › Settings › Demo account; "Try the demo"
//      appears on the sign-in page (it isn't there while the demo is off).
//      The page shows the most demo spaces at once, with ⓘ, and how many
//      are in use, live.
//   2. A visitor tries the demo: no sign-up, a banner counts their time, and
//      their own copy of the sample layout is there. A second visitor gets
//      a space of their own, with another name, and can't open the first
//      one's layout. The first adds a part to their copy and makes a layout.
//   3. A link to the sample itself opens the visitor's own copy.
//   4. The admin presses Reset now while the visitor has their copy open.
//      The reset only puts the template's samples back: nobody is signed
//      out and the visitor keeps their copy and their layout.
//   5. With the most spaces at once at 1, another visitor is told "The demo
//      is busy right now".
//   6. Turning the demo off signs the visitor out and hides Try the demo;
//      their page says the demo has ended.
//
// A second journey gives a space a short time to live: the banner counts
// down, warns in the last 5 minutes with "Download this layout", and at
// the end the page says "The demo was reset. Start again?".

import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { signIn, adminSection } from '../../helpers';
import { makeGlobalAdmin, setDemoSpaceTimeLeft, siteSettingsAtDefaults } from '../../dbHelpers';

siteSettingsAtDefaults();

const ts = Date.now();
const ADMIN = `j-demo-admin-${ts}@example.com`;
const PART = 'ts_narrowgauge_straight.8';
const SAMPLE = 'Sample layout';
/** Set to a folder to keep pictures of the new settings and the "network is full" message, light and dark. */
const SHOTS = process.env.DEMO_SHOTS;

async function shootBoth(page: Page, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `${SHOTS}/${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

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
    // Each space lasts 1 hour unless changed; the setting has ⓘ help.
    await expect(admin.getByTestId('demo-lifetime').getByLabel('1 hour')).toBeChecked();
    await admin.getByTestId('demo-lifetime').getByRole('button', { name: /help/i }).click();
    await expect(admin.getByText(/A visitor sees a friendly countdown/).first()).toBeVisible();
    await admin.keyboard.press('Escape');
    await expect(admin.getByTestId('demo-live-spaces')).toHaveText('0 demo spaces in use now');
    await admin.getByTestId('demo-max-spaces').getByRole('button', { name: /help/i }).click();
    await expect(admin.getByText(/A space and everything in it is deleted when its time is up/).first()).toBeVisible();
    await admin.keyboard.press('Escape');

    // ── 2. A visitor tries it. ──
    await visitor.goto('/login');
    await visitor.getByRole('button', { name: 'Try the demo' }).click();
    await expect(visitor.getByTestId('demo-banner')).toContainText(/Your demo space is yours for about \d+ more minutes\./);
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
    await expect(admin.getByTestId('demo-sign-in-note')).toContainText('Putting the samples back never cuts a visit short');

    // ── 4. The admin resets it while the visitor has the layout open. ──
    const lastBefore = await admin.getByTestId('demo-last-reset').textContent();
    await admin.getByRole('button', { name: 'Reset now' }).click();
    await expect(admin.getByTestId('demo-last-reset')).not.toHaveText(lastBefore ?? '', { timeout: 15000 });
    // Nobody is signed out: the visitor still has their layout open, with their part.
    await expect(visitor.getByRole('alertdialog')).toHaveCount(0);
    expect((await whoAmI(visitor))!.id).toBe(one!.id);
    expect((await whoAmI(other))!.id).toBe(two!.id);
    await expect.poll(() => brickCount(visitor)).toBe(original + 1);
    const after = await myLayouts(visitor);
    expect(after.map((l) => l.title).sort()).toEqual([SAMPLE, `Visitor layout ${ts}`].sort());
    expect(await savedBricks(visitor, sample!.id)).toBe(original + 1);
    await expect(admin.getByTestId('demo-live-spaces')).toHaveText('2 demo spaces in use now', { timeout: 15000 });
    // The sample's own link still opens their copy.
    await visitor.goto(`/editor/${SAMPLE_ID}`);
    await expect(visitor).toHaveURL(new RegExp(`/editor/${sample!.id}$`));
    await expect(visitor.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    await expect(visitor.getByText(/This layout isn't here/)).toHaveCount(0);
    await visitor.goto('/');

    // The demo can't share: the server says so in plain words.
    const share = await visitor.request.post(`/api/layouts/${sample!.id}/public-share`);
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

    // ── 4b. One visitor can't take the demo from everyone. ──
    // "Try the demo" again from the same browser: the space it has, not another.
    const liveBefore = await admin.getByTestId('demo-live-spaces').textContent();
    const again = await visitor.request.post('/api/auth/demo', { data: {} });
    expect(await again.json()).toEqual({ ok: true, reused: true });
    await admin.reload();
    await expect(admin.getByTestId('demo-live-spaces')).toHaveText(liveBefore!);
    // A demo space holds little (50 MB unless changed), with ⓘ help; the admin makes it 1 MB.
    const room = admin.getByTestId('demo-limit-storagePerDemoSpace');
    await expect(room.getByLabel('Space for each demo space (MB)')).toHaveValue('50');
    await room.getByRole('button', { name: /help/i }).click();
    await expect(admin.getByText(/anyone can open a demo space without an account/).first()).toBeVisible();
    await admin.keyboard.press('Escape');
    await room.getByLabel('Space for each demo space (MB)').fill('1');
    await room.getByRole('button', { name: 'Save' }).click();
    await expect(room.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(room.getByLabel('Space for each demo space (MB)')).toHaveValue('1');
    const big = await visitor.request.post('/api/layouts', { data: { title: 'Too big', sidecar: JSON.stringify({ schemaVersion: 1, bbmHashSha256: '', notes: 'x'.repeat(2 * 1024 * 1024) }) } });
    expect(big.status()).toBe(403);
    expect(((await big.json()) as { message: string }).message).toBe('Your demo space is full (1 MB). Delete something you don’t need to make room.');
    // One network address opens only so many at once (10 unless changed), with ⓘ help; the admin makes it 1.
    const perAddress = admin.getByTestId('demo-limit-demoSpacesPerAddress');
    await expect(perAddress.getByLabel('Demo spaces from one network address')).toHaveValue('10');
    await perAddress.getByRole('button', { name: /help/i }).click();
    await expect(admin.getByText(/People on one Wi-Fi/).first()).toBeVisible();
    await admin.keyboard.press('Escape');
    await perAddress.getByLabel('Demo spaces from one network address').fill('1');
    await perAddress.getByRole('button', { name: 'Save' }).click();
    await expect(perAddress.getByRole('button', { name: 'Save' })).toHaveCount(0);
    const crowdCtx = await browser.newContext();
    const crowd = await crowdCtx.newPage();
    await crowd.goto('/login');
    await crowd.getByRole('button', { name: 'Try the demo' }).click();
    await expect(crowd.getByText(/already .* open from your network\. Try again when one ends, in 1 hour at most\./)).toBeVisible();
    if (SHOTS) await shootBoth(crowd, 'demo-network-full');
    expect(await whoAmI(crowd)).toBeNull();
    await crowdCtx.close();
    if (SHOTS) {
      await admin.getByRole('heading', { name: 'Demo account' }).scrollIntoViewIfNeeded();
      await shootBoth(admin, 'demo-admin-limits');
    }
    await admin.request.patch('/api/admin/limits', { data: { demoSpacesPerAddress: null } });

    // ── 5. At the most spaces at once, the next visitor is told the demo is busy. ──
    const most = admin.getByLabel('Most demo spaces at once');
    await most.fill('1');
    await admin.getByTestId('demo-max-spaces').getByRole('button', { name: 'Save' }).click();
    await expect(most).toHaveValue('1');
    await expect(admin.getByTestId('demo-max-spaces').getByRole('button', { name: 'Save' })).toHaveCount(0);
    // (Another new visitor.)
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
    await admin.request.patch('/api/admin/limits', { data: { demoSpacesPerAddress: null, storagePerDemoSpace: null } });
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

test('a demo space counts its time down, warns in the last 5 minutes with a download, and ends with the start-again card', async ({ page: admin, browser }) => {
  test.setTimeout(240_000);
  const email = `j-demo-life-${ts}@example.com`;
  await signIn(admin, email, 'Demo Lifetime Admin');
  makeGlobalAdmin(email);
  const ctx = await browser.newContext();
  const visitor = await ctx.newPage();
  try {
    expect((await admin.request.patch('/api/admin/settings', { data: { demoEnabled: true } })).ok()).toBe(true);
    await visitor.goto('/login');
    await visitor.getByRole('button', { name: 'Try the demo' }).click();
    const banner = visitor.getByTestId('demo-banner');
    await expect(banner).toContainText(/Your demo space is yours for about (59|60) more minutes\./);
    const me = (await whoAmI(visitor))!;
    const [sample] = await myLayouts(visitor);

    // 4 minutes left, in the editor: it warns and offers the layout.
    setDemoSpaceTimeLeft(me.id, 4 * 60_000 + 20_000);
    await visitor.goto(`/editor/${sample!.id}`);
    await expect(banner).toHaveAttribute('data-state', 'ending', { timeout: 15000 });
    await expect(banner).toContainText(/Your demo space is ending soon: \d min left\./);
    const download = banner.getByRole('link', { name: 'Download this layout' });
    await expect(download).toHaveAttribute('href', `/api/layouts/${sample!.id}/export.bld-layout`);
    expect((await visitor.request.get(`/api/layouts/${sample!.id}/export.bld-layout`)).ok()).toBe(true);

    // A few seconds left: the count and the end come with no refresh.
    setDemoSpaceTimeLeft(me.id, 8_000);
    await visitor.reload();
    await expect(banner).toContainText(/ending soon/);
    const notice = visitor.getByRole('alertdialog', { name: 'The demo was reset. Start again?' });
    await expect(notice).toBeVisible({ timeout: 30000 });
    await expect(notice.getByRole('button', { name: 'Start again' })).toBeVisible();
    expect(await whoAmI(visitor)).toBeNull();
    // One click and they have a new space with a full hour.
    await notice.getByRole('button', { name: 'Start again' }).click();
    await expect(visitor.getByTestId('demo-banner')).toContainText(/yours for about (59|60) more minutes/);
    expect((await whoAmI(visitor))!.id).not.toBe(me.id);
  } finally {
    await admin.request.patch('/api/admin/settings', { data: { demoEnabled: false } });
    await ctx.close();
  }
});

/** The banner and the box of `el` share no pixel. */
async function apart(page: Page, el: import('@playwright/test').Locator): Promise<boolean> {
  const a = await page.getByTestId('demo-banner').boundingBox();
  const b = await el.boundingBox();
  if (!a || !b) return false;
  return a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
}

// The countdown used to float over the editor's Build / Venue / Notes /
// Parts list tabs and hide them. In an editor it is now a bar in the page's
// flow above the header: the tabs stay visible and clickable at desktop and
// phone widths, in the last 5 minutes too (when the bar takes clicks).
test('in the editor the demo countdown never covers the task tabs', async ({ page: admin, browser }) => {
  test.setTimeout(240_000);
  const email = `j-demo-tabs-${ts}@example.com`;
  await signIn(admin, email, 'Demo Tabs Admin');
  makeGlobalAdmin(email);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const visitor = await ctx.newPage();
  try {
    expect((await admin.request.patch('/api/admin/settings', { data: { demoEnabled: true } })).ok()).toBe(true);
    await visitor.goto('/login');
    await visitor.getByRole('button', { name: 'Try the demo' }).click();
    const banner = visitor.getByTestId('demo-banner');
    await expect(banner).toBeVisible();
    // Off the editor it still floats, as before.
    await expect(banner).toHaveAttribute('data-placement', 'floating');
    const me = (await whoAmI(visitor))!;
    const [sample] = await myLayouts(visitor);

    for (const left of [30 * 60_000, 4 * 60_000 + 30_000]) {
      setDemoSpaceTimeLeft(me.id, left);
      for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
        await visitor.setViewportSize(size);
        await visitor.goto(`/editor/${sample!.id}`);
        await expect(banner).toHaveAttribute('data-placement', 'inline');
        await expect(banner).toHaveAttribute('data-state', left < 5 * 60_000 ? 'ending' : 'running');
        const header = visitor.locator('header').first();
        await expect(header).toBeVisible();
        // Above the header, not over it.
        expect(await apart(visitor, header)).toBe(true);
        const tabs = visitor.getByRole('group', { name: 'Tasks' });
        // (A phone shows them where it has room; wherever they are, they're clear of the bar.)
        if (size.width >= 768) await expect(tabs).toBeVisible();
        if (await tabs.isVisible()) {
          for (const name of ['Build', 'Venue', 'Notes', 'Parts list']) {
            const tab = tabs.getByRole('button', { name, exact: true });
            await expect(tab).toBeVisible();
            expect(await apart(visitor, tab)).toBe(true);
          }
          // Clickable: the click reaches the tab, not the bar.
          await tabs.getByRole('button', { name: 'Venue', exact: true }).click();
          await expect(tabs.getByRole('button', { name: 'Venue', exact: true })).toHaveAttribute('aria-pressed', 'true');
          await tabs.getByRole('button', { name: 'Build', exact: true }).click();
          await expect(tabs.getByRole('button', { name: 'Build', exact: true })).toHaveAttribute('aria-pressed', 'true');
        }
      }
    }
  } finally {
    await admin.request.patch('/api/admin/settings', { data: { demoEnabled: false } });
    await ctx.close();
  }
});
