// A big layout on a slow link (full review area 4, Bug 3 and Idea 2). Over
// the live connection the whole layout came as one message, and the page
// closed a connection that had received nothing for 30 s: on a slow link a
// big layout started over every 30-45 s and never opened. Now its first copy
// streams over HTTP, the card says how much has arrived, and the live
// connection only sends what changed since.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn } from '../helpers';

const FORDYCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures/fordyce-2026.bbm'), 'utf-8');

/** The live connection over a link of `kbps` (each message waits for the ones before it). */
async function slowLive(page: Page, kbps: number, layoutId: string): Promise<{ closes: number; bytesIn: number }> {
  const st = { closes: 0, bytesIn: 0 };
  let busy = 0;
  await page.routeWebSocket(/\/ws\/layout\//, (ws) => {
    const mine = ws.url().endsWith(`/${layoutId}`);
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      const n = typeof m === 'string' ? m.length : m.length;
      if (mine) st.bytesIn += n;
      busy = Math.max(Date.now(), busy) + (n * 8) / kbps;
      setTimeout(() => {
        try {
          ws.send(m);
        } catch {
          /* closed meanwhile */
        }
      }, busy - Date.now());
    });
    ws.onClose(() => {
      if (mine) st.closes++;
      server.close();
    });
    server.onClose((code, reason) => {
      if (mine) st.closes++;
      ws.close({ code, reason });
    });
  });
  return st;
}

test('a big layout opens on a slow link, saying how much has arrived', async ({ page, context }) => {
  test.setTimeout(120_000);
  await signIn(page, `slow-link-${Date.now()}@example.com`, 'Slow Link');
  const make = async (title: string, bbm?: string) =>
    ((await (await page.request.post('/api/layouts', { data: { title, ...(bbm ? { bbm } : {}) } })).json()) as { id: string }).id;
  const warm = await make('Warm up');
  const id = await make('Fordyce on show Wi-Fi', FORDYCE);
  // How big the layout is as the server sends it.
  const size = (await (await page.request.get(`/api/layouts/${id}/snapshot`)).body()).length;
  expect(size).toBeGreaterThan(200_000);

  // The live connection at 60 kbit/s: the whole layout as one live message
  // takes longer than 30 s (on main it started over, forever).
  const kbps = 60;
  expect((size * 8) / kbps).toBeGreaterThan(30_000);
  const live = await slowLive(page, kbps, id);
  // The page's other requests at 200 kbit/s (the layout over HTTP: about 10 s).
  const httpKbps = 200;
  // The editor's code is in: an empty layout opened at full speed.
  await page.goto(`/editor/${warm}`);
  await expect(page.getByTestId('save-status')).toHaveText(/Saved/, { timeout: 30_000 });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 100, downloadThroughput: (httpKbps * 1000) / 8, uploadThroughput: (httpKbps * 1000) / 8 });
  await page.evaluate((to) => {
    history.pushState({}, '', `/editor/${to}`);
    dispatchEvent(new PopStateEvent('popstate'));
  }, id);

  // The card counts up in MB of the layout's size.
  const card = page.getByTestId('opening-layout');
  await expect(card.getByTestId('loading-count')).toHaveText(/ of [0-9.]+ (MB|KB)$/, { timeout: 30_000 });
  await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuemax', String(size));

  await expect(page.getByTestId('save-status')).toHaveText(/Saved/, { timeout: 90_000 });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  // It opened on its first live connection, which carried a small part of it.
  expect(live.closes).toBe(0);
  expect(live.bytesIn).toBeLessThan(size / 4);
});
