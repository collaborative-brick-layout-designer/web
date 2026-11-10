// Journey — normal use asks the server only for what exists.
//
// The live site sits behind a WAF that bans an address after a burst of
// 404/403 answers, and a club at a show shares one address. Each journey
// here is everyday use, watched for any 4xx answer (e2e/quietNetwork.ts):
//
//   1. Open the Fordyce 2026 layout (about 1050 pieces, some parts this
//      server doesn't have), again from Home, then Home with its picture.
//   2. A layout with a custom part and parts nobody has.
//   3. Browse the catalog, a collection and an item, with and without pictures.
//   4. A visitor, signed out: a shared link and the catalog.
//   5. Old share links: one switched off since.
//   6. Live editing while a club mate deletes the layout's module and the layout.

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn } from '../../helpers';
import { makeGlobalAdmin, siteSettingsAtDefaults } from '../../dbHelpers';
import { watch4xx } from '../../quietNetwork';

siteSettingsAtDefaults();

test.setTimeout(240_000);
const ts = Date.now();
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures');
const FORDYCE = readFileSync(join(FIXTURES, 'fordyce-2026.bbm'));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const XML = Buffer.from('<?xml version="1.0"?><part><Author>e2e</Author><Description><en>Quiet arch</en></Description></part>').toString('base64');

const settle = (page: Page) => page.waitForTimeout(2500);
const canvasUp = (page: Page) => expect(page.locator('canvas').first()).toBeVisible({ timeout: 30000 });
const streamOpen = (page: Page) => expect(page.locator('html')).toHaveAttribute('data-live', 'open', { timeout: 15000 });

async function browserFor(browser: Browser, email?: string, name?: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (email) await signIn(page, email, name);
  return { ctx, page };
}

async function post<T = { id: string }>(page: Page, url: string, data: object): Promise<T> {
  const res = await page.request.post(url, { data });
  expect(res.ok(), `${url}: ${res.status()} ${await res.text()}`).toBe(true);
  return res.json() as Promise<T>;
}

/** Home → New layout from a file; the editor is open on it. */
async function newLayoutFromFile(page: Page, name: string, buffer: Buffer): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New layout', exact: true }).first().click();
  await page.getByRole('dialog', { name: 'New layout' }).locator('input[type=file][accept^=".bld-layout"]').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  await page.getByRole('dialog', { name: 'New layout' }).getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/editor\/[0-9a-f-]{36}$/, { timeout: 30000 });
  await canvasUp(page);
  return page.url().split('/editor/')[1]!;
}

