// Partner clubs and one-off module shares between clubs, end to end
// (docs/shared-modules.md, section 11):
//   - two clients: Tina asks Riverside LUG to be partners from Train Club's
//     page; Rita sees the request on her club's page with no reload, and
//     accepts; Tina's page shows the partner with no reload;
//   - Tina shares Train Club's module with the partner from the Share
//     dialog, at once; Riverside LUG shares one back; Lou (a plain member)
//     finds Train Club's module on the Module library's Clubs tab, under
//     "From Train Club", and places it in the club's layout;
//   - a one-off offer to Hill Club: waiting, declined (live in Tina's
//     dialog), another taken back, offered again and accepted;
//   - Tina ends the partnership, after a box that says what happens: Lou's
//     copy is "No longer shared", the one-off share to Hill Club stays;
//   - a partner club deleted: the partnership ends and Train Club is told;
//   - a plain member sees the partners, but can't ask or answer.
// SHOTS=<dir> saves light and dark pictures along the way.

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { signIn } from '../helpers';
import { makeGlobalAdmin } from '../dbHelpers';

const ts = Date.now();
const n = ts % 100000;
const TINA = `cp-tina-${ts}@example.com`;
const RITA = `cp-rita-${ts}@example.com`;
const LOU = `cp-lou-${ts}@example.com`;
const HANK = `cp-hank-${ts}@example.com`;
const ROOT = `cp-root-${ts}@example.com`;
const TRAIN = `Train Club ${n}`;
const LUG = `Riverside LUG ${n}`;
const HILL = `Hill Club ${n}`;
const PART = 'ts_narrowgauge_straight.8';
const SHOTS = process.env.SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const missing = await page.evaluate(() => {
    type N = { name: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.name() === 'unresolved-part' || n.name() === 'brick-loading').length : 0;
  });
  expect(missing, 'parts without their picture').toBe(0);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function api(page: Page, method: 'post' | 'patch' | 'get', url: string, data?: object) {
  const res = method === 'get' ? await page.request.get(url) : await page.request[method](url, { data: data ?? {} });
  expect(res.ok(), `${url}: ${res.status()} ${await res.text()}`).toBe(true);
  return res.json() as Promise<Record<string, unknown>>;
}

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}

async function openPanel(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel(label, { exact: true }).check();
  await page.mouse.click(400, 400);
}

/** A club of `owner`'s, listed in the Clubs directory. */
async function club(page: Page, name: string): Promise<{ id: string; slug: string }> {
  const c = (await api(page, 'post', '/api/orgs', { name })) as { id: string; slug: string };
  await api(page, 'patch', `/api/orgs/${c.slug}`, { listed: true });
  return c;
}

