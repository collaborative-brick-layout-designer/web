// Journey — a trusted club reviews what's published under its own name.
//
//   1. A site moderator finds ArkLUG in Moderation › Trusted clubs and
//      trusts it.
//   2. Mel, a member, shares one of the club's modules from Home: it goes to
//      the club's own review, not the site's.
//   3. Ada, the club's admin, has Manage › Review open: it shows up live.
//      She approves it; Vic, outside the club, sees it in the Catalog with
//      a "Trusted club" badge.
//   4. Ada shares another club module herself: public at once.
//   5. The moderator stops trusting ArkLUG: Ada's Review tab goes, live, and
//      her next share waits for the site's moderators again.

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { signIn, fromSettingsMenu, confirmInDialog } from '../../helpers';
import { makeGlobalAdmin, siteSettingsAtDefaults } from '../../dbHelpers';

siteSettingsAtDefaults();

const ts = Date.now();
test.setTimeout(240_000);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

interface Person {
  ctx: BrowserContext;
  page: Page;
}
async function person(browser: Browser, email: string, name: string): Promise<Person> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, email, name);
  return { ctx, page };
}
const streamOpen = (page: Page) => expect(page.locator('html')).toHaveAttribute('data-live', 'open', { timeout: 15000 });
const idOf = async (p: Person) => ((await (await p.page.request.get('/api/auth/me')).json()) as { user: { id: string } }).user.id;

