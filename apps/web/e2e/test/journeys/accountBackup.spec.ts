// Journey — a member backs up their things and brings them back.
//
//   Profile → Download a backup (one zip of their own layouts, modules,
//   venues and engines and cars; not their club's) → a layout and a venue
//   are deleted → Restore from a backup → the list says what comes back:
//   the deleted ones ticked, what they still have left out, a name they
//   already use renamed "… (restored)" → Restore → the things are back as
//   new copies, and nothing they had was changed. A layout's places, its
//   modules' places and a library module's come back with them, and so do
//   the cars standing on its track, their waybills and its jobs, which a
//   copy of the layout has too, and an older version put back.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { test, expect } from '@playwright/test';
import { mapMenu, signIn } from '../../helpers';

const ts = Date.now();
const EMAIL = `j-backup-${ts}@example.com`;
const BBM = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures/tight-corner.bbm'), 'utf-8');
const place = (id: string, name: string) => ({ id, name, kind: 'industry', spots: [], accepts: ['reefer'], ships: [], tags: [], notes: 'Ice at\nthe yard' });
// Two cars coupled on the track, one loaded, and an empty cut another was coupled away from.
const CARS = [
  { id: 'c1', number: '101', length: 20, trucks: [{ at: 5, swivelMax: 30 }, { at: -5, swivelMax: 30 }], opsCut: 'ct-1', opsLoad: 'loaded', opsWaybill: 'wb-1', opsHome: 'pl-1' },
  { id: 'c2', number: '102', length: 20, trucks: [{ at: 5, swivelMax: 30 }, { at: -5, swivelMax: 30 }], opsCut: 'ct-1', opsHold: true },
];
const WAYBILLS = [{ id: 'wb-1', car: 'c1', from: 'pl-1', leg: 1, to1: 'pl-2', spot1: '', load1: 'loaded', note1: 'Ice first', to2: 'pl-1', spot2: '', load2: 'empty', note2: '' }];
// An ended session and its log (Live Ops design 2.5): they go along with the layout, as they were.
const SESSIONS = [{ id: 'os-1', name: 'Session 1 — Nov 22', status: 'ended', seed: 7, layout: 'old', host: 'sam', crew: [{ userId: '', name: 'Guest 1', role: 'crew', places: [], job: 'jb-1' }], clockFast: 4, clockStart: '06:00', startedAt: 1.7e12, endedAt: 1.7e12 + 3600e3, start: null }];
const LOG = [{ id: 'log-1', session: 'os-1', at: 1.7e12 + 60e3, by: 'sam', kind: 'move', what: 'ct-1', from: null, to: { brick: '222', from: 0, to: 1, s: 4, facing: 'to' }, note: '' }];
const JOBS = [{ id: 'jb-1', name: 'Cannery Turn', kind: 'turn', train: '', order: 1, stop_a: { place: 'pl-1', at: 1 }, stop_b: { place: 'pl-2', at: 2 } }];
const CUTS = [
  { id: 'ct-1', name: '', cut: true, units: [{ stock: 'c1', reversed: false }, { stock: 'c2', reversed: true }], position: { brick: '222', from: 0, to: 1, s: 4, facing: 'to' }, over: { '222/0': 1 }, color: '#B40000', speed: 40, trackKind: 'rail' },
  { id: 'ct-2', name: '', cut: true, units: [], position: { brick: '222', from: 0, to: 1, s: 9, facing: 'from' }, over: {}, emptiedAt: 1.7e12, color: '#B40000', speed: 40, trackKind: 'rail' },
];
const ROOM = { name: 'Hall', enabled: true, edges: [], obstacles: [], minWalkwayStuds: 0 };