/** A small .bbm: one bundled part, one custom part, and two parts nobody has. */
function oddPartsBbm(custom: string): Buffer {
  const brick = (n: number, part: string) => `
        <Brick id="22222222-2222-2222-2222-22222222222${n}">
          <DisplayArea><X>${n * 40}</X><Y>0</Y><Width>32</Width><Height>32</Height></DisplayArea>
          <MyGroup />
          <PartNumber>${part}</PartNumber>
          <Orientation>0</Orientation>
          <ActiveConnectionPointIndex>0</ActiveConnectionPointIndex>
          <Altitude>0</Altitude>
          <Connexions count="0" />
        </Brick>`;
  const bricks = [brick(1, '3001.1'), brick(2, custom), brick(3, 'NOBODY-HAS-THIS.1'), brick(4, 'MISSING_PIECE.8')].join('');
  return Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<Map>
  <Version>9</Version>
  <nbItems>4</nbItems>
  <BackgroundColor><IsKnownColor>true</IsKnownColor><Name>White</Name></BackgroundColor>
  <Author />
  <LUG />
  <Event />
  <Date><Day>30</Day><Month>9</Month><Year>2026</Year></Date>
  <Comment />
  <ExportInfo>
    <ExportPath />
    <ExportFileType>1</ExportFileType>
    <ExportArea><X>0</X><Y>0</Y><Width>0</Width><Height>0</Height></ExportArea>
    <ExportScale>0</ExportScale>
    <ExportWatermark>false</ExportWatermark>
    <ExportElectricCircuit>false</ExportElectricCircuit>
    <ExportConnectionPoints>false</ExportConnectionPoints>
  </ExportInfo>
  <SelectedLayerIndex>-1</SelectedLayerIndex>
  <Layers>
    <Layer type="brick" id="11111111-1111-1111-1111-111111111111">
      <Name>Layer 1</Name>
      <Visible>true</Visible>
      <Transparency>100</Transparency>
      <HullProperties isVisible="false">
        <hullColor><IsKnownColor>false</IsKnownColor><Name>ff000000</Name></hullColor>
        <hullThickness>1</hullThickness>
      </HullProperties>
      <DisplayBrickElevation>false</DisplayBrickElevation>
      <Bricks>${bricks}
      </Bricks>
      <Groups />
    </Layer>
  </Layers>
</Map>`);
}

test('opening a big layout with parts the server lacks asks for nothing that is not there', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const net = watch4xx(page);
  await signIn(page, `j-quiet-big-${ts}@example.com`, 'Quiet Builder');
  net.stage('open Fordyce from a file');
  const id = await newLayoutFromFile(page, 'Fordyce 2026.bbm', FORDYCE);
  await settle(page);
  await page.keyboard.press('f');
  await settle(page);
  net.stage('Home with its picture');
  await page.goto('/');
  await expect(page.getByText('Fordyce 2026').first()).toBeVisible({ timeout: 15000 });
  await settle(page);
  net.stage('open it again');
  await page.goto(`/editor/${id}`);
  await canvasUp(page);
  await settle(page);
  net.expectQuiet();
});

test('a layout with a custom part and parts nobody has opens quietly', async ({ page }) => {
  const net = watch4xx(page);
  await signIn(page, `j-quiet-odd-${ts}@example.com`, 'Odd Parts');
  const custom = `QUIET${ts}.1`;
  await post(page, '/api/custom-parts', { partNumber: custom, displayName: 'Quiet arch', xmlBase64: XML, spriteBase64: PNG, spriteMime: 'image/png' });
  net.stage('open the odd-parts layout');
  const id = await newLayoutFromFile(page, 'Odd parts.bbm', oddPartsBbm(custom));
  await settle(page);
  net.stage('Home');
  await page.goto('/');
  await settle(page);
  net.stage('again');
  await page.goto(`/editor/${id}`);
  await canvasUp(page);
  await settle(page);
  net.expectQuiet();
});

test('the catalog, a collection and an item, signed in and signed out, ask only for pictures that exist', async ({ page, browser }) => {
  const ADMIN = `j-quiet-admin-${ts}@example.com`;
  await signIn(page, ADMIN, 'Quiet Admin');
  makeGlobalAdmin(ADMIN);
  type Catalog = { modules: boolean; parts: boolean; layouts: boolean; review: string; anonymousBrowse: boolean };
  const before = ((await (await page.request.get('/api/admin/settings')).json()) as { catalog: Catalog }).catalog;
  const set = (c: Catalog) =>
    page.request.patch('/api/admin/settings', {
      data: { moduleCatalogEnabled: c.modules, partsCatalogEnabled: c.parts, layoutCatalogEnabled: c.layouts, catalogReview: c.review, catalogAnonymousBrowse: c.anonymousBrowse },
    });
  expect((await set({ modules: true, parts: true, layouts: true, review: 'none', anonymousBrowse: true })).ok()).toBe(true);
  const owner = await browserFor(browser, `j-quiet-owner-${ts}@example.com`, 'Quiet Owner');
  const visitor = await browserFor(browser);
  try {
    // A module with no picture yet, one with a picture, a part (its sprite is its picture) and a layout.
    const bare = await post(owner.page, '/api/modules', { title: `Quiet shed ${ts}` });
    const drawn = await post(owner.page, '/api/modules', { title: `Quiet mill ${ts}` });
    expect((await owner.page.request.put(`/api/modules/${drawn.id}/thumbnail`, { data: { mime: 'image/png', data: PNG } })).ok()).toBe(true);
    const part = await post(owner.page, '/api/custom-parts', { partNumber: `QCAT${ts}.1`, displayName: 'Quiet signal', xmlBase64: XML, spriteBase64: PNG, spriteMime: 'image/png' });
    const lay = await post(owner.page, '/api/layouts', { title: `Quiet yard ${ts}` });
    await post(owner.page, '/api/catalog/submissions', { kind: 'module', sourceId: bare.id, title: `Quiet shed ${ts}` });
    await post(owner.page, '/api/catalog/submissions', { kind: 'module', sourceId: drawn.id, title: `Quiet mill ${ts}` });
    await post(owner.page, '/api/catalog/submissions', { kind: 'part', sourceId: part.id, title: `Quiet signal ${ts}` });
    await post(owner.page, '/api/catalog/submissions', { kind: 'layout', sourceId: lay.id, title: `Quiet yard ${ts}` });
    const coll = await post(owner.page, '/api/catalog/collections', {
      title: `Quiet picks ${ts}`,
      description: '',
      entries: [{ source: 'library', kind: 'module', id: bare.id }, { source: 'library', kind: 'module', id: drawn.id }],
      coverItemId: null,
      audience: 'everyone',
    });
    const { token } = await post<{ token: string }>(owner.page, `/api/layouts/${lay.id}/public-share`, {});

    for (const [who, p] of [['signed in', owner.page], ['signed out', visitor.page]] as const) {
      const net = watch4xx(p);
      net.stage(`${who}: catalog`);
      await p.goto('/catalog');
      await expect(p.getByText(`Quiet shed ${ts}`).first()).toBeVisible({ timeout: 15000 });
      // The module with a picture shows it; the bare one asks for none.
      const card = (title: string) => p.getByTestId('catalog-item').filter({ hasText: title });
      await expect.poll(() => card(`Quiet mill ${ts}`).locator('img[data-testid="catalog-preview"]').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
      await expect(card(`Quiet shed ${ts}`).locator('img')).toHaveCount(0);
      await settle(p);
      net.stage(`${who}: parts and layouts`);
      await p.goto('/catalog?kind=part');
      await settle(p);
      await p.goto('/catalog?kind=layout');
      await settle(p);
      net.stage(`${who}: collections`);
      await p.goto('/catalog?kind=collections');
      await settle(p);
      net.stage(`${who}: a collection`);
      await p.goto(`/catalog/collections/${coll.id}`);
      await expect(p.getByText(`Quiet mill ${ts}`).first()).toBeVisible({ timeout: 15000 });
      await settle(p);
      net.stage(`${who}: an item`);
      await p.goto('/catalog');
      await p.getByText(`Quiet shed ${ts}`).first().click();
      await settle(p);
      net.stage(`${who}: the shared link`);
      await p.goto(`/p/${token}`);
      await expect(p.getByText(`Quiet yard ${ts}`).first()).toBeVisible({ timeout: 15000 });
      await settle(p);
      net.expectQuiet();
    }
  } finally {
    await set(before);
    await owner.ctx.close();
    await visitor.ctx.close();
  }
});

test('a shared Fordyce opens quietly for a visitor, and an old link says it is switched off', async ({ page, browser }) => {
  await signIn(page, `j-quiet-share-${ts}@example.com`, 'Quiet Sharer');
  const id = await newLayoutFromFile(page, 'Fordyce 2026.bbm', FORDYCE);
  const { token } = await post<{ token: string }>(page, `/api/layouts/${id}/public-share`, {});
  const old = await post<{ token: string }>(page, `/api/layouts/${(await post(page, '/api/layouts', { title: 'Gone yard' })).id}/public-share`, {});
  const visitor = await browserFor(browser);
  try {
    const net = watch4xx(visitor.page);
    net.stage('the shared Fordyce');
    await visitor.page.goto(`/p/${token}`);
    await canvasUp(visitor.page);
    await settle(visitor.page);
    net.expectQuiet();
    net.stage('an old link');
    expect((await page.request.delete(`/api/layouts/${(await (await page.request.get(`/api/public-layouts/${old.token}`)).json()).layout.id}/public-share`)).ok()).toBe(true);
    await visitor.page.goto(`/p/${old.token}`);
    await expect(visitor.page.getByText('Layout not found').first()).toBeVisible({ timeout: 15000 });
    net.expectQuiet();
  } finally {
    await visitor.ctx.close();
  }
});

test('live editing while a club mate deletes the module and the layout stays quiet', async ({ browser }) => {
  const a = await browserFor(browser, `j-quiet-live-a-${ts}@example.com`, 'Live Ann');
  const b = await browserFor(browser, `j-quiet-live-b-${ts}@example.com`, 'Live Ben');
  try {
    const club = await post<{ slug: string }>(a.page, '/api/orgs', { name: `Quiet club ${ts}` });
    expect((await a.page.request.patch(`/api/orgs/${club.slug}`, { data: { joinPolicy: 'open', listed: true } })).ok()).toBe(true);
    expect((await b.page.request.post(`/api/orgs/${club.slug}/join`, { data: {} })).ok()).toBe(true);
    const lay = await post(a.page, '/api/layouts', { title: `Quiet club yard ${ts}`, orgSlug: club.slug });
    const mod = await post(a.page, '/api/modules', { title: `Quiet club shed ${ts}`, orgSlug: club.slug });

    const net = watch4xx(b.ctx);
    net.stage('Ben: Home and the club layout');
    await b.page.goto('/');
    await streamOpen(b.page);
    await expect(b.page.getByText(`Quiet club shed ${ts}`).first()).toBeVisible({ timeout: 15000 });
    const editor = await b.ctx.newPage();
    await editor.goto(`/editor/${lay.id}`);
    await canvasUp(editor);
    await editor.getByRole('button', { name: 'Panels', exact: true }).click();
    await editor.getByLabel('Module library').check();
    await editor.mouse.click(400, 400);
    await streamOpen(editor);
    await settle(editor);

    net.stage('Ann deletes the module');
    expect((await a.page.request.delete(`/api/modules/${mod.id}`)).ok()).toBe(true);
    await expect(b.page.getByText(`Quiet club shed ${ts}`)).toHaveCount(0, { timeout: 15000 });
    await settle(editor);
    net.stage('Ann deletes the layout');
    expect((await a.page.request.delete(`/api/layouts/${lay.id}`)).ok()).toBe(true);
    await expect(b.page.getByText(`Quiet club yard ${ts}`)).toHaveCount(0, { timeout: 15000 });
    await settle(editor);
    await settle(b.page);
    net.expectQuiet();
  } finally {
    await a.ctx.close();
    await b.ctx.close();
  }
});
