// The budget is shared with the layout (area 7 part B, Bug 1): a layout
// uploaded with a budget in its sidecar shows it, and the layout file
// downloaded from the editor carries the budget set there. It used to live
// only on the server, so the desktop never saw it.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { signIn, mapMenu } from '../../helpers';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures');
const TIGHT_CORNER = readFileSync(join(FIXTURES, 'tight-corner.bbm'), 'utf-8');

/** A zip's entries (stored or deflated), by name. */
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

async function openEditor(page: Page, id: string): Promise<void> {
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('save-status')).toHaveText(/Saved/, { timeout: 30000 });
}

test('a budget travels with the layout: in, on screen, and out in the layout file', async ({ page }) => {
  await signIn(page, `budget-shared-${Date.now()}@example.com`, 'Budget Sharer');
  // A layout the desktop uploaded, budget and all (tight-corner has no part 9999.1).
  const sidecar = JSON.stringify({ schemaVersion: 1, bbmHashSha256: '', budgetLimits: { '9999.1': 2 } });
  const res = await page.request.post('/api/layouts', { data: { title: 'Budget Test', bbm: TIGHT_CORNER, sidecar } });
  expect(res.status()).toBe(201);
  const { id } = (await res.json()) as { id: string };

  await openEditor(page, id);
  await expect(page.getByTitle('Budget status')).toHaveText('Budget: OK');

  // A limit set here (every part of the layout is over a limit of 0).
  await mapMenu(page, 'Budget', 'Edit budget…');
  const dialog = page.getByRole('dialog', { name: 'Budget' });
  await expect(dialog).toBeVisible();
  const firstLimit = dialog.locator('input[type="number"]').first();
  await firstLimit.fill('0');
  await firstLimit.press('Tab');
  await expect(page.getByTitle('Budget status')).toHaveText(/Budget: \d+ over/);

  // Downloaded, the layout file carries both.
  const dl = page.waitForEvent('download');
  await mapMenu(page, 'Download & export', 'Download layout (.bld-layout)');
  const entries = unzip(readFileSync(await (await dl).path()));
  const out = JSON.parse(entries.get('sidecar.json')!.toString()) as { budgetLimits: Record<string, number> };
  expect(out.budgetLimits['9999.1']).toBe(2);
  expect(Object.values(out.budgetLimits)).toContain(0);
  // And so does the server's copy of the sidecar.
  const served = (await (await page.request.get(`/api/layouts/${id}/export.bld-layout`)).body());
  const servedSidecar = JSON.parse(unzip(served).get('sidecar.json')!.toString()) as { budgetLimits: Record<string, number> };
  expect(servedSidecar.budgetLimits).toEqual(out.budgetLimits);
});
