// Journey — club and private collections, and "Add to a collection…".
//
// A club's private collection:
//   1. Out shares a module and a part to the catalog; a moderator approves them.
//   2. Ada runs ArkLUG; Mel is a member with the club page open.
//   3. Ada makes "ArkLUG show standards" from the club page: the club's own
//      module, the catalog module and (with the Parts filter) the catalog part.
//      It's private: only ArkLUG members. Mel's page shows it, live.
//   4. Mel opens it and uses Add all: the module, the catalog module and the
//      part all come to him. Out, outside the club, can't see it.
//   5. Ada pins it (live for Mel). A site moderator removes it from
//      Moderation (abuse); Mel's open page loses it, live.
//
// Your own collection, made public:
//   1. Cora puts her own module in a new private collection from Home
//      (⋯ › Add to a collection… › New collection with this), then a catalog
//      module from its catalog card: a note says so, with Open collection.
//   2. Home shows it under Collections. Nothing went for review.
//   3. She makes it public: its text goes for review, and her module goes
//      for its own review ("Waiting for review" on its row).
//   4. A moderator approves the text: Vic sees it with only the catalog
//      module. The moderator approves her module: it shows up on Vic's open
//      page, live. A new title waits for review, shown old beside new.

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { signIn, fromSettingsMenu, confirmInDialog } from '../../helpers';
import { makeGlobalAdmin, siteSettingsAtDefaults } from '../../dbHelpers';

siteSettingsAtDefaults();

const ts = Date.now();
test.setTimeout(240_000);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const XML = Buffer.from('<?xml version="1.0"?><part><Author>e2e</Author></part>').toString('base64');

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

/** The site's settings, a moderator, and a public module and part shared by `out`. */
async function setUp(admin: Person, mod: Person, out: Person, tag: string): Promise<{ yard: string; signal: string }> {
  expect((await admin.page.request.patch('/api/admin/settings', { data: { moduleCatalogEnabled: true, partsCatalogEnabled: true, catalogReview: 'moderators' } })).ok()).toBe(true);
  expect((await admin.page.request.patch(`/api/admin/users/${await idOf(mod)}`, { data: { isModerator: true } })).ok()).toBe(true);
  const m = (await (await out.page.request.post('/api/modules', { data: { title: `Freight yard ${tag}` } })).json()) as { id: string };
  expect((await out.page.request.put(`/api/modules/${m.id}/thumbnail`, { data: { mime: 'image/png', data: PNG } })).ok()).toBe(true);
  const yard = ((await (await out.page.request.post('/api/catalog/submissions', { data: { kind: 'module', sourceId: m.id, title: `Freight yard ${tag}` } })).json()) as { id: string }).id;
  const part = await out.page.request.post('/api/custom-parts', {
    data: { partNumber: `SIG${tag}`, displayName: `Home signal ${tag}`, xmlBase64: XML, spriteBase64: PNG, spriteMime: 'image/png' },
  });
  const partId = ((await part.json()) as { id: string }).id;
  const signal = ((await (await out.page.request.post('/api/catalog/submissions', { data: { kind: 'part', sourceId: partId, title: `Home signal ${tag}` } })).json()) as { id: string }).id;
  const queue = ((await (await mod.page.request.get('/api/moderation/items')).json()) as { queue: { versionId: string; itemId: string }[] }).queue;
  for (const q of queue.filter((x) => x.itemId === yard || x.itemId === signal)) {
    expect((await mod.page.request.post(`/api/moderation/versions/${q.versionId}/approve`, { data: {} })).ok()).toBe(true);
  }
  return { yard, signal };
}

