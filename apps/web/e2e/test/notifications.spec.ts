// E2E: notifications (docs/notifications.md).
//   - Two people, live: Rita asks to join Ada's club in her browser, and
//     Ada's bell counts it in two tabs with no reload; marking it read in one
//     tab clears the other; Ada lets her in from the panel, and Rita's bell
//     says so, live.
//   - A club warning: Rita's banner waits for "I understand"; the full page
//     keeps it, understood. The old /notices page goes to /notifications.
//   - On a phone the panel is a bottom sheet.
// SHOTS_DIR=<dir> saves light and dark pictures of the bell, the panel, the
// page and the phone sheet.

import { test, expect, devices, type Page } from '@playwright/test';
import { signIn } from '../helpers';

const ts = Date.now();
const ADMIN = `notif-admin-${ts}@example.com`;
const ASKER = `notif-asker-${ts}@example.com`;
const SHOTS = process.env.SHOTS_DIR;

async function call(page: Page, method: 'post' | 'patch', url: string, data: object = {}) {
  const res = await page.request[method](url, { data });
  expect(res.ok(), `${url}: ${res.status()} ${await res.text()}`).toBe(true);
  return res.json() as Promise<Record<string, string>>;
}

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const badge = (page: Page) => page.getByTestId('notification-badge');

test('a request in one browser reaches the other’s bell live, and is answered from the panel', async ({ browser }) => {
  test.setTimeout(180_000);
  const ada = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  const rita = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  await signIn(ada, ADMIN, 'Ada Admin');
  await signIn(rita, ASKER, 'Rita Rails');
  const a1 = await ada.newPage();
  const a2 = await ada.newPage();
  const r = await rita.newPage();
  await a1.goto('/');
  const club = await call(a1, 'post', '/api/orgs', { name: `Bell Club ${ts}` });
  await call(a1, 'patch', `/api/orgs/${club.slug}`, { joinPolicy: 'request', listed: true });
  await a2.goto('/orgs');
  await r.goto('/');
  for (const p of [a1, a2, r]) {
    await expect(p.getByTestId('notification-bell')).toBeVisible();
    await expect(badge(p)).toHaveCount(0);
  }
  await shoot(a1, 'notifications-bell-before');

  // Rita asks; Ada's two tabs count it without a reload.
  await call(r, 'post', `/api/orgs/${club.slug}/join`, { message: 'We run trains on Tuesdays.' });
  for (const p of [a1, a2]) await expect(badge(p)).toHaveText('1', { timeout: 15000 });
  await shoot(a1, 'notifications-bell-after');

  // Read in one tab: the other tab's badge goes too.
  await a1.getByTestId('notification-bell').click();
  const panel = a1.getByTestId('notification-panel');
  const item = panel.getByTestId('notification-item').first();
  await expect(item).toContainText('Rita Rails asked to join');
  await expect(item).toContainText('We run trains on Tuesdays.');
  await shoot(a1, 'notifications-panel');
  await item.getByRole('button', { name: /as read/ }).click();
  for (const p of [a1, a2]) await expect(badge(p)).toHaveCount(0, { timeout: 15000 });
  // …and unread again.
  await item.getByRole('button', { name: /as unread/ }).click();
  for (const p of [a1, a2]) await expect(badge(p)).toHaveText('1', { timeout: 15000 });

  // Let her in from the panel: the club page's approve, as Ada.
  await item.getByRole('button', { name: 'Let them in' }).click();
  await expect(item.getByTestId('notification-outcome')).toHaveText('You let them in');
  await shoot(a1, 'notifications-panel-answered');
  // Rita hears, live.
  await expect(badge(r)).toHaveText('1', { timeout: 15000 });
  await r.getByTestId('notification-bell').click();
  await expect(r.getByTestId('notification-panel').getByTestId('notification-item').first()).toContainText(`You’re in Bell Club ${ts}`);
  // And she's in.
  await r.goto(`/orgs/${club.slug}`);
  await expect(r.getByRole('heading', { name: `Bell Club ${ts}` })).toBeVisible();

  // Mark all as read clears it.
  await r.getByTestId('notification-bell').click();
  await r.getByTestId('notification-panel').getByRole('button', { name: 'Mark all as read' }).click();
  await expect(badge(r)).toHaveCount(0);

  // A warning from the club: a banner until "I understand", then kept on the page.
  const members = (await (await a1.request.get(`/api/orgs/${club.slug}/members`)).json()) as { members: { userId: string; displayName: string }[] };
  const ritaId = members.members.find((m) => m.displayName === 'Rita Rails')!.userId;
  await call(a1, 'post', `/api/orgs/${club.slug}/warnings`, { userId: ritaId, severity: 'warning', reason: 'Please keep the layout tidy.' });
  const banner = r.getByTestId('notice-banner');
  await expect(banner).toContainText(`Warning from Bell Club ${ts}`, { timeout: 15000 });
  await expect(banner).toContainText('Please keep the layout tidy.');
  await banner.getByRole('button', { name: 'I understand' }).click();
  await expect(banner).toHaveCount(0);

  // The old page goes to the new one, which lists everything.
  await r.goto('/notices');
  await expect(r).toHaveURL(/\/notifications$/);
  await expect(r.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  const rows = r.getByTestId('notification-item');
  await expect(rows.filter({ hasText: `Warning from Bell Club ${ts}` }).getByTestId('notification-outcome')).toHaveText('You understood');
  await expect(rows.filter({ hasText: `You’re in Bell Club ${ts}` })).toHaveCount(1);
  await r.getByRole('searchbox', { name: 'Search notifications' }).fill('tidy');
  await expect(rows).toHaveCount(1);
  await shoot(r, 'notifications-page');

  await ada.close();
  await rita.close();
});

const { defaultBrowserType: _p, ...pixel7 } = devices['Pixel 7'];
test.describe('on a phone', () => {
  test.use(pixel7);
  test('the panel opens as a bottom sheet with its answers in reach', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'touch emulation');
    await signIn(page, `notif-phone-${ts}@example.com`, 'Pat Phone');
    await page.goto('/');
    await page.getByTestId('notification-bell').tap();
    const sheet = page.getByTestId('notification-panel');
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    const view = page.viewportSize()!;
    // Anchored to the bottom, the full width.
    expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(view.height - 2);
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(view.width - 2);
    await expect(sheet.getByTestId('notification-empty')).toBeVisible();
    await shoot(page, 'notifications-phone-sheet');
    await sheet.getByRole('button', { name: 'Close notifications' }).tap();
    await expect(sheet).toHaveCount(0);
  });
});
