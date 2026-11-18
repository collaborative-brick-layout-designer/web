// E2E: read-only module sharing with the desktop app in the layout
// (docs/shared-modules.md, phase 1). The desktop side is `bld_sync_driver`,
// the desktop's own SyncSession, lock (edit/SharedLock) and API calls,
// driven over stdin; the web side is the real server and the web editor in
// a browser.
//
//   - Alice (web) shares her module with her club; Bob (web) places it in
//     the club's layout, which moves the layout to doc shape 4;
//   - the desktop opens that layout: it reads shape 4, and sees the module
//     as shared, by Alice, at version 1;
//   - on the desktop a change to its parts or its name is refused with the
//     plain reason, and nothing is sent (the connection stays);
//   - the desktop moves the module as a whole: the server takes it, the
//     web sees it, and the module's placement follows;
//   - Alice saves version 2; the desktop asks the server to put it in
//     (Update): one writer, so the desktop and the web both get the new
//     parts once, where the desktop moved the module to; asking again
//     changes nothing;
//   - the web presses Go back, and the desktop follows;
//   - the update keeps the track that didn't change (its id; doc shape 5),
//     and the desktop's undo of its move, made before the update, takes
//     the whole module back (the new track too); redo moves it again;
//   - an older desktop (2.1.4, which reads up to doc shape 3) refuses the
//     layout cleanly and changes nothing (BLD_SYNC_DRIVER_OLD; skipped
//     without it); so does one that reads up to shape 4 (2.1.6,
//     BLD_SYNC_DRIVER_SHAPE4) once an update kept parts.
//
// It was written in the desktop repo with the desktop side, and lives here
// now. CI runs it on main and nightly with the desktop's main driver
// (live-smoke.yml); by hand, against a web stack:
//
//   BLD_SYNC_DRIVER=<build>/src/app/bld_sync_driver \
//   BLD_SYNC_DRIVER_OLD=<2.1.4 build>/src/app/bld_sync_driver \
//   BLD_SYNC_DRIVER_SHAPE4=<2.1.6 build>/src/app/bld_sync_driver \
//   BLD_SYNC_SERVER=http://127.0.0.1:3000 \
//   pnpm --filter @cld/web exec playwright test sharedModulesDesktop
//
// A second test does the same for a partner club's module (section 11): the
// desktop, as Train Club's admin, sees the partner in the Share dialog's
// answer, shares the club's module with it at once and offers it to another
// club (which the web shows that club live, and the desktop takes back); a
// Riverside LUG member places it from the web's Clubs tab; the desktop, as
// another member, lists it as another club's module and finds it locked,
// shared by Train Club, in the club's layout.
//
// Needs BLD_SYNC_DRIVER (path to the built driver); skipped without it.
// BLD_SYNC_DRIVER_OLD is optional (the older-desktop part is skipped without it).

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { signIn } from '../helpers';

const DRIVER = process.env.BLD_SYNC_DRIVER;
const OLD_DRIVER = process.env.BLD_SYNC_DRIVER_OLD;
/** A desktop that reads up to doc shape 4 (2.1.6): it must refuse the layout once an update kept parts (shape 5). Optional. */
const SHAPE4_DRIVER = process.env.BLD_SYNC_DRIVER_SHAPE4;
const SERVER = process.env.BLD_SYNC_SERVER ?? 'http://127.0.0.1:3000';
const ts = Date.now();
const ALICE = `shared-desk-alice-${ts}@example.com`;
const BOB = `shared-desk-bob-${ts}@example.com`;
const PART = 'ts_narrowgauge_straight.8';
const CLUB = `Harbor LUG ${ts % 100000}`;
const NAME = `Harbor crane ${ts % 100000}`;

/** The desktop driver: one command line in, one reply line out. */
class Driver {
  private proc: ChildProcessWithoutNullStreams;
  private lines: string[] = [];
  private waiters: ((line: string) => void)[] = [];
  private stderr = '';

  constructor(path: string, token: string) {
    this.proc = spawn(path, [SERVER], { env: { ...process.env, BLD_SYNC_TOKEN: token } });
    createInterface({ input: this.proc.stdout }).on('line', (l) => {
      const w = this.waiters.shift();
      if (w) w(l);
      else this.lines.push(l);
    });
    this.proc.stderr.on('data', (d: Buffer) => (this.stderr += d.toString()));
  }