test('a club’s private collection: members see it live and Add all, outsiders don’t, and a moderator can remove it', async ({ browser }) => {
  const tag = `${ts}a`;
  const admin = await person(browser, `j-cc-admin-${tag}@example.com`, 'Site Admin');
  makeGlobalAdmin(`j-cc-admin-${tag}@example.com`);
  const mod = await person(browser, `j-cc-mod-${tag}@example.com`, 'Mo Derator');
  const out = await person(browser, `j-cc-out-${tag}@example.com`, 'Out Sider');
  const ada = await person(browser, `j-cc-ada-${tag}@example.com`, 'Ada Admin');
  const mel = await person(browser, `j-cc-mel-${tag}@example.com`, 'Mel Member');
  const people = [admin, mod, out, ada, mel];
  const TITLE = `ArkLUG show standards ${tag}`;
  try {
    await setUp(admin, mod, out, tag);
    const club = (await (await ada.page.request.post('/api/orgs', { data: { name: `ArkLUG ${tag}` } })).json()) as { slug: string };
    expect((await ada.page.request.patch(`/api/orgs/${club.slug}`, { data: { joinPolicy: 'open', listed: true } })).ok()).toBe(true);
    expect((await mel.page.request.post(`/api/orgs/${club.slug}/join`, { data: {} })).ok()).toBe(true);
    const corner = (await (await ada.page.request.post('/api/modules', { data: { title: `Show corner ${tag}`, orgSlug: club.slug } })).json()) as { id: string };
    expect((await ada.page.request.put(`/api/modules/${corner.id}/thumbnail`, { data: { mime: 'image/png', data: PNG } })).ok()).toBe(true);

    // Mel has the club page open: no collections yet, and no New collection for him.
    await mel.page.goto(`/orgs/${club.slug}`);
    const melSection = mel.page.getByRole('region', { name: 'Collections' });
    await expect(melSection.getByText('No collections yet.')).toBeVisible();
    await expect(melSection.getByRole('button', { name: /New collection/ })).toHaveCount(0);
    await streamOpen(mel.page);

    // Ada makes it from the club page: private to the club.
    await ada.page.goto(`/orgs/${club.slug}`);
    await ada.page.getByRole('button', { name: `New collection for ArkLUG ${tag}` }).click();
    const editor = ada.page.getByRole('dialog', { name: 'New collection' });
    await editor.getByLabel('Title').fill(TITLE);
    await expect(editor.getByLabel(`Only ArkLUG ${tag} members`)).toBeChecked();
    const own = editor.getByRole('list', { name: `ArkLUG ${tag}’s modules and parts` });
    await own.getByRole('button', { name: `Put Show corner ${tag} in the collection` }).click();
    await editor.getByLabel('Find modules and parts').fill(tag);
    await editor.getByRole('list', { name: 'Catalog items to add' }).getByRole('button', { name: `Put Freight yard ${tag} in the collection` }).click();
    // The Parts filter shows the catalog's parts only.
    await editor.getByLabel('Show modules or parts').selectOption('part');
    await expect(editor.getByRole('button', { name: `Put Freight yard ${tag} in the collection` })).toHaveCount(0);
    await editor.getByRole('button', { name: `Put Home signal ${tag} in the collection` }).click();
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor.getByRole('status')).toHaveText(`Saved. Only ArkLUG ${tag} members can see it.`);
    await editor.getByRole('button', { name: 'Done' }).click();

    // Mel's open page shows it, no reload: 2 modules and a part, private.
    const card = melSection.getByTestId('club-collection-card').filter({ hasText: TITLE });
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.getByTestId('collection-counts')).toHaveText(`2 modules · 1 part · by ArkLUG ${tag}`);
    await expect(card).toContainText('Private');
    // Nothing went for review: no catalog item for the club's module.
    expect(((await (await mod.page.request.get('/api/moderation/collections')).json()) as { queue: unknown[] }).queue).toEqual([]);
    const items = ((await (await mod.page.request.get('/api/moderation/items')).json()) as { queue: { title: string }[] }).queue;
    expect(items.map((q) => q.title)).not.toContain(`Show corner ${tag}`);

    // Mel opens it and adds it all to his own things: module, catalog module and part.
    await card.click();
    await expect(mel.page.getByRole('heading', { name: TITLE })).toBeVisible();
    await expect(mel.page.getByTestId('collection-audience')).toHaveText(`Who can see this: Only ArkLUG ${tag} members`);
    await expect(mel.page.getByTestId('collection-item')).toHaveCount(3);
    await mel.page.getByRole('button', { name: 'Add all' }).click();
    const all = mel.page.getByRole('dialog', { name: `Add all of ${TITLE}` });
    await expect(all).toContainText('2 modules · 1 part');
    await all.getByRole('button', { name: 'Add all' }).click();
    await expect(all.getByRole('status')).toContainText('Added 3 items.');
    await all.getByRole('button', { name: 'Done' }).click();
    const melModules = ((await (await mel.page.request.get('/api/modules?owner=me')).json()) as { modules: { title: string }[] }).modules.map((m) => m.title);
    expect(melModules.sort()).toEqual([`Freight yard ${tag}`, `Show corner ${tag}`]);
    const melParts = ((await (await mel.page.request.get('/api/custom-parts')).json()) as { parts: { displayName: string; ownerOrgId: string | null }[] }).parts;
    expect(melParts.filter((p) => !p.ownerOrgId).map((p) => p.displayName)).toEqual([`Home signal ${tag}`]);
    const url = mel.page.url();

    // Out, outside the club, can't see it.
    await out.page.goto(url);
    await expect(out.page.getByText('This collection isn’t in the catalog, or you can’t see it.')).toBeVisible();

    // Ada pins it: Mel's club page shows it, live.
    await mel.page.goto(`/orgs/${club.slug}`);
    await streamOpen(mel.page);
    await ada.page.goto(url);
    await ada.page.getByRole('button', { name: 'Pin to the top' }).click();
    await expect(ada.page.getByRole('button', { name: 'Unpin' })).toBeVisible();
    await expect(card).toContainText('Pinned', { timeout: 10000 });

    // A site moderator removes it (abuse handling): gone from Mel's open page, live.
    await mel.page.goto(url);
    await streamOpen(mel.page);
    await mod.page.goto('/');
    await fromSettingsMenu(mod.page, /^Moderation/);
    await mod.page.getByRole('tab', { name: /^Collections/ }).click();
    const row = mod.page.getByTestId('moderated-club-collection').filter({ hasText: TITLE });
    await expect(row).toContainText(`ArkLUG ${tag}`);
    await row.getByRole('button', { name: `Remove collection ${TITLE}` }).click();
    await confirmInDialog(mod.page, { reason: 'Spam' });
    await expect(row).toHaveCount(0);
    await expect(mel.page.getByText('This collection isn’t in the catalog, or you can’t see it.')).toBeVisible({ timeout: 10000 });
  } finally {
    await admin.page.request.patch('/api/admin/settings', { data: { moduleCatalogEnabled: false, partsCatalogEnabled: false, catalogReview: 'moderators' } }).catch(() => undefined);
    for (const p of people) await p.ctx.close();
  }
});

