// What the editor says when live editing goes sideways (full review area 4):
//   - Bug 7: Undo after someone else moved the same part did nothing, said
//     nothing and stayed lit;
//   - Unclear UI 1: lowered to view only, the tools went with no word why;
//   - Unclear UI 3: an offline change someone else's replaced vanished;
//   - Unclear UI 4: offline, the pill said "Reconnecting…" forever.

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn } from '../helpers';

const FORDYCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures/fordyce-2026.bbm'), 'utf-8');
function twoParts(): string {
  const xml = [0, 40]
    .map(
      (x, i) =>
        `<Brick id="${700 + i}"><DisplayArea><X>${x}</X><Y>0</Y><Width>16</Width><Height>8</Height></DisplayArea>` +
        '<MyGroup /><PartNumber>2867.8</PartNumber><Orientation>0</Orientation>' +
        '<ActiveConnectionPointIndex>0</ActiveConnectionPointIndex><Altitude>0</Altitude><Connexions count="0" /></Brick>',
    )
    .join('');
  const first = /<Layer type="brick"[\s\S]*?<\/Layer>/.exec(FORDYCE)![0];
  const layer = first.replace(/<Bricks>[\s\S]*<\/Bricks>/, `<Bricks>${xml}</Bricks>`);
  return FORDYCE.replace(/<Layer type="(brick|ruler|text)"[\s\S]*?<\/Layer>/g, '').replace(/(<Layers[^>]*>)/, `$1${layer}`);
}

const ts = Date.now();

/** The parts as drawn: id and where on screen. */
function shown(page: Page): Promise<{ id: string; sx: number; sy: number }[]> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string; getAbsolutePosition: () => { x: number; y: number } };
    const st = (window as unknown as { Konva?: { stages: { container: () => HTMLElement; find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    if (!st) return [];
    const box = st.container().getBoundingClientRect();
    return st
      .find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-'))
      .map((n) => {
        const a = n.getAbsolutePosition();
        return { id: n.name().slice(6), sx: box.left + a.x, sy: box.top + a.y };
      });
  });
}

/** Bob's live connection, which the test can take down (the Wi-Fi drops) and bring back. */
async function droppable(page: Page): Promise<{ down: () => void; up: () => void }> {
  let isDown = false;
  const open = new Set<{ close: () => void }>();
  await page.routeWebSocket(/\/ws\/layout\//, (ws) => {
    if (isDown) {
      void ws.close({ code: 1001 });
      return;
    }
    const server = ws.connectToServer();
    const pair = { close: () => void ws.close({ code: 1001 }) };
    open.add(pair);
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
    ws.onClose(() => {
      open.delete(pair);
      void server.close();
    });
    server.onClose((code, reason) => void ws.close({ code, reason }));
  });
  return {
    down: () => {
      isDown = true;
      for (const p of [...open]) p.close();
    },
    up: () => {
      isDown = false;
    },
  };
}

async function setup(browser: import('@playwright/test').Browser, tag: string) {
  const mk = async (who: string): Promise<{ ctx: BrowserContext; page: Page }> => {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
    await signIn(ctx, `notices-${tag}-${who}-${ts}@example.com`, `${who} Builder`);
    return { ctx, page: await ctx.newPage() };
  };
  const alice = await mk('alice');
  const bob = await mk('bob');
  const wifi = await droppable(bob.page);
  const res = await alice.page.request.post('/api/layouts', { data: { title: `Notices ${tag}`, bbm: twoParts() } });
  const { id } = (await res.json()) as { id: string };
  const invite = await alice.page.request.post(`/api/layouts/${id}/invites`, { data: { email: `notices-${tag}-bob-${ts}@example.com`, role: 'editor' } });
  const { token } = (await invite.json()) as { token: string };
  expect((await bob.page.request.post(`/api/invites/${token}`)).ok()).toBe(true);
  for (const p of [alice.page, bob.page]) {
    await p.goto(`/editor/${id}`);
    await expect(p.getByTestId('save-status')).toHaveText(/Saved/, { timeout: 30000 });
    await expect.poll(() => shown(p).then((x) => x.length), { timeout: 15000 }).toBe(2);
  }
  return { alice, bob, id, wifi };
}

