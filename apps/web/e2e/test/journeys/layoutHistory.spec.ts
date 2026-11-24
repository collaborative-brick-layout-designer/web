// Journey — a layout's version history.
//
//   Map › File › Version history… → keep a named version → back in the
//   layout, delete its part → Version history… → pick the named version
//   (it shows in the viewer, with when, why and what was in it) → Restore
//   this version → the layout as it was just before is kept as "Before a
//   restore", and the part is back in the editor → Copy as a new layout →
//   the copy opens with the part, and the layout itself is left as it is.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn, mapMenu } from '../../helpers';

const FORDYCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures/fordyce-2026.bbm'), 'utf-8');

/** Fordyce's sheets with one 9V curve on the first brick sheet and nothing else. */
function oneCurve(): string {
  const brick =
    '<Brick id="900"><DisplayArea><X>0</X><Y>0</Y><Width>16</Width><Height>8</Height></DisplayArea>' +
    '<MyGroup /><PartNumber>2867.8</PartNumber><Orientation>0</Orientation>' +
    '<ActiveConnectionPointIndex>0</ActiveConnectionPointIndex><Altitude>0</Altitude><Connexions count="0" /></Brick>';
  const first = /<Layer type="brick"[\s\S]*?<\/Layer>/.exec(FORDYCE)![0];
  const layer = first.replace(/<Bricks>[\s\S]*<\/Bricks>/, `<Bricks>${brick}</Bricks>`);
  return FORDYCE.replace(/<Layer type="(brick|ruler|text)"[\s\S]*?<\/Layer>/g, '').replace(/(<Layers[^>]*>)/, `$1${layer}`);
}

const parts = (page: Page) =>
  page.evaluate(() => {
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: { name: () => string; getClassName: () => string }) => boolean) => unknown[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : -1;
  });

test('a layout goes back to a kept version, and a version is copied out as a new layout', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  const ts = Date.now();
  await signIn(page, `j-history-${ts}@example.com`, 'History Keeper');
  const res = await page.request.post('/api/layouts', { data: { title: `Yard ${ts}`, bbm: oneCurve() } });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };

  await page.goto(`/editor/${id}`);
  await expect.poll(() => parts(page), { timeout: 30_000 }).toBe(1);

  // ── Keep a named version. ──
  await mapMenu(page, 'File', 'Version history…');
  await expect(page).toHaveURL(new RegExp(`/editor/${id}/history$`));
  const history = page.getByRole('complementary', { name: 'Version history' });
  await history.getByLabel('Name for the version').fill('Start');
  await history.getByRole('button', { name: 'Keep a version now' }).click();
  await expect(history.getByRole('status')).toContainText('Kept a version');
  const start = history.locator('li').filter({ hasText: '“Start”' });
  await expect(start).toContainText('1 part');
  await expect(start).toContainText('History Keeper');

  // ── Lose the part. ──
  await page.getByRole('button', { name: 'Back to the layout' }).click();
  // The editor itself first: the history page's viewer also draws the part, so a part count alone
  // is true while the editor isn't mounted yet (and its keys aren't listening).
  await expect(page).toHaveURL(new RegExp(`/editor/${id}$`));
  await expect(page.locator('footer')).toContainText('no selection', { timeout: 30_000 });
  await expect.poll(() => parts(page), { timeout: 30_000 }).toBe(1);
  const area = (await page.locator('.konvajs-content').first().boundingBox())!;
  await page.mouse.click(area.x + 5, area.y + area.height - 5);
  await page.keyboard.press('Control+a');
  // Delete only once the map has the part picked (the footer says so), not on a guess.
  await expect(page.locator('footer')).toContainText('selected: 1');
  await page.keyboard.press('Delete');
  await expect.poll(() => parts(page)).toBe(0);
  // On the server too, before going on.
  await expect.poll(async () => (await (await page.request.get(`/api/layouts/${id}/export.bbm`)).text()).includes('<Brick '), { timeout: 30_000 }).toBe(false);

  // ── Restore the named version. ──
  await mapMenu(page, 'File', 'Version history…');
  await history.locator('li').filter({ hasText: '“Start”' }).getByRole('button').first().click();
  await expect(page.getByText(/^Version from /)).toBeVisible();
  await history.getByRole('button', { name: 'Restore this version' }).click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('kept in this list first');
  await ask.getByRole('button', { name: 'Restore this version' }).click();
  await expect(history.getByRole('status')).toContainText('The layout is back to how it was');
  await expect(history.locator('li').filter({ hasText: 'Before a restore' }).first()).toContainText('0 parts');

  await history.getByRole('link', { name: 'Open the layout' }).click();
  await expect.poll(() => parts(page), { timeout: 30_000 }).toBe(1);

  // ── Copy the named version out. ──
  await mapMenu(page, 'File', 'Version history…');
  await history.locator('li').filter({ hasText: '“Start”' }).getByRole('button').first().click();
  await history.getByRole('button', { name: 'Copy as a new layout' }).click();
  await expect(history.getByRole('status')).toContainText(`Made a new layout, “Yard ${ts} (earlier version)”`);
  await history.getByRole('link', { name: 'Open the copy' }).click();
  await expect(page).not.toHaveURL(new RegExp(id));
  await expect.poll(() => parts(page), { timeout: 30_000 }).toBe(1);
});
