// Three follow-ups to club-to-club sharing (docs/shared-modules.md, section 11):
//   1. two clubs become partners while a module offer waits between them:
//      the offer turns into a partner share at once (live on both pages), the
//      receiving club's Admins and Managers are told, and a member can place
//      the module from the Module library's Clubs tab;
//   2. the Clubs tour has a "Partner clubs" stop for someone in a club;
//   3. a module copied into a club starts at version 1 (never "v0").
// SHOTS=<dir> saves light and dark pictures; BEFORE=1 only takes the pictures
// (it runs against main, where the new behavior isn't there yet).

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { signIn } from '../helpers';
import catalogue from '../../src/tours/tours.json' with { type: 'json' };

const ts = Date.now();
const n = ts % 100000;
const SHOTS = process.env.SHOTS;
const BEFORE = !!process.env.BEFORE;
const PART = 'ts_narrowgauge_straight.8';

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
    return st ? st.find((nd) => nd.getClassName() === 'Group' && nd.name().startsWith('brick-')).length : 0;
  });
}

async function openPanel(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel(label, { exact: true }).check();
  await page.mouse.click(400, 400);
}

async function club(page: Page, name: string): Promise<{ id: string; slug: string }> {
  const c = (await api(page, 'post', '/api/orgs', { name })) as { id: string; slug: string };
  await api(page, 'patch', `/api/orgs/${c.slug}`, { listed: true });
  return c;
}

/** A club's module with one track, made in the editor and copied into the club. */
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
  return ((await api(page, 'post', `/api/modules/${id}/copy`, { orgSlug: clubSlug, title })) as { id: string }).id;
}

test('a module offer waiting when the clubs become partners turns into a partner share', async ({ page, browser }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1300, height: 1100 });
  const ctx = async (email: string, name: string) => {
    const p = await (await browser.newContext({ viewport: { width: 1300, height: 1100 } })).newPage();
    await signIn(p, email, name);
    return p;
  };
  const LUG = `Riverside LUG ${n}`;
  const TRAIN = `Train Club ${n}`;
  const LOU = `cf-lou-${ts}@example.com`;
  await signIn(page, `cf-tina-${ts}@example.com`, 'Tina');
  const rita = await ctx(`cf-rita-${ts}@example.com`, 'Rita');
  const lou = await ctx(LOU, 'Lou');
  const train = await club(page, TRAIN);
  const lug = await club(rita, LUG);
  const invite = (await api(rita, 'post', `/api/orgs/${lug.slug}/invites`, { email: LOU, role: 'member' })) as { token: string };
  await api(lou, 'post', `/api/org-invites/${invite.token}`);

  // Train Club offers its module to Riverside LUG, which isn't a partner yet.
  const crane = `Harbor crane ${n}`;
  const craneId = await clubModule(page, train.slug, crane);
  const offered = await page.request.post(`/api/modules/${craneId}/club-shares`, { data: { orgSlug: lug.slug } });
  expect(offered.status()).toBe(202);
  await rita.goto(`/orgs/${lug.slug}`);
  const ritaPartners = rita.getByTestId('club-partners');
  await expect(ritaPartners.getByTestId('module-offers-in')).toContainText(`${TRAIN} wants to share “${crane}” with you`);
  await shot(rita, 'offer-waiting');

  // The clubs become partners: Train Club asks, Rita accepts.
  await api(page, 'post', `/api/orgs/${train.slug}/partners`, { slug: lug.slug });
  await expect(ritaPartners.getByTestId('partner-requests-in')).toContainText(TRAIN, { timeout: 15000 });
  await ritaPartners.getByTestId('partner-requests-in').getByRole('button', { name: 'Accept' }).click();
  await expect(ritaPartners.getByTestId('partner-list')).toContainText(TRAIN);
  if (BEFORE) {
    await shot(rita, 'offer-after-partners');
    return;
  }
  // The offer is gone, with no reload: it is a partner share now.
  await expect(ritaPartners.getByTestId('module-offers-in')).toHaveCount(0, { timeout: 15000 });
  await expect(ritaPartners.getByTestId('partner-list')).toContainText('1 module from them');
  await shot(rita, 'offer-after-partners');
  const mine = (await api(page, 'get', `/api/modules/${craneId}/shares`)) as { offers: unknown[]; clubs: { name: string; via: string }[] };
  expect(mine.offers).toEqual([]);
  expect(mine.clubs).toEqual([expect.objectContaining({ name: LUG, via: 'partner' })]);
  // Riverside LUG's Admins and Managers are told.
  await rita.goto('/notices');
  await expect(rita.getByText(`${TRAIN} offered your club the module “${crane}”, and now that your clubs are partners it is shared with you.`)).toBeVisible();
  await shot(rita, 'offer-notice');

  // A plain member places it from the Clubs tab, with no accept.
  const show = (await api(rita, 'post', '/api/layouts', { title: `Show plan ${n}`, orgSlug: lug.slug })) as { id: string };
  await lou.goto(`/editor/${show.id}`);
  await expect(lou.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await openPanel(lou, 'Module library');
  await lou.getByTestId('module-library-tab-clubs').click();
  await expect(lou.getByTestId('module-library-from-club').first()).toHaveText(`From ${TRAIN}`);
  const row = lou.getByTestId('module-library-row').filter({ hasText: crane });
  await expect(row.getByTestId('module-shared-via')).toContainText(`shared with ${LUG}`);
  await expect(row).toContainText('v1 ·');
  await row.getByRole('button', { name: 'Add to layout' }).click();
  await expect.poll(() => brickCount(lou)).toBe(1);
  await expect(lou.getByTestId('part-pictures')).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
  await shot(lou, 'offer-placed');
});

