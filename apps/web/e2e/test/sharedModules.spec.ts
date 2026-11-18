// Read-only module sharing, end to end (docs/shared-modules.md), with two
// people in one layout:
//   - Alice shares her module with her club, from its Share dialog;
//   - Bob, a member, finds it under Shared with me and places it in the
//     club's layout: it arrives locked, with a link badge and "Shared by";
//   - changing its parts is refused with a plain reason (Edit module, a
//     part deleted), while moving it works;
//   - moved as a whole, its placement follows it;
//   - Alice saves a new version: Bob's layout says so without a reload, he
//     presses Update, and both Bob and Alice (who has the layout open too)
//     get the new parts once, where Bob moved the module to, the part that
//     didn't change keeping its id; Bob's undo of his move, made before the
//     update, takes the whole module back, and redo moves it again;
//   - a copy of the layout from its file, with a part laid over the module,
//     says after the update what the module overlaps; one whose module's
//     parts were changed outside the app offers Put back Alice's version;
//   - Go back puts the earlier version in again;
//   - copied and pasted in the club's layout it stays shared; pasted in
//     Bob's own layout it is an ordinary module, and he is told why;
//   - a module shared with Bob through the club can't go into his own
//     layout, and he is told whom to ask;
//   - the club's admin makes the placed copy the club's own, and takes
//     another member's module off the club's list.
// SHOTS=<dir> saves light and dark pictures along the way.

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { signIn, confirmInDialog } from '../helpers';

const ts = Date.now();
const ALICE = `shared-alice-${ts}@example.com`;
const BOB = `shared-bob-${ts}@example.com`;
const CAROL = `shared-carol-${ts}@example.com`;
const PART = 'ts_narrowgauge_straight.8';
const CLUB = `Riverside LUG ${ts % 100000}`;
const NAME = `Harbor crane ${ts % 100000}`;
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

/** Every part picture the map asked for has arrived (a second window may not be drawing frames, so no frame is waited for). */
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

interface Brick {
  id: string;
  x: number;
  y: number;
}

/** Every brick of the server's layout, from its .bbm export. */
async function serverBricks(page: Page, id: string): Promise<Brick[]> {
  const res = await page.request.get(`/api/layouts/${id}/export.bbm`);
  expect(res.ok()).toBe(true);
  const out: Brick[] = [];
  for (const m of (await res.text()).matchAll(/<Brick id="([^"]+)">([\s\S]*?)<\/Brick>/g)) {
    const field = (tag: string) => Number(new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(m[2]!)![1]);
    out.push({ id: m[1]!, x: field('X'), y: field('Y') });
  }
  return out;
}

const spots = (bricks: Brick[]) => bricks.map((b) => `${b.x.toFixed(2)},${b.y.toFixed(2)}`).sort();

/** The layout's modules, as its file's sidecar has them. */
async function sidecarModules(page: Page, id: string): Promise<{ id: string; shared?: { placement?: { x: number; y: number }; review?: unknown } }[]> {
  const r = await page.request.get(`/api/layouts/${id}/export.bbm.bld`);
  return r.ok() ? (((await r.json()) as { modules?: [] }).modules ?? []) : [];
}

/** The entries of a .bld-layout (a zip). */
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