  /** Run a command; the whole reply line ("ok …" or "error …"). */
  async say(cmd: string): Promise<string> {
    this.proc.stdin.write(`${cmd}\n`);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`driver: no reply to "${cmd}"\n${this.stderr}`)), 45_000);
      const done = (l: string) => {
        clearTimeout(timer);
        resolve(l);
      };
      const queued = this.lines.shift();
      if (queued !== undefined) done(queued);
      else this.waiters.push(done);
    });
  }

  /** Run a command; returns what follows "ok", throws on "error". */
  async run(cmd: string): Promise<string> {
    const line = await this.say(cmd);
    if (!line.startsWith('ok')) throw new Error(`driver: "${cmd}" -> ${line}`);
    return line.slice(2).trim();
  }

  async json<T>(cmd: string): Promise<T> {
    return JSON.parse(await this.run(cmd)) as T;
  }

  async close(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    this.proc.stdin.write('quit\n');
    await new Promise((r) => {
      this.proc.once('exit', r);
      setTimeout(r, 3000);
    });
    this.proc.kill();
  }
}

interface Shared {
  id: string;
  moduleId: string;
  version: number;
  by: string;
  name: string;
  members: string[];
  placement: { degrees: number; x: number; y: number } | null;
  review: { from: number; to: number } | null;
}
interface Brick {
  id: string;
  x: number;
  y: number;
  orientation: number;
}

/** An API token for the driver, from the device sign-in the desktop app uses. */
async function desktopToken(page: Page, request: APIRequestContext): Promise<string> {
  const code = (await (
    await request.post('/api/auth/device/code', { data: { client_name: 'Sync driver', scope: 'layouts:read layouts:write' } })
  ).json()) as { device_code: string; user_code: string };
  expect((await page.request.post('/api/auth/device/approve', { data: { user_code: code.user_code } })).ok()).toBe(true);
  const tok = await request.post('/api/auth/device/token', {
    data: { device_code: code.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
  });
  expect(tok.ok()).toBe(true);
  return ((await tok.json()) as { access_token: string }).access_token;
}

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}

async function post(page: Page, url: string, data: object) {
  const res = await page.request.post(url, { data });
  expect(res.ok(), `${url}: ${res.status()} ${await res.text()}`).toBe(true);
  return res.json() as Promise<Record<string, string>>;
}

async function placePart(page: Page): Promise<void> {
  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
}

