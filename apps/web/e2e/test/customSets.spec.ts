// A set of your own parts, as Brick Track Designer's "Layout parts" export
// makes one (sent from the desktop's Upload to server…): its three parts
// and the set that puts them down as designed. The set shows as a "Set" in
// your parts list, and the editor's Parts panel places it as one group.

import { test, expect, type Page } from '@playwright/test';
import { signIn } from '../helpers';

const ts = Date.now();
const KEY = `Switch_${ts}`;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

const partXml = (n: number, ends: [number, number, number][]) =>
  `<?xml version="1.0"?><part><Author>Brick Track Designer</Author><Description><en>${KEY}: base${n}</en></Description>` +
  `<ConnexionList>${ends
    .map(([x, y, a]) => `<connexion><type>1</type><position><x>${x}</x><y>${y}</y></position><angle>${a}</angle></connexion>`)
    .join('')}</ConnexionList></part>`;
// Three plates in a row, 8 studs apart, joined at their cuts.
const SET_XML =
  `<?xml version="1.0"?><group><Author>Brick Track Designer</Author><Description><en>${KEY} (all 3 parts, as designed)</en></Description>` +
  `<CanUngroup>true</CanUngroup><SubPartList>` +
  [0, 1, 2].map((i) => `<SubPart id="${KEY}.base${i + 1}"><position><x>0</x><y>${i * 8}</y></position><angle>0</angle></SubPart>`).join('') +
  `</SubPartList></group>`;

async function post(page: Page, data: object): Promise<string> {
  const res = await page.request.post('/api/custom-parts', { data });
  expect(res.ok(), `${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

async function uploadDesign(page: Page): Promise<void> {
  for (const n of [1, 2, 3])
    await post(page, {
      partNumber: `${KEY}.base${n}`,
      displayName: `${KEY}: base${n}`,
      xmlBase64: b64(partXml(n, [[0, -4, -90], [0, 4, 90]])),
      spriteBase64: PNG,
      spriteMime: 'image/png',
    });
  // The set: its XML only, no picture.
  await post(page, { partNumber: `${KEY}.whole`, displayName: `${KEY} (all 3 parts, as designed)`, xmlBase64: b64(SET_XML) });
}

test('a set of your own parts shows as a Set and places as one group', async ({ page }) => {
  await signIn(page, `custom-sets-${ts}@example.com`, 'Set Maker');
  await uploadDesign(page);

  // Your parts list: the set has a "Set" tile, not a picture, and no picture to download.
  await page.goto('/?owner=me');
  const row = page.locator('#parts').getByRole('listitem').filter({ hasText: `${KEY} (all 3 parts` });
  await expect(row.getByText('Set', { exact: true })).toBeVisible();
  await expect(row.locator('img')).toHaveCount(0);
  await row.getByRole('button', { name: `More for ${KEY}.whole` }).click();
  await expect(page.getByRole('menuitem', { name: 'Download XML' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Download picture' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The editor: the set is in the Parts panel and goes down as one group of its three parts.
  const res = await page.request.post('/api/layouts', { data: { title: 'Set test' } });
  expect(res.ok()).toBe(true);
  const id = ((await res.json()) as { id: string }).id;
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Search parts (name or number)').fill(`${KEY}.whole`);
  const tile = page.locator('aside li button[draggable="true"]').filter({ hasText: KEY }).first();
  await expect(tile).toBeVisible({ timeout: 10000 });
  await tile.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('footer')).toContainText(`Placed set: ${KEY} (all 3 parts, as designed) (3 parts)`);
  await expect(page.locator('footer')).toContainText('selected: 3');

  // Saved as one BlueBrick group holding the three parts, joined at their cuts.
  const bbm = async () => (await (await page.request.get(`/api/layouts/${id}/export.bbm`)).text());
  const groupsOf = (xml: string) => [...xml.matchAll(/<Group id="([^"]+)">/g)].map((m) => m[1]!);
  await expect.poll(async () => groupsOf(await bbm()).length).toBe(1);
  const xml = await bbm();
  expect(xml.split(`<MyGroup>${groupsOf(xml)[0]}</MyGroup>`).length - 1).toBe(3);
  await expect.poll(async () => ((await bbm()).match(/<LinkedTo>[^<]+<\/LinkedTo>/g) ?? []).length).toBe(4);
});