test('a module shared with a club: placed locked, updated by its owner, for everyone in the layout', async ({ page, browser }) => {
  test.setTimeout(240_000);
  // Alice makes the module (one track) and a club with Bob in it.
  await signIn(page, ALICE, 'Alice');
  // Tall windows: four panels are open at once on the right.
  await page.setViewportSize({ width: 1400, height: 1200 });
  const bob = await (await browser.newContext({ viewport: { width: 1400, height: 1200 } })).newPage();
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
  await placePart(page);
  await expect.poll(() => brickCount(page)).toBe(1);
  await saveWithNote(page, 'One track');

  // She shares it with the club from its Share dialog.
  await page.goto('/');
  const row = page.getByTestId('module-row').filter({ hasText: NAME });
  await row.getByRole('button', { name: `More for ${NAME}` }).click();
  await page.getByRole('menuitem', { name: 'Share with people…' }).click();
  const share = page.getByRole('dialog', { name: `Share ${NAME}` });
  await expect(share.getByText('They can’t change its parts.').first()).toBeVisible();
  await share.getByTestId('module-club-pick').selectOption({ label: CLUB });
  await share.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(share.getByTestId('module-clubs')).toContainText(CLUB);
  await expect(share.getByTestId('module-clubs')).toContainText('can place it');
  await shot(page, 'share-dialog');
  await share.getByRole('button', { name: 'Close' }).click();

  // Bob opens a layout of the club's and finds it under Shared with me.
  const layout = await post(bob, '/api/layouts', { title: `Show plan ${ts}`, orgSlug: club.slug! });
  await bob.goto(`/editor/${layout.id}`);
  await expect(bob.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await openPanel(bob, 'Module library');
  await bob.getByTestId('module-library-tab-shared').click();
  const libRow = bob.getByTestId('module-library-row').filter({ hasText: NAME });
  await expect(libRow.getByTestId('module-shared-via')).toContainText(`Alice · via ${CLUB}`);
  await libRow.getByRole('button', { name: 'Add to layout' }).click();
  await expect.poll(() => brickCount(bob)).toBe(1);
  await expect(bob.getByText('Shared modules follow their owner’s updates.')).toBeVisible();

  // It is locked: the Modules panel says whose it is, and Edit module says why not.
  await openPanel(bob, 'Modules');
  await expect(bob.getByTestId('module-shared-note')).toContainText('Shared by Alice · v1');
  await picturesReady(bob);
  await shot(bob, 'placed-shared');
  await bob.getByTestId('module-more').click();
  await bob.getByTestId('module-menu-edit').click();
  await expect(bob.getByText(`“${NAME}” is shared by Alice, so its parts can’t be changed here.`)).toBeVisible();
  await shot(bob, 'locked-reason');
  await expect(bob.getByText('editing', { exact: true })).toHaveCount(0);

  // Moved as a whole (the Modules panel's Move…): its placement follows it.
  const placedBefore = (await sidecarModules(bob, layout.id!))[0]!.shared!.placement!;
  const firstBefore = (await serverBricks(bob, layout.id!))[0]!;
  await bob.getByTestId('module-more').click();
  await bob.getByRole('menuitem', { name: 'Move…' }).click();
  await bob.getByLabel('ΔX (studs)').fill('32');
  await bob.getByLabel('ΔY (studs)').fill('16');
  await bob.getByRole('button', { name: 'Move', exact: true }).click();
  await expect
    .poll(async () => {
      const p = (await sidecarModules(bob, layout.id!))[0]?.shared?.placement;
      return p ? [Math.round((p.x - placedBefore.x) * 1000) / 1000, Math.round((p.y - placedBefore.y) * 1000) / 1000] : null;
    }, { timeout: 15000 })
    .toEqual([32, 16]);

  // Alice has the club's layout open too, and saves a new version of her module in another tab.
  await page.goto(`/editor/${layout.id}`);
  await expect.poll(() => brickCount(page), { timeout: 20000 }).toBe(1);
  const editor = await page.context().newPage();
  await editor.goto(moduleUrl);
  await expect.poll(() => brickCount(editor), { timeout: 20000 }).toBe(1);
  await placePart(editor);
  await expect.poll(() => brickCount(editor)).toBe(2);
  await saveWithNote(editor, 'longer pier');
  await editor.close();

  // Bob's layout says so, without a reload.
  const notice = bob.getByTestId('shared-module-updates');
  await expect(notice).toContainText(`“${NAME}” has a new version from Alice (v2): “longer pier”.`, { timeout: 20000 });
  await expect(bob.getByTestId('module-shared-note')).toContainText('v2 is ready');
  await shot(bob, 'update-notice');
  await notice.getByRole('button', { name: 'Update', exact: true }).click();

  // Both people in the layout have the new version, once.
  await expect.poll(() => brickCount(bob), { timeout: 20000 }).toBe(2);
  await expect.poll(() => brickCount(page), { timeout: 20000 }).toBe(2);
  const updatedFirst = bob.getByTestId('shared-module-updated');
  await expect(updatedFirst).toContainText(`“${NAME}” is now version 2.`);
  await expect(page.getByTestId('shared-module-updated')).toContainText('is now version 2.');
  await expect(bob.getByTestId('module-shared-note')).toContainText('Shared by Alice · v2');
  await expect(bob.getByTestId('shared-module-updates')).toHaveCount(0);
  await picturesReady(bob);
  await shot(bob, 'updated-notice');
  // Where Bob moved it: its first track hasn't gone back.
  const updatedBricks = await serverBricks(bob, layout.id!);
  expect(updatedBricks.some((b) => Math.abs(b.x - (firstBefore.x + 32)) < 0.01 && Math.abs(b.y - (firstBefore.y + 16)) < 0.01)).toBe(true);
  // The update kept the part that didn't change: the same part, by its id (doc shape 5).
  expect(updatedBricks.map((b) => b.id)).toContain(firstBefore.id);
  // Bob's undo of his move, made before the update, takes the whole module back (the new part too),
  // and redo moves it all again: the module is never pulled apart.
  await bob.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await bob.keyboard.press('Control+z');
  const movedBack = spots(updatedBricks.map((b) => ({ ...b, x: b.x - 32, y: b.y - 16 })));
  await expect.poll(async () => spots(await serverBricks(bob, layout.id!)), { timeout: 15000 }).toEqual(movedBack);
  await bob.keyboard.press('Control+Shift+z');
  await expect.poll(async () => spots(await serverBricks(bob, layout.id!)), { timeout: 15000 }).toEqual(spots(updatedBricks));

  // The layout's file, opened as a new layout of the club's: once with a part laid over the
  // module (the update's notice says what it overlaps), once with the module's parts changed
  // outside the app (Put back Alice's version).
  const file = unzip(Buffer.from(await (await bob.request.get(`/api/layouts/${layout.id}/export.bld-layout`)).body()));
  const bbm = file.get('layout.bbm')!.toString('utf-8');
  const sidecarText = file.get('sidecar.json')!.toString('utf-8');
  const firstXml = /<Brick id="[^"]+">[\s\S]*?<\/Brick>/.exec(bbm)![0];
  const laidOver = firstXml.replace(/id="[^"]+"/, 'id="990001"').replace(/<Connexions[^>]*\/>|<Connexions[\s\S]*?<\/Connexions>/, '<Connexions count="0" />');
  const overLayout = await post(bob, '/api/layouts', { title: `Overlap ${ts}`, orgSlug: club.slug!, bbm: bbm.replace(firstXml, firstXml + laidOver), sidecar: sidecarText });
  await bob.goto(`/editor/${overLayout.id}`);
  await expect.poll(() => brickCount(bob), { timeout: 20000 }).toBe(3);
  await expect(bob.getByTestId('shared-module-updated')).toContainText(`“${NAME}” is now version 2. It overlaps 1 part.`, { timeout: 20000 });
  await openPanel(bob, 'Modules');
  await expect(bob.getByTestId('module-shared-note')).toContainText('Overlaps 1 part');
  await picturesReady(bob);
  await shot(bob, 'overlap-marks');

  const changed = firstXml.replace(/<X>([^<]*)<\/X>/, (_m, x: string) => `<X>${Number(x) + 3}</X>`);
  const unreviewed = JSON.parse(sidecarText) as { modules: { shared?: Record<string, unknown> }[] };
  for (const m of unreviewed.modules) delete m.shared?.review;
  const driftLayout = await post(bob, '/api/layouts', { title: `Changed ${ts}`, orgSlug: club.slug!, bbm: bbm.replace(firstXml, changed), sidecar: JSON.stringify(unreviewed) });
  expect(spots(await serverBricks(bob, driftLayout.id!))).not.toEqual(spots(updatedBricks));
  await bob.goto(`/editor/${driftLayout.id}`);
  const drift = bob.getByTestId('shared-module-drift');
  await expect(drift).toContainText(`“${NAME}” was changed outside the app`, { timeout: 20000 });
  await expect(drift).toContainText('Its parts aren’t Alice’s version 2 anymore');
  await expect(bob.getByTestId('module-shared-note')).toContainText('Changed outside the app');
  await picturesReady(bob);
  await shot(bob, 'changed-outside');
  await drift.getByRole('button', { name: 'Put back Alice’s version' }).click();
  await expect(drift).toHaveCount(0);
  await expect.poll(async () => spots(await serverBricks(bob, driftLayout.id!)), { timeout: 15000 }).toEqual(spots(updatedBricks));
  await expect(bob.getByTestId('module-shared-note')).not.toContainText('Changed outside the app');

  // Back to the club's layout.
  await bob.goto(`/editor/${layout.id}`);
  await expect.poll(() => brickCount(bob), { timeout: 20000 }).toBe(2);
  const updated = bob.getByTestId('shared-module-updated');

  // Go back puts version 1 in again, for both.
  await updated.getByRole('button', { name: 'Go back to version 1' }).click();
  await expect.poll(() => brickCount(bob), { timeout: 20000 }).toBe(1);
  await expect.poll(() => brickCount(page), { timeout: 20000 }).toBe(1);
  // OK puts the notice away for everyone.
  await bob.getByTestId('shared-module-updated').getByRole('button', { name: 'OK' }).click();
  await expect(bob.getByTestId('shared-module-updated')).toHaveCount(0);
  await expect(page.getByTestId('shared-module-updated')).toHaveCount(0, { timeout: 15000 });

  // Copied and pasted in the club's layout: another shared placement, following Alice too.
  await bob.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await bob.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await bob.keyboard.press('Control+a');
  await bob.keyboard.press('Control+c');
  await bob.mouse.move(500, 500);
  await bob.keyboard.press('Control+v');
  await expect.poll(() => brickCount(bob)).toBe(2);
  await expect(bob.getByTestId('module-shared-note')).toHaveCount(2);
  await expect(bob.getByTestId('module-shared-note').last()).toContainText('Shared by Alice · v1');

  // In Bob's own layout the club's share doesn't count: he is told whom to ask, and nothing is placed.
  const own = await post(bob, '/api/layouts', { title: `Bob at home ${ts}` });
  await bob.goto(`/editor/${own.id}`);
  await expect(bob.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await openPanel(bob, 'Module library');
  await bob.getByTestId('module-library-tab-shared').click();
  await bob.getByTestId('module-library-row').filter({ hasText: NAME }).getByRole('button', { name: 'Add to layout' }).click();
  const refused = bob.getByRole('alertdialog', { name: /can’t go in this layout yet/ });
  await expect(refused).toContainText('Ask Alice to share it with you too.');
  await shot(bob, 'cant-place');
  await refused.getByRole('button', { name: 'Close' }).click();
  expect(await brickCount(bob)).toBe(0);
  // Pasted here, the copy can't follow Alice: it is an ordinary module, and Bob is told why.
  await bob.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await bob.mouse.move(500, 500);
  await bob.keyboard.press('Control+v');
  await expect.poll(() => brickCount(bob)).toBe(1);
  await expect(bob.getByText(`“${NAME}” is shared by Alice, but not with this layout, so the pasted copy is an ordinary module`)).toBeVisible();
  await openPanel(bob, 'Modules');
  await expect(bob.getByTestId('module-shared-note')).toHaveCount(0);

  // The club's admin (Alice made the club) makes the placed copy the club's own: unlocked, no more updates.
  await openPanel(page, 'Modules');
  await expect(page.getByTestId('module-shared-note')).toHaveCount(2);
  await page.getByTestId('module-more').first().click();
  await page.getByTestId('module-menu-shared-detach').click();
  await confirmInDialog(page);
  await expect(page.getByText(`“${NAME}” is now a module of this layout.`)).toBeVisible();
  await expect(page.getByTestId('module-shared-note')).toHaveCount(1);

  // Carol, another member, shares a module of hers with the club; Alice, its admin, takes it off the club's list.
  const carol = await (await browser.newContext()).newPage();
  await signIn(carol, CAROL, 'Carol');
  const carolInvite = await post(page, `/api/orgs/${club.slug}/invites`, { email: CAROL, role: 'member' });
  await post(carol, `/api/org-invites/${carolInvite.token}`, {});
  const bridge = await post(carol, '/api/modules', { title: `Carol’s bridge ${ts % 100000}` });
  await post(carol, `/api/modules/${bridge.id}/club-shares`, { orgSlug: club.slug! });
  await openPanel(page, 'Module library');
  await page.getByTestId('module-library-tab-shared').click();
  const carolsRow = page.getByTestId('module-library-row').filter({ hasText: `Carol’s bridge ${ts % 100000}` });
  await expect(carolsRow.getByTestId('module-shared-via')).toContainText(`Carol · via ${CLUB}`);
  // Alice's own module isn't in her Shared with me, so it has no Remove.
  await expect(page.getByTestId('module-library-row').filter({ hasText: NAME })).toHaveCount(0);
  await shot(page, 'club-remove');
  await carolsRow.getByRole('button', { name: `Remove from ${CLUB}…` }).click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('The club’s layouts keep it as it is now.');
  await expect(page.getByTestId('confirm-dialog')).toContainText('Carol is told.');
  await confirmInDialog(page);
  await expect(page.getByText(`“Carol’s bridge ${ts % 100000}” is off ${CLUB}’s list.`)).toBeVisible();
  await expect(carolsRow).toHaveCount(0);
  // Bob, a plain member, has no Remove on a club share.
  await bob.goto(`/editor/${layout.id}`);
  await expect(bob.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await openPanel(bob, 'Module library');
  await bob.getByTestId('module-library-tab-shared').click();
  await expect(bob.getByTestId('module-library-row').filter({ hasText: NAME })).toHaveCount(1);
  await expect(bob.getByTestId('module-remove-club-share')).toHaveCount(0);
});
