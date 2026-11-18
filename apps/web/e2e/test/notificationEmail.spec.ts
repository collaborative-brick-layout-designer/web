// E2E: notification email and Settings › Notifications.
//   - A request to join emails the club's admin right away, with a one-click
//     List-Unsubscribe header and a "Stop these emails" link; the link's page
//     asks first and needs no sign-in; afterwards Settings shows that email
//     off, and the next request sends none.
//   - Settings › Notifications: a category opens to its types; choosing a
//     daily summary, quiet hours and muting a club save at once and stay
//     after a reload.
// SHOTS_DIR=<dir> saves light and dark pictures of the settings and the page.

import { test, expect, type Page } from '@playwright/test';
import { signIn } from '../helpers';
import { useSmtp } from '../dbHelpers';
import { startMailSink } from '../mailSink';

const ts = Date.now();
const ADMIN = `nmail-admin-${ts}@example.com`;
const SHOTS = process.env.SHOTS_DIR;

async function shoot(page: Page, name: string, fullPage = false) {
  if (!SHOTS) return;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}-${scheme}.png`, fullPage });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('a request emails right away, and “Stop these emails” works with no sign-in', async ({ browser }) => {
  test.setTimeout(180_000);
  const sink = await startMailSink();
  const restore = useSmtp({ host: sink.host, port: sink.port, from: 'site@example.com' });
  try {
    const ada = await browser.newContext();
    await signIn(ada, ADMIN, 'Ada Admin');
    const a = await ada.newPage();
    await a.goto('/');
    const club = (await (await a.request.post('/api/orgs', { data: { name: `Mail Club ${ts}` } })).json()) as { slug: string };
    expect((await a.request.patch(`/api/orgs/${club.slug}`, { data: { joinPolicy: 'request', listed: true } })).ok()).toBe(true);

    const ask = async (n: number) => {
      const ctx = await browser.newContext();
      await signIn(ctx, `nmail-asker${n}-${ts}@example.com`, `Asker ${n}`);
      const p = await ctx.newPage();
      expect((await p.request.post(`/api/orgs/${club.slug}/join`, { data: {} })).ok()).toBe(true);
      await ctx.close();
    };
    // (Signing up may email them too: only the notifications count here.)
    const asks = () => sink.to(ADMIN).filter((m) => m.subject.includes('asked to join'));
    await ask(1);
    await expect.poll(() => asks().length, { timeout: 15000 }).toBe(1);
    const mail = asks()[0]!;
    expect(mail.subject).toBe(`Asker 1 asked to join Mail Club ${ts}`);
    expect(mail.listUnsubscribe).toMatch(/^<http:\/\/localhost:\d+\/api\/notifications\/unsubscribe\?t=[^>]+>$/);
    expect(mail.body).toContain('Notification settings: ');
    const page = /(http:\/\/localhost:\d+\/unsubscribe\?t=\S+)/.exec(mail.body)![1]!;

    // Signed out: the page says what it stops and asks first.
    const anon = await browser.newContext();
    const u = await anon.newPage();
    await u.goto(page.replace(/^http:\/\/localhost:\d+/, ''));
    await expect(u.getByText(/Stop emails about “Requests to join a club you run”\?/)).toBeVisible();
    await shoot(u, 'after-unsubscribe-ask');
    await u.getByRole('button', { name: 'Stop these emails' }).click();
    await expect(u.getByTestId('unsubscribe-done')).toBeVisible();
    await shoot(u, 'after-unsubscribe-done');
    await anon.close();

    // Ada's settings say so, and the next request sends nothing.
    await a.goto('/settings#notifications');
    const clubs = a.getByTestId('notification-category-clubs');
    await clubs.locator('summary').click();
    await expect(clubs.getByRole('combobox', { name: 'Requests to join a club you run: email' })).toHaveValue('off');
    await ask(2);
    await a.waitForTimeout(2000);
    expect(asks()).toHaveLength(1);
    // But it is in the bell.
    await a.goto('/');
    await expect(a.getByTestId('notification-badge')).toHaveText('2');
    await ada.close();
  } finally {
    restore();
    await sink.close();
  }
});

test('Settings › Notifications saves each choice at once', async ({ page }) => {
  await signIn(page, `nset-${ts}@example.com`, 'Set Tings');
  const club = (await (await page.request.post('/api/orgs', { data: { name: `Settings Club ${ts}` } })).json()) as { slug: string };
  expect(club.slug).toBeTruthy();
  await page.goto('/settings#notifications');
  const section = page.getByTestId('notification-settings');
  await expect(section).toBeVisible();
  // The time zone followed this browser.
  await expect(section.getByLabel('Time zone')).not.toHaveValue('');
  await shoot(page, 'after-settings', true);
  const clubs = section.getByTestId('notification-category-clubs');
  await clubs.locator('summary').click();
  await clubs.getByRole('combobox', { name: 'Your roles in a club changed: email' }).selectOption('daily');
  await expect(section.getByRole('status')).toHaveText('Saved.');
  await shoot(page, 'after-settings-clubs-open');
  // Warnings can't leave the app.
  const mod = section.getByTestId('notification-category-moderation');
  await mod.locator('summary').click();
  await expect(mod.getByRole('switch', { name: 'Warnings: in the app', exact: true })).toBeDisabled();
  await section.getByRole('switch', { name: 'Quiet hours' }).click();
  await expect(section.getByRole('status')).toHaveText('Saved.');
  await section.getByLabel('Quiet hours start').fill('21:30');
  await section.getByRole('switch', { name: `Mute Settings Club ${ts}` }).click();
  await expect(section.getByRole('status')).toHaveText('Saved.');
  await page.reload();
  const again = page.getByTestId('notification-settings');
  await again.getByTestId('notification-category-clubs').locator('summary').click();
  await expect(again.getByRole('combobox', { name: 'Your roles in a club changed: email' })).toHaveValue('daily');
  await expect(again.getByRole('switch', { name: 'Quiet hours' })).toHaveAttribute('aria-checked', 'true');
  await expect(again.getByLabel('Quiet hours start')).toHaveValue('21:30');
  await expect(again.getByRole('switch', { name: `Mute Settings Club ${ts}` })).toHaveAttribute('aria-checked', 'true');
});
