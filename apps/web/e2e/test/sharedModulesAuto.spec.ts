// Shared modules, phase 2, end to end (docs/shared-modules.md):
//   - Bob sets one of the club's layouts to take Alice's updates
//     Automatically (Map › Modules & sets › Updates from shared modules…);
//     another stays Ask first;
//   - with both open in Bob's browser, Alice saves a new version: the
//     Automatically layout changes with no reload and nothing pressed, and
//     says "is now version 2"; the Ask first one shows the update notice;
//   - the home page's list badges the Ask first layout ("1 update"), and
//     the club's page counts it, without a reload;
//   - Bob leaves; Alice saves again while nobody has the layout open: the
//     server puts the version in, and when Bob opens it, "Updated while
//     you were away" says what changed, and Go back puts version 2 back.
// SHOTS=<dir> saves light and dark pictures along the way.

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { mapMenu, signIn } from '../helpers';

const ts = Date.now();
const ALICE = `auto-alice-${ts}@example.com`;
const BOB = `auto-bob-${ts}@example.com`;
const PART = 'ts_narrowgauge_straight.8';
const CLUB = `Harbor LUG ${ts % 100000}`;
const NAME = `Pier ${ts % 100000}`;
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

async function picturesReady(page: Page): Promise<void> {
  await expect(page.getByTestId('part-pictures')).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
}

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}

async function post(page: Page, url: string, data: object) {
  const res = await page.request.post(url, { data });
  expect(res.ok(), `${url}: ${res.status()} ${await res.text()}`).toBe(true);
  return res.json() as Promise<Record<string, string>>;
}

async function placePart(page: Page): Promise<void> {
  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
}