test('a trusted club reviews its members’ shares itself; untrusted, the site reviews again', async ({ browser }) => {
  const admin = await person(browser, `j-tc-admin-${ts}@example.com`, 'Site Admin');
  makeGlobalAdmin(`j-tc-admin-${ts}@example.com`);
  const mod = await person(browser, `j-tc-mod-${ts}@example.com`, 'Mo Derator');
  const ada = await person(browser, `j-tc-ada-${ts}@example.com`, 'Ada Admin');
  const mel = await person(browser, `j-tc-mel-${ts}@example.com`, 'Mel Member');
  const vic = await person(browser, `j-tc-vic-${ts}@example.com`, 'Vic Viewer');
  const people = [admin, mod, ada, mel, vic];
  const CLUB = `Trusty ${ts}`;
  try {
    expect((await admin.page.request.patch('/api/admin/settings', { data: { moduleCatalogEnabled: true, catalogReview: 'moderators' } })).ok()).toBe(true);
    expect((await admin.page.request.patch(`/api/admin/users/${await idOf(mod)}`, { data: { isModerator: true } })).ok()).toBe(true);
    const club = (await (await ada.page.request.post('/api/orgs', { data: { name: CLUB } })).json()) as { slug: string };
    expect((await ada.page.request.patch(`/api/orgs/${club.slug}`, { data: { joinPolicy: 'open', listed: true } })).ok()).toBe(true);
    expect((await mel.page.request.post(`/api/orgs/${club.slug}/join`, { data: {} })).ok()).toBe(true);
    const made: Record<string, string> = {};
    for (const t of [`Bench ${ts}`, `Lamp ${ts}`, `Gate ${ts}`]) {
      const m = (await (await ada.page.request.post('/api/modules', { data: { title: t, orgSlug: club.slug } })).json()) as { id: string };
      expect((await ada.page.request.put(`/api/modules/${m.id}/thumbnail`, { data: { mime: 'image/png', data: PNG } })).ok()).toBe(true);
      made[t] = m.id;
    }

    // The moderator trusts the club from Moderation.
    await mod.page.goto('/');
    await fromSettingsMenu(mod.page, /^Moderation/);
    await mod.page.getByRole('tab', { name: 'Trusted clubs', exact: true }).click();
    await mod.page.getByLabel('Find a club to trust').fill(String(ts));
    await mod.page.getByRole('list', { name: 'Clubs found' }).getByRole('button', { name: `Trust ${CLUB}` }).click();
    await expect(mod.page.getByTestId('trusted-club').filter({ hasText: CLUB })).toContainText('Trusted club');

    // Ada has Manage › Review open.
    await ada.page.goto(`/orgs/${club.slug}/admin`);
    await ada.page.getByRole('tab', { name: 'Review' }).click();
    await expect(ada.page.getByText('Nothing waiting.')).toBeVisible();
    await streamOpen(ada.page);
    // …and her Clubs list in another tab.
    const adaClubs = await ada.page.context().newPage();
    await adaClubs.goto('/orgs');
    await streamOpen(adaClubs);
    await expect(adaClubs.getByTestId('club-review-waiting')).toHaveCount(0);

    // Mel shares a club module from Home: it goes to the club's own review.
    await mel.page.goto('/');
    const row = mel.page.getByTestId('module-row').filter({ hasText: `Bench ${ts}` });
    await row.getByRole('button', { name: `More for Bench ${ts}` }).click();
    await mel.page.getByRole('menuitem', { name: 'Share to the public catalog…' }).click();
    const share = mel.page.getByRole('dialog', { name: 'Share to the public catalog' });
    await share.getByRole('checkbox').check();
    await share.getByRole('button', { name: /^Share/ }).click();
    await expect(share.getByRole('status')).toContainText(`Sent to ${CLUB}’s own review`);
    await share.getByRole('button', { name: 'Done' }).click();

    // Not in the site's queue: under trusted clubs'.
    await mod.page.getByRole('tab', { name: /^Trusted clubs’ queues/ }).click();
    await expect(mod.page.locator('section[aria-labelledby="mod-list-trusted"]').getByTestId('moderation-entry').filter({ hasText: `Bench ${ts}` })).toHaveCount(1);
    await mod.page.getByRole('tab', { name: /^To review/ }).click();
    await expect(mod.page.locator('section[aria-labelledby="mod-list-waiting"]')).toBeVisible();
    await expect(mod.page.getByTestId('moderation-entry').filter({ hasText: `Bench ${ts}` })).toHaveCount(0);
    await mod.page.getByRole('tab', { name: 'Trusted clubs', exact: true }).click();

    // Ada's open Review tab shows it, live; she approves it.
    const waiting = ada.page.getByTestId('club-review-item').filter({ hasText: `Bench ${ts}` });
    await expect(waiting).toContainText('Sent by Mel Member', { timeout: 10000 });
    // The count shows live on the Review tab and in her Clubs list.
    await expect(ada.page.getByTestId('review-count')).toHaveText('1');
    await expect(adaClubs.getByTestId('club-review-waiting')).toHaveText('1 share to review');
    await waiting.getByRole('button', { name: `Approve Bench ${ts}` }).click();
    await expect(waiting).toHaveCount(0);
    await expect(ada.page.getByTestId('review-count')).toHaveCount(0);
    await expect(adaClubs.getByTestId('club-review-waiting')).toHaveCount(0);
    await expect(ada.page.getByTestId('club-published').filter({ hasText: `Bench ${ts}` })).toContainText('Public');

    // Vic sees it in the Catalog, with the badge.
    await vic.page.goto('/catalog');
    const card = vic.page.getByTestId('catalog-item').filter({ hasText: `Bench ${ts}` });
    await expect(card.getByTestId('trusted-badge')).toHaveText('Trusted club');

    // Ada's own share is public at once.
    expect(((await (await ada.page.request.post('/api/catalog/submissions', { data: { kind: 'module', sourceId: made[`Lamp ${ts}`] } })).json()) as { status: string }).status).toBe('public');

    // Untrusted: Ada's Review tab goes (live), and her next share waits for the site.
    await mod.page.getByRole('button', { name: `Stop trusting ${CLUB}` }).click();
    await confirmInDialog(mod.page);
    await expect(ada.page.getByRole('tab', { name: 'Review' })).toHaveCount(0, { timeout: 10000 });
    expect(((await (await ada.page.request.post('/api/catalog/submissions', { data: { kind: 'module', sourceId: made[`Gate ${ts}`] } })).json()) as { status: string }).status).toBe('in_review');
    // What was public stays public.
    await vic.page.reload();
    await expect(vic.page.getByTestId('catalog-item').filter({ hasText: `Bench ${ts}` })).toBeVisible();
  } finally {
    await admin.page.request.patch('/api/admin/settings', { data: { moduleCatalogEnabled: false, catalogReview: 'moderators' } }).catch(() => undefined);
    for (const p of people) await p.ctx.close();
  }
});
