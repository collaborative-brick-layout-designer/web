// Journey — author credit, and taking a module back from the club.
//
// Sam moves his module into ArkLUG (the dialog says the club will own it
// and he stays credited). Ada, ArkLUG's admin, sees it on her Home page as
// "by Sam · in ArkLUG", live. Sam takes it back from the ⋯ menu; ArkLUG
// keeps its own copy, credited to Sam ("based on Station by Sam"), Ada gets
// a note, and the club's layout is just as it was.

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { signIn } from '../../helpers';

const ts = Date.now();
test.setTimeout(180_000);

async function browserFor(browser: Browser, email: string, name: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, email, name);
  return { ctx, page };
}

const streamOpen = (page: Page) => expect(page.locator('html')).toHaveAttribute('data-live', 'open', { timeout: 15000 });

test('a module moves to the club with its author credited, Sam takes it back, and the club keeps a copy', async ({ browser }) => {
  const ada = await browserFor(browser, `j-own-ada-${ts}@example.com`, 'Ada');
  const sam = await browserFor(browser, `j-own-sam-${ts}@example.com`, 'Sam');
  try {
    const CLUB = `ArkLUG ${ts}`;
    const MODULE = `Station ${ts}`;
    const club = (await (await ada.page.request.post('/api/orgs', { data: { name: CLUB } })).json()) as { slug: string };
    expect((await ada.page.request.patch(`/api/orgs/${club.slug}`, { data: { joinPolicy: 'open', listed: true } })).ok()).toBe(true);
    expect((await sam.page.request.post(`/api/orgs/${club.slug}/join`, { data: {} })).ok()).toBe(true);
    expect((await sam.page.request.post('/api/modules', { data: { title: MODULE } })).ok()).toBe(true);
    // The club's layout, to check it doesn't change.
    const layout = (await (await ada.page.request.post('/api/layouts', { data: { title: `Show ${ts}`, orgSlug: club.slug } })).json()) as { id: string };
    const bbmBefore = await (await ada.page.request.get(`/api/layouts/${layout.id}/export.bbm`)).text();

    for (const p of [ada.page, sam.page]) {
      await p.goto('/');
      await streamOpen(p);
    }

    // Sam moves it into the club: one click, after the dialog says what that means.
    const samRow = sam.page.getByTestId('module-row').filter({ hasText: MODULE });
    await samRow.getByRole('button', { name: `More for ${MODULE}` }).click();
    await sam.page.getByRole('menuitem', { name: 'Move or copy…' }).click();
    await sam.page.getByLabel(/Move to a club/).check();
    await sam.page.getByRole('button', { name: 'Move', exact: true }).click();
    const dialog = sam.page.getByTestId('confirm-dialog');
    await expect(dialog.getByRole('heading')).toHaveText(`Move it to ${CLUB}?`);
    await expect(dialog).toContainText(`${CLUB} will own this. Members with the Delete club items permission can rename, share or delete it.`);
    await expect(dialog).toContainText('You stay credited as the author, and you can take it back while you’re a member.');
    await dialog.getByRole('button', { name: 'Move' }).click();

    // Ada sees it, credited to Sam, without a reload.
    const adaRow = ada.page.getByTestId('module-row').filter({ hasText: MODULE });
    await expect(adaRow.getByTestId('credit')).toHaveText(`by Sam · in ${CLUB}`, { timeout: 15000 });
    await expect(samRow.getByTestId('credit')).toHaveText(`by you · in ${CLUB}`, { timeout: 15000 });

    // Sam takes it back.
    await samRow.getByRole('button', { name: `More for ${MODULE}` }).click();
    await sam.page.getByRole('menuitem', { name: 'Take back to mine' }).click();
    await expect(dialog.getByRole('heading')).toHaveText(`Take “${MODULE}” back?`);
    await expect(dialog).toContainText(`${CLUB} keeps its own copy, credited to you`);
    await dialog.getByRole('button', { name: 'Take back' }).click();
    await expect(sam.page.getByTestId('toast')).toContainText(`“${MODULE}” is yours again`);

    // Sam has the original, his own; the club's copy is credited to him.
    const samRows = sam.page.getByTestId('module-row').filter({ hasText: MODULE });
    await expect(samRows).toHaveCount(2, { timeout: 15000 });
    await expect(samRows.filter({ has: sam.page.getByTestId('owner-chip').filter({ hasText: 'Me' }) }).getByTestId('credit')).toHaveText('by you');
    // Ada: only the club's copy, live, credited to Sam and based on his original.
    await expect(adaRow).toHaveCount(1, { timeout: 15000 });
    await expect(adaRow.getByTestId('credit')).toHaveText(`by Sam · in ${CLUB} · based on ${MODULE} by Sam`, { timeout: 15000 });
    // …and a note about it.
    await expect(ada.page.getByTestId('notification-badge')).toHaveText('1', { timeout: 15000 });
    await ada.page.getByTestId('notification-bell').click();
    const note = ada.page.getByTestId('notification-panel').getByTestId('notification-item').first();
    await expect(note).toContainText(CLUB);
    await expect(note).toContainText(`Sam took back the module “${MODULE}”`);

    // The club's layout is just as it was.
    expect(await (await ada.page.request.get(`/api/layouts/${layout.id}/export.bbm`)).text()).toBe(bbmBefore);
  } finally {
    await ada.ctx.close();
    await sam.ctx.close();
  }
});
