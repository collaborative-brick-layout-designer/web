// Journey — requests to join go to whoever can let people in, by role.
//
//   Ada runs a club that takes requests. She makes a "Door crew" role that
//   can invite people (and so answer requests) and gives it to Cleo, who
//   is also a Member. The club's Manager role no longer invites, and Ben
//   holds it. Gus asks to join with a note → Cleo's Clubs link shows the
//   waiting request at once, and she gets an email about it (one, though
//   she holds two roles); so does Ada, the Admin. Ben, a Manager without
//   that permission, sees no badge and gets no email. Cleo turns the
//   email for requests to join off in Settings › Notifications; Hal asks
//   next, and only Ada is emailed.

import { test, expect, type Page } from '@playwright/test';
import { fromSettingsMenu, signIn } from '../../helpers';
import { useSmtp } from '../../dbHelpers';
import { startMailSink } from '../../mailSink';

const ts = Date.now();
const ADA = `j-door-ada-${ts}@example.com`;
const BEN = `j-door-ben-${ts}@example.com`;
const CLEO = `j-door-cleo-${ts}@example.com`;
const GUS = `j-door-gus-${ts}@example.com`;
const HAL = `j-door-hal-${ts}@example.com`;
const CLUB = `Door Club ${ts}`;

async function call(page: Page, method: 'post' | 'patch' | 'get', url: string, data?: object): Promise<Record<string, unknown>> {
  const res = await page.request[method](url, data ? { data } : {});
  expect(res.ok(), `${url}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

test('a Door crew role that lets people in gets the join requests; a Manager without it doesn’t', async ({ page, browser }) => {
  test.setTimeout(240_000);
  await signIn(page, ADA, 'Ada Admin');
  const ben = await browser.newPage();
  await signIn(ben, BEN, 'Ben Manager');
  const cleo = await browser.newPage();
  await signIn(cleo, CLEO, 'Cleo Door');
  const gus = await browser.newPage();
  await signIn(gus, GUS, 'Gus Guest');
  const hal = await browser.newPage();
  await signIn(hal, HAL, 'Hal Hopeful');

  // ── The club takes requests; Ben is a Manager, Cleo a Member. ──
  const club = await call(page, 'post', '/api/orgs', { name: CLUB });
  const slug = club.slug as string;
  await call(page, 'patch', `/api/orgs/${slug}`, { joinPolicy: 'request', listed: true });
  for (const [who, email, role] of [[ben, BEN, 'manager'], [cleo, CLEO, 'member']] as const) {
    const invite = await call(page, 'post', `/api/orgs/${slug}/invites`, { email, role });
    await call(who, 'post', `/api/org-invites/${invite.token as string}`, {});
  }
  // The club's Manager role no longer invites people (so it answers no requests).
  const roles = (await call(page, 'get', `/api/orgs/${slug}/roles`)).roles as Array<{ id: string; key: string | null; permissions: string[] }>;
  const manager = roles.find((r) => r.key === 'manager')!;
  await call(page, 'patch', `/api/orgs/${slug}/roles/${manager.id}`, { permissions: manager.permissions.filter((p) => p !== 'invite') });

  // ── Ada makes Door crew, which can invite people, and gives it to Cleo. ──
  await page.goto(`/orgs/${slug}/admin`);
  await page.getByRole('tab', { name: 'Roles' }).click();
  const hint = page.getByTestId('roles-hint');
  if (await hint.isVisible()) await hint.getByRole('button', { name: 'Got it' }).click();
  await page.getByRole('button', { name: 'New role' }).click();
  const form = page.getByRole('form', { name: 'New role' });
  await form.getByLabel('Role name').fill('Door crew');
  await form.getByRole('checkbox', { name: /Invite people/ }).check();
  await form.getByRole('button', { name: 'Add role' }).click();
  await expect(page.getByRole('list', { name: 'Club roles' }).getByRole('listitem').filter({ hasText: 'Door crew' })).toBeVisible();
  await page.getByRole('tab', { name: 'People' }).click();
  const chips = page.getByRole('group', { name: 'Roles for Cleo Door' });
  await chips.getByRole('button', { name: '+ Door crew' }).click();
  await expect(chips.getByRole('button', { name: '✓ Door crew' })).toBeVisible();
  await expect(chips.getByRole('button', { name: '✓ Member' })).toBeVisible();

  // ── The site sends email to a local mail sink while this runs. ──
  const sink = await startMailSink();
  const restoreSmtp = useSmtp({ host: sink.host, port: sink.port, from: 'site@example.com' });
  try {
    await cleo.goto('/');
    await ben.goto('/');
    const site = (p: Page) => p.getByRole('navigation', { name: 'Site' });
    await expect(site(cleo).getByRole('link', { name: 'Clubs' })).toBeVisible();
    await expect(site(ben).getByRole('link', { name: 'Clubs' })).toBeVisible();

    // ── Gus asks to join, with a note. ──
    await call(gus, 'post', `/api/orgs/${slug}/join`, { message: 'I bring a lot of track.' });

    // Cleo's Clubs link shows it without a reload, and she's emailed once.
    await expect(site(cleo).getByLabel('1 request to join')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => sink.to(CLEO).length, { timeout: 15_000 }).toBe(1);
    const mail = sink.to(CLEO)[0]!;
    expect(mail.subject).toBe(`Gus Guest asked to join ${CLUB}`);
    expect(mail.body).toContain('I bring a lot of track.');
    expect(mail.body).toContain(`/orgs/${slug}/admin?tab=people`);
    await expect.poll(() => sink.to(ADA).length, { timeout: 15_000 }).toBe(1);

    // Ben, a Manager whose role doesn't let people in: no badge, no email.
    const counted = ben.waitForResponse((r) => r.url().includes('/api/join-requests/count'));
    await ben.reload();
    expect(((await (await counted).json()) as { count: number }).count).toBe(0);
    await expect(site(ben).getByRole('link', { name: 'Clubs' })).toBeVisible();
    await expect(site(ben).getByLabel(/request.? to join/)).toHaveCount(0);
    expect(sink.to(BEN)).toHaveLength(0);

    // Cleo follows the badge on Clubs to the request.
    await site(cleo).getByRole('link', { name: /^Clubs/ }).click();
    await cleo.getByRole('link', { name: '1 request to join', exact: true }).click();
    await expect(cleo.getByRole('region', { name: /Requests to join/ }).getByText('Gus Guest')).toBeVisible();

    // ── Cleo turns the emails off in Settings › Notifications. ──
    await fromSettingsMenu(cleo, 'Notifications and email');
    const clubs = cleo.getByTestId('notification-category-clubs');
    await clubs.locator('summary').click();
    const emails = clubs.getByRole('combobox', { name: 'Requests to join a club you run: email' });
    await expect(emails).toHaveValue('now');
    await emails.selectOption('off');
    await expect
      .poll(async () => ((await call(cleo, 'get', '/api/me/notification-settings')).types as { type: string; email: string }[]).find((t) => t.type === 'club.join_request')!.email)
      .toBe('off');

    // Hal asks next: Ada is emailed, Cleo isn't (her badge still counts it).
    await call(hal, 'post', `/api/orgs/${slug}/join`, {});
    await expect.poll(() => sink.to(ADA).length, { timeout: 15_000 }).toBe(2);
    expect(sink.to(CLEO)).toHaveLength(1);
    expect(sink.to(BEN)).toHaveLength(0);
    await cleo.goto('/');
    await expect(site(cleo).getByLabel('2 requests to join')).toBeVisible();
  } finally {
    restoreSmtp();
    await sink.close();
  }
  for (const p of [ben, cleo, gus, hal]) await p.close();
});