/** Tina makes a module with one track, then the club's copy of it, titled `title`. */
async function clubModule(page: Page, clubSlug: string, title: string): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New module' }).click();
  const made = page.getByRole('dialog', { name: 'New module' });
  await made.getByLabel('Title').fill(`${title} draft`);
  await made.getByRole('button', { name: 'Create and open' }).click();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  const id = page.url().split('/').pop()!.split('?')[0]!;
  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
  await expect.poll(() => brickCount(page)).toBe(1);
  await page.getByRole('button', { name: 'Save module' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
  const copy = (await api(page, 'post', `/api/modules/${id}/copy`, { orgSlug: clubSlug, title })) as { id: string };
  return copy.id;
}

/** Tina's Share dialog for a module on the home page. */
async function shareDialog(page: Page, title: string) {
  await page.goto('/');
  const row = page.getByTestId('module-row').filter({ has: page.getByText(title, { exact: true }) });
  await row.getByRole('button', { name: `More for ${title}` }).click();
  await page.getByRole('menuitem', { name: 'Share with people…' }).click();
  return page.getByRole('dialog', { name: `Share ${title}` });
}

test('partner clubs and one-off shares between clubs', async ({ page, browser }) => {
  test.setTimeout(360_000);
  await page.setViewportSize({ width: 1300, height: 1100 });
  const ctx = async (email: string, name: string) => {
    const p = await (await browser.newContext({ viewport: { width: 1300, height: 1100 } })).newPage();
    await signIn(p, email, name);
    return p;
  };
  await signIn(page, TINA, 'Tina');
  const rita = await ctx(RITA, 'Rita');
  const lou = await ctx(LOU, 'Lou');
  const hank = await ctx(HANK, 'Hank');
  const train = await club(page, TRAIN);
  const lug = await club(rita, LUG);
  const hill = await club(hank, HILL);
  const invite = (await api(rita, 'post', `/api/orgs/${lug.slug}/invites`, { email: LOU, role: 'member' })) as { token: string };
  await api(lou, 'post', `/api/org-invites/${invite.token}`);

  // ---- Two clients: ask, see it live, accept, see it live.
  await page.goto(`/orgs/${train.slug}`);
  await rita.goto(`/orgs/${lug.slug}`);
  const tinaPartners = page.getByTestId('club-partners');
  const ritaPartners = rita.getByTestId('club-partners');
  await expect(tinaPartners).toContainText('No partner clubs yet.');
  await shot(page, 'partners-empty');
  await tinaPartners.getByTestId('partner-search').fill(LUG);
  await tinaPartners.getByTestId('partner-search-results').getByRole('button', { name: 'Ask' }).click();
  await expect(tinaPartners.getByRole('status')).toHaveText(`Asked ${LUG}. Their Admins or Managers must accept it.`);
  await expect(tinaPartners.getByTestId('partner-requests-out')).toContainText('Waiting for them to accept.');
  // Rita's page: no reload.
  await expect(ritaPartners.getByTestId('partner-requests-in')).toContainText(`${TRAIN} wants to be partners with ${LUG}`, { timeout: 15000 });
  await expect(ritaPartners.getByTestId('partners-waiting')).toHaveText('1 waiting');
  await shot(rita, 'partner-request-in');
  await ritaPartners.getByTestId('partner-requests-in').getByRole('button', { name: 'Accept' }).click();
  await expect(ritaPartners.getByTestId('partner-list')).toContainText(TRAIN);
  // Tina's page: no reload.
  await expect(tinaPartners.getByTestId('partner-list')).toContainText(LUG, { timeout: 15000 });
  await expect(tinaPartners.getByTestId('partner-requests-out')).toHaveCount(0);
  await shot(page, 'partners');

  // A plain member sees the partner, and can't ask or answer.
  await lou.goto(`/orgs/${lug.slug}`);
  await expect(lou.getByTestId('partner-list')).toContainText(TRAIN);
  await expect(lou.getByTestId('partner-search')).toHaveCount(0);
  await expect(lou.getByText('The club’s Admins and Managers ask other clubs to be partners and answer their requests.')).toBeVisible();

  // ---- Partners share both ways, with no accept per module.
  const crane = `Harbor crane ${n}`;
  const craneId = await clubModule(page, train.slug, crane);
  let share = await shareDialog(page, crane);
  await expect(share.getByTestId('club-to-club')).toContainText('Partner clubs get it straight away. Any other club must accept it first.');
  await share.getByTestId('partner-club-pick').selectOption({ label: LUG });
  await share.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(share.getByTestId('module-clubs')).toContainText(`${LUG} (partner club) · can place it`);
  await shot(page, 'share-dialog-partner');
  const mill = (await api(rita, 'post', '/api/modules', { title: `Water mill ${n}`, orgSlug: lug.slug })) as { id: string };
  expect((await rita.request.post(`/api/modules/${mill.id}/club-shares`, { data: { orgSlug: train.slug } })).status()).toBe(201);
  const tinas = (await api(page, 'get', '/api/modules?owner=shared')) as { modules: { id: string }[] };
  expect(tinas.modules.map((m) => m.id)).toContain(mill.id);

  // Lou places Train Club's module in Riverside LUG's layout, from the Clubs tab.
  const show = (await api(rita, 'post', '/api/layouts', { title: `Show plan ${n}`, orgSlug: lug.slug })) as { id: string };
  await lou.goto(`/editor/${show.id}`);
  await expect(lou.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await openPanel(lou, 'Module library');
  await lou.getByTestId('module-library-tab-clubs').click();
  await expect(lou.getByTestId('module-library-from-club').first()).toHaveText(`From ${TRAIN}`);
  const libRow = lou.getByTestId('module-library-row').filter({ hasText: crane });
  await expect(libRow.getByTestId('module-shared-via')).toContainText(`shared with ${LUG}`);
  await libRow.getByRole('button', { name: 'Add to layout' }).click();
  await expect.poll(() => brickCount(lou)).toBe(1);
  await expect(lou.getByTestId('part-pictures')).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
  await shot(lou, 'library-clubs-tab');

  // ---- A one-off offer: waiting, declined live, offered again only after a while.
  await page.bringToFront();
  share = await shareDialog(page, crane);
  await share.getByTestId('other-club-search').fill(HILL);
  await share.getByTestId('other-club-results').getByRole('button', { name: 'Offer' }).click();
  await expect(share.getByRole('status')).toHaveText(`Offered “${crane}” to ${HILL}. It’s shared once their Admins or Managers accept it.`);
  await expect(share.getByTestId('module-offers')).toContainText(`${HILL} · waiting for them to accept`);
  await shot(page, 'share-dialog-offer');
  await hank.goto(`/orgs/${hill.slug}`);
  const hankOffers = hank.getByTestId('module-offers-in');
  await expect(hankOffers).toContainText(`${TRAIN} wants to share “${crane}” with you`);
  await shot(hank, 'module-offer-in');
  await hankOffers.getByRole('button', { name: 'Decline' }).click();
  await expect(hank.getByTestId('module-offers-in')).toHaveCount(0);
  // Tina's open dialog follows, with no reload.
  await expect(share.getByTestId('module-offers')).toContainText(`${HILL} · declined (you can offer it again in a day)`, { timeout: 15000 });
  await expect(share.getByRole('button', { name: 'Offer again' })).toHaveCount(0);

  // Another module: taken back (gone from Hank's page live), offered again, accepted.
  const tower = `Signal tower ${n}`;
  const towerId = await clubModule(page, train.slug, tower);
  share = await shareDialog(page, tower);
  await share.getByTestId('other-club-search').fill(HILL);
  await share.getByTestId('other-club-results').getByRole('button', { name: 'Offer' }).click();
  await expect(hank.getByTestId('module-offers-in')).toContainText(tower, { timeout: 15000 });
  await share.getByRole('button', { name: 'Take back' }).click();
  await expect(share.getByTestId('module-offers')).toHaveCount(0);
  await expect(hank.getByTestId('module-offers-in')).toHaveCount(0, { timeout: 15000 });
  await share.getByTestId('other-club-search').fill(HILL);
  await share.getByTestId('other-club-results').getByRole('button', { name: 'Offer' }).click();
  await hank.getByTestId('module-offers-in').getByRole('button', { name: 'Accept' }).click();
  await expect(hank.getByTestId('club-partners').getByRole('status')).toContainText(`“${tower}” is shared with ${HILL}.`);
  await expect(share.getByTestId('module-clubs')).toContainText(`${HILL} (club, accepted) · can place it`, { timeout: 15000 });
  const hanks = (await api(hank, 'get', '/api/modules?owner=shared')) as { modules: { id: string }[] };
  expect(hanks.modules.map((m) => m.id)).toEqual([towerId]);
  await share.getByRole('button', { name: 'Close' }).click();

  // ---- Ending the partnership: Lou's copy is no longer shared; the one-off share stays.
  await page.goto(`/orgs/${train.slug}`);
  await page.getByTestId('partner-list').getByRole('button', { name: 'End partnership' }).click();
  const box = page.getByRole('alertdialog', { name: `End the partnership with ${LUG}?` });
  await expect(box).toContainText('The 2 modules your clubs shared through it stop, both ways');
  await expect(box).toContainText('Modules shared one off and accepted stay shared.');
  await shot(page, 'end-partnership');
  await box.getByRole('button', { name: 'End partnership' }).click();
  await expect(page.getByTestId('club-partners').getByRole('status')).toHaveText(`The partnership with ${LUG} ended. 2 modules stopped.`);
  await expect(rita.getByTestId('partner-list')).toHaveCount(0, { timeout: 15000 });
  await expect(rita.getByTestId('club-partners')).toContainText('No partner clubs yet.');
  await expect
    .poll(async () => ((await api(lou, 'get', `/api/layouts/${show.id}/shared-modules`)) as { modules: { state: string }[] }).modules.map((m) => m.state), { timeout: 15000 })
    .toEqual(['unshared']);
  await openPanel(lou, 'Modules');
  await expect(lou.getByTestId('module-shared-note')).toContainText('No longer shared', { timeout: 15000 });
  expect(((await api(hank, 'get', '/api/modules?owner=shared')) as { modules: { id: string }[] }).modules.map((m) => m.id)).toEqual([towerId]);
  void craneId;

  // ---- A partner club deleted: the partnership ends, and Train Club is told.
  const req = (await api(hank, 'post', `/api/orgs/${hill.slug}/partners`, { slug: train.slug })) as { id: string };
  await api(page, 'post', `/api/orgs/${train.slug}/partner-requests/${req.id}/accept`);
  await page.goto(`/orgs/${train.slug}`);
  await expect(page.getByTestId('partner-list')).toContainText(HILL);
  const root = await ctx(ROOT, 'Root');
  makeGlobalAdmin(ROOT);
  await api(root, 'post', `/api/admin/orgs/${hill.id}/erase`, { confirm: HILL, catalog: 'takedown' });
  await expect(page.getByTestId('club-partners')).toContainText('No partner clubs yet.', { timeout: 15000 });
  await page.goto('/notices');
  await expect(page.getByText(`${HILL} was deleted, so your clubs are no longer partners.`)).toBeVisible();
});