async function saveWithNote(page: Page, note: string): Promise<void> {
  await page.getByLabel('What changed (optional)').fill(note);
  await page.getByRole('button', { name: 'Save module' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
}

async function openPanel(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel(label, { exact: true }).check();
  await page.mouse.click(400, 400);
}

/** Every brick of the server's layout, from its .bbm export. */
async function serverBricks(page: Page, id: string): Promise<Brick[]> {
  const res = await page.request.get(`/api/layouts/${id}/export.bbm`);
  expect(res.ok()).toBe(true);
  const out: Brick[] = [];
  for (const m of (await res.text()).matchAll(/<Brick id="([^"]+)">([\s\S]*?)<\/Brick>/g)) {
    const field = (tag: string) => Number(new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(m[2]!)![1]);
    out.push({ id: m[1]!, x: field('X'), y: field('Y'), orientation: field('Orientation') });
  }
  return out;
}

test('a shared module with the web and the desktop in one layout', async ({ page, browser, request }) => {
  test.skip(!DRIVER, 'BLD_SYNC_DRIVER (the desktop repo’s bld_sync_driver) is not set');
  test.setTimeout(300_000);

  // Alice makes the module (one track) and a club with Bob in it, and shares the module with the club.
  await signIn(page, ALICE, 'Alice');
  await page.setViewportSize({ width: 1400, height: 1200 });
  const bob = await (await browser.newContext({ viewport: { width: 1400, height: 1200 } })).newPage();
  await signIn(bob, BOB, 'Bob');
  const club = await post(page, '/api/orgs', { name: CLUB });
  const invite = await post(page, `/api/orgs/${club.slug}/invites`, { email: BOB, role: 'member' });
  await post(bob, `/api/org-invites/${invite.token}`, {});

  await page.goto('/');
  await page.getByRole('button', { name: 'New module' }).click();
  const made = page.getByRole('dialog', { name: 'New module' });
  await made.getByLabel('Title').fill(NAME);
  await made.getByRole('button', { name: 'Create and open' }).click();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  const moduleUrl = page.url();
  const libraryId = /\/modules\/([^/?#]+)/.exec(moduleUrl)![1]!;
  await placePart(page);
  await expect.poll(() => brickCount(page)).toBe(1);
  await saveWithNote(page, 'One track');
  await post(page, `/api/modules/${libraryId}/club-shares`, { orgSlug: club.slug! });

  // Bob (web) places it in a layout of the club's: the layout is shape 4 from here.
  const layout = await post(bob, '/api/layouts', { title: `Show plan ${ts}`, orgSlug: club.slug! });
  await bob.goto(`/editor/${layout.id}`);
  await expect(bob.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await openPanel(bob, 'Module library');
  await bob.getByTestId('module-library-tab-shared').click();
  await bob.getByTestId('module-library-row').filter({ hasText: NAME }).getByRole('button', { name: 'Add to layout' }).click();
  await expect.poll(() => brickCount(bob)).toBe(1);
  await openPanel(bob, 'Modules');
  await expect(bob.getByTestId('module-shared-note')).toContainText('Shared by Alice · v1');

  // An older desktop (2.1.4: reads up to shape 3) is told plainly instead of
  // being cut off mid-edit: it never gets in step, and it changes nothing.
  const before = await serverBricks(bob, layout.id!);
  if (OLD_DRIVER) {
    const old = new Driver(OLD_DRIVER, await desktopToken(bob, request));
    try {
      await old.run(`open ${layout.id}`);
      const answer = await old.say('wait-synced 8000');
      expect(answer.startsWith('error'), `the older desktop: ${answer}`).toBe(true);
      expect(await serverBricks(bob, layout.id!)).toEqual(before);
      await expect(bob.getByTestId('module-shared-note')).toContainText('Shared by Alice · v1');
    } finally {
      await old.close();
    }
  }

  // This desktop reads shape 4: Bob opens the same layout there.
  const driver = new Driver(DRIVER!, await desktopToken(bob, request));
  try {
    await driver.run('name Bob on desktop');
    await driver.run(`open ${layout.id}`);
    await driver.run('wait-synced');
    let shared = await driver.json<Shared[]>('shared');
    expect(shared).toHaveLength(1);
    const m = shared[0]!;
    expect(m).toMatchObject({ moduleId: libraryId, version: 1, by: 'Alice', name: NAME });
    expect(m.members).toHaveLength(1);
    expect(m.placement).not.toBeNull();

    // The lock: its name and its parts are its owner's. Nothing is sent; the connection stays.
    const renamed = await driver.say(`module-rename ${m.id} My crane`);
    expect(renamed).toBe(`error locked: “${NAME}” is shared by Alice, so its name is Alice's. You can move it, turn it and change its outline color.`);
    const deleted = await driver.say(`brick-delete ${m.members[0]}`);
    expect(deleted).toContain('error locked:');
    expect(deleted).toContain("so its parts can't be changed here");
    expect(await driver.run('status')).toContain('Synced');
    expect(await serverBricks(bob, layout.id!)).toEqual(before);
    await expect(bob.getByTestId('module-shared-note')).toContainText('Shared by Alice · v1');

    // Moved as a whole: an ordinary edit. The server takes it, and the placement follows.
    await driver.run(`module-move ${m.id} 32 16`);
    await expect
      .poll(async () => (await serverBricks(bob, layout.id!)).map((b) => [b.x - before[0]!.x, b.y - before[0]!.y]), { timeout: 15000 })
      .toEqual([[32, 16]]);
    shared = await driver.json<Shared[]>('shared');
    expect(shared[0]!.placement!.x - m.placement!.x).toBeCloseTo(32, 6);
    expect(shared[0]!.placement!.y - m.placement!.y).toBeCloseTo(16, 6);
    expect(await driver.run('status')).toContain('Synced');

    // Alice saves version 2 (a second track).
    const editor = await page.context().newPage();
    await editor.goto(moduleUrl);
    await expect.poll(() => brickCount(editor), { timeout: 20000 }).toBe(1);
    await placePart(editor);
    await expect.poll(() => brickCount(editor)).toBe(2);
    await saveWithNote(editor, 'longer pier');
    await editor.close();

    // The desktop is told there is one, and may update (Bob edits the club's layouts).
    await expect
      .poll(async () => (await driver.json<{ canUpdate: boolean; modules: { placedId: string; latest: number; latestNote: string; owner: string }[] }>('shared-rows')).modules[0]?.latest, { timeout: 15000 })
      .toBe(2);
    const rows = await driver.json<{ canUpdate: boolean; canDetach: boolean; modules: { placedId: string; state: string; latestNote: string; owner: string }[] }>('shared-rows');
    expect(rows.canUpdate).toBe(true);
    expect(rows.canDetach).toBe(false);
    expect(rows.modules[0]).toMatchObject({ placedId: m.id, state: 'shared', latestNote: 'longer pier', owner: 'Alice' });

    // Update from the desktop: the server puts version 2 in, for the desktop and the web, once.
    // (A desktop from before doc shape 5, such as CI's main build until the desktop's shape-5 release,
    // is told plainly that the layout needs a newer version once the update keeps parts: checked, and the rest skipped.)
    const keepsIds = (await driver.say('features')).includes('keepIds');
    expect(await driver.json('shared-apply ' + m.id + ' 2')).toEqual({ changed: true, version: 2, from: 1 });
    if (!keepsIds) {
      await expect.poll(() => brickCount(bob), { timeout: 20000 }).toBe(2);
      await expect.poll(async () => await driver.say('wait-synced 2000'), { timeout: 20000 }).toMatch(/^error/);
      return;
    }
    await expect.poll(async () => (await driver.json<Shared[]>('shared'))[0]?.version, { timeout: 15000 }).toBe(2);
    shared = await driver.json<Shared[]>('shared');
    expect(shared[0]!.members).toHaveLength(2);
    expect(shared[0]!.review).toEqual({ from: 1, to: 2 });
    await expect.poll(() => brickCount(bob), { timeout: 20000 }).toBe(2);
    await expect(bob.getByTestId('shared-module-updated')).toContainText(`“${NAME}” is now version 2.`);
    // Where the desktop moved it: the first track hasn't gone back.
    const after = await serverBricks(bob, layout.id!);
    expect(after).toHaveLength(2);
    expect(after.some((b) => Math.abs(b.x - (before[0]!.x + 32)) < 0.01 && Math.abs(b.y - (before[0]!.y + 16)) < 0.01)).toBe(true);
    // The track that didn't change is the same part (its id): the layout is shape 5 from here.
    expect(shared[0]!.members).toContain(m.members[0]);
    // The desktop's undo of its move, made before the update, takes the whole module back, the
    // new track too, as one change; redo moves it all again.
    const spotsOf = (bricks: { x: number; y: number }[]) => bricks.map((b) => `${b.x.toFixed(2)},${b.y.toFixed(2)}`).sort();
    expect(await driver.run('undo')).toBe('true');
    await expect
      .poll(async () => spotsOf(await serverBricks(bob, layout.id!)), { timeout: 15000 })
      .toEqual(spotsOf(after.map((b) => ({ x: b.x - 32, y: b.y - 16 }))));
    expect(await driver.run('redo')).toBe('true');
    await expect.poll(async () => spotsOf(await serverBricks(bob, layout.id!)), { timeout: 15000 }).toEqual(spotsOf(after));
    expect(await driver.run('status')).toContain('Synced');
    // A desktop that reads up to shape 4 is told plainly, and changes nothing.
    if (SHAPE4_DRIVER) {
      const older = new Driver(SHAPE4_DRIVER, await desktopToken(bob, request));
      try {
        await older.run(`open ${layout.id}`);
        const answer = await older.say('wait-synced 8000');
        expect(answer.startsWith('error'), `the shape-4 desktop: ${answer}`).toBe(true);
        expect(spotsOf(await serverBricks(bob, layout.id!))).toEqual(spotsOf(after));
      } finally {
        await older.close();
      }
    }
    // Pressed again (or by someone else at the same moment): nothing more changes.
    expect(await driver.json('shared-apply ' + m.id + ' 2')).toEqual({ changed: false, version: 2, from: 2 });
    expect(await serverBricks(bob, layout.id!)).toHaveLength(2);
    expect(await driver.run('status')).toContain('Synced');

    // The web goes back to version 1: the desktop follows.
    await bob.getByTestId('shared-module-updated').getByRole('button', { name: 'Go back to version 1' }).click();
    await expect.poll(() => brickCount(bob), { timeout: 20000 }).toBe(1);
    await expect.poll(async () => (await driver.json<Shared[]>('shared'))[0]?.version, { timeout: 15000 }).toBe(1);
    shared = await driver.json<Shared[]>('shared');
    expect(shared[0]!.members).toHaveLength(1);
    expect(await driver.run('status')).toContain('Synced');

    // Make it mine is the layout owner's: a member is told so, in the server's words for the app to show.
    expect(await driver.say(`shared-detach ${m.id}`)).toBe('error 403 only_the_layouts_owner');
  } finally {
    await driver.close();
  }
});

test('a partner club’s module with the web and the desktop', async ({ page, browser, request }) => {
  test.skip(!DRIVER, 'BLD_SYNC_DRIVER (the desktop repo’s bld_sync_driver) is not set');
  test.setTimeout(240_000);
  const n = (Date.now() + 7) % 100000;
  const TINA = `partner-desk-tina-${ts}@example.com`;
  const RITA = `partner-desk-rita-${ts}@example.com`;
  const LOU = `partner-desk-lou-${ts}@example.com`;
  const HANK = `partner-desk-hank-${ts}@example.com`;
  const TRAIN = `Train Club ${n}`;
  const LUG = `Riverside LUG ${n}`;
  const HILL = `Hill Club ${n}`;
  const CRANE = `Partner crane ${n}`;
  await page.setViewportSize({ width: 1300, height: 1100 });
  await signIn(page, TINA, 'Tina');
  const other = async (email: string, name: string) => {
    const p = await (await browser.newContext({ viewport: { width: 1300, height: 1100 } })).newPage();
    await signIn(p, email, name);
    return p;
  };
  const rita = await other(RITA, 'Rita');
  const lou = await other(LOU, 'Lou');
  const hank = await other(HANK, 'Hank');
  const train = await post(page, '/api/orgs', { name: TRAIN });
  const lug = await post(rita, '/api/orgs', { name: LUG });
  const hill = await post(hank, '/api/orgs', { name: HILL });
  // Listed, so its name shows to the club offering it (a club that isn't listed shows only its address).
  expect((await hank.request.patch(`/api/orgs/${hill.slug}`, { data: { listed: true } })).ok()).toBe(true);
  const invite = await post(rita, `/api/orgs/${lug.slug}/invites`, { email: LOU, role: 'member' });
  await post(lou, `/api/org-invites/${invite.token}`, {});
  // Partners (the web's Partner clubs section does this; covered in clubPartners.spec.ts).
  const asked = await post(page, `/api/orgs/${train.slug}/partners`, { slug: lug.slug! });
  await post(rita, `/api/orgs/${lug.slug}/partner-requests/${asked.id}/accept`, {});

  // Train Club's module, with one track.
  await page.goto('/');
  await page.getByRole('button', { name: 'New module' }).click();
  const made = page.getByRole('dialog', { name: 'New module' });
  await made.getByLabel('Title').fill(`${CRANE} draft`);
  await made.getByRole('button', { name: 'Create and open' }).click();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  const draft = page.url().split('/').pop()!.split('?')[0]!;
  await placePart(page);
  await expect.poll(() => brickCount(page)).toBe(1);
  await saveWithNote(page, 'One track');
  const crane = await post(page, `/api/modules/${draft}/copy`, { orgSlug: train.slug!, title: CRANE });

  // The desktop, as Train Club's admin: the partner, shared at once; another club, offered.
  const tina = new Driver(DRIVER!, await desktopToken(page, request));
  try {
    // A driver from before partner clubs (desktop 2.1.7 and older) doesn't know these commands.
    const knows = !(await tina.say('club-requests')).startsWith('error unknown command');
    test.skip(!knows, 'this BLD_SYNC_DRIVER predates partner clubs');
    const shares = await tina.json<{ canShareWithOtherClubs: boolean; club: string; partners: string[]; offers: unknown[] }>(`club-shares ${crane.id}`);
    expect(shares).toMatchObject({ canShareWithOtherClubs: true, club: TRAIN, partners: [LUG], offers: [] });
    expect(await tina.json(`club-share ${crane.id} ${lug.slug}`)).toEqual({ status: 'shared', name: LUG, slug: lug.slug });
    expect(await tina.json(`club-share ${crane.id} ${SERVER}/orgs/${hill.slug}`)).toEqual({ status: 'offered', name: HILL, slug: hill.slug });
    // Hill Club's page shows the offer with no reload; the desktop takes it back, and it goes there too.
    await hank.goto(`/orgs/${hill.slug}`);
    await expect(hank.getByTestId('module-offers-in')).toContainText(`${TRAIN} wants to share “${CRANE}” with you`);
    const hankDesk = new Driver(DRIVER!, await desktopToken(hank, request));
    try {
      expect(await hankDesk.json('club-requests')).toEqual([{ slug: hill.slug, name: HILL, count: 1 }]);
    } finally {
      await hankDesk.close();
    }
    const offers = (await tina.json<{ offers: { id: string; club: string; state: string }[] }>(`club-shares ${crane.id}`)).offers;
    expect(offers).toEqual([{ id: expect.any(String), club: HILL, state: 'pending' }]);
    expect(await tina.say(`club-offer-withdraw ${crane.id} ${offers[0]!.id}`)).toBe('ok');
    await expect(hank.getByTestId('module-offers-in')).toHaveCount(0, { timeout: 15000 });
    expect((await tina.json<{ clubs: { name: string; via: string }[] }>(`club-shares ${crane.id}`)).clubs).toEqual([{ name: LUG, via: 'partner' }]);
  } finally {
    await tina.close();
  }

  // Lou places it from the web's Clubs tab in Riverside LUG's layout.
  const show = await post(rita, '/api/layouts', { title: `Partner plan ${n}`, orgSlug: lug.slug! });
  await lou.goto(`/editor/${show.id}`);
  await expect(lou.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await openPanel(lou, 'Module library');
  await lou.getByTestId('module-library-tab-clubs').click();
  await expect(lou.getByTestId('module-library-from-club').first()).toHaveText(`From ${TRAIN}`);
  await lou.getByTestId('module-library-row').filter({ hasText: CRANE }).getByRole('button', { name: 'Add to layout' }).click();
  await expect.poll(() => brickCount(lou)).toBe(1);

  // The desktop, as Rita (another member): another club's module in the library; in the layout, locked, shared by Train Club.
  const desk = new Driver(DRIVER!, await desktopToken(rita, request));
  try {
    const lib = await desk.json<{ id: string; owner: { kind: string; name: string }; fromAnotherClub: boolean; clubs: string[] }[]>('library-shared');
    expect(lib).toEqual([{ id: crane.id, title: CRANE, owner: { kind: 'org', name: TRAIN }, fromAnotherClub: true, clubs: [LUG] }]);
    await desk.run(`open ${show.id}`);
    await desk.run('wait-synced 20000');
    await expect.poll(async () => (await desk.json<Shared[]>('shared')).length, { timeout: 15000 }).toBe(1);
    const [m] = await desk.json<Shared[]>('shared');
    expect(m).toMatchObject({ moduleId: crane.id, by: TRAIN });
    expect(await desk.say(`module-rename ${m!.id} Our crane`)).toBe(
      `error locked: “${CRANE}” is shared by ${TRAIN}, so its name is ${TRAIN}'s. You can move it, turn it and change its outline color.`,
    );
    const rows = await desk.json<{ modules: { state: string; owner: string }[] }>('shared-rows');
    expect(rows.modules).toEqual([expect.objectContaining({ state: 'shared', owner: TRAIN })]);
  } finally {
    await desk.close();
  }
});
