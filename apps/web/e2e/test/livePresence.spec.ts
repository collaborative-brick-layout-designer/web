// Three people on one layout (full review area 4):
//   - Bug 1: a tab still opening the layout shared an empty presence ({}),
//     and drawing it blanked the editor of everyone already in the layout.
//     Now that tab shares nothing until the layout opens, the server drops a
//     presence that isn't a person's, and the editor skips one if it comes.
//   - Bug 2: every tab sent everyone else's presence back to the server,
//     about 20 messages a second per person moving the mouse, so an idle
//     person in a crowded layout was closed for sending too fast. Now a tab
//     sends only its own.

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { signIn } from '../helpers';

const ts = Date.now();

async function person(browser: import('@playwright/test').Browser, who: string): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  await signIn(ctx, `live-${who.toLowerCase()}-${ts}@example.com`, `${who} Builder`);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}

async function shareWith(owner: Page, id: string, other: Page, email: string, role: 'editor' | 'viewer'): Promise<void> {
  const invite = await owner.request.post(`/api/layouts/${id}/invites`, { data: { email, role } });
  expect(invite.ok()).toBe(true);
  const { token } = (await invite.json()) as { token: string };
  expect((await other.request.post(`/api/invites/${token}`)).ok()).toBe(true);
}

const people = (page: Page) => page.getByRole('group', { name: 'People here now' }).locator(':scope > span');

async function openEditor(page: Page, id: string): Promise<void> {
  await page.goto(`/editor/${id}`);
  await expect(page.locator('.konvajs-content').first()).toBeVisible({ timeout: 20000 });
}

/** The presence messages (type 1) a page sends on the layout's live connection. */
function countPresenceSent(page: Page): { n: number } {
  const count = { n: 0 };
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/ws/layout/')) return;
    ws.on('framesent', (f) => {
      if (typeof f.payload !== 'string' && f.payload[0] === 1) count.n++;
    });
  });
  return count;
}

test('a tab still opening the layout, or an empty presence, leaves everyone else editing', async ({ browser }) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const carol = await person(browser, 'Carol');
  const res = await alice.page.request.post('/api/layouts', { data: { title: 'Live presence' } });
  const { id } = (await res.json()) as { id: string };
  await shareWith(alice.page, id, bob.page, `live-bob-${ts}@example.com`, 'editor');
  await shareWith(alice.page, id, carol.page, `live-carol-${ts}@example.com`, 'viewer');
  await openEditor(alice.page, id);
  await openEditor(bob.page, id);
  await expect(people(alice.page)).toHaveCount(1, { timeout: 10000 });
  await expect(people(alice.page).first()).toHaveAttribute('title', /Bob Builder/);

  // Carol's tab is still opening it: the server's messages are held back
  // (a big layout on a slow link), so the layout hasn't arrived.
  const held: (() => void)[] = [];
  let release = false;
  await carol.page.routeWebSocket(/\/ws\/layout\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => (release ? ws.send(m) : held.push(() => ws.send(m))));
  });
  const carolSent = countPresenceSent(carol.page);
  await carol.page.goto(`/editor/${id}`);
  await carol.page.waitForTimeout(3000);
  // She shares no presence while it opens, so nobody sees an empty one.
  expect(carolSent.n).toBe(0);
  await expect(people(alice.page)).toHaveCount(1);

  // An empty presence sent anyway (an older page, or on purpose): dropped.
  await carol.page.evaluate(async (layoutId) => {
    const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/ws/layout/${layoutId}`);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const json = new TextEncoder().encode('{}');
    // [awareness, length, 1 entry, clientID 4242 (varuint), clock 1, state]
    const entry = [1, 0x92, 0x21, 1, json.length, ...json];
    ws.send(new Uint8Array([1, entry.length, ...entry]));
    await new Promise((r) => setTimeout(r, 1500));
    ws.close();
  }, id);
  await expect(alice.page.locator('.konvajs-content').first()).toBeVisible();
  await expect(people(alice.page)).toHaveCount(1);
  await expect(bob.page.locator('.konvajs-content').first()).toBeVisible();

  // Carol's layout arrives: now she's here, by name.
  release = true;
  for (const send of held.splice(0)) send();
  await expect(carol.page.locator('.konvajs-content').first()).toBeVisible({ timeout: 20000 });
  await expect(people(alice.page)).toHaveCount(2, { timeout: 10000 });
  await expect(people(alice.page).filter({ hasText: 'Carol Builder' })).toHaveCount(1);
  expect(alice.errors).toEqual([]);
  expect(bob.errors).toEqual([]);
  for (const p of [alice, bob, carol]) await p.ctx.close();
});

test("an idle person doesn't send everyone's cursor back, so a busy layout keeps them connected", async ({ browser }) => {
  const alice = await person(browser, 'Ann');
  const bob = await person(browser, 'Ben');
  const carol = await person(browser, 'Cat');
  const res = await alice.page.request.post('/api/layouts', { data: { title: 'Busy layout' } });
  const { id } = (await res.json()) as { id: string };
  await shareWith(alice.page, id, bob.page, `live-ben-${ts}@example.com`, 'editor');
  await shareWith(alice.page, id, carol.page, `live-cat-${ts}@example.com`, 'viewer');
  const carolSent = countPresenceSent(carol.page);
  const carolCloses: number[] = [];
  carol.page.on('websocket', (ws) => ws.on('close', () => carolCloses.push(Date.now())));
  await openEditor(carol.page, id);
  await openEditor(alice.page, id);
  await openEditor(bob.page, id);
  await expect(people(carol.page)).toHaveCount(2, { timeout: 10000 });

  // Ann and Ben move their mouse over the map for 4 s; Cat sits still.
  const before = carolSent.n;
  const wiggle = async (page: Page): Promise<void> => {
    const box = (await page.locator('.konvajs-content').first().boundingBox())!;
    for (let i = 0; i < 80; i++) {
      await page.mouse.move(box.x + 200 + 150 * Math.cos(i / 5), box.y + 200 + 150 * Math.sin(i / 5));
      await page.waitForTimeout(50);
    }
  };
  await Promise.all([wiggle(alice.page), wiggle(bob.page)]);
  const sent = carolSent.n - before;
  // Before: about 20 a second per person moving (160 here). Now: none of theirs.
  expect(sent).toBeLessThan(5);
  expect(carolCloses).toEqual([]);
  // And she still sees both of them.
  await expect(people(carol.page)).toHaveCount(2);
  for (const p of [alice, bob, carol]) await p.ctx.close();
});