async function saveWithNote(page: Page, note: string): Promise<void> {
  await page.getByLabel('What changed (optional)').fill(note);
  await page.getByRole('button', { name: 'Save module' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
}

/** How many parts the server's copy of the layout has (its .bbm export: the stored doc, or the open room's). */
async function serverBrickCount(page: Page, id: string): Promise<number> {
  const res = await page.request.get(`/api/layouts/${id}/export.bbm`);
  expect(res.ok()).toBe(true);
  return [...(await res.text()).matchAll(/<Brick id="/g)].length;
}

function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const out = new Map<string, Buffer>();
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = buf.readUInt16LE(eocd + 10); i > 0; i--) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf-8', p + 46, p + 46 + nameLen);
    const local = buf.readUInt32LE(p + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

async function openPanel(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel(label, { exact: true }).check();
  await page.mouse.click(400, 400);
}

/** Alice saves a new version of her module, from its own editor in another tab. */
async function aliceSaves(page: Page, moduleUrl: string, parts: number, note: string): Promise<void> {
  const editor = await page.context().newPage();
  await editor.goto(moduleUrl);
  await expect.poll(() => brickCount(editor), { timeout: 20000 }).toBe(parts - 1);
  await placePart(editor);
  await expect.poll(() => brickCount(editor)).toBe(parts);
  await saveWithNote(editor, note);
  await editor.close();
}

test('Automatically and Ask first layouts, the list badges, and "Updated while you were away"', async ({ page, browser }) => {
  test.setTimeout(300_000);
  // Alice makes the module (one track) and shares it with her club, which Bob is in.
  await signIn(page, ALICE, 'Alice');
  await page.setViewportSize({ width: 1400, height: 1000 });
  const bobContext = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const bob = await bobContext.newPage();
  await signIn(bob, BOB, 'Bob');
  const club = await post(page, '/api/orgs', { name: CLUB });
  const invite = await post(page, `/api/orgs/${club.slug}/invites`, { email: BOB, role: 'member' });
  await post(bob, `/api/org-invites/${invite.token}`, {});

  await page.goto('/');
  await page.getByRole('button', { name: 'New module' }).click();
  const made = page.getByRole('dialog', { name: 'New module' });
  await made.getByLabel('Title').fill(NAME);
  await made.getByRole('button', { name: 'Create and open' }).click();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  const moduleUrl = page.url();
  const moduleId = moduleUrl.split('/').pop()!.split('?')[0]!;
  await placePart(page);
  await expect.poll(() => brickCount(page)).toBe(1);
  await saveWithNote(page, 'One track');
  await post(page, `/api/modules/${moduleId}/club-shares`, { orgSlug: club.slug! });

  // Bob places it in a layout of the club's; a second layout of the club's is made from its file.
  const auto = await post(bob, '/api/layouts', { title: `Auto plan ${ts}`, orgSlug: club.slug! });
  await bob.goto(`/editor/${auto.id}`);
  await expect(bob.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await openPanel(bob, 'Module library');
  await bob.getByTestId('module-library-tab-shared').click();
  await bob.getByTestId('module-library-row').filter({ hasText: NAME }).getByRole('button', { name: 'Add to layout' }).click();
  await expect.poll(() => brickCount(bob)).toBe(1);
  await expect.poll(() => serverBrickCount(bob, auto.id!), { timeout: 15000 }).toBe(1);
  const file = unzip(Buffer.from(await (await bob.request.get(`/api/layouts/${auto.id}/export.bld-layout`)).body()));
  const ask = await post(bob, '/api/layouts', {
    title: `Ask plan ${ts}`,
    orgSlug: club.slug!,
    bbm: file.get('layout.bbm')!.toString('utf-8'),
    sidecar: file.get('sidecar.json')!.toString('utf-8'),
  });

  // The setting: Ask first to begin with; Bob picks Automatically for the first layout.
  await mapMenu(bob, 'Modules & sets', 'Updates from shared modules…');
  const dialog = bob.getByRole('dialog', { name: 'Updates from shared modules' });
  await expect(dialog.getByRole('radio', { name: /Ask first/ })).toBeChecked();
  await shot(bob, 'setting-ask');
  await dialog.getByRole('radio', { name: /Automatically/ }).check();
  await expect(bob.getByText('New versions of shared modules now go in automatically.')).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Automatically/ })).toBeChecked();
  await shot(bob, 'setting-auto');
  await dialog.getByRole('button', { name: 'Done' }).click();
  expect(((await (await bob.request.get(`/api/layouts/${auto.id}`)).json()) as { layout: { sharedModuleUpdates: string } }).layout.sharedModuleUpdates).toBe('auto');

  // Both layouts open in Bob's browser; Alice saves version 2.
  const askPage = await bobContext.newPage();
  await askPage.goto(`/editor/${ask.id}`);
  await expect.poll(() => brickCount(askPage), { timeout: 20000 }).toBe(1);
  await aliceSaves(page, moduleUrl, 2, 'longer pier');

  // Automatically: it changes by itself, with no reload, and says so.
  await expect.poll(() => brickCount(bob), { timeout: 30000 }).toBe(2);
  await expect(bob.getByTestId('shared-module-updated')).toContainText(`“${NAME}” is now version 2.`);
  await expect(bob.getByTestId('shared-module-updates')).toHaveCount(0);
  await picturesReady(bob);
  await shot(bob, 'auto-updated');
  // Ask first: the notice, and nothing changed.
  await expect(askPage.getByTestId('shared-module-updates')).toContainText(`“${NAME}” has a new version from Alice (v2): “longer pier”.`, { timeout: 30000 });
  expect(await brickCount(askPage)).toBe(1);
  await askPage.close();

  // Home: the Ask first layout has "1 update", the Automatically one none; the club's page counts it.
  await bob.goto('/');
  const askRow = bob.locator('li').filter({ hasText: `Ask plan ${ts}` });
  await expect(askRow.getByTestId('shared-updates-badge')).toHaveText(/1 update/);
  await expect(bob.locator('li').filter({ hasText: `Auto plan ${ts}` }).getByTestId('shared-updates-badge')).toHaveCount(0);
  await shot(bob, 'home-badge');
  // Live: Alice saves version 3 while Bob looks at the list (and nobody has the Automatically layout open).
  await aliceSaves(page, moduleUrl, 3, 'a crane');
  await expect(askRow.getByTestId('shared-updates-badge')).toHaveText(/1 update/);
  await bob.goto(`/orgs/${club.slug}`);
  await expect(bob.getByTestId('club-shared-updates')).toHaveText('1 has updates');

  // The Automatically layout got version 3 with nobody in it.
  await expect.poll(() => serverBrickCount(bob, auto.id!), { timeout: 30000 }).toBe(3);

  if (SHOTS) writeFileSync(join(SHOTS, 'world.json'), JSON.stringify({ bob: BOB, alice: ALICE, auto: auto.id, ask: ask.id, club: club.slug, moduleUrl }));
  // Bob opens it: what changed while he was away, with Go back.
  await bob.goto(`/editor/${auto.id}`);
  await expect.poll(() => brickCount(bob), { timeout: 20000 }).toBe(3);
  const away = bob.getByTestId('shared-module-away');
  await expect(away).toContainText('Updated while you were away');
  await expect(away).toContainText(`“${NAME}” went from version 2 to 3: this layout takes Alice’s updates automatically.`);
  // Not said twice.
  await expect(bob.getByTestId('shared-module-updated')).toHaveCount(0);
  await picturesReady(bob);
  await shot(bob, 'away');
  await away.getByRole('button', { name: 'Go back to version 2' }).click();
  await expect.poll(() => brickCount(bob), { timeout: 20000 }).toBe(2);
  await expect(away).toHaveCount(0);

  // Opened again: said once only.
  await bob.reload();
  await expect.poll(() => brickCount(bob), { timeout: 20000 }).toBe(2);
  await bob.waitForTimeout(1500);
  await expect(bob.getByTestId('shared-module-away')).toHaveCount(0);
});
