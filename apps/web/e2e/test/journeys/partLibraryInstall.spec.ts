// An admin installs a part library (Admin › Part libraries › Upload zip).
// Its parts show up at once in an editor someone already has open, with
// their pictures loaded: no server restart and no page refresh. Before,
// a fresh server listed the library but 404'd every one of its files, and
// the parts list kept the old catalog until the server restarted.

import { test, expect } from '@playwright/test';
import { adminSection, signIn } from '../../helpers';
import { makeGlobalAdmin } from '../../dbHelpers';

const ts = Date.now();
const KEY = `LibRail${ts}`;
const SLUG = `lib-rail-${ts}`;
// A 32x16 red GIF (a 4x2 stud part at 8 px a stud).
const GIF = Buffer.from('R0lGODdhIAAQAIEAAP8AAAAAAAAAAAAAACwAAAAAIAAQAEAIJwABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjxADAgA7', 'base64');
const XML = `<?xml version="1.0"?><part><Author>Test</Author><Description><en>${KEY} rail</en></Description></part>`;

/** A zip of stored (uncompressed) entries. */
function storedZip(files: Record<string, Buffer>): Buffer {
  return Buffer.concat(
    Object.entries(files).map(([name, data]) => {
      const nameBytes = Buffer.from(name, 'utf8');
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt32LE(data.length, 18);
      header.writeUInt32LE(data.length, 22);
      header.writeUInt16LE(nameBytes.length, 26);
      return Buffer.concat([header, nameBytes, data]);
    }),
  );
}

test('an installed part library is in open editors right away, pictures and all', async ({ page, browser }) => {
  const ADMIN = `lib-admin-${ts}@example.com`;
  await signIn(page, ADMIN, 'Library Admin');
  makeGlobalAdmin(ADMIN);

  // Someone is already in the editor, its parts list loaded.
  const user = await browser.newPage();
  await signIn(user, `lib-user-${ts}@example.com`, 'Library User');
  const res = await user.request.post('/api/layouts', { data: { title: `Library ${ts}` } });
  expect(res.ok()).toBe(true);
  const id = ((await res.json()) as { id: string }).id;
  await user.goto(`/editor/${id}`);
  await expect(user.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await user.getByPlaceholder('Search parts (name or number)').fill(KEY);
  const tile = user.locator('aside li button[draggable="true"]').filter({ hasText: KEY });
  await expect(tile).toHaveCount(0);

  let libraryId = '';
  try {
    // The admin installs the library from a zip.
    await page.goto('/admin');
    await adminSection(page, 'libraries');
    await page.getByRole('button', { name: 'Upload zip' }).click();
    await page.getByLabel('Library name').fill(`Rails ${ts}`);
    await page.getByLabel('Slug (unique, URL-safe)').fill(SLUG);
    await page.getByLabel('Zip file').setInputFiles({
      name: 'rails.zip',
      mimeType: 'application/zip',
      buffer: storedZip({ [`${KEY}.1.xml`]: Buffer.from(XML, 'utf8'), [`${KEY}.1.gif`]: GIF }),
    });
    const installed = page.waitForResponse((r) => r.url().endsWith('/api/admin/part-libraries') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    const reply = await installed;
    expect(reply.status()).toBe(201);
    libraryId = ((await reply.json()) as { id: string }).id;

    // The open editor gets the part without a refresh, and its picture loads.
    await expect(tile).toHaveCount(1, { timeout: 15000 });
    const img = tile.locator('img').first();
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10000 }).toBeGreaterThan(0);
    const file = await user.request.get(`/parts/libraries/${SLUG}/${KEY}.1.xml`);
    expect(file.status()).toBe(200);
  } finally {
    if (libraryId) await page.request.delete(`/api/admin/part-libraries/${libraryId}`);
  }
  // Removing it takes it out of the open editor too.
  await expect(tile).toHaveCount(0, { timeout: 15000 });
});
