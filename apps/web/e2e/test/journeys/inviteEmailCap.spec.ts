// Journey: the daily cap on invite emails.
//
//   Admin › Settings: the admin reads the ⓘ and sets new accounts to one
//   invite email a day → a new club owner invites someone (emailed) → and
//   then someone else: the invite is still made, the email is skipped, and
//   a friendly note says to copy the link, which is right there.

import { test, expect } from '@playwright/test';
import { signIn, adminSection } from '../../helpers';
import { makeGlobalAdmin, useSmtp } from '../../dbHelpers';
import { startMailSink } from '../../mailSink';

const ts = Date.now();
const ADMIN = `j-cap-admin-${ts}@example.com`;
const OWNER = `j-cap-owner-${ts}@example.com`;
const FIRST = `j-cap-first-${ts}@example.com`;
const SECOND = `j-cap-second-${ts}@example.com`;

test('past the daily email cap, an invite is still made and its link is there to copy', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const sink = await startMailSink();
  const restoreSmtp = useSmtp({ host: sink.host, port: sink.port, from: 'site@example.com' });
  await signIn(page, ADMIN, 'Cap Admin');
  makeGlobalAdmin(ADMIN);
  const owner = await browser.newPage();
  await signIn(owner, OWNER, 'Cap Owner');
  const before = (await (await page.request.get('/api/admin/limits')).json()) as { enforcedSetting?: boolean };
  try {
    // ── Settings: limits on; new accounts may send one invite email a day. ──
    await page.goto('/admin');
    await adminSection(page, 'settings');
    const enforce = page.getByLabel('Enforce usage limits');
    if (!(await enforce.isChecked())) await enforce.click();
    await page.getByRole('button', { name: /Invite emails a day/ }).first().click();
    await expect(page.getByText(/Past it, the invite is still made/).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByLabel('Invite emails a day in an account’s first week').fill('1');
    await page.getByRole('button', { name: 'Save limits' }).click();
    await expect(page.getByText(/Saved\. New limits apply right away/)).toBeVisible();

    // ── The owner's first invite is emailed. ──
    const club = (await (await owner.request.post('/api/orgs', { data: { name: `Cap Club ${ts}` } })).json()) as { slug: string };
    await owner.goto(`/orgs/${club.slug}`);
    await owner.getByRole('link', { name: 'Manage the club' }).click();
    await owner.getByLabel('Name or email').fill(FIRST);
    await owner.getByRole('button', { name: 'Send invite' }).click();
    await expect(owner.getByText('Invite sent by email. You can also send this link yourself:')).toBeVisible();
    await expect.poll(() => sink.to(FIRST).length, { timeout: 15_000 }).toBe(1);

    // ── The second is made, not emailed, and says what to do. ──
    await owner.getByLabel('Name or email').fill(SECOND);
    await owner.getByRole('button', { name: 'Send invite' }).click();
    await expect(
      owner.getByText('You’ve sent 1 invite email today, the most for one day, so this one wasn’t emailed. Your invite is ready: copy the link and send it yourself.'),
    ).toBeVisible();
    await expect(owner.getByText(/\/org-invite\//).first()).toBeVisible();
    await expect(owner.getByRole('button', { name: 'Copy link' }).first()).toBeVisible();
    // Both wait to join (shown masked).
    await expect(owner.getByRole('region', { name: /Waiting to join/ }).getByText('j…@example.com')).toHaveCount(2);
    await owner.waitForTimeout(1000);
    expect(sink.to(SECOND)).toHaveLength(0);
  } finally {
    await page.request.patch('/api/admin/limits', { data: { newAccountInviteEmailsPerDay: null } });
    await page.request.patch('/api/admin/settings', { data: { limitsEnforced: before.enforcedSetting ?? true } });
    restoreSmtp();
    await sink.close();
    await owner.close();
  }
});
