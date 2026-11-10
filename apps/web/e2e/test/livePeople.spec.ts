// Who's here, as people see it (full review area 4):
//   - Bug 10: the same person in two tabs showed as two people, and you saw
//     yourself in "People here now";
//   - Bug 9: the same two people tended to get the same color everywhere;
//   - Bug 8: other people's cursors shrank with the zoom (specks at Fit).

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn } from '../helpers';

const FORDYCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures/fordyce-2026.bbm'), 'utf-8');
const ts = Date.now();

async function person(browser: import('@playwright/test').Browser, who: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  await signIn(ctx, `people-${who.toLowerCase()}-${ts}@example.com`, `${who} Builder`);
  return ctx;
}

const people = (page: Page) => page.getByRole('group', { name: 'People here now' }).locator(':scope > span');

async function open(page: Page, id: string): Promise<void> {
  await page.goto(`/editor/${id}`);
  await expect(page.getByTestId('save-status')).toHaveText(/Saved/, { timeout: 30000 });
}

/** The on-screen scale of other people's cursors (1: the same size at any zoom). */
function cursorScales(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    type N = { getAbsoluteScale: () => { x: number } };
    const st = (window as unknown as { Konva?: { stages: { find: (s: string) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find('.remote-cursor').map((n) => Math.round(n.getAbsoluteScale().x * 100) / 100) : [];
  });
}

test('each other person once, never yourself, in colors nobody else has, with cursors the same size at any zoom', async ({ browser }) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const a1 = await alice.newPage();
  const res = await a1.request.post('/api/layouts', { data: { title: 'People here', bbm: FORDYCE } });
  const { id } = (await res.json()) as { id: string };
  const invite = await a1.request.post(`/api/layouts/${id}/invites`, { data: { email: `people-bob-${ts}@example.com`, role: 'editor' } });
  const { token } = (await invite.json()) as { token: string };
  const b = await bob.newPage();
  expect((await b.request.post(`/api/invites/${token}`)).ok()).toBe(true);

  // Alice in two tabs, Bob in one.
  const a2 = await alice.newPage();
  await open(a1, id);
  await open(a2, id);
  await open(b, id);

  // Bob sees Alice once; Alice sees only Bob, in both tabs.
  await expect(people(b)).toHaveCount(1, { timeout: 10000 });
  await expect(people(b).first()).toHaveAttribute('title', /Alice Builder/);
  for (const tab of [a1, a2]) {
    await expect(people(tab)).toHaveCount(1, { timeout: 10000 });
    await expect(people(tab).first()).toHaveAttribute('title', /Bob Builder/);
  }
  // Their colors differ, and each sees the same color for the other on both sides.
  const bobAsAliceSees = await people(a1).first().evaluate((e) => (e as HTMLElement).style.backgroundColor);
  const aliceAsBobSees = await people(b).first().evaluate((e) => (e as HTMLElement).style.backgroundColor);
  expect(bobAsAliceSees).not.toBe(aliceAsBobSees);
  expect(await people(a2).first().evaluate((e) => (e as HTMLElement).style.backgroundColor)).toBe(bobAsAliceSees);

  // Bob's cursor, as Alice sees it at Fit and zoomed in: the same size on screen.
  const box = (await b.locator('.konvajs-content').first().boundingBox())!;
  await b.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => cursorScales(a1), { timeout: 10000 }).toEqual([1]);
  await a1.getByRole('button', { name: 'Fit' }).click();
  await b.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2);
  await expect.poll(() => cursorScales(a1), { timeout: 10000 }).toEqual([1]);
  // (Alice's own other tab draws no cursor of hers.)
  await a2.bringToFront();
  await a1.mouse.move(box.x + 100, box.y + 100);
  await expect.poll(() => cursorScales(a2), { timeout: 5000 }).toEqual([1]);
  await alice.close();
  await bob.close();
});
