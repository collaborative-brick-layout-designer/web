// Journey — an account made while the site's email checks are off, and a
// club invite sent to its address.
//
//   Ada invites Pat's address to her club. Pat signs up while the site
//   doesn't ask for email confirmation, so Pat is signed in at once, but
//   hasn't shown the address is theirs: Home doesn't list the invite and
//   offers "Confirm your email" instead (with its ⓘ), and the invite's own
//   page waits too. Pat sends the confirmation email (a local mail sink)
//   and opens its link on another device: it asks Pat to sign in first,
//   then confirms. Home, still open (and signed in) in the first browser,
//   shows the invite by itself. Pat joins. In Admin › Users, Ada sees
//   Pat's email as confirmed.

import { test, expect } from '@playwright/test';
import { PASS, adminSection, signIn, submitAuthForm } from '../../helpers';
import { makeGlobalAdmin, setRequireEmailVerification, siteSettingsAtDefaults, useSmtp } from '../../dbHelpers';
import { startMailSink } from '../../mailSink';

siteSettingsAtDefaults();

const ts = Date.now();
const ADA = `j-confirm-ada-${ts}@example.com`;
const PAT = `j-confirm-pat-${ts}@example.com`;
const CLUB = `Confirm Club ${ts}`;

test('an account made with checks off sees an invite to its address only once it confirms by email', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const sink = await startMailSink();
  const restoreSmtp = useSmtp({ host: sink.host, port: sink.port, from: 'site@example.com' });
  let restoreChecks: (() => void) | null = null;
  const pat = await browser.newContext();
  try {
    // ── Ada's club invites Pat's address. ──
    await signIn(page, ADA, 'Ada Admin');
    makeGlobalAdmin(ADA);
    const club = await page.request.post('/api/orgs', { data: { name: CLUB } });
    expect(club.ok(), await club.text()).toBe(true);
    const { slug } = (await club.json()) as { slug: string };
    const invite = await page.request.post(`/api/orgs/${slug}/invites`, { data: { email: PAT, role: 'member' } });
    expect(invite.ok(), await invite.text()).toBe(true);
    const { token } = (await invite.json()) as { token: string };

    // ── Pat signs up while the site doesn't ask for confirmation: signed in at once. ──
    restoreChecks = setRequireEmailVerification(false);
    const home = await pat.newPage();
    const reg = await home.request.post('/api/auth/password/register', { data: { email: PAT, password: PASS, displayName: 'Pat Newbie' } });
    expect(await reg.json()).toEqual({ ok: true, verificationRequired: false });

    await home.goto('/');
    const card = home.getByTestId('confirm-email');
    await expect(card.getByText('Confirm your email to see club invites sent to it')).toBeVisible();
    await expect(card).toContainText(PAT);
    await expect(home.getByTestId('my-invites')).toHaveCount(0);
    await card.getByRole('button', { name: 'Help: Confirm your email' }).click();
    await expect(home.getByText(/you stay signed in everywhere, with the same password/)).toBeVisible();
    await home.keyboard.press('Escape');

    // The invite's own page waits for it too, rather than failing.
    const invitePage = await pat.newPage();
    await invitePage.goto(`/org-invite/${token}`);
    await expect(invitePage.getByText('Confirm your email to join this club')).toBeVisible();
    await invitePage.close();

    // ── "Send me a confirmation email", then its link, in this browser. ──
    await card.getByRole('button', { name: 'Send me a confirmation email' }).click();
    await expect(card.getByRole('status')).toContainText('We sent a link to');
    const confirms = () => sink.to(PAT).filter((m) => m.body.includes('/verify-email/'));
    await expect.poll(() => confirms().length, { timeout: 15_000 }).toBe(1);
    expect(confirms()[0]!.body).toContain('You asked to confirm this email address');
    const link = new URL(/https?:\/\/\S+\/verify-email\/[0-9a-f]+(\?\S*)?/.exec(confirms()[0]!.body)![0]);
    // Opened on another device (a browser not signed in): it asks to sign in first.
    const phone = await browser.newContext();
    const opened = await phone.newPage();
    await opened.goto(link.pathname + link.search);
    const step = opened.getByTestId('confirm-sign-in');
    await expect(step.getByRole('heading', { name: 'Sign in to confirm your email' })).toBeVisible();
    await step.getByRole('link', { name: 'Sign in' }).click();
    await opened.getByLabel('Email').fill(PAT);
    await opened.getByLabel('Password').fill(PASS);
    await submitAuthForm(opened, '/api/auth/password/login', () => opened.getByRole('button', { name: 'Sign in', exact: true }).click());
    // Back on the link, signed in: confirmed straight away.
    await expect(opened.getByText('Email confirmed! Taking you back…')).toBeVisible();
    await phone.close();

    // ── Home, open all along, shows the invite by itself; Pat joins. ──
    const invites = home.getByTestId('my-invites');
    await expect(invites.getByText('You’re invited to a club')).toBeVisible({ timeout: 15_000 });
    // Still signed in here, with the same password.
    expect(((await (await home.request.get('/api/auth/me')).json()) as { user: unknown }).user).not.toBeNull();
    await expect(home.getByTestId('confirm-email')).toHaveCount(0);
    await invites.getByRole('button', { name: `Join ${CLUB}` }).click();
    await expect(home).toHaveURL(new RegExp(`/orgs/${slug}$`));

    // ── Admin › Users: Pat's email is confirmed. ──
    await page.goto('/admin');
    await adminSection(page, 'users');
    await page.getByPlaceholder('Search by email or name…').fill(PAT);
    const row = page.getByRole('row').filter({ hasText: PAT });
    await expect(row.getByTestId('email-state')).toHaveText('✓ Confirmed');
  } finally {
    restoreChecks?.();
    restoreSmtp();
    await pat.close();
    await sink.close();
  }
});
