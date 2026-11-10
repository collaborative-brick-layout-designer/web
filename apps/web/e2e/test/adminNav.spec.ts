// The admin pages' sections: a list down the left (grouped, with counts)
// on a computer, one "Section" picker on a phone, each section its own
// address; a moderator gets Moderation alone, with no list. Moderation
// handles a long queue: tick several and approve them at once.

import { test, expect, type Browser } from '@playwright/test';
import { signIn, adminSection, confirmInDialog } from '../helpers';
import { makeGlobalAdmin, siteSettingsAtDefaults } from '../dbHelpers';

siteSettingsAtDefaults();

const ts = Date.now();
const ADMIN = `nav-admin-${ts}@example.com`;
const MOD = `nav-mod-${ts}@example.com`;
const OWNER = `nav-owner-${ts}@example.com`;

async function page(browser: Browser, email: string, name: string, phone = false) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await signIn(p, email, name);
  return p;
}

test('sections: a side list on a computer, a picker on a phone; moderators get Moderation alone; approve several at once', async ({ browser }) => {
  const admin = await page(browser, ADMIN, 'Nav Admin');
  makeGlobalAdmin(ADMIN);
  const mod = await page(browser, MOD, 'Nav Mod');
  const owner = await page(browser, OWNER, 'Nav Owner');
  const before = (await (await admin.request.get('/api/admin/settings')).json()) as { catalog?: { modules: boolean; review: string } };
  try {
    const modId = ((await (await admin.request.get('/api/admin/users?q=' + encodeURIComponent(MOD))).json()) as { users: { id: string; email: string }[] }).users.find((u) => u.email === MOD)!.id;
    expect((await admin.request.patch(`/api/admin/users/${modId}`, { data: { isModerator: true } })).ok()).toBe(true);
    expect((await admin.request.patch('/api/admin/settings', { data: { moduleCatalogEnabled: true, catalogReview: 'moderators' } })).ok()).toBe(true);
    // Three modules wait for review.
    for (const i of [1, 2, 3]) {
      const m = (await (await owner.request.post('/api/modules', { data: { title: `Nav shed ${i} ${ts}` } })).json()) as { id: string };
      expect((await owner.request.post('/api/catalog/submissions', { data: { kind: 'module', sourceId: m.id, title: `Nav shed ${i} ${ts}` } })).ok()).toBe(true);
    }

    // A computer: the list down the side, grouped, with the waiting count.
    await admin.goto('/admin');
    const nav = admin.getByRole('navigation', { name: 'Admin sections' });
    await expect(nav.getByRole('heading')).toHaveText(['Overview', 'People', 'Content', 'Requests', 'Site']);
    await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: /^Moderation/ }).getByLabel(/waiting for review/)).toBeVisible();
    await expect(admin.getByRole('combobox', { name: 'Section' })).toBeHidden();
    await nav.getByRole('link', { name: 'Users' }).click();
    await expect(admin).toHaveURL(/tab=users/);
    await expect(nav.getByRole('link', { name: 'Users' })).toHaveAttribute('aria-current', 'page');
    // Back goes to the section before.
    await admin.goBack();
    await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');

    // Moderation: tick the three, approve them at once.
    await adminSection(admin, 'moderation');
    const rows = admin.getByTestId('moderation-entry').filter({ hasText: String(ts) });
    await admin.getByLabel('Search').fill(`Nav shed`);
    await expect(rows).toHaveCount(3);
    for (const i of [1, 2, 3]) await admin.getByLabel(`Tick Nav shed ${i} ${ts}`).check();
    await admin.getByRole('button', { name: 'Approve 3' }).click();
    await confirmInDialog(admin);
    await expect(rows).toHaveCount(0);
    expect(((await (await owner.request.get('/api/catalog/items?kind=module&q=' + encodeURIComponent(`nav shed`))).json()) as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(3);

    // A moderator: Moderation alone, no list and no picker.
    await mod.goto('/admin?tab=users');
    await expect(mod.getByRole('tab', { name: /^To review/ })).toBeVisible();
    await expect(mod.getByRole('navigation', { name: 'Admin sections' })).toHaveCount(0);
    await expect(mod.getByRole('combobox', { name: 'Section' })).toHaveCount(0);

    // A phone: one picker at the top showing where you are; nothing scrolls sideways.
    const phone = await page(browser, ADMIN, 'Nav Admin', true);
    await phone.goto('/admin?tab=audit');
    const pick = phone.getByRole('combobox', { name: 'Section' });
    await expect(pick).toBeVisible();
    await expect(pick).toHaveValue('audit');
    await expect(phone.getByRole('navigation', { name: 'Admin sections' })).toBeHidden();
    expect((await pick.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await pick.selectOption('settings');
    await expect(phone).toHaveURL(/tab=settings/);
    await expect(pick).toHaveValue('settings');
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await phone.context().close();
  } finally {
    if (before.catalog) await admin.request.patch('/api/admin/settings', { data: { moduleCatalogEnabled: before.catalog.modules, catalogReview: before.catalog.review } });
    for (const p of [admin, mod, owner]) await p.context().close();
  }
});
