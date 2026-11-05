// Journey — an edit that reaches the server before the edit it follows is
// kept, and nobody is disconnected.
//
//   Two browsers on one layout → in the first, place a part and change the
//   grid's cell size (Sheet options) while what the page sends is held back
//   → the server gets them in the reverse order, the cell size first (as
//   after a reconnect, when an edit can go out before the sync that carries
//   the ones before it) → the first page stays connected and says nothing
//   was refused → the second shows the part and the new cell size → the
//   server's copy has both.
//
// What arrives in which order on a real connection can't be timed from a
// page, so the first page's socket is routed: its messages are held back,
// then sent in the order under test. The server's socket tests cover the
// details (apps/server src/routes/test/wsEarlyEdit.test.ts).

import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { signIn } from '../../helpers';

const ts = Date.now();
const EMAIL = `j-early-edit-${ts}@example.com`;
const PART = 'ts_narrowgauge_straight.8';

async function placePart(page: Page): Promise<void> {
  await page.getByPlaceholder(/fuzzy filter/i).first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
}

/** Open the grid's Sheet options. */
async function gridOptions(page: Page) {
  await page.locator('aside', { hasText: 'Sheets' }).locator('li', { hasText: 'Grid' }).first().dblclick();
  const options = page.getByRole('dialog', { name: 'Sheet options' });
  await expect(options).toBeVisible();
  return options;
}

/** The server's copy of the layout, as a .bbm. */
async function onServer(page: Page, id: string): Promise<string> {
  const r = await page.request.get(`/api/layouts/${id}/export.bbm`);
  expect(r.ok()).toBe(true);
  return r.text();
}

test('an edit that arrives before the one it follows is kept, and the page stays connected', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, EMAIL, 'Early Edie');
  const id = ((await (await page.request.post('/api/layouts', { data: { title: `Early edit ${ts}` } })).json()) as { id: string }).id;

  // The first page's socket, routed: what it sends can be held back, then sent in another order.
  let holdBack = false;
  const held: (string | Buffer)[] = [];
  let toServer: WebSocketRoute | null = null;
  await page.routeWebSocket(new RegExp(`/ws/layout/${id}$`), (ws) => {
    const server = ws.connectToServer();
    toServer = server;
    ws.onMessage((m) => {
      if (holdBack) held.push(m);
      else server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await page.goto(`/editor/${id}`);
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 20000 });

  // The second browser, watching.
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await other.setViewportSize({ width: 1400, height: 900 });
  await signIn(other, EMAIL, 'Early Edie');
  await other.goto(`/editor/${id}`);
  await expect(other.getByText('Saved', { exact: true })).toBeVisible({ timeout: 20000 });

  // A part, then a new cell size, both held back.
  holdBack = true;
  await placePart(page);
  await expect(page.locator('footer')).toContainText('1 piece');
  const options = await gridOptions(page);
  await options.getByLabel('Cell size').fill('48');
  await options.getByRole('button', { name: 'OK' }).click();
  await expect(options).toHaveCount(0);
  const isSync = (m: string | Buffer) => typeof m !== 'string' && m[0] === 0;
  await expect.poll(() => held.filter(isSync).length).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(300);

  // Sent the other way round: the cell size reaches the server before the part it follows.
  holdBack = false;
  const sync = held.filter(isSync).reverse();
  const rest = held.filter((m) => !isSync(m));
  held.length = 0;
  for (const m of [...sync, ...rest]) toServer!.send(m);

  // Nobody is disconnected, nothing refused: the other browser gets both.
  await expect(other.locator('footer')).toContainText('1 piece', { timeout: 15000 });
  const seen = await gridOptions(other);
  await expect(seen.getByLabel('Cell size')).toHaveValue('48');
  await seen.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Your changes weren’t sent')).toHaveCount(0);
  await expect(page.getByTestId('refused-copy')).toHaveCount(0);
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  // And the server keeps both.
  await expect.poll(async () => (await onServer(page, id)).match(new RegExp(PART.replace('.', '\\.'), 'gi'))?.length ?? 0, { timeout: 15000 }).toBe(1);
  expect(await onServer(page, id)).toMatch(/<GridSizeInStud>48<\/GridSizeInStud>/i);

  // A later edit goes through on the same connection.
  await placePart(page);
  await expect(other.locator('footer')).toContainText('2 pieces', { timeout: 15000 });
  await ctx.close();
});
