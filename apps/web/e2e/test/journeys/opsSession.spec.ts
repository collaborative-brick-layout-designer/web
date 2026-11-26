// An operating session (Live Ops Phase 4), on tight-corner.bbm with two
// places on its track: Ada (the owner) starts a session with Ben, who only
// views the layout, as the crew of the Cannery Turn, and sends the job
// out. On his phone Ben sees he is the crew, moves the car at the cannery,
// and is told why he can't move the mill's car, which stays where it is.
// The board shows the job out; while the session runs Ada can't change
// the track, and when she ends it every car goes back where it started.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import * as Y from 'yjs';
import { mapMenu, signIn } from '../../helpers';

const BBM = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures/tight-corner.bbm'), 'utf-8');
const ts = Date.now();
const ADA = `j-ops-ada-${ts}@example.com`;
const BEN = `j-ops-ben-${ts}@example.com`;
const place = (id: string, name: string, brick: string) => ({ id, name, kind: 'industry', spots: [{ id: 's1', name: 'Dock', track: { brick, from: 0, to: 1 }, capacity: 2 }], accepts: [], ships: [], tags: [], notes: '' });
const car = (id: string, number: string) => ({ id, number, name: '', kind: 'car', type: 'boxcar', trackKind: 'rail', length: 20, width: 6, bodyLength: 18, trucks: [{ at: 5, swivelMax: 30 }, { at: -5, swivelMax: 30 }], opsCut: `cut-${id}` });
const cut = (id: string, brick: string) => ({ id: `cut-${id}`, name: '', cut: true, units: [{ stock: id, reversed: false }], position: { brick, from: 0, to: 1, s: 8, facing: 'to' }, over: {}, color: '#B40000', speed: 40, trackKind: 'rail' });
const SIDECAR = JSON.stringify({
  schemaVersion: 1,
  bbmHashSha256: '',
  layoutPlaces: [place('cannery', 'Acme Cannery', '141'), place('mill', 'Mill', '322')],
  rollingStock: [car('c1', '101'), car('c2', '102')],
  trains: [cut('c1', '141'), cut('c2', '322')],
  opsJobs: [
    { id: 'j1', name: 'Cannery Turn', kind: 'turn', train: '', order: 1, stop_a: { place: 'cannery', at: 1 } },
    { id: 'j2', name: 'Mill Job', kind: 'local', train: '', order: 2, stop_a: { place: 'mill', at: 1 } },
  ],
});

