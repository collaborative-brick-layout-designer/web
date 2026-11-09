// E2E: the first-visit welcome card and the guided tours. A new account
// gets the welcome card on the home page; putting it away sticks (it's in
// the account's toursSeen). "Take the tour" opens a layout and walks
// through the editor tour, outlining real controls; Esc closes, Tab stays
// in the card. Tours start from the Help menu and from Settings, the
// Rooms tour opens the room designer, and a phone gets the View tour.

import { test, expect, devices, type Page } from '@playwright/test';
import { signIn } from '../helpers';
import catalogue from '../../src/tours/tours.json' with { type: 'json' };

const ts = Date.now();
/** A tour as the web app shows it: without its desktop-only steps (tours.ts). */
const tour = (id: string) => {
  const t = catalogue.tours.find((x) => x.id === id)!;
  return { ...t, steps: t.steps.filter((s) => !('apps' in s) || (s.apps as string[]).includes('web')) };
};
const card = (page: Page) => page.getByTestId('tour').getByRole('dialog');

async function prefs(page: Page): Promise<string[]> {
  const res = await page.request.get('/api/me/preferences');
  return ((await res.json()) as { prefs: { toursSeen: string[] } }).prefs.toursSeen;
}

test('a new account is welcomed once; Not now sticks', async ({ page }) => {
  await signIn(page, `welcome-${ts}@example.com`, 'Robin Bricks');
  await page.goto('/');
  const welcome = page.getByTestId('welcome');
  await expect(welcome.getByRole('heading', { name: `Hi Robin! ${catalogue.welcome.title}` })).toBeVisible();
  await welcome.getByRole('button', { name: catalogue.welcome.dismiss }).click();
  await expect(welcome).toHaveCount(0);
  await expect.poll(() => prefs(page)).toContain('welcome');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Layouts' })).toBeVisible();
  await expect(page.getByTestId('welcome')).toHaveCount(0);
});

