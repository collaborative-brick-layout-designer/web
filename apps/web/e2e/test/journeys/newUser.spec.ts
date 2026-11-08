// Journey 1 — a new club member's first layout.
//
//   Sign up (the real form and the emailed link) → the welcome card → the
//   editor tour → design a venue → Start layout from it → place, move and
//   rotate a part → it is saved on the server → share a picture → save a
//   view and export all views.
//
// And an older account whose name is its email address: asked "What should
// we call you?" after signing in, while its club only ever sees
// "Builder #…", then the new name, live.
//
// Every result is checked where a member would find it again: the venue in
// the layout's file, the part's place and turn in the server's .bbm.

import { test, expect, type Page } from '@playwright/test';
import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { PASS, signIn } from '../../helpers';
import { getVerificationToken, setStoredName } from '../../dbHelpers';
import catalogue from '../../../src/tours/tours.json' with { type: 'json' };

const ts = Date.now();
const EMAIL = `j-new-${ts}@example.com`;
const VENUE = `Village hall ${ts}`;
const LAYOUT = `First layout ${ts}`;
const PART = 'ts_narrowgauge_straight.8';
const NAME = `Sam ${ts}`;

async function clickCanvas(page: Page, fx: number, fy: number): Promise<void> {
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

/** The one part in the server's copy of the layout: where it is and how it is turned. */
async function savedPart(page: Page, id: string): Promise<{ x: number; angle: number } | null> {
  const r = await page.request.get(`/api/layouts/${id}/export.bbm`);
  if (!r.ok()) return null;
  const xml = await r.text();
  const brick = /<Brick [^>]*>([\s\S]*?)<\/Brick>/.exec(xml)?.[1];
  if (!brick) return null;
  const x = Number(/<DisplayArea>\s*<X>([-\d.]+)<\/X>/.exec(brick)?.[1] ?? NaN);
  const angle = Number(/<Orientation>([-\d.]+)<\/Orientation>/.exec(brick)?.[1] ?? NaN);
  return { x, angle };
}

/** Names of the files in a zip (stored or deflated entries). */
function zipNames(buf: Buffer): string[] {
  const names: string[] = [];
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    names.push(buf.toString('utf8', i + 30, i + 30 + nameLen));
    const start = i + 30 + nameLen + extraLen;
    if (method === 8) inflateRawSync(buf.subarray(start, start + size));
    i = start + size;
  }
  return names;
}

test('a new member signs up and makes, saves and shares a first layout', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 900 });

  // ── Sign up with the form, then the link from the email. ──
  await page.goto('/login');
  await page.getByRole('button', { name: /need an account/i }).click();
  // The name others see is asked for up front (ⓘ says where it shows).
  await page.getByLabel('Your name (shown to others)').fill(NAME);
  await page.getByPlaceholder('Email').fill(EMAIL);
  await page.getByPlaceholder('Password').fill(PASS);
  // Sign-up is rate-limited per address; on a busy test server, wait the
  // minute the message asks for and press Create account again.
  for (let attempt = 0; ; attempt++) {
    await page.getByRole('button', { name: 'Create account' }).click();
    const sent = page.getByText(/check/i).first();
    const slowDown = page.getByText(/too many/i).first();
    let outcome = '';
    await expect
      .poll(async () => (outcome = (await sent.isVisible()) ? 'sent' : (await slowDown.isVisible()) ? 'wait' : ''), { timeout: 20_000 })
      .not.toBe('');
    if (outcome === 'sent') break;
    expect(attempt, 'still rate-limited after waiting').toBeLessThan(2);
    test.setTimeout(test.info().timeout + 65_000);
    await page.waitForTimeout(61_000);
  }
  await page.goto(`/verify-email/${await getVerificationToken(EMAIL)}`);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('No OAuth providers configured.')).toHaveCount(0);

  // ── Welcome card → Take the tour → the editor tour to the end. ──
  await page.goto('/');
  const welcome = page.getByTestId('welcome');
  await expect(welcome).toBeVisible({ timeout: 15000 });
  // Greeted by the name they gave, never the email address, and not asked again.
  await expect(welcome).not.toContainText('@');
  // The Settings menu says who's signed in.
  await page.getByRole('banner').getByRole('button', { name: /^Menu/ }).click();
  await expect(page.getByTestId('settings-menu-who')).toContainText(NAME);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('name-prompt')).toHaveCount(0);
  await welcome.getByRole('button', { name: new RegExp(catalogue.welcome.actions.tour.label) }).click();
  await expect(page).toHaveURL(/\/editor\//);
  const steps = catalogue.tours.find((t) => t.id === 'editor')!.steps;
  const card = page.getByTestId('tour').getByRole('dialog');
  for (const [i, s] of steps.entries()) {
    await expect(card).toHaveAccessibleName(s.title);
    await card.getByRole('button', { name: i === steps.length - 1 ? 'Done' : 'Next' }).click();
  }
  await expect(page.getByTestId('tour')).toHaveCount(0);

  // ── Home → New venue: a 40′ × 20′ hall, named and saved. ──
  await page.goto('/');
  await page.getByRole('button', { name: 'New venue' }).click();
  await expect(page).toHaveURL(/\/venues\/new/);
  await expect(page.getByRole('navigation', { name: 'Tools', exact: true })).toBeVisible();
  await page.keyboard.press('r');
  await clickCanvas(page, 0.2, 0.2);
  await page.mouse.move(600, 600);
  for (const ch of "40'x20'") await page.keyboard.press(ch);
  await page.keyboard.press('Enter');
  await expect(page.getByText('Venue 40′ 0″ × 20′ 0″')).toBeVisible();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await page.keyboard.press('Escape');
  await inspector.getByLabel('Name').fill(VENUE);
  await inspector.getByLabel('Name').press('Enter');
  await page.getByRole('button', { name: 'Save venue' }).click();
  await expect(page).toHaveURL(/\/venues\/[^/]+\/design$/);
  await page.getByRole('button', { name: 'Close' }).click();

  // ── Start layout from the venue. ──
  const venueRow = page.locator('li', { hasText: VENUE });
  await venueRow.getByRole('link', { name: 'Start layout' }).click();
  const create = page.getByRole('dialog', { name: 'New layout' });
  await expect(create.getByRole('combobox')).toHaveValue(/.+/);
  await create.getByLabel('Title').fill(LAYOUT);
  await create.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/editor\/[0-9a-f-]{36}$/);
  const id = /\/editor\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await expect
    .poll(async () => {
      const r = await page.request.get(`/api/layouts/${id}/export.bbm.bld`);
      return r.ok() ? (((await r.json()) as { venue?: { edges: unknown[] } }).venue?.edges ?? []).length : 0;
    }, { timeout: 15000 })
    .toBe(4);

  // ── Place a part; move it right; rotate it. Each lands on the server. ──
  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15000 });
  await expect.poll(() => savedPart(page, id), { timeout: 15000 }).not.toBeNull();
  const placed = (await savedPart(page, id))!;
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await savedPart(page, id))!.x, { timeout: 15000 }).toBeGreaterThan(placed.x);
  await page.getByRole('button', { name: 'Turn right' }).click();
  await expect.poll(async () => (await savedPart(page, id))!.angle, { timeout: 15000 }).not.toBe(placed.angle);
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
  await page.reload();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('1 pieces').or(page.getByText('1 piece'))).toBeVisible({ timeout: 15000 });

  // ── Share a picture: on a computer it downloads. ──
  await page.getByRole('button', { name: 'Share picture' }).click();
  const sheet = page.getByTestId('share-picture');
  await expect(sheet.getByRole('img', { name: 'Picture of Whole layout' })).toBeVisible({ timeout: 15000 });
  const pic = page.waitForEvent('download');
  await sheet.getByRole('button', { name: 'Download picture' }).click();
  expect((await pic).suggestedFilename()).toBe(`${LAYOUT} - Whole layout.png`);
  await page.keyboard.press('Escape');

  // ── Save a view; Export all views gives a zip with it. ──
  const views = page.getByRole('region', { name: 'Views' });
  await page.getByRole('group', { name: 'Tasks' }).getByRole('button', { name: 'Build' }).click();
  await views.getByRole('button', { name: '+ Add view' }).click();
  await views.getByLabel('Name the view').fill('Whole hall');
  await views.getByRole('button', { name: 'Add view', exact: true }).click();
  await expect(page.getByTestId('active-view')).toContainText('Showing Whole hall');
  const zip = page.waitForEvent('download');
  await views.getByRole('button', { name: 'Export all views' }).click();
  const download = await zip;
  expect(download.suggestedFilename()).toBe(`${LAYOUT} - views.zip`);
  expect(zipNames(readFileSync((await download.path())!))).toEqual([expect.stringContaining('Whole hall')]);
});