async function post(page: Page, url: string, data: object): Promise<Record<string, string>> {
  const res = await page.request.post(url, { data });
  expect(res.ok(), `${url}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as Record<string, string>;
}

/** Where each cut's head stands on the server, by its brick and distance. */
async function cutsOnServer(page: Page, id: string): Promise<Record<string, string>> {
  const res = await page.request.get(`/api/layouts/${id}/snapshot`);
  if (!res.ok()) return {};
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(await res.body()));
  const trains = ((doc.getMap('meta').get('trains') as Y.Map<unknown> | undefined)?.toJSON() ?? {}) as Record<string, { position: { brick: string; s: number } | null }>;
  return Object.fromEntries(Object.entries(trains).map(([k, t]) => [k, t.position ? `${t.position.brick}@${Math.round(t.position.s)}` : 'off']));
}

type N = { name: () => string; id: () => string; x: () => number; y: () => number; find: (f: (n: N) => boolean) => N[] };
function cars(page: Page): Promise<Record<string, { x: number; y: number }>> {
  return page.evaluate(() => {
    const st = (window as unknown as { Konva?: { stages: N[] } }).Konva?.stages[0];
    return st ? Object.fromEntries(st.find((n) => n.name() === 'car-hit').map((n) => [n.id(), { x: n.x() / 8, y: n.y() / 8 }])) : {};
  });
}
/** Press on a car and pull it along (a picked car, on a phone: tap it first). */
async function dragCar(page: Page, id: string, dx: number, dy: number) {
  const at = (await cars(page))[id]!;
  const on = (x: number, y: number) =>
    page.evaluate(([sx, sy]) => {
      type St = { getAbsoluteTransform: () => { point: (p: { x: number; y: number }) => { x: number; y: number } }; container: () => HTMLElement };
      const st = (window as unknown as { Konva: { stages: St[] } }).Konva.stages[0]!;
      const p = st.getAbsoluteTransform().point({ x: sx! * 8, y: sy! * 8 });
      const box = st.container().getBoundingClientRect();
      return { x: box.left + p.x, y: box.top + p.y };
    }, [x, y]);
  const a = await on(at.x, at.y);
  const b = await on(at.x + dx, at.y + dy);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

test('a session with a viewer as crew: their car moves, another job’s doesn’t, the board, and every car put back', async ({ page, browser }) => {
  test.setTimeout(240_000);
  await signIn(page, ADA, 'Ada Host');
  const benContext = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const ben = await benContext.newPage();
  await signIn(ben, BEN, 'Ben Crew');
  const layout = await post(page, '/api/layouts', { title: `Ops night ${ts}`, bbm: BBM, sidecar: SIDECAR });
  const invite = await post(page, `/api/layouts/${layout.id}/invites`, { email: BEN, role: 'viewer' });
  await post(ben, `/api/invites/${invite.token}`, {});
  const before = await cutsOnServer(page, layout.id!);
  expect(before['cut-c1']).toBe('141@8');

  // Ada sets the session up: Ben is the Cannery Turn's crew.
  await page.goto(`/editor/${layout.id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.keyboard.press('f');
  await mapMenu(page, 'Modules & sets', 'Live Ops');
  const panel = page.getByTestId('ops-panel');
  await panel.getByTestId('ops-tab-session').click();
  await panel.getByTestId('ops-session-new').click();
  await panel.getByTestId('ops-crew-pick').selectOption({ label: 'Ben Crew' });
  await panel.getByTestId('ops-crew-add').click();
  await panel.getByLabel('Ben Crew’s job').selectOption({ label: 'Cannery Turn' });
  await panel.getByTestId('ops-session-start').click();
  await expect(page.getByTestId('ops-session-banner')).toContainText('you’re the Host');
  // The session panel shows over the map now (the map is locked): send the job out.
  await mapMenu(page, 'Modules & sets', 'Live Ops');
  const sheet = page.getByTestId('ops-panel');
  await sheet.getByTestId('ops-tab-session').click();
  await sheet.locator('[data-board-job="j1"]').getByRole('button', { name: 'Send out' }).click();
  await expect(sheet.locator('[data-board-job="j1"]').getByTestId('ops-board-status')).toHaveText('Out');

  // Ben, on his phone: he is the crew; the cannery's car moves.
  await ben.goto(`/editor/${layout.id}`);
  await expect(ben.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await expect(ben.getByTestId('ops-session-banner')).toContainText('you’re the Crew', { timeout: 15000 });
  await ben.waitForTimeout(1000);
  await dragCar(ben, 'c1', 4, 0);
  await expect.poll(async () => (await cutsOnServer(page, layout.id!))['cut-c1'], { timeout: 15000 }).not.toBe('141@8');
  // The mill's car is another job's: it stays, and he is told why.
  await dragCar(ben, 'c2', 4, 0);
  await expect(ben.getByText(/outside your role’s reach/)).toBeVisible();
  expect((await cutsOnServer(page, layout.id!))['cut-c2']).toBe(before['cut-c2']);
  // Nothing wider than his screen.
  expect(await ben.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // Ada ends it, putting every car back where it started.
  await sheet.getByTestId('ops-session-end').click();
  await sheet.getByTestId('ops-end-back').click();
  await expect(page.getByTestId('ops-session-banner')).toHaveCount(0);
  await expect.poll(async () => (await cutsOnServer(page, layout.id!))['cut-c1'], { timeout: 15000 }).toBe('141@8');
  await expect(ben.getByTestId('ops-session-banner')).toHaveCount(0, { timeout: 15000 });
  await benContext.close();
});
