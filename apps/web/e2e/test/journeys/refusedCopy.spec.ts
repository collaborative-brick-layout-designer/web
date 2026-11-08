// Journey — the server refuses a page's changes, and nothing is lost.
//
//   Build a layout (one part) → a second part that never reaches the
//   server → the server closes the connection with 1008
//   layout_merge_refused (apps/server/src/ws/mergeGuard.ts) → the editor
//   says so plainly, and a card keeps the page's copy: it stays when
//   leaving the editor, and closing the page asks first → Download it
//   (.bld-layout) → Save my copy as a new layout: a new layout with both
//   parts, the original unchanged → the downloaded file opens as a layout
//   with both parts too.
//
// The refusal itself is the server's (its socket tests cover when it
// refuses); here the socket is routed so the second part is held back and
// the close comes exactly as the server sends it.

import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { signIn } from '../../helpers';

const ts = Date.now();
const TITLE = `Refused ${ts}`;
const PART = 'ts_narrowgauge_straight.8';

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}

/** How many of the part the server's copy of a layout holds. */
async function onServer(page: Page, id: string): Promise<number> {
  const r = await page.request.get(`/api/layouts/${id}/export.bbm`);
  expect(r.ok()).toBe(true);
  return ((await r.text()).match(new RegExp(PART.replace('.', '\\.'), 'gi')) ?? []).length;
}

async function placePart(page: Page): Promise<void> {
  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
}

test('a refused copy is kept until it is saved as a new layout or downloaded', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `j-refused-${ts}@example.com`, 'Kept Builder');
  const id = ((await (await page.request.post('/api/layouts', { data: { title: TITLE } })).json()) as { id: string }).id;

  // The layout's socket, routed: what the page sends can be held back.
  let toPage: WebSocketRoute | null = null;
  let holdBack = false;
  await page.routeWebSocket(new RegExp(`/ws/layout/${id}$`), (ws) => {
    const server = ws.connectToServer();
    toPage = ws;
    ws.onMessage((m) => {
      if (!holdBack) server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });

  await page.goto(`/editor/${id}`);
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 20000 });
  await placePart(page);
  await expect.poll(() => onServer(page, id), { timeout: 15000 }).toBe(1);

  // A second part the server never gets, then the server refuses.
  holdBack = true;
  await placePart(page);
  await expect.poll(() => brickCount(page)).toBe(2);
  await toPage!.close({ code: 1008, reason: 'layout_merge_refused' });

  await expect(page.getByText('Your changes weren’t sent')).toBeVisible({ timeout: 10000 });
  const card = page.getByTestId('refused-copy');
  await expect(card).toContainText(`Your copy of “${TITLE}” is kept on this page`);
  expect(await onServer(page, id)).toBe(1);

  // Leaving the editor keeps it.
  await page.getByRole('link', { name: /Back to Home/ }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(card).toBeVisible();

  // Closing the page asks first (the person stays).
  const asked = new Promise<string>((resolve) =>
    page.once('dialog', (d) => {
      resolve(d.type());
      void d.dismiss();
    }),
  );
  await page.close({ runBeforeUnload: true });
  expect(await asked).toBe('beforeunload');
  expect(page.isClosed()).toBe(false);

  // Download it, and the file opens as a layout with both parts.
  const download = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Download it (.bld-layout)' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\(my copy\)\.bld-layout$/);
  await expect(card.getByRole('button', { name: 'Done' })).toBeVisible();
  const downloaded = (await file.path())!;

  // Save my copy as a new layout: the editor opens on it, both parts there.
  await card.getByRole('button', { name: 'Save my copy as a new layout' }).click();
  await expect(page).toHaveURL(/\/editor\/[0-9a-f-]{36}$/, { timeout: 15000 });
  const copyId = page.url().split('/').at(-1)!;
  expect(copyId).not.toBe(id);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(2);
  expect(await onServer(page, copyId)).toBe(2);
  await expect(card).toHaveCount(0);
  // The original is as the server had it.
  expect(await onServer(page, id)).toBe(1);
  const list = (await (await page.request.get('/api/layouts')).json()) as { layouts: { id: string; title: string }[] };
  expect(list.layouts.find((l) => l.id === copyId)?.title).toBe(`${TITLE} (my copy)`);

  // The downloaded file opens as a layout with both parts too.
  await page.goto('/');
  await page.getByRole('button', { name: 'New layout', exact: true }).first().click();
  await page
    .getByRole('dialog', { name: 'New layout' })
    .locator('input[type=file][accept*=".bld-layout"]')
    .setInputFiles({ name: 'copy.bld-layout', mimeType: 'application/octet-stream', buffer: readFileSync(downloaded) });
  await page.getByRole('dialog', { name: 'New layout' }).getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/editor\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(2);
});