test('Add to a collection… from Home and the Catalog; made public, its text and its own module are reviewed apart', async ({ browser }) => {
  const tag = `${ts}b`;
  const admin = await person(browser, `j-cc-admin-${tag}@example.com`, 'Site Admin');
  makeGlobalAdmin(`j-cc-admin-${tag}@example.com`);
  const mod = await person(browser, `j-cc-mod-${tag}@example.com`, 'Mo Derator');
  const out = await person(browser, `j-cc-out-${tag}@example.com`, 'Out Sider');
  const cora = await person(browser, `j-cc-cora-${tag}@example.com`, 'Cora Curator');
  const vic = await person(browser, `j-cc-vic-${tag}@example.com`, 'Vic Viewer');
  const people = [admin, mod, out, cora, vic];
  const TITLE = `Bridges ${tag}`;
  try {
    await setUp(admin, mod, out, tag);
    const bridge = (await (await cora.page.request.post('/api/modules', { data: { title: `My bridge ${tag}` } })).json()) as { id: string };
    expect((await cora.page.request.put(`/api/modules/${bridge.id}/thumbnail`, { data: { mime: 'image/png', data: PNG } })).ok()).toBe(true);

    // Home › her module's ⋯ › Add to a collection… › New collection with this.
    await cora.page.goto('/');
    const moduleRow = cora.page.getByTestId('module-row').filter({ hasText: `My bridge ${tag}` });
    await moduleRow.getByRole('button', { name: `More for My bridge ${tag}` }).click();
    await cora.page.getByRole('menuitem', { name: 'Add to a collection…' }).click();
    const picker = cora.page.getByRole('dialog', { name: 'Add to a collection' });
    await expect(picker).toContainText('You have no collections it can go in yet.');
    await picker.getByRole('button', { name: 'New collection with this' }).click();
    const editor = cora.page.getByRole('dialog', { name: 'New collection' });
    await expect(editor.getByRole('list', { name: 'Items in the collection' })).toContainText(`My bridge ${tag}`);
    await editor.getByLabel('Title').fill(TITLE);
    // Nothing matches: it says why, and how to share one.
    await editor.getByLabel('Find modules and parts').fill(`nothing-${tag}`);
    await expect(editor.getByTestId('picker-empty')).toContainText('it has to be shared to the catalog first');
    await expect(editor.getByRole('link', { name: 'How to share a module or part' })).toHaveAttribute('href', '/help#catalog');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor.getByRole('status')).toHaveText('Saved. Only you can see it.');
    await editor.getByRole('button', { name: 'Done' }).click();

    // Home's Collections shows it under Yours.
    await expect(cora.page.getByTestId('home-my-collection').filter({ hasText: TITLE })).toBeVisible({ timeout: 10000 });

    // A catalog module, from its card in the Catalog: the note links to the collection.
    await cora.page.goto('/catalog?kind=collections');
    await expect(cora.page.getByRole('heading', { name: /Your collections/ })).toBeVisible();
    await cora.page.getByRole('tab', { name: 'Modules' }).click();
    const catalogCard = cora.page.getByTestId('catalog-item').filter({ hasText: `Freight yard ${tag}` });
    await catalogCard.getByRole('button', { name: `Freight yard ${tag}: add to a collection` }).click();
    await cora.page.getByRole('dialog', { name: 'Add to a collection' }).getByRole('button', { name: `Add to ${TITLE}` }).click();
    const toast = cora.page.getByTestId('collection-toast');
    await expect(toast).toContainText(`Added “Freight yard ${tag}” to “${TITLE}”.`);
    await toast.getByRole('link', { name: 'Open collection' }).click();
    await expect(cora.page.getByRole('heading', { name: TITLE })).toBeVisible();
    await expect(cora.page.getByTestId('collection-item')).toHaveCount(2);
    await expect(cora.page.getByTestId('collection-audience')).toHaveText('Who can see this: Only you');
    // A private collection: nothing went for review, and nobody else can open it.
    expect(((await (await mod.page.request.get('/api/moderation/collections')).json()) as { queue: unknown[] }).queue).toEqual([]);
    const collectionUrl = cora.page.url();
    await vic.page.goto(collectionUrl);
    await expect(vic.page.getByText('This collection isn’t in the catalog, or you can’t see it.')).toBeVisible();

    // Made public: its text goes for review, and her module for its own.
    await cora.page.getByRole('button', { name: 'Edit' }).click();
    const edit = cora.page.getByRole('dialog', { name: 'Edit collection' });
    await edit.getByLabel('Everyone (reviewed first)').check();
    await expect(edit).toContainText('Your own modules and parts in it are shared to the catalog');
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(edit.getByRole('status')).toContainText('Sent for review');
    await expect(edit.getByRole('status')).toContainText('One of your own items was shared to the catalog for review');
    await edit.getByRole('button', { name: 'Done' }).click();
    const bridgeRow = cora.page.getByTestId('collection-item').filter({ hasText: `My bridge ${tag}` });
    await expect(bridgeRow.getByTestId('item-review')).toHaveText('Waiting for review');

    // The moderator approves the text: Vic sees it with the catalog module only.
    await mod.page.goto('/');
    await fromSettingsMenu(mod.page, /^Moderation/);
    const entry = mod.page.getByTestId('moderation-collection').filter({ hasText: TITLE });
    await expect(entry.getByTestId('review-new')).toContainText(TITLE);
    await expect(entry.getByTestId('review-old')).toHaveCount(0);
    await entry.getByRole('button', { name: `Approve collection ${TITLE}` }).click();
    await expect(entry).toHaveCount(0);
    await vic.page.goto(collectionUrl);
    await expect(vic.page.getByTestId('collection-item')).toHaveCount(1);
    await expect(vic.page.getByTestId('collection-item')).toContainText(`Freight yard ${tag}`);
    await streamOpen(vic.page);

    // Her module, approved on its own, shows up on Vic's open page, live.
    await mod.page.getByRole('button', { name: `Approve My bridge ${tag}` }).click();
    await expect(vic.page.getByTestId('collection-item')).toHaveCount(2, { timeout: 10000 });
    await expect(bridgeRow.getByTestId('item-review')).toHaveCount(0, { timeout: 10000 });

    // A new title waits; the moderator sees the old one beside it.
    await cora.page.getByRole('button', { name: 'Edit' }).click();
    await edit.getByLabel('Title').fill(`${TITLE} and more`);
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(edit.getByRole('status')).toContainText('Sent for review');
    await edit.getByRole('button', { name: 'Done' }).click();
    const change = mod.page.getByTestId('moderation-collection').filter({ hasText: `${TITLE} and more` });
    await expect(change.getByTestId('review-old')).toContainText(TITLE, { timeout: 10000 });
    await expect(change.getByTestId('review-new')).toContainText(`${TITLE} and more`);
    await expect(change).toContainText('Changed: title.');
    await expect(vic.page.getByRole('heading', { name: TITLE, exact: true })).toBeVisible();
  } finally {
    await admin.page.request.patch('/api/admin/settings', { data: { moduleCatalogEnabled: false, partsCatalogEnabled: false, catalogReview: 'moderators' } }).catch(() => undefined);
    for (const p of people) await p.ctx.close();
  }
});
