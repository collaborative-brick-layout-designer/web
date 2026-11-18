// Journey — warnings, from the site and from a club, arriving live.
//
//   1. The site admin warns a member from the member's admin page. The
//      member, with Home open, gets a banner without a reload, follows it
//      to the Notifications page and says "I understand" there; the
//      admin's history shows it acknowledged, also without a reload.
//   2. A club admin sends a member a note from the club's Manage page. The
//      member's bell shows it as from the club; reading it there is all it
//      asks, and the club's "Warnings sent" shows when it was read. Someone
//      outside the club never sees it.

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { signIn, adminSection } from '../../helpers';
import { makeGlobalAdmin } from '../../dbHelpers';

const ts = Date.now();
test.setTimeout(120_000);

async function person(browser: Browser, email: string, name: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, email, name);
  return { ctx, page };
}
const streamOpen = (page: Page) => expect(page.locator('html')).toHaveAttribute('data-live', 'open', { timeout: 15000 });

test('a site warning reaches the member live, and the admin sees it read', async ({ browser }) => {
  const ADMIN = `j-warn-admin-${ts}@example.com`;
  const MEMBER = `j-warn-member-${ts}@example.com`;
  const admin = await person(browser, ADMIN, 'Site Admin');
  makeGlobalAdmin(ADMIN);
  const member = await person(browser, MEMBER, `Member ${ts}`);
  try {
    await member.page.goto('/');
    await streamOpen(member.page);
    await expect(member.page.getByTestId('notice-banner')).toHaveCount(0);

    // The admin opens the member's page and sends a warning.
    await admin.page.goto('/admin');
    await adminSection(admin.page, 'users');
    await admin.page.getByPlaceholder('Search by email or name…').fill(MEMBER);
    await admin.page.getByRole('button', { name: MEMBER }).click();
    const form = admin.page.getByRole('form', { name: `Warn Member ${ts}` });
    await form.getByLabel('Warning', { exact: true }).check();
    await form.getByLabel(/Reason/).fill('Please keep layout names friendly.');
    await form.getByLabel(/Link to what/).fill('/catalog');
    await form.getByRole('button', { name: 'Send warning' }).click();
    await expect(form.getByText('Sent.')).toBeVisible();
    const row = admin.page.getByTestId('warning-row').filter({ hasText: 'Please keep layout names friendly.' });
    await expect(row).toContainText('Not acknowledged yet');
    await streamOpen(admin.page);

    // The member's open Home shows it, no reload.
    const banner = member.page.getByTestId('notice-banner');
    await expect(banner).toBeVisible({ timeout: 10000 });
    await expect(banner).toContainText('Warning from the site team');
    await expect(banner).toContainText('Please keep layout names friendly.');
    await banner.getByRole('link', { name: 'All notifications' }).click();
    await expect(member.page).toHaveURL(/\/notifications$/);
    // No banner over the page that lists it.
    await expect(banner).toHaveCount(0);
    const item = member.page.getByTestId('notification-item').filter({ hasText: 'Please keep layout names friendly.' });
    await item.getByRole('button', { name: 'I understand' }).click();
    await expect(item.getByTestId('notification-outcome')).toHaveText('You understood');
    await member.page.goto('/');
    await expect(banner).toHaveCount(0);

    // The admin's open page shows it read, no reload.
    await expect(row).toContainText('Acknowledged', { timeout: 10000 });
  } finally {
    await admin.ctx.close();
    await member.ctx.close();
  }
});

test('a club warning comes from the club, and only its people see it', async ({ browser }) => {
  const ann = await person(browser, `j-warn-ann-${ts}@example.com`, 'Ann Admin');
  const bob = await person(browser, `j-warn-bob-${ts}@example.com`, `Bob ${ts}`);
  const cat = await person(browser, `j-warn-cat-${ts}@example.com`, 'Cat Outsider');
  try {
    const club = (await (await ann.page.request.post('/api/orgs', { data: { name: `Warn club ${ts}` } })).json()) as { slug: string; name: string };
    expect((await ann.page.request.patch(`/api/orgs/${club.slug}`, { data: { joinPolicy: 'open', listed: true } })).ok()).toBe(true);
    expect((await bob.page.request.post(`/api/orgs/${club.slug}/join`, { data: {} })).ok()).toBe(true);

    await bob.page.goto('/');
    await streamOpen(bob.page);
    await cat.page.goto('/');
    await streamOpen(cat.page);

    // Ann: Manage › People › Bob › Warn.
    await ann.page.goto(`/orgs/${club.slug}/admin`);
    const bobRow = ann.page.getByRole('listitem').filter({ hasText: `Bob ${ts}` }).first();
    await bobRow.getByRole('button', { name: 'Warn' }).click();
    const form = ann.page.getByRole('form', { name: `Warn Bob ${ts}` });
    await form.getByLabel('Note', { exact: true }).check();
    await form.getByLabel(/Reason/).fill('Please ask before moving the goods yard.');
    await form.getByRole('button', { name: 'Send note' }).click();
    const sent = ann.page.getByTestId('warning-row').filter({ hasText: 'Please ask before moving the goods yard.' });
    await expect(sent).toContainText('Not acknowledged yet', { timeout: 10000 });
    await streamOpen(ann.page);

    // Bob sees it live in his bell, from the club (a note: no banner), and reads it.
    await expect(bob.page.getByTestId('notification-badge')).toHaveText('1', { timeout: 10000 });
    await expect(bob.page.getByTestId('notice-banner')).toHaveCount(0);
    await bob.page.getByTestId('notification-bell').click();
    const note = bob.page.getByTestId('notification-panel').getByTestId('notification-item').filter({ hasText: `Note from Warn club ${ts}` });
    await expect(note).toContainText('Please ask before moving the goods yard.');
    await note.getByRole('button', { name: /as read/ }).click();
    await expect(bob.page.getByTestId('notification-badge')).toHaveCount(0);
    await expect(sent).toContainText('Acknowledged', { timeout: 10000 });

    // Cat, outside the club, never saw anything.
    await expect(cat.page.getByTestId('notice-banner')).toHaveCount(0);
    await expect(cat.page.getByTestId('notification-badge')).toHaveCount(0);
    expect(((await (await cat.page.request.get('/api/notices')).json()) as { notices: unknown[] }).notices).toEqual([]);
  } finally {
    await ann.ctx.close();
    await bob.ctx.close();
    await cat.ctx.close();
  }
});