test('Take the tour walks through the editor, outlining real controls', async ({ page }) => {
  await signIn(page, `tour-editor-${ts}@example.com`, 'Tour Taker');
  await page.goto('/');
  await page.getByTestId('welcome').getByRole('button', { name: new RegExp(catalogue.welcome.actions.tour.label) }).click();
  await expect(page).toHaveURL(/\/editor\//);
  const steps = tour('editor').steps;
  for (const [i, s] of steps.entries()) {
    await expect(card(page)).toHaveAccessibleName(s.title);
    await expect(card(page)).toContainText(`${i + 1} of ${steps.length}`);
    // Every editor step outlines its control.
    await expect(page.getByTestId('tour-highlight')).toBeVisible();
    await card(page).getByRole('button', { name: i === steps.length - 1 ? 'Done' : 'Next' }).click();
  }
  await expect(page.getByTestId('tour')).toHaveCount(0);
  await expect.poll(() => prefs(page)).toEqual(expect.arrayContaining(['welcome', 'editor']));
});

test('the keyboard: focus starts on Next, Tab stays in the card, Esc closes', async ({ page }) => {
  await signIn(page, `tour-keys-${ts}@example.com`, 'Key Person');
  const res = await page.request.post('/api/layouts', { data: { title: 'Keys' } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await page.getByRole('button', { name: 'Tour: The editor' }).click();
  await expect(card(page).getByRole('button', { name: 'Next' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card(page)).toHaveAccessibleName(tour('editor').steps[1]!.title);
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    await expect(card(page).locator(':focus')).toHaveCount(1);
  }
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tour')).toHaveCount(0);
  // Esc reached the tour, not the editor (which would have changed tool or cleared the selection).
  await expect(page.getByRole('button', { name: 'Help', exact: true })).toBeVisible();
});

test('the Venues tour opens the venue designer from the home page’s menu', async ({ page }) => {
  await signIn(page, `tour-rooms-${ts}@example.com`, 'Room Planner');
  await page.goto('/');
  await page.getByRole('banner').getByRole('button', { name: /^Menu/ }).click();
  // Help starts folded; open it, then take the tour.
  const menu = page.getByRole('menu', { name: 'Menu' });
  const help = menu.getByRole('button', { name: /^Help/ });
  if ((await help.getAttribute('aria-expanded')) !== 'true') await help.click();
  await menu.getByRole('menuitem', { name: 'Tour: Venues' }).click();
  await expect(page).toHaveURL(/\/venues\/new/);
  for (const s of tour('rooms').steps) {
    await expect(card(page)).toHaveAccessibleName(s.title);
    await expect(page.getByTestId('tour-highlight')).toBeVisible();
    await card(page).getByRole('button', { name: /Next|Done/ }).click();
  }
  await expect(page.getByTestId('tour')).toHaveCount(0);
});

test('Settings starts a tour, and Show tours again brings the welcome back', async ({ page }) => {
  await signIn(page, `tour-settings-${ts}@example.com`, 'Set Tings');
  await page.goto('/');
  await page.getByTestId('welcome').getByRole('button', { name: catalogue.welcome.dismiss }).click();
  await expect.poll(() => prefs(page)).toContain('welcome');
  await page.goto('/settings');
  await page.getByRole('group', { name: 'Take a tour' }).getByRole('button', { name: 'Clubs' }).click();
  await expect(page).toHaveURL(/\/$/);
  // In no club yet: the tour leaves out "Mine and my clubs'" (nothing to
  // point at), and its last step outlines the Home page's Join a club card.
  const forClubless = tour('clubs').steps.filter((st) => !(st as { needsClub?: boolean }).needsClub);
  expect(forClubless.length).toBe(tour('clubs').steps.length - 1);
  await expect(card(page)).toHaveAccessibleName(forClubless[0]!.title);
  for (let i = 1; i < forClubless.length; i++) {
    await card(page).getByRole('button', { name: 'Next' }).click();
    await expect(card(page)).toHaveAccessibleName(forClubless[i]!.title);
  }
  await expect(page.getByTestId('join-club-card')).toBeVisible();
  await expect(page.getByTestId('tour-highlight')).toBeVisible();
  await card(page).getByRole('button', { name: 'Done' }).click();
  await expect.poll(() => prefs(page)).toContain('clubs');
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Show tours again' }).click();
  await expect.poll(() => prefs(page)).toEqual([]);
  await page.goto('/');
  await expect(page.getByTestId('welcome')).toBeVisible();
});

test.describe('on a phone', () => {
  const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];
  test.use(pixel);
  test('the shorter View tour, its card across the screen', async ({ page }) => {
    await signIn(page, `tour-phone-${ts}@example.com`, 'Phone Person');
    await page.goto('/');
    await page.getByTestId('welcome').getByRole('button', { name: new RegExp(catalogue.welcome.actions.tour.label) }).click();
    await expect(page).toHaveURL(/\/editor\//);
    const steps = tour('view').steps;
    await expect(card(page)).toContainText(`${tour('view').title} · 1 of ${steps.length}`);
    const box = (await card(page).boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.width).toBeGreaterThan(width - 40);
    for (const [i, s] of steps.entries()) {
      await expect(card(page)).toHaveAccessibleName(s.title);
      if (s.target === 'layout.menu') {
        // The layout's name is at the top, so the card docks along the bottom, clear of it.
        const height = page.viewportSize()!.height;
        await expect.poll(async () => Math.round((await card(page).boundingBox())!.y + (await card(page).boundingBox())!.height)).toBe(height - 8);
        await expect(page.getByTestId('tour-highlight')).toBeVisible();
      }
      await card(page).getByRole('button', { name: i === steps.length - 1 ? 'Done' : 'Next' }).click();
    }
    await expect.poll(() => prefs(page)).toContain('view');
  });
});
