// Journey — catalog collections, from submission to "Add all", live.
//
//   1. Two modules are in the public catalog (shared and approved).
//   2. Cora, an ordinary member, builds a collection of both from the
//      Catalog page (Your collections › New collection), for Everyone, and
//      submits it: In review.
//   3. Vic has the Catalog open. A moderator approves the collection; it
//      shows up on Vic's page without a reload.
//   4. Vic opens it, adds one item by itself, then "Add all": only the
//      other is added (nothing duplicated).
//   4b. Cora uploads her own cover; it waits for review (the old one stays
//      up), and shows on Vic's page once approved.
//   5. The moderator unpublishes one item. It drops out of the collection
//      on Vic's open page, and Cora's Mine tells her why.

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { signIn, fromSettingsMenu } from '../../helpers';
import { makeGlobalAdmin, siteSettingsAtDefaults } from '../../dbHelpers';

siteSettingsAtDefaults();

const ts = Date.now();
test.setTimeout(180_000);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function person(browser: Browser, email: string, name: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, email, name);
  return { ctx, page };
}
const streamOpen = (page: Page) => expect(page.locator('html')).toHaveAttribute('data-live', 'open', { timeout: 15000 });

test('a submitted collection is approved, shows up live, Add all skips what you have, and an unpublished item drops out', async ({ browser }) => {
  const ADMIN = `j-coll-admin-${ts}@example.com`;
  const MOD = `j-coll-mod-${ts}@example.com`;
  const OWNER = `j-coll-owner-${ts}@example.com`;
  const CORA = `j-coll-cora-${ts}@example.com`;
  const VIC = `j-coll-vic-${ts}@example.com`;
  const admin = await person(browser, ADMIN, 'Site Admin');
  makeGlobalAdmin(ADMIN);
  const mod = await person(browser, MOD, 'Mo Derator');
  const owner = await person(browser, OWNER, 'Owner Olive');
  const cora = await person(browser, CORA, 'Cora Curator');
  const vic = await person(browser, VIC, 'Vic Viewer');
  const people = [admin, mod, owner, cora, vic];
  const TITLE = `Yard basics ${ts}`;
  try {
    // The module catalog is on, reviewed by moderators; Mo is a moderator.
    expect((await admin.page.request.patch('/api/admin/settings', { data: { moduleCatalogEnabled: true, catalogReview: 'moderators' } })).ok()).toBe(true);
    const modId = ((await (await mod.page.request.get('/api/auth/me')).json()) as { user: { id: string } }).user.id;
    expect((await admin.page.request.patch(`/api/admin/users/${modId}`, { data: { isModerator: true } })).ok()).toBe(true);

    // Olive shares two modules (with pictures); Mo approves them.
    const items: Record<string, string> = {};
    for (const t of [`Freight yard ${ts}`, `Engine shed ${ts}`]) {
      const m = (await (await owner.page.request.post('/api/modules', { data: { title: t } })).json()) as { id: string };
      expect((await owner.page.request.put(`/api/modules/${m.id}/thumbnail`, { data: { mime: 'image/png', data: PNG } })).ok()).toBe(true);
      const s = (await (await owner.page.request.post('/api/catalog/submissions', { data: { kind: 'module', sourceId: m.id, title: t } })).json()) as { id: string };
      items[t] = s.id;
    }
    const queue = ((await (await mod.page.request.get('/api/moderation/items')).json()) as { queue: { versionId: string; itemId: string }[] }).queue;
    for (const q of queue.filter((x) => Object.values(items).includes(x.itemId))) {
      expect((await mod.page.request.post(`/api/moderation/versions/${q.versionId}/approve`, { data: {} })).ok()).toBe(true);
    }

    // Vic has the Catalog open: no collections yet.
    await vic.page.goto('/catalog');
    // (Other journeys may have left catalog items and collections behind.)
    await expect(vic.page.getByTestId('catalog-item').filter({ hasText: String(ts) })).toHaveCount(2);
    await streamOpen(vic.page);
    // Collections are a tab of the Catalog, like the kinds.
    await vic.page.getByRole('tab', { name: 'Collections' }).click();
    await expect(vic.page.getByTestId('collection-card').filter({ hasText: TITLE })).toHaveCount(0);

    // Cora builds a collection from the Catalog page and submits it.
    await cora.page.goto('/catalog?kind=collections');
    await cora.page.getByRole('button', { name: 'New collection' }).click();
    const editor = cora.page.getByRole('dialog', { name: 'New collection' });
    await editor.getByLabel('Title').fill(TITLE);
    await editor.getByLabel('Description (optional)').fill('Everything a small goods yard needs.');
    await editor.getByLabel('Everyone (reviewed first)').check();
    await editor.getByRole('button', { name: `Put Freight yard ${ts} in the collection` }).click();
    await editor.getByRole('button', { name: `Put Engine shed ${ts} in the collection` }).click();
    await editor.getByRole('button', { name: 'Submit' }).click();
    await expect(editor.getByRole('status')).toContainText('Sent for review');
    await editor.getByRole('button', { name: 'Done' }).click();
    const mine = cora.page.getByTestId('my-collection').filter({ hasText: TITLE });
    await expect(mine.getByTestId('collection-status')).toHaveText('In review');

    // Mo approves it from Moderation.
    await mod.page.goto('/');
    await fromSettingsMenu(mod.page, /^Moderation/);
    const entry = mod.page.getByTestId('moderation-collection').filter({ hasText: TITLE });
    // A moderator sees who sent it by name; addresses are for site admins.
    await expect(entry).toContainText('Cora Curator');
    await expect(entry).not.toContainText(CORA);
    // The review covers its text; each item is reviewed on its own.
    await expect(entry.getByTestId('review-new')).toContainText('Everything a small goods yard needs.');
    await expect(entry).toContainText('2 items');
    await entry.getByRole('button', { name: `Approve collection ${TITLE}` }).click();
    await expect(entry).toHaveCount(0);

    // Vic's open Catalog shows it, no reload; so does Cora's Mine.
    const card = vic.page.getByTestId('collection-card').filter({ hasText: TITLE });
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card).toContainText('2 modules · by Cora Curator');
    await expect(mine.getByTestId('collection-status')).toHaveText('Public', { timeout: 10000 });

    // Cora uploads her own cover: it waits for review while the old one stays up.
    await cora.page.getByRole('button', { name: `Edit ${TITLE}` }).click();
    const edit = cora.page.getByRole('dialog', { name: 'Edit collection' });
    await expect(edit.getByLabel('Title')).toHaveValue(TITLE);
    await edit.getByLabel('Upload your own picture').check();
    await edit.getByLabel('Cover picture').setInputFiles({ name: 'yard.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });
    await expect(edit.getByRole('button', { name: 'Remove custom picture' })).toBeVisible();
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(edit.getByRole('status')).toContainText('Sent for review');
    await edit.getByRole('button', { name: 'Done' }).click();
    await expect(card.locator('img')).not.toHaveAttribute('src', /\/cover\?/);
    await mod.page.reload();
    const change = mod.page.getByTestId('moderation-collection').filter({ hasText: TITLE });
    await expect(change).toContainText('Changed: cover');
    await expect(change.getByTestId('review-new').locator('img')).toHaveAttribute('src', /\/cover\?image=/);
    await change.getByRole('button', { name: `Approve collection ${TITLE}` }).click();
    await expect(card.locator('img')).toHaveAttribute('src', /\/cover\?image=.*size=small/, { timeout: 10000 });

    // Vic opens it, adds the shed by itself, then Add all: only the yard is new.
    await card.click();
    await expect(vic.page.getByRole('heading', { name: TITLE })).toBeVisible();
    await expect(vic.page.getByTestId('collection-item')).toHaveCount(2);
    await expect(vic.page.getByTestId('collection-item').first().getByTestId('catalog-preview')).toBeVisible();
    await vic.page.getByRole('button', { name: `Add Engine shed ${ts}` }).click();
    const one = vic.page.getByRole('dialog', { name: `Add Engine shed ${ts}` });
    await one.getByRole('button', { name: 'Add' }).click();
    await expect(one.getByRole('status')).toContainText('is now in your modules');
    await one.getByRole('button', { name: 'Done' }).click();
    await vic.page.getByRole('button', { name: 'Add all' }).click();
    const all = vic.page.getByRole('dialog', { name: `Add all of ${TITLE}` });
    await all.getByRole('button', { name: 'Add all' }).click();
    await expect(all.getByRole('status')).toContainText('Added 1 item · already had 1.');
    await all.getByRole('button', { name: 'Done' }).click();
    const vicModules = (await (await vic.page.request.get('/api/modules')).json()) as { modules: { title: string }[] };
    expect(vicModules.modules.map((m) => m.title).sort()).toEqual([`Engine shed ${ts}`, `Freight yard ${ts}`]);

    // Mo unpublishes the shed: it drops out of Vic's open page, and Cora is told.
    await streamOpen(vic.page);
    expect((await mod.page.request.post(`/api/moderation/items/${items[`Engine shed ${ts}`]}/unpublish`, { data: { reason: 'Copied' } })).ok()).toBe(true);
    await expect(vic.page.getByTestId('collection-item')).toHaveCount(1, { timeout: 10000 });
    await expect(vic.page.getByTestId('collection-item')).toContainText(`Freight yard ${ts}`);
    await expect(mine.getByRole('note')).toContainText(`“Engine shed ${ts}” was unpublished by a moderator`, { timeout: 10000 });
  } finally {
    await admin.page.request.patch('/api/admin/settings', { data: { moduleCatalogEnabled: false, catalogReview: 'moderators' } }).catch(() => undefined);
    for (const p of people) await p.ctx.close();
  }
});