/** Pick a part by clicking it, then nudge it right. */
async function nudge(page: Page, id: string): Promise<void> {
  const part = (await shown(page)).find((p) => p.id === id)!;
  await page.mouse.click(part.sx + 4, part.sy + 4);
  await page.keyboard.press('ArrowRight');
}

const notice = (page: Page) => page.getByTestId('notice');

test('Undo after someone else moved the same part says so, and goes out', async ({ browser }) => {
  const { alice, bob } = await setup(browser, 'undo');
  const at = async (page: Page, id: string) => (await shown(page)).find((p) => p.id === id)!.sx;
  const [a] = await shown(alice.page);
  const bobBefore = await at(bob.page, a!.id);
  await nudge(alice.page, a!.id);
  await expect.poll(() => at(bob.page, a!.id), { timeout: 10000 }).not.toBe(bobBefore);
  const aliceAfterHers = await at(alice.page, a!.id);
  await nudge(bob.page, a!.id);
  const moved = await at(bob.page, a!.id);
  await expect.poll(() => at(alice.page, a!.id), { timeout: 10000 }).not.toBe(aliceAfterHers);
  const undo = alice.page.getByRole('button', { name: 'Undo', exact: true });
  await expect(undo).toBeEnabled();
  await alice.page.keyboard.press('Control+z');
  await expect(notice(alice.page)).toHaveText(/Someone else changed that after you, so there was nothing to undo/);
  await expect(undo).toBeDisabled();
  // Bob's move stands.
  await alice.page.waitForTimeout(500);
  expect(await at(bob.page, a!.id)).toBe(moved);
  await alice.ctx.close();
  await bob.ctx.close();
});

test('lowered to view only and raised again, it says so both times', async ({ browser }) => {
  const { alice, bob, id } = await setup(browser, 'role');
  const bobId = ((await (await bob.page.request.get('/api/auth/me')).json()) as { user: { id: string } }).user.id;
  expect((await alice.page.request.patch(`/api/layouts/${id}/collaborators/${bobId}`, { data: { role: 'viewer' } })).ok()).toBe(true);
  await expect(notice(bob.page)).toHaveText(/You can only view this layout now\. Your access to “Notices role” changed to view only/, { timeout: 15000 });
  expect((await alice.page.request.patch(`/api/layouts/${id}/collaborators/${bobId}`, { data: { role: 'editor' } })).ok()).toBe(true);
  await expect(notice(bob.page)).toHaveText(/You can edit this layout now/, { timeout: 15000 });
  await alice.ctx.close();
  await bob.ctx.close();
});

test('offline, the pill says so; an offline change someone else replaced is mentioned', async ({ browser }) => {
  const { alice, bob, wifi } = await setup(browser, 'offline');
  const [, b] = await shown(bob.page);
  wifi.down();
  await expect(bob.page.getByTestId('save-status')).toHaveText('Reconnecting…', { timeout: 15000 });
  await expect(bob.page.getByTestId('save-status')).toHaveText('Offline: changes kept here', { timeout: 15000 });
  // Bob moves a part offline; Alice deletes it meanwhile.
  await nudge(bob.page, b!.id);
  const part = (await shown(alice.page)).find((p) => p.id === b!.id)!;
  await alice.page.mouse.click(part.sx + 4, part.sy + 4);
  await alice.page.keyboard.press('Delete');
  await expect.poll(() => shown(alice.page).then((x) => x.length)).toBe(1);
  wifi.up();
  await expect(bob.page.getByTestId('save-status')).toHaveText(/Saved/, { timeout: 45000 });
  await expect(notice(bob.page)).toHaveText(/Your offline change was replaced by someone else's change to the same part/, { timeout: 10000 });
  await expect.poll(() => shown(bob.page).then((x) => x.length)).toBe(1);
  await alice.ctx.close();
  await bob.ctx.close();
});
