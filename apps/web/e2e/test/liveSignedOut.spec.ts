// Signed out mid-edit (full review area 4, Bug 12): the editor used to be
// replaced within 150 ms by "Sign in to open this layout. This layout is
// private." (wrong for its own editor, and it may not be private), and
// changes not sent yet survived only as a separate copy. Now the layout
// stays open, read only, behind "You were signed out"; signing in again
// picks up where it left off and sends what wasn't sent.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASS, postAuth, signIn } from '../helpers';

const FORDYCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures/fordyce-2026.bbm'), 'utf-8');
const ts = Date.now();

/** The parts as drawn: where on screen. */
function shown(page: Page): Promise<{ sx: number; sy: number }[]> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string; getAbsolutePosition: () => { x: number; y: number } };
    const st = (window as unknown as { Konva?: { stages: { container: () => HTMLElement; find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    if (!st) return [];
    const box = st.container().getBoundingClientRect();
    return st
      .find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-'))
      .map((n) => ({ sx: box.left + n.getAbsolutePosition().x, sy: box.top + n.getAbsolutePosition().y }));
  });
}
const partsShown = async (page: Page) => (await shown(page)).length;
const onServer = async (request: import('@playwright/test').APIRequestContext, id: string) =>
  ((await (await request.get(`/api/layouts/${id}/export.bbm`)).text()).match(/<Brick /g) ?? []).length;

test('signed out mid-edit, the layout stays open; signing in again sends what was kept', async ({ browser }) => {
  test.setTimeout(120_000);
  const email = `signed-out-${ts}@example.com`;
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  await signIn(ctx, email, 'Sam Builder');
  const page = await ctx.newPage();
  const res = await page.request.post('/api/layouts', { data: { title: 'Signed out', bbm: FORDYCE } });
  const { id } = (await res.json()) as { id: string };

  // The live connection, which the test can take down (the Wi-Fi drops).
  let down = false;
  const open = new Set<{ close: (o: { code: number }) => Promise<void> }>();
  await page.routeWebSocket(/\/ws\/layout\//, (ws) => {
    if (down) {
      void ws.close({ code: 1001 });
      return;
    }
    const server = ws.connectToServer();
    open.add(ws);
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
    ws.onClose(() => {
      open.delete(ws);
      void server.close();
    });
    server.onClose((code, reason) => void ws.close({ code, reason }));
  });
  await page.goto(`/editor/${id}`);
  await expect(page.getByTestId('save-status')).toHaveText(/Saved/, { timeout: 30000 });
  const before = await partsShown(page);
  expect(before).toBeGreaterThan(10);
  const serverBefore = await onServer(page.request, id);

  // Offline, a change: one part deleted.
  down = true;
  for (const w of [...open]) await w.close({ code: 1001 });
  await expect(page.getByTestId('save-status')).not.toHaveText(/Saved/, { timeout: 15000 });
  // (A part on top where it's clicked: the last drawn.)
  const part = (await shown(page)).at(-1)!;
  await page.mouse.click(part.sx + 3, part.sy + 3);
  await page.keyboard.press('Delete');
  await expect.poll(() => partsShown(page)).toBe(before - 1);

  // Meanwhile Sam signs out of his other browsers from a second one.
  const other = await browser.newContext();
  expect((await postAuth(other.request, '/api/auth/password/login', { email, password: PASS })).ok()).toBe(true);
  expect((await other.request.post('/api/auth/sessions/sign-out-others')).ok()).toBe(true);
  // Back online: the server refuses the ended sign-in.
  down = false;
  const card = page.getByTestId('signed-out');
  await expect(card).toBeVisible({ timeout: 30000 });
  await expect(card).toContainText('You were signed out');
  await expect(card).toContainText('Nothing is lost');
  // Still the layout, read only; not "This layout is private".
  await expect(page.getByText('This layout is private')).toHaveCount(0);
  await expect(page.getByText('View only').first()).toBeVisible();
  expect(await partsShown(page)).toBe(before - 1);

  // Signed in again (as in the new tab the card opens): it picks up and sends the change.
  expect((await postAuth(ctx.request, '/api/auth/password/login', { email, password: PASS })).ok()).toBe(true);
  await expect(card).toHaveCount(0, { timeout: 15000 });
  await expect(page.getByTestId('save-status')).toHaveText(/Saved/, { timeout: 30000 });
  await expect.poll(() => onServer(other.request, id), { timeout: 15000 }).toBe(serverBefore - 1);
  await other.close();
  await ctx.close();
});
