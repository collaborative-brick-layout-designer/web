// Journey: the site's mail (SMTP) password.
// - An admin saves it in Admin › Settings. The database holds it encrypted,
//   the page never shows it again, and email goes out with it.
// - The server's key is lost (here: the saved value was made with another
//   key). The site keeps working; Admin › Settings says the password can't
//   be read and asks for it again; no email goes out meanwhile.
// - The admin enters it again: the message goes without a refresh, and
//   email goes out again.

import { test, expect, type Page } from '@playwright/test';
import { adminSection, signIn } from '../../helpers';
import { loseMailPasswordKey, makeGlobalAdmin, storedMailPassword, useSmtp } from '../../dbHelpers';
import { startMailSink } from '../../mailSink';

const ts = Date.now();
const ADMIN = `j-mailpw-admin-${ts}@example.com`;
const people = [1, 2, 3].map((n) => `j-mailpw-${n}-${ts}@example.com`);
const SECRET = `Mail-pass-${ts}-x9`;
const AGAIN = `Mail-pass-again-${ts}`;
/** Set to a folder to keep pictures of the message, light and dark. */
const SHOTS = process.env.MAIL_PASSWORD_SHOTS;

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  const section = page.locator('section', { has: page.getByRole('heading', { name: 'SMTP server' }) });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: `${SHOTS}/${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('the mail password is kept encrypted, and a lost key asks for it again', async ({ page, browser }) => {
  const sink = await startMailSink();
  const restoreSmtp = useSmtp({ host: sink.host, port: sink.port, from: 'site@example.com' });
  const visitorCtx = await browser.newContext();
  const visitor = await visitorCtx.newPage();
  const resetMails = (email: string) => sink.to(email).filter((m) => m.body.includes('/reset-password/'));
  const forgot = async (email: string) => expect((await visitor.request.post('/api/auth/password/forgot', { data: { email } })).ok()).toBe(true);
  try {
    for (const email of people) await signIn(visitorCtx, email);
    await visitorCtx.clearCookies();
    await signIn(page, ADMIN, 'Mia Mail');
    makeGlobalAdmin(ADMIN);

    // ── Save a user name and password. ──
    await page.goto('/admin');
    await adminSection(page, 'settings');
    await expect(page.getByRole('heading', { name: 'SMTP server' })).toBeVisible();
    await expect(page.getByLabel('Host')).toHaveValue(sink.host);
    await page.getByLabel('Username').fill('mailer');
    await page.getByLabel('Password', { exact: true }).fill(SECRET);
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();

    // The database has it encrypted; the page and the API only say one is set.
    const kept = storedMailPassword()!;
    expect(kept.startsWith('enc:v1:')).toBe(true);
    expect(kept).not.toContain(SECRET);
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('placeholder', /set/);
    const shown = await (await page.request.get('/api/admin/settings')).text();
    expect(shown).not.toContain(SECRET);
    expect(shown).not.toContain(kept);
    expect(JSON.parse(shown).smtp).toMatchObject({ passSet: true, passUnreadable: false, active: true });
    await shoot(page, 'mail-password-set');

    // Email goes out, signed in to the mail server with the password as typed.
    await forgot(people[0]!);
    await expect.poll(() => resetMails(people[0]!).length, { timeout: 15_000 }).toBe(1);
    expect(sink.logins.at(-1)).toEqual({ user: 'mailer', pass: SECRET });

    // ── The key is lost. ──
    loseMailPasswordKey();
    await page.reload();
    const alert = page.getByTestId('smtp-pass-unreadable');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("The SMTP password can't be read. Please enter it again.");
    await expect(page.getByText('Using the configuration below.')).toHaveCount(0);
    await shoot(page, 'mail-password-unreadable');
    // The site still answers, and sends nothing with a password it can't read.
    const loginsBefore = sink.logins.length;
    await forgot(people[1]!);
    expect((await visitor.request.get('/api/health/ready')).ok()).toBe(true);
    await page.waitForTimeout(1500);
    expect(resetMails(people[1]!)).toHaveLength(0);
    expect(sink.logins).toHaveLength(loginsBefore);

    // ── Entered again: the message goes by itself, and email works. ──
    await page.getByLabel('Password', { exact: true }).fill(AGAIN);
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(alert).toHaveCount(0);
    await expect(page.getByText('Using the configuration below.')).toBeVisible();
    expect(storedMailPassword()).not.toContain(AGAIN);
    await forgot(people[2]!);
    await expect.poll(() => resetMails(people[2]!).length, { timeout: 15_000 }).toBe(1);
    expect(sink.logins.at(-1)).toEqual({ user: 'mailer', pass: AGAIN });
  } finally {
    restoreSmtp();
    await visitorCtx.close();
    await sink.close();
  }
});