test('a member downloads a backup of their things and restores what they lost', async ({ page }, info) => {
  test.setTimeout(180_000);
  await signIn(page, EMAIL, `Backer ${ts}`);
  const docOf = async (url: string): Promise<Y.Doc> => {
    const res = await page.request.get(url);
    expect(res.ok(), url).toBe(true);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(await res.body()));
    return doc;
  };
  const placesIn = (doc: Y.Doc) => (doc.getMap('meta').get('places') as Y.Map<unknown> | undefined)?.toJSON() ?? {};
  const post = async (url: string, data: unknown) => {
    const res = await page.request.post(url, { data });
    expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
    return (await res.json()) as { id: string };
  };
  const yard = await post('/api/layouts', {
    title: `Yard ${ts}`,
    bbm: BBM,
    sidecar: JSON.stringify({
      schemaVersion: 1,
      bbmHashSha256: '',
      modules: [{ id: 'depot', name: 'Depot', members: ['222'], transform: [1, 0, 0, 0, 1, 0, 0, 0, 1], places: [place('pl-2', 'Depot dock')] }],
      layoutPlaces: [place('pl-1', 'Acme Cannery')],
      rollingStock: CARS,
      trains: CUTS,
      waybills: WAYBILLS,
      opsJobs: JOBS,
      opsSessions: SESSIONS,
      opsLog: LOG,
    }),
  });
  await post('/api/layouts', { title: `Harbor ${ts}` });
  const corner = await post('/api/modules', { title: `Corner ${ts}` });
  const cornerDoc = await docOf(`/api/modules/${corner.id}/snapshot`);
  cornerDoc.transact(() => {
    const all = new Y.Map<unknown>();
    cornerDoc.getMap('meta').set('places', all);
    all.set('pl-3', new Y.Map(Object.entries(place('pl-3', 'Corner mill'))));
  });
  const put = await page.request.put(`/api/modules/${corner.id}/snapshot`, { headers: { 'content-type': 'application/octet-stream' }, data: Buffer.from(Y.encodeStateAsUpdate(cornerDoc)) });
  expect(put.ok(), await put.text()).toBe(true);
  const hall = await post('/api/venues', { name: `Hall ${ts}`, data: ROOM });
  await post('/api/rolling-stock', { record: { number: '4014', name: `Big Boy ${ts}`, length: 36 } });

  // ── Download. ──
  await page.goto('/profile');
  const section = page.locator('section#backup');
  await expect(section.getByRole('heading', { name: /Back up your things/ })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), section.getByRole('button', { name: 'Download a backup' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^my-brick-layouts-backup-\d{4}-\d{2}-\d{2}\.zip$/);
  const saved = info.outputPath('backup.zip');
  await download.saveAs(saved);
  expect(readFileSync(saved).subarray(0, 2).toString('latin1')).toBe('PK');
  await expect(section.getByText(/Saved my-brick-layouts-backup-.* with 5 things in it/)).toBeVisible();

  // ── Things go missing; one is replaced by another of the same name. ──
  expect((await page.request.delete(`/api/layouts/${yard.id}`)).ok()).toBe(true);
  expect((await page.request.delete(`/api/venues/${hall.id}`)).ok()).toBe(true);
  await post('/api/venues', { name: `Hall ${ts}`, data: ROOM });

  // ── Restore: the list says what happens to each. ──
  await section.locator('input[type=file]').setInputFiles(saved);
  const plan = section.getByRole('region', { name: 'What to restore' });
  await expect(plan).toBeVisible();
  await expect(plan.getByLabel(`Restore Yard ${ts}`)).toBeChecked();
  await expect(plan.getByLabel(`Restore Harbor ${ts}`)).not.toBeChecked();
  await expect(plan.getByText('You still have this one').first()).toBeVisible();
  await expect(plan.getByLabel(`Restore Hall ${ts}`)).toBeChecked();
  await expect(plan.getByText(`so it comes back as “Hall ${ts} (restored)”`)).toBeVisible();
  // A copy of one they still have, too: the module and the engine.
  await plan.getByLabel(`Restore Corner ${ts}`).check();
  await plan.getByLabel(`Restore 4014 Big Boy ${ts}`).check();
  await plan.getByRole('button', { name: 'Restore 4 things' }).click();
  await expect(section.getByText('Restored 4 things.')).toBeVisible({ timeout: 60_000 });

  // ── Back as new copies; nothing else changed. ──
  const layouts = ((await (await page.request.get('/api/layouts?owner=me')).json()) as { layouts: { id: string; title: string }[] }).layouts;
  expect(layouts.filter((l) => l.title === `Yard ${ts}`)).toHaveLength(1);
  expect(layouts.find((l) => l.title === `Yard ${ts}`)!.id).not.toBe(yard.id);
  expect(layouts.filter((l) => l.title === `Harbor ${ts}`)).toHaveLength(1);
  const venues = ((await (await page.request.get('/api/venues?owner=me')).json()) as { venues: { name: string }[] }).venues.map((v) => v.name).sort();
  expect(venues).toEqual([`Hall ${ts}`, `Hall ${ts} (restored)`]);
  const library = ((await (await page.request.get('/api/modules?owner=me')).json()) as { modules: { id: string; title: string }[] }).modules;
  expect(library.map((m) => m.title).sort()).toEqual([`Corner ${ts}`, `Corner ${ts} (restored)`]);
  const stock = ((await (await page.request.get('/api/rolling-stock?owner=me')).json()) as { stock: { name: string }[] }).stock.map((x) => x.name).sort();
  expect(stock).toEqual([`Big Boy ${ts}`, `Big Boy ${ts} (restored)`]);

  // The places came back: the layout's own, its module's, and the library module's.
  const restored = layouts.find((l) => l.title === `Yard ${ts}`)!;
  const yardDoc = await docOf(`/api/layouts/${restored.id}/snapshot`);
  expect(placesIn(yardDoc)).toEqual({ 'pl-1': place('pl-1', 'Acme Cannery') });
  const cache = yardDoc.getMap('meta').get('cache') as { modules: { id: string; places: unknown }[] };
  expect(cache.modules.map((m) => [m.id, m.places])).toEqual([['depot', [place('pl-2', 'Depot dock')]]]);
  const byId = (list: readonly { id: string }[]) => Object.fromEntries(list.map((x) => [x.id, x]));
  const records = (doc: Y.Doc, key: string) => (doc.getMap('meta').get(key) as Y.Map<unknown> | undefined)?.toJSON() ?? {};
  // Its cars stand where they did, coupled and loaded; a copy of the layout has them too.
  const copy = await post(`/api/layouts/${restored.id}/copy`, {});
  for (const doc of [yardDoc, await docOf(`/api/layouts/${copy.id}/snapshot`)]) {
    expect(records(doc, 'rollingStock')).toEqual(byId(CARS));
    expect(records(doc, 'trains')).toEqual(byId(CUTS));
    expect(records(doc, 'waybills')).toEqual(byId(WAYBILLS));
    expect(records(doc, 'opsJobs')).toEqual(byId(JOBS));
    expect(records(doc, 'opsSessions')).toEqual(byId(SESSIONS));
    expect(records(doc, 'opsLog')).toEqual(byId(LOG));
  }
  const cornerCopy = library.find((m) => m.title === `Corner ${ts} (restored)`)!;
  expect(placesIn(await docOf(`/api/modules/${cornerCopy.id}/snapshot`))).toEqual({ 'pl-3': place('pl-3', 'Corner mill') });

  // The restored layout opens, with its cannery in Places.
  await page.goto(`/editor/${restored.id}`);
  await expect(page.getByText(`Yard ${ts}`).first()).toBeVisible({ timeout: 30_000 });
  await mapMenu(page, 'Modules & sets', 'Places');
  await expect(page.getByTestId('places-panel')).toContainText('Acme Cannery');
});