test('an account named by its email is asked for a name, and its club never sees the address', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const ADA = `j-names-ada-${ts}@example.com`;
  const PAT = `j-names-pat-${ts}@example.com`;
  await signIn(page, ADA, 'Ada Names');
  const pat = await browser.newPage();
  await signIn(pat, PAT, 'Pat');
  // An account from before sign-up asked for a name: its name is its email.
  setStoredName(PAT, PAT);

  // Ada's club, with Pat in it (an open, listed club: one click to join).
  const made = await page.request.post('/api/orgs', { data: { name: `Name Club ${ts}` } });
  expect(made.ok(), await made.text()).toBe(true);
  const slug = ((await made.json()) as { slug: string }).slug;
  expect((await page.request.patch(`/api/orgs/${slug}`, { data: { joinPolicy: 'open', listed: true } })).ok()).toBe(true);
  expect((await pat.request.post(`/api/orgs/${slug}/join`, { data: {} })).ok()).toBe(true);

  // Ada's member list: "Builder #…" for Pat, never the address as a name
  // (as the club's admin she may see addresses, on their own line).
  await page.goto(`/orgs/${slug}/admin`);
  await expect(page.getByRole('group', { name: /^Roles for Builder #[0-9a-f]{6}$/ })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('group', { name: `Roles for ${PAT}` })).toHaveCount(0);

  // Pat signs in: "What should we call you?", prefilled from the email.
  await pat.goto('/');
  const ask = pat.getByTestId('name-prompt');
  await expect(ask).toBeVisible({ timeout: 15000 });
  await expect(ask.getByLabel('Your name (shown to others)')).toHaveValue(`j names pat ${ts}`);
  await ask.getByLabel('Your name (shown to others)').fill(PAT);
  await ask.getByRole('button', { name: 'Save name' }).click();
  await expect(ask.getByText(/can’t be an email address/)).toBeVisible();
  await ask.getByLabel('Your name (shown to others)').fill(`Pat Plates ${ts}`);
  await ask.getByRole('button', { name: 'Save name' }).click();
  await expect(ask).toHaveCount(0);
  await pat.getByRole('banner').getByRole('button', { name: /^Menu/ }).click();
  await expect(pat.getByTestId('settings-menu-who')).toContainText(`Pat Plates ${ts}`);
  await pat.keyboard.press('Escape');

  // Ada sees the new name without reloading.
  await expect(page.getByRole('group', { name: `Roles for Pat Plates ${ts}` })).toBeVisible({ timeout: 15000 });
  await pat.close();
});