test('the Clubs tour has a Partner clubs stop for someone in a club', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, `cf-tour-${ts}@example.com`, 'Tour Taker');
  await club(page, `Tour Club ${n}`);
  await page.goto('/');
  await page.getByTestId('welcome').getByRole('button', { name: catalogue.welcome.dismiss }).click();
  await page.goto('/settings');
  await page.getByRole('group', { name: 'Take a tour' }).getByRole('button', { name: 'Clubs' }).click();
  const card = page.getByTestId('tour').getByRole('dialog');
  if (BEFORE) {
    // Main's fourth stop, where "Partner clubs" goes now.
    for (let i = 0; i < 3; i++) await card.getByRole('button', { name: 'Next' }).click();
    await shot(page, 'tour-partner-clubs');
    return;
  }
  const steps = catalogue.tours.find((t) => t.id === 'clubs')!.steps.filter((s) => !('apps' in s) || (s.apps as string[]).includes('web'));
  const stop = steps.find((s) => s.title === 'Partner clubs')!;
  for (let i = 0; i < steps.indexOf(stop); i++) await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAccessibleName('Partner clubs');
  await expect(card).toContainText(stop.text);
  await shot(page, 'tour-partner-clubs');
  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAccessibleName(steps[steps.indexOf(stop) + 1]!.title);
});

test('a module copied into a club starts at version 1', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1300, height: 1100 });
  await signIn(page, `cf-copy-${ts}@example.com`, 'Copy Maker');
  const c = await club(page, `Copy Club ${n}`);
  const title = `Siding ${n}`;
  const copyId = await clubModule(page, c.slug, title);
  const got = (await api(page, 'get', `/api/modules/${copyId}`)) as { module: { docVersion: number; latestVersion: number } };
  if (!BEFORE) expect(got.module).toMatchObject({ docVersion: 1, latestVersion: 1 });
  const layout = (await api(page, 'post', '/api/layouts', { title: `Plan ${n}`, orgSlug: c.slug })) as { id: string };
  await page.goto(`/editor/${layout.id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await openPanel(page, 'Module library');
  await page.getByTestId('module-library-tab-clubs').click();
  const row = page.getByTestId('module-library-row').filter({ hasText: title });
  await expect(row).toBeVisible();
  if (!BEFORE) {
    await expect(row).toContainText('v1 ·');
    await expect(row).not.toContainText('v0');
  }
  await row.getByRole('button', { name: 'Add to layout' }).click();
  await expect.poll(() => brickCount(page)).toBe(1);
  await expect(page.getByTestId('part-pictures')).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
  await shot(page, 'copy-version');
});
