// E2E: the desktop app and the web editor editing one layout live
// (DESKTOP-LIVE-SYNC phase P5). The desktop side is the desktop repo's
// headless `bld_sync_driver` — the desktop's own SyncSession and
// LayoutMerge, driven over stdin — against this real server; the web side
// is the editor in the browser. See references/DESKTOP-SYNC-E2E.md.
//
// Needs BLD_SYNC_DRIVER (path to the built driver); skipped without it.
// BLD_SYNC_SERVER is where the driver finds the API server (default
// http://127.0.0.1:3000). CI runs it on main and nightly (live-smoke.yml).

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapMenu, makeModule, signIn } from '../helpers';
import { engineIo } from '../stockModel';

const DRIVER = process.env.BLD_SYNC_DRIVER;
const SERVER = process.env.BLD_SYNC_SERVER ?? 'http://127.0.0.1:3000';
const TIGHT_CORNER_BBM = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures/tight-corner.bbm'),
  'utf-8',
);
const EMAIL = `desktop-sync-${Date.now()}@example.com`;
const WEB_NAME = 'Web Tester';
const DESKTOP_NAME = 'Desktop Driver';
const DESKTOP_EMAIL = `desktop-sync-driver-${Date.now()}@example.com`;
const STUD_PX = 8; // apps/web/src/editor/render/coords.ts

interface Pose {
  x: number;
  y: number;
  orientation: number;
}
type Poses = Map<string, Pose>;

const norm = (deg: number) => ((deg % 360) + 360) % 360;

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

  /** Run a command; returns what follows "ok", throws on "error". */
  async run(cmd: string): Promise<string> {
    this.proc.stdin.write(`${cmd}\n`);
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`driver: no reply to "${cmd}"\n${this.stderr}`)), 30_000);
      const done = (l: string) => {
        clearTimeout(timer);
        resolve(l);
      };
      const queued = this.lines.shift();
      if (queued !== undefined) done(queued);
      else this.waiters.push(done);
    });
    if (!line.startsWith('ok')) throw new Error(`driver: "${cmd}" -> ${line}`);
    return line.slice(2).trim();
  }

  async poses(which: '' | 'shared' = ''): Promise<Poses> {
    const bricks = JSON.parse(await this.run(`dump ${which}`)) as { id: string; x: number; y: number; orientation: number }[];
    return new Map(bricks.map((b) => [b.id, { x: b.x, y: b.y, orientation: b.orientation }]));
  }

  async peers(): Promise<{ user?: { displayName?: string }; cursor?: { x: number; y: number } | null }[]> {
    return JSON.parse(await this.run('peers'));
  }

  /** The editor's modules; null from a driver built before it had module commands. */
  async modules(): Promise<{ id: string; name: string; members: string[] }[] | null> {
    try {
      return JSON.parse(await this.run('modules'));
    } catch {
      return null;
    }
  }

  /** The desktop's switch settings, or null when this driver has no switch commands (older desktop). */
  async switches(): Promise<Record<string, number> | null> {
    try {
      return JSON.parse(await this.run('switches')) as Record<string, number>;
    } catch {
      return null;
    }
  }

  /** The desktop's named routes (id, name, steps, broken), or null when this driver has none (older desktop). */
  async routes(): Promise<{ id: string; name: string; steps: { brick: string }[]; broken: boolean }[] | null> {
    try {
      return JSON.parse(await this.run('routes'));
    } catch {
      return null;
    }
  }

  /** The desktop's rolling stock and trains, or null when this driver has none (older desktop). */
  async trains(): Promise<{ rollingStock: { id: string; number: string; length: number; kind?: string; trucks?: { at: number }[]; look?: { mode: string; partKey?: string }; model?: { partKey?: string; file?: string; format?: string } }[]; trains: { id: string; name: string; units: { stock: string }[]; position: { brick: string; facing: string } | null }[] } | null> {
    try {
      return JSON.parse(await this.run('trains'));
    } catch {
      return null;
    }
  }

  /** The desktop's places, the layout's own and each module's, or null when this driver has none (older desktop). */
  async places(): Promise<{ layout: Place[]; modules: { id: string; name: string; places: Place[] }[] } | null> {
    try {
      return JSON.parse(await this.run('places'));
    } catch {
      return null;
    }
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

/** Every brick of the server's layout, from its .bbm export. */
async function serverPoses(request: APIRequestContext, id: string): Promise<Poses> {
  const res = await request.get(`/api/layouts/${id}/export.bbm`);
  expect(res.ok()).toBe(true);
  const out: Poses = new Map();
  for (const m of (await res.text()).matchAll(/<Brick id="([^"]+)">([\s\S]*?)<\/Brick>/g)) {
    const field = (tag: string) => Number(new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(m[2]!)![1]);
    out.set(m[1]!, { x: field('X'), y: field('Y'), orientation: field('Orientation') });
  }
  return out;
}

/** Every brick as the browser draws it: its Konva group's pivot (px) and rotation. */
function browserPoses(page: Page): Promise<Record<string, Pose>> {
  return page.evaluate(() => {
    type Node = { name: () => string; getClassName: () => string; x: () => number; y: () => number; rotation: () => number };
    const K = (window as unknown as { Konva: { stages: { find: (s: (n: Node) => boolean) => Node[] }[] } }).Konva;
    const out: Record<string, { x: number; y: number; orientation: number }> = {};
    for (const n of K.stages.flatMap((st) => st.find((n: Node) => n.getClassName() === 'Group' && n.name().startsWith('brick-'))))
      out[n.name().slice('brick-'.length)] = { x: n.x(), y: n.y(), orientation: n.rotation() };
    return out;
  });
}

/** The bricks' boxes in the fixture (width, height), for quarter turns. */
const SIZES = new Map(
  [...TIGHT_CORNER_BBM.matchAll(/<Brick id="([^"]+)">[\s\S]*?<Width>([^<]*)<\/Width>\s*<Height>([^<]*)<\/Height>/g)].map(
    (m) => [m[1]!, { w: Number(m[2]), h: Number(m[3]) }],
  ),
);

/** A brick of `poses` given a quarter turn: its box swaps about the centre. */
function quarterTurn(poses: Poses, id: string): Pose {
  const p = poses.get(id)!;
  const { w, h } = SIZES.get(id)!;
  return { x: p.x + (w - h) / 2, y: p.y + (h - w) / 2, orientation: p.orientation + 90 };
}

/** Bricks where the desktop's map and the server's differ (none, once they agree). */
async function differences(driver: Driver, request: APIRequestContext, id: string): Promise<string[]> {
  const [mine, server] = [await driver.poses(), await serverPoses(request, id)];
  const all = new Set([...mine.keys(), ...server.keys()]);
  const key = (p?: Pose) => (p ? `${p.x},${p.y},${norm(p.orientation)}` : 'missing');
  return [...all].filter((b) => key(mine.get(b)) !== key(server.get(b)));
}

/** `base` with some bricks changed, as a plain comparable list. */
function expected(base: Poses, changes: Record<string, Partial<Pose>> = {}): [string, Pose][] {
  return [...base].map(([id, p]) => [id, { ...p, ...changes[id] }]);
}

function listed(poses: Poses): [string, Pose][] {
  return [...poses].map(([id, p]) => [id, { x: p.x, y: p.y, orientation: norm(p.orientation) }]);
}
function normalised(list: [string, Pose][]): [string, Pose][] {
  return list.map(([id, p]) => [id, { ...p, orientation: norm(p.orientation) }]);
}

/** The browser shows `want` for these bricks: moves against where they started, turns as given. */
async function expectBrowser(page: Page, start: Record<string, Pose>, base: Poses, want: Poses, ids: string[]) {
  await expect
    .poll(async () => {
      const now = await browserPoses(page);
      return ids.map((id) => {
        const w = want.get(id)!;
        const b = base.get(id)!;
        // Position only for bricks that didn't turn: a turn moves the pivot of a part with a hull.
        const turned = norm(w.orientation) !== norm(b.orientation);
        return {
          id,
          dx: turned ? 0 : Math.round((now[id]!.x - start[id]!.x) / STUD_PX),
          dy: turned ? 0 : Math.round((now[id]!.y - start[id]!.y) / STUD_PX),
          orientation: norm(now[id]!.orientation),
        };
      });
    }, { timeout: 10_000 })
    .toEqual(
      ids.map((id) => {
        const w = want.get(id)!;
        const b = base.get(id)!;
        const turned = norm(w.orientation) !== norm(b.orientation);
        return { id, dx: turned ? 0 : w.x - b.x, dy: turned ? 0 : w.y - b.y, orientation: norm(w.orientation) };
      }),
    );
}

/** An API token for the driver, from the device sign-in the desktop app uses. */
async function desktopToken(page: Page, request: APIRequestContext, scope = 'layouts:read layouts:write'): Promise<string> {
  const code = (await (
    await request.post('/api/auth/device/code', {
      data: { client_name: 'Sync driver', scope },
    })
  ).json()) as { device_code: string; user_code: string };
  expect((await page.request.post('/api/auth/device/approve', { data: { user_code: code.user_code } })).ok()).toBe(true);
  const tok = await request.post('/api/auth/device/token', {
    data: { device_code: code.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
  });
  expect(tok.ok()).toBe(true);
  return ((await tok.json()) as { access_token: string }).access_token;
}

/** Click candidate bricks until the web has exactly one selected. */
async function selectOneBrick(page: Page, candidates: string[]): Promise<void> {
  const footer = page.locator('footer');
  for (const id of candidates) {
    const at = await page.evaluate((id) => {
      type Node = { getClientRect: () => { x: number; y: number; width: number; height: number } };
      const K = (window as unknown as {
        Konva: { stages: { findOne: (s: string) => Node | undefined; container: () => HTMLElement }[] };
      }).Konva;
      for (const st of K.stages) {
        const n = st.findOne(`.brick-${id}`);
        if (!n) continue;
        const r = n.getClientRect();
        const c = st.container().getBoundingClientRect();
        return { x: c.x + r.x + r.width / 2, y: c.y + r.y + r.height / 2 };
      }
      return null;
    }, id);
    if (!at || at.x < 0 || at.y < 0 || at.x > page.viewportSize()!.width || at.y > page.viewportSize()!.height) continue;
    await page.mouse.click(at.x, at.y);
    if ((await footer.innerText()).includes('selected: 1')) return;
  }
  throw new Error('no brick could be selected on its own');
}

/** The bricks whose pose differs between two layouts. */
function movedBrick(before: Poses, after: Poses): string[] {
  return [...after].filter(([id, p]) => {
    const b = before.get(id)!;
    return b.x !== p.x || b.y !== p.y || norm(b.orientation) !== norm(p.orientation);
  }).map(([id]) => id);
}

interface Place {
  id: string;
  name: string;
  kind: string;
  spots: { id: string; name: string; track?: { brick: string; from: number; to: number }; capacity?: number }[];
}

test.describe('desktop and web live editing', () => {
  test.skip(!DRIVER, 'BLD_SYNC_DRIVER is not set: build bld_sync_driver in the desktop repo (-DBLD_SYNC=ON), see references/DESKTOP-SYNC-E2E.md');

  test('both end up identical: edits, undo, presence, offline and resolve', async ({ page, request, browser }) => {
    test.setTimeout(180_000);
    await signIn(page, EMAIL, WEB_NAME);
    const created = await page.request.post('/api/layouts', { data: { title: 'Desktop Sync E2E', bbm: TIGHT_CORNER_BBM } });
    expect(created.ok()).toBe(true);
    const { id } = (await created.json()) as { id: string };
    // The desktop is someone else, an editor (the web doesn't draw your own
    // other app's cursor as someone else's).
    const desk = await browser.newContext();
    await signIn(desk, DESKTOP_EMAIL, DESKTOP_NAME);
    const deskPage = await desk.newPage();
    const invite = await page.request.post(`/api/layouts/${id}/invites`, { data: { email: DESKTOP_EMAIL, role: 'editor' } });
    expect((await deskPage.request.post(`/api/invites/${((await invite.json()) as { token: string }).token}`)).ok()).toBe(true);
    const token = await desktopToken(deskPage, request);
    await desk.close();
    const driver = new Driver(DRIVER!, token);

    try {
      const base0 = await serverPoses(page.request, id);
      expect(base0.size).toBeGreaterThan(100);

      await test.step('1. the desktop joins the layout made on the web and sees it', async () => {
        await page.goto(`/editor/${id}`);
        await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
        await driver.run(`open ${id}`);
        await driver.run('wait-synced');
        expect(listed(await driver.poses())).toEqual(normalised(expected(base0)));
      });

      await page.waitForTimeout(1000); // first render settles
      await page.keyboard.press('f'); // fit, so every brick is on screen
      const start = await browserPoses(page);
      expect(Object.keys(start).length).toBe(base0.size);

      // Loose bricks (no group), which the web selects on their own.
      const bbmGroups = new Map(
        [...TIGHT_CORNER_BBM.matchAll(/<Brick id="([^"]+)">[\s\S]*?<MyGroup(?: \/>|>([^<]*)<\/MyGroup>)/g)].map((m) => [m[1]!, m[2] ?? '']),
      );
      const loose = [...base0.keys()].filter((b) => !bbmGroups.get(b));

      let A = '';
      let B = '';
      let C = '';
      await test.step('2. interleaved edits: the web moves one brick, the desktop moves and turns others', async () => {
        await selectOneBrick(page, loose);
        await page.keyboard.press('ArrowRight');
        await expect.poll(async () => movedBrick(base0, await serverPoses(page.request, id)).length).toBe(1);
        A = movedBrick(base0, await serverPoses(page.request, id))[0]!;
        [B, C] = loose.filter((b) => b !== A).slice(0, 2) as [string, string];

        await driver.run(`move ${B} 4 0`);
        await expect.poll(async () => (await serverPoses(page.request, id)).get(B)!.x).toBe(base0.get(B)!.x + 4);
        await page.keyboard.press('ArrowDown');
        await driver.run(`rotate ${C} 90`);

        const want = new Map(
          expected(base0, {
            [A]: { x: base0.get(A)!.x + 1, y: base0.get(A)!.y + 1 },
            [B]: { x: base0.get(B)!.x + 4 },
            [C]: quarterTurn(base0, C),
          }),
        );
        await expect.poll(async () => listed(await serverPoses(page.request, id))).toEqual(normalised([...want]));
        // The desktop's own map, brick by brick, is the server's.
        await expect.poll(() => differences(driver, page.request, id)).toEqual([]);
        await expectBrowser(page, start, base0, want, [A, B, C]);
      });

      await test.step('3. undo on the desktop reverts only the desktop\'s edits', async () => {
        expect(await driver.run('undo')).toBe('true');
        expect(await driver.run('undo')).toBe('true');
        const want = new Map(expected(base0, { [A]: { x: base0.get(A)!.x + 1, y: base0.get(A)!.y + 1 } }));
        await expect.poll(async () => listed(await serverPoses(page.request, id))).toEqual(normalised([...want]));
        expect(listed(await driver.poses())).toEqual(normalised([...want]));
        await expectBrowser(page, start, base0, want, [A, B, C]);
      });

      await test.step('4. presence: each side sees the other\'s cursor', async () => {
        await driver.run(`name ${DESKTOP_NAME}`);
        await driver.run('cursor 120 120');
        const cursorLabels = () =>
          page.evaluate((name) => {
            const K = (window as unknown as { Konva: { stages: { find: (s: string) => { text: () => string }[] }[] } }).Konva;
            return K.stages.flatMap((st) => st.find('Text')).filter((t) => t.text() === name).length;
          }, DESKTOP_NAME);
        await expect.poll(cursorLabels, { timeout: 10_000 }).toBeGreaterThan(0);

        const box = (await page.locator('.konvajs-content').first().boundingBox())!;
        await expect
          .poll(async () => {
            await page.mouse.move(box.x + box.width / 2 + Math.random() * 20, box.y + box.height / 2);
            return (await driver.peers()).some((p) => p.user?.displayName === WEB_NAME && !!p.cursor);
          }, { timeout: 10_000 })
          .toBe(true);
      });

      await test.step('5. offline: edits on both sides, one clash, resolved keeping mine', async () => {
        const s1 = await serverPoses(page.request, id);
        await driver.run('disconnect');
        // The web: A down one more (clashes with the desktop's move of A).
        await expect(page.locator('footer')).toContainText('selected: 1');
        await page.keyboard.press('ArrowDown');
        await expect.poll(async () => (await serverPoses(page.request, id)).get(A)!.y).toBe(s1.get(A)!.y + 1);
        // The desktop, offline: A right five, B right three, C turned.
        await driver.run(`move ${A} 5 0`);
        await driver.run(`move ${B} 3 0`);
        await driver.run(`rotate ${C} 90`);
        expect(await driver.run('status')).toBe('Offline 3');
        const webOnly = listed(new Map(expected(s1, { [A]: { y: s1.get(A)!.y + 1 } })));
        expect(listed(await serverPoses(page.request, id))).toEqual(webOnly);

        // Back online, the two edits nothing clashes with go to the server
        // by themselves (the desktop's #293); the move of A, which the web
        // moved too, waits for review.
        await driver.run('reconnect');
        await driver.run('wait-synced');
        const sentThemselves = normalised(
          expected(s1, { [A]: { y: s1.get(A)!.y + 1 }, [B]: { x: s1.get(B)!.x + 3 }, [C]: quarterTurn(s1, C) }),
        );
        await expect.poll(async () => listed(await serverPoses(page.request, id)), { timeout: 10_000 }).toEqual(sentThemselves);
        await page.waitForTimeout(1000);
        expect(listed(await serverPoses(page.request, id))).toEqual(sentThemselves);
        expect(await driver.run('status')).toBe('Synced 1');
        expect(listed(await driver.poses('shared'))).toEqual(sentThemselves);

        const keys = JSON.parse(await driver.run('resolve mine')) as string[];
        expect(keys.filter((k) => k.startsWith('brick:')).map((k) => k.split(':')[2])).toContain(A);
        const want = new Map(
          expected(s1, {
            [A]: { x: s1.get(A)!.x + 5 }, // mine, over the web's move down
            [B]: { x: s1.get(B)!.x + 3 },
            [C]: quarterTurn(s1, C),
          }),
        );
        await expect.poll(async () => listed(await serverPoses(page.request, id))).toEqual(normalised([...want]));
        expect(await driver.run('status')).toBe('Synced 0');
        await expect.poll(() => differences(driver, page.request, id)).toEqual([]);
        await expectBrowser(page, start, base0, want, [A, B, C]);
      });
    } finally {
      await driver.close();
    }
  });
  // The full review (area 4) ran browsers and one desktop. Two desktops on
  // one layout, here as two drivers with their own sign-ins:
  test('two desktops on one layout: both people’s edits stay and all three end up identical', async ({ page, request, browser }) => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    await signIn(page, `two-desks-owner-${stamp}@example.com`, 'Layout Owner');
    const created = await page.request.post('/api/layouts', { data: { title: 'Two desktops', bbm: TIGHT_CORNER_BBM } });
    expect(created.ok()).toBe(true);
    const { id } = (await created.json()) as { id: string };
    const desks: Driver[] = [];
    for (const who of ['Ann', 'Ben']) {
      const email = `two-desks-${who.toLowerCase()}-${stamp}@example.com`;
      const ctx = await browser.newContext();
      await signIn(ctx, email, `${who} Desktop`);
      const p = await ctx.newPage();
      const invite = await page.request.post(`/api/layouts/${id}/invites`, { data: { email, role: 'editor' } });
      expect((await p.request.post(`/api/invites/${((await invite.json()) as { token: string }).token}`)).ok()).toBe(true);
      const token = await desktopToken(p, request);
      await ctx.close();
      desks.push(new Driver(DRIVER!, token));
    }
    const [ann, ben] = desks as [Driver, Driver];
    /** Both desktops' maps are the server's, part by part. */
    const allAgree = async () => {
      await expect.poll(() => differences(ann, page.request, id), { timeout: 15_000 }).toEqual([]);
      await expect.poll(() => differences(ben, page.request, id), { timeout: 15_000 }).toEqual([]);
    };

    try {
      const base = await serverPoses(page.request, id);
      for (const [d, name] of [[ann, 'Ann'], [ben, 'Ben']] as const) {
        await d.run(`open ${id}`);
        await d.run('wait-synced');
        await d.run(`name ${name}`);
        expect((await d.poses()).size).toBe(base.size);
      }
      const [A, B, C] = [...base.keys()].slice(0, 3) as [string, string, string];

      await test.step('1. different parts moved at the same instant: both moves stay', async () => {
        await Promise.all([ann.run(`move ${A} 4 0`), ben.run(`move ${B} 0 3`)]);
        const want = expected(base, { [A]: { x: base.get(A)!.x + 4 }, [B]: { y: base.get(B)!.y + 3 } });
        await expect.poll(async () => listed(await serverPoses(page.request, id))).toEqual(normalised(want));
        await allAgree();
      });

      await test.step('2. the same part moved at the same instant, five times: one part, the same everywhere', async () => {
        for (let round = 0; round < 5; round++) {
          await Promise.all([ann.run(`move ${C} 1 0`), ben.run(`move ${C} 0 1`)]);
          await allAgree();
          const now = await serverPoses(page.request, id);
          expect(now.size, 'no part lost, none there twice').toBe(base.size);
          // It moved (one move, or both: across and down are separate values).
          const c = now.get(C)!;
          expect(c.x !== base.get(C)!.x || c.y !== base.get(C)!.y).toBe(true);
        }
      });

      await test.step('3. each desktop sees the other’s cursor', async () => {
        await ann.run('cursor 40 40');
        await ben.run('cursor 80 80');
        // (Each is shown under its account's name, "Ann Desktop": the server puts
        // the account's own name on every presence entry, whatever the app sent.)
        await expect.poll(async () => (await ben.peers()).some((p) => p.user?.displayName === 'Ann Desktop' && !!p.cursor), { timeout: 10_000 }).toBe(true);
        await expect.poll(async () => (await ann.peers()).some((p) => p.user?.displayName === 'Ben Desktop' && !!p.cursor), { timeout: 10_000 }).toBe(true);
      });

      await test.step('4. Undo on one desktop takes back only its own edit', async () => {
        const before = await serverPoses(page.request, id);
        await ann.run(`move ${A} 2 0`);
        await ben.run(`move ${B} 2 0`);
        await expect.poll(async () => (await serverPoses(page.request, id)).get(B)!.x).toBe(before.get(B)!.x + 2);
        await expect.poll(async () => (await ann.poses()).get(B)!.x).toBe(before.get(B)!.x + 2);
        expect(await ann.run('undo')).toBe('true');
        const want = expected(before, { [B]: { x: before.get(B)!.x + 2 } });
        await expect.poll(async () => listed(await serverPoses(page.request, id))).toEqual(normalised(want));
        await allAgree();
      });

      await test.step('5. one desktop offline, both edit different parts: back online both edits are there, unasked', async () => {
        const before = await serverPoses(page.request, id);
        await ann.run('disconnect');
        await ann.run(`move ${A} 1 0`);
        expect(await ann.run('status')).toBe('Offline 1');
        await ben.run(`move ${B} 0 1`);
        await expect.poll(async () => (await serverPoses(page.request, id)).get(B)!.y).toBe(before.get(B)!.y + 1);
        await ann.run('reconnect');
        await ann.run('wait-synced');
        const want = expected(before, { [A]: { x: before.get(A)!.x + 1 }, [B]: { y: before.get(B)!.y + 1 } });
        await expect.poll(async () => listed(await serverPoses(page.request, id)), { timeout: 15_000 }).toEqual(normalised(want));
        await expect.poll(() => ann.run('status')).toBe('Synced 0');
        await allAgree();
      });

      await test.step('6. offline and both move the same part: it waits for review, and “mine” puts it in', async () => {
        const before = await serverPoses(page.request, id);
        await ann.run('disconnect');
        await ann.run(`move ${C} 5 0`);
        await ben.run(`move ${C} 0 7`);
        await expect.poll(async () => (await serverPoses(page.request, id)).get(C)!.y).toBe(before.get(C)!.y + 7);
        await ann.run('reconnect');
        await ann.run('wait-synced');
        await page.waitForTimeout(1000);
        // Nothing of Ann's went by itself: it clashes with Ben's.
        expect((await serverPoses(page.request, id)).get(C)).toEqual({ ...before.get(C)!, y: before.get(C)!.y + 7 });
        expect(await ann.run('status')).toBe('Synced 1');
        await ann.run('resolve mine');
        await expect.poll(async () => (await serverPoses(page.request, id)).get(C)).toEqual({ ...before.get(C)!, x: before.get(C)!.x + 5 });
        expect(await ann.run('status')).toBe('Synced 0');
        await allAgree();
        expect((await serverPoses(page.request, id)).size).toBe(base.size);
      });
    } finally {
      await ann.close();
      await ben.close();
    }
  });

  // One module changed from the web and from the desktop at once (area 4
  // left it out). The web is in Edit module and places a part, which joins
  // the module; at that instant the desktop takes another part out.
  test('one module, the web and the desktop: a change from each at the same instant', async ({ page, request, browser }) => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    const NAME = `Corner ${stamp % 10000}`;
    await page.setViewportSize({ width: 1400, height: 900 });
    await signIn(page, `mod-desk-web-${stamp}@example.com`, 'Web Tester');
    const created = await page.request.post('/api/layouts', { data: { title: 'One module, web and desktop', bbm: TIGHT_CORNER_BBM } });
    const { id } = (await created.json()) as { id: string };
    const deskEmail = `mod-desk-driver-${stamp}@example.com`;
    const desk = await browser.newContext();
    await signIn(desk, deskEmail, 'Desktop Driver');
    const deskPage = await desk.newPage();
    const invite = await page.request.post(`/api/layouts/${id}/invites`, { data: { email: deskEmail, role: 'editor' } });
    expect((await deskPage.request.post(`/api/invites/${((await invite.json()) as { token: string }).token}`)).ok()).toBe(true);
    const token = await desktopToken(deskPage, request);
    await desk.close();
    const driver = new Driver(DRIVER!, token);
    interface Mod {
      id: string;
      name: string;
      members: string[];
    }
    const serverModules = async (): Promise<Mod[]> => {
      const r = await page.request.get(`/api/layouts/${id}/export.bbm.bld`);
      return r.ok() ? (((await r.json()) as { modules?: Mod[] }).modules ?? []) : [];
    };

    try {
      await driver.run(`open ${id}`);
      await driver.run('wait-synced');
      test.skip((await driver.modules()) === null, 'this bld_sync_driver has no module commands yet (desktop main is older)');

      // The web makes every part one module.
      await page.goto(`/editor/${id}`);
      await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(1000);
      await page.keyboard.press('f');
      const parts = Object.keys(await browserPoses(page));
      await page.keyboard.press('Control+a');
      await makeModule(page, NAME);
      await expect.poll(async () => (await serverModules()).map((m) => m.members.length), { timeout: 10_000 }).toEqual([parts.length]);
      const moduleId = (await serverModules())[0]!.id;
      await expect.poll(async () => (await driver.modules())?.map((m) => m.members.length)).toEqual([parts.length]);

      await test.step('in turn: the desktop renames it and takes a part out, the web sees both', async () => {
        await driver.run(`module-rename ${moduleId} ${NAME} east`);
        await driver.run(`module-remove ${moduleId} ${parts[0]}`);
        await expect.poll(async () => (await serverModules())[0]).toMatchObject({ name: `${NAME} east` });
        await expect.poll(async () => (await serverModules())[0]!.members.length).toBe(parts.length - 1);
        await page.getByRole('button', { name: 'Panels', exact: true }).click();
        await page.getByLabel('Modules', { exact: true }).check();
        // (Esc closes the Panels list, and only that.)
        await page.keyboard.press('Escape');
        await expect(page.getByLabel('Modules', { exact: true })).toBeHidden();
        await expect(page.getByRole('button', { name: `More for ${NAME} east` })).toBeVisible({ timeout: 10_000 });
      });

      await test.step('at the same instant: the web’s added part and the desktop’s take-out both stay', async () => {
        await page.getByRole('button', { name: `More for ${NAME} east` }).click();
        await page.getByTestId('module-menu-edit').click();
        await expect(page.getByTestId('module-edit-bar')).toContainText(`Editing module ${NAME} east`);
        await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
        const part = page.locator('[title*="(ts_narrowgauge_straight.8)"]').first();
        await expect(part).toBeVisible();
        await Promise.all([part.dblclick(), driver.run(`module-remove ${moduleId} ${parts[1]}`)]);
        // The new part is on the map and in the module, on the server and on the desktop.
        await expect.poll(async () => Object.keys(await browserPoses(page)).length, { timeout: 10_000 }).toBe(parts.length + 1);
        const added = Object.keys(await browserPoses(page)).find((p) => !parts.includes(p))!;
        await expect.poll(async () => (await serverModules())[0]!.members.includes(added), { timeout: 10_000, message: 'the web’s part is in the module' }).toBe(true);
        await expect.poll(async () => (await driver.modules())?.[0]?.members.includes(added), { timeout: 10_000 }).toBe(true);
        // And the desktop's take-out is there too: each part added or taken
        // out is a key of its own in the shared layout (docs/module-members.md),
        // so neither change replaces the other.
        await expect
          .poll(async () => (await serverModules())[0]!.members.includes(parts[1]!), { timeout: 10_000, message: 'the desktop’s part is out of the module' })
          .toBe(false);
        // (The module had every part but the one taken out above: one in, one out.)
        const members = (await serverModules())[0]!.members;
        expect(members.length).toBe(parts.length - 1);
        // Either way the desktop and the server agree, and the module is there once.
        await expect.poll(async () => (await driver.modules())?.[0]?.members.slice().sort()).toEqual(members.slice().sort());
        expect((await serverModules()).length).toBe(1);
      });
    } finally {
      await driver.close();
    }
  });

  test('switches: a flip on the web shows on the desktop live, and the other way round', async ({ page, request, browser }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    await signIn(page, `switch-desk-web-${stamp}@example.com`, 'Web Tester');
    const created = await page.request.post('/api/layouts', { data: { title: 'Switches, web and desktop', bbm: TIGHT_CORNER_BBM } });
    const { id } = (await created.json()) as { id: string };
    const deskEmail = `switch-desk-driver-${stamp}@example.com`;
    const desk = await browser.newContext();
    await signIn(desk, deskEmail, 'Desktop Driver');
    const deskPage = await desk.newPage();
    const invite = await page.request.post(`/api/layouts/${id}/invites`, { data: { email: deskEmail, role: 'editor' } });
    expect((await deskPage.request.post(`/api/invites/${((await invite.json()) as { token: string }).token}`)).ok()).toBe(true);
    const token = await desktopToken(deskPage, request);
    await desk.close();
    const driver = new Driver(DRIVER!, token);
    /** Every switch arrow on the web: key, color and its heel on the page. */
    const arrows = () =>
      page.evaluate(() => {
        type N = { name: () => string; getClassName: () => string; getAttr: (k: string) => unknown; find: (f: (n: N) => boolean) => N[]; getAbsolutePosition: () => { x: number; y: number }; getStage: () => { container: () => HTMLElement } };
        const out: { key: string; color: string; x: number; y: number }[] = [];
        for (const st of (window as unknown as { Konva: { stages: N[] } }).Konva.stages)
          for (const g of st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('switch-') && n.name() !== 'switch-arrows')) {
            const heel = g.find((n) => n.getClassName() === 'Circle')[0]!;
            const at = heel.getAbsolutePosition();
            const box = heel.getStage().container().getBoundingClientRect();
            out.push({ key: g.name().slice('switch-'.length), color: String(g.find((n) => n.getClassName() === 'Arrow')[0]!.getAttr('stroke')), x: box.left + at.x, y: box.top + at.y });
          }
        return out;
      });
    try {
      await driver.run(`open ${id}`);
      await driver.run('wait-synced');
      test.skip((await driver.switches()) === null, 'this bld_sync_driver has no switch commands yet (desktop main is older)');
      await page.goto(`/editor/${id}`);
      await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
      await page.getByTestId('run-mode').click();
      await expect.poll(async () => (await arrows()).length, { timeout: 20000 }).toBe(8);

      // The web flips one: the desktop has the setting.
      const first = (await arrows())[0]!;
      await page.mouse.click(first.x, first.y);
      await expect.poll(async () => Object.keys((await driver.switches()) ?? {}), { timeout: 10_000 }).toEqual([first.key]);

      // The desktop puts it back, then flips it again: the web follows each.
      const exit = (await driver.switches())![first.key]!;
      await driver.run(`switch-set ${first.key} default`);
      await expect.poll(async () => (await arrows()).find((a) => a.key === first.key)?.color, { timeout: 10_000 }).toBe('#16A34A');
      await driver.run(`switch-set ${first.key} ${exit}`);
      await expect.poll(async () => (await arrows()).find((a) => a.key === first.key)?.color, { timeout: 10_000 }).toBe('#EA580C');
    } finally {
      await driver.close();
    }
  });

  test('routes: a route the web draws reaches the desktop, and a part the desktop takes out breaks it on the web', async ({ page, request, browser }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    await page.setViewportSize({ width: 1400, height: 900 });
    await signIn(page, `route-desk-web-${stamp}@example.com`, 'Web Tester');
    const created = await page.request.post('/api/layouts', { data: { title: 'Routes, web and desktop', bbm: TIGHT_CORNER_BBM } });
    const { id } = (await created.json()) as { id: string };
    const deskEmail = `route-desk-driver-${stamp}@example.com`;
    const desk = await browser.newContext();
    await signIn(desk, deskEmail, 'Desktop Driver');
    const deskPage = await desk.newPage();
    const invite = await page.request.post(`/api/layouts/${id}/invites`, { data: { email: deskEmail, role: 'editor' } });
    expect((await deskPage.request.post(`/api/invites/${((await invite.json()) as { token: string }).token}`)).ok()).toBe(true);
    const token = await desktopToken(deskPage, request);
    await desk.close();
    const driver = new Driver(DRIVER!, token);
    // Two loose monorail straights on the longest row (as routes.spec.ts picks them).
    const straights = [...TIGHT_CORNER_BBM.matchAll(/<Brick id="([^"]+)">\s*<DisplayArea>\s*<X>([^<]*)<\/X>\s*<Y>([^<]*)<\/Y>\s*<Width>([^<]*)<\/Width>\s*<Height>([^<]*)<\/Height>\s*<\/DisplayArea>\s*<MyGroup \/>\s*<PartNumber>267[01]\.7<\/PartNumber>/g)].map((m) => ({
      x: Number(m[2]) + Number(m[4]) / 2,
      y: Number(m[3]) + Number(m[5]) / 2,
    }));
    const rows = new Map<number, { x: number; y: number }[]>();
    for (const s of straights) rows.set(Math.round(s.y), [...(rows.get(Math.round(s.y)) ?? []), s]);
    const row = [...rows.values()].sort((p, q) => q.length - p.length)[0]!.sort((p, q) => p.x - q.x);
    const onPage = (x: number, y: number) =>
      page.evaluate(([sx, sy]) => {
        type St = { getAbsoluteTransform: () => { point: (p: { x: number; y: number }) => { x: number; y: number } }; container: () => HTMLElement };
        const st = (window as unknown as { Konva: { stages: St[] } }).Konva.stages[0]!;
        const p = st.getAbsoluteTransform().point({ x: sx! * 8, y: sy! * 8 });
        const box = st.container().getBoundingClientRect();
        return { x: box.left + p.x, y: box.top + p.y };
      }, [x, y]);
    try {
      await driver.run(`open ${id}`);
      await driver.run('wait-synced');
      test.skip((await driver.routes()) === null, 'this bld_sync_driver has no route commands yet (desktop main is older)');
      await page.goto(`/editor/${id}`);
      await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(1000);
      await page.keyboard.press('f');
      await page.getByRole('button', { name: 'Panels', exact: true }).click();
      await page.getByLabel('Routes', { exact: true }).check();
      await page.keyboard.press('Escape');

      // The web draws and saves a route: the desktop has it.
      await page.getByTestId('route-new').click();
      let p = await onPage(row[1]!.x, row[1]!.y);
      await page.mouse.click(p.x, p.y);
      p = await onPage(row[row.length - 2]!.x, row[row.length - 2]!.y);
      await page.mouse.click(p.x, p.y);
      const banner = page.getByTestId('route-draft-banner');
      await banner.getByLabel('Route name').fill('Monorail run');
      await banner.getByRole('button', { name: 'Save route' }).click();
      await expect.poll(async () => (await driver.routes())?.map((r) => r.name), { timeout: 10_000 }).toEqual(['Monorail run']);
      const route = (await driver.routes())![0]!;
      expect(route.broken).toBe(false);

      // The desktop takes a part out from under it: Broken on the web, live.
      await driver.run(`brick-delete ${route.steps[Math.floor(route.steps.length / 2)]!.brick}`);
      const item = page.getByRole('list', { name: 'Routes' }).getByRole('listitem').filter({ hasText: 'Monorail run' });
      await expect(item.getByTestId('route-status')).toHaveText('Broken', { timeout: 15000 });
      await expect.poll(async () => (await driver.routes())![0]!.broken).toBe(true);
      // Mended on the web: the desktop has the new way.
      await item.getByRole('button', { name: 'Find a new way' }).click();
      await expect.poll(async () => (await driver.routes())![0]!.broken, { timeout: 10_000 }).toBe(false);
    } finally {
      await driver.close();
    }
  });

  test('places: a place the web names reaches the desktop, and one the desktop names shows on the web, on the layout and on a module', async ({ page, request, browser }) => {
    test.setTimeout(150_000);
    const stamp = Date.now();
    await page.setViewportSize({ width: 1400, height: 900 });
    await signIn(page, `places-desk-web-${stamp}@example.com`, 'Web Tester');
    const { id } = (await (await page.request.post('/api/layouts', { data: { title: 'Places, web and desktop', bbm: TIGHT_CORNER_BBM } })).json()) as { id: string };
    const deskEmail = `places-desk-driver-${stamp}@example.com`;
    const desk = await browser.newContext();
    await signIn(desk, deskEmail, 'Desktop Driver');
    const deskPage = await desk.newPage();
    const invite = await page.request.post(`/api/layouts/${id}/invites`, { data: { email: deskEmail, role: 'editor' } });
    expect((await deskPage.request.post(`/api/invites/${((await invite.json()) as { token: string }).token}`)).ok()).toBe(true);
    const token = await desktopToken(deskPage, request);
    await desk.close();
    const driver = new Driver(DRIVER!, token);
    try {
      await driver.run(`open ${id}`);
      await driver.run('wait-synced');
      test.skip((await driver.places()) === null, 'this bld_sync_driver has no place commands yet (desktop main is older)');
      await page.goto(`/editor/${id}`);
      await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(1000);
      await page.keyboard.press('f');

      // The web names a place on the stub: the desktop has it, with its spot.
      await mapMenu(page, 'Modules & sets', 'Places');
      const panel = page.getByTestId('places-panel');
      await panel.getByTestId('place-new').click();
      await expect(page.getByTestId('place-pick-banner')).toBeVisible();
      await page.waitForTimeout(200);
      const at = await page.evaluate(() => {
        type St = { getAbsoluteTransform: () => { point: (p: { x: number; y: number }) => { x: number; y: number } }; container: () => HTMLElement };
        const st = (window as unknown as { Konva: { stages: St[] } }).Konva.stages[0]!;
        const p = st.getAbsoluteTransform().point({ x: 456 * 8, y: 192 * 8 });
        const box = st.container().getBoundingClientRect();
        return { x: box.left + p.x, y: box.top + p.y };
      });
      await page.mouse.click(at.x, at.y);
      const editor = page.getByTestId('place-editor');
      await editor.getByTestId('place-name').fill('Acme Cannery');
      await editor.getByTestId('place-name').press('Enter');
      await expect.poll(async () => (await driver.places())!.layout.map((p) => [p.name, p.kind, p.spots.length]), { timeout: 15_000 }).toEqual([['Acme Cannery', 'industry', 1]]);
      const made = (await driver.places())!.layout[0]!;
      const brick = made.spots[0]!.track!.brick;

      // The desktop renames it and adds another: the web shows both, with nothing to refresh.
      await driver.run(`place-set layout ${JSON.stringify({ ...made, name: 'Cannery Row' })}`);
      await expect(editor.getByTestId('place-name')).toHaveValue('Cannery Row', { timeout: 10_000 });
      await driver.run(`place-set layout ${JSON.stringify({ ...made, id: 'pl-desk', name: 'Desk Yard', kind: 'yard' })}`);
      await editor.getByTestId('place-back').click();
      await expect(panel).toContainText('Desk Yard', { timeout: 10_000 });

      // On a module (the desktop makes one of the spot's track): both places are the module's on both sides.
      await driver.run(`place-module Depot ${brick}`);
      await expect(panel.getByRole('region', { name: 'Depot' })).toContainText('Cannery Row', { timeout: 10_000 });
      await expect.poll(async () => (await driver.places())!.modules.map((m) => m.places.map((p) => p.name).sort()), { timeout: 10_000 }).toEqual([['Cannery Row', 'Desk Yard']]);

      // The web deletes one: gone on the desktop.
      await panel.getByRole('button', { name: 'Desk Yard' }).click();
      await editor.getByTestId('place-delete').click();
      await page.getByRole('alertdialog').or(page.getByRole('dialog')).getByRole('button', { name: 'Delete', exact: true }).click();
      await expect.poll(async () => (await driver.places())!.modules.flatMap((m) => m.places.map((p) => p.name)), { timeout: 10_000 }).toEqual(['Cannery Row']);
    } finally {
      await driver.close();
    }
  });

  test('trains: a train the web puts on the track reaches the desktop, and a car the desktop adds shows on the web', async ({ page, request, browser }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    await page.setViewportSize({ width: 1400, height: 900 });
    await signIn(page, `train-desk-web-${stamp}@example.com`, 'Web Tester');
    const created = await page.request.post('/api/layouts', { data: { title: 'Trains, web and desktop', bbm: TIGHT_CORNER_BBM } });
    const { id } = (await created.json()) as { id: string };
    const deskEmail = `train-desk-driver-${stamp}@example.com`;
    const desk = await browser.newContext();
    await signIn(desk, deskEmail, 'Desktop Driver');
    const deskPage = await desk.newPage();
    const invite = await page.request.post(`/api/layouts/${id}/invites`, { data: { email: deskEmail, role: 'editor' } });
    expect((await deskPage.request.post(`/api/invites/${((await invite.json()) as { token: string }).token}`)).ok()).toBe(true);
    const token = await desktopToken(deskPage, request);
    await desk.close();
    const driver = new Driver(DRIVER!, token);
    const onPage = (x: number, y: number) =>
      page.evaluate(([sx, sy]) => {
        type St = { getAbsoluteTransform: () => { point: (p: { x: number; y: number }) => { x: number; y: number } }; container: () => HTMLElement };
        const st = (window as unknown as { Konva: { stages: St[] } }).Konva.stages[0]!;
        const p = st.getAbsoluteTransform().point({ x: sx! * 8, y: sy! * 8 });
        const box = st.container().getBoundingClientRect();
        return { x: box.left + p.x, y: box.top + p.y };
      }, [x, y]);
    try {
      await driver.run(`open ${id}`);
      await driver.run('wait-synced');
      test.skip((await driver.trains()) === null, 'this bld_sync_driver has no train commands yet (desktop main is older)');
      await page.goto(`/editor/${id}`);
      await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(1000);
      await page.keyboard.press('f');
      await page.getByRole('button', { name: 'Panels', exact: true }).click();
      await page.getByRole('checkbox', { name: 'Trains', exact: true }).check();
      await page.keyboard.press('Escape');

      // The web makes a car and a train of it, and puts it in the middle of the top-left monorail corner.
      await page.getByTestId('stock-new').click();
      await page.getByTestId('stock-editor').getByLabel('Road number').fill('101');
      await page.getByTestId('stock-save').click();
      await page.getByLabel('Pick 101 for a new train').check();
      await page.getByTestId('train-from-ticked').click();
      await page.getByTestId('train-place').click();
      const p = await onPage(140 - 28 * Math.SQRT1_2, 140 - 28 * Math.SQRT1_2);
      await page.mouse.click(p.x, p.y);
      await expect.poll(async () => (await driver.trains())?.trains[0]?.position?.brick ?? null, { timeout: 10_000 }).not.toBeNull();
      const theirs = (await driver.trains())!;
      expect(theirs.rollingStock.map((s) => s.number)).toEqual(['101']);
      expect(theirs.trains[0]!.units.map((u) => u.stock)).toEqual([theirs.rollingStock[0]!.id]);

      // The desktop adds a car and renames the train: the web shows both, live.
      await driver.run('stock-add 202 28');
      await driver.run(`train-rename ${theirs.trains[0]!.id} Desk Express`);
      await page.getByTestId('trains-tab-stock').click();
      await expect(page.getByRole('list', { name: 'Rolling stock' })).toContainText('202', { timeout: 15000 });
      await page.getByTestId('trains-tab-trains').click();
      await expect(page.getByRole('list', { name: 'Trains' })).toContainText('Desk Express', { timeout: 15000 });
    } finally {
      await driver.close();
    }
  });
  test('cars: one split off a cut on the web shows on the desktop at once, the desktop couples it again, and both moving the same car leave it in one place', async ({ page, request, browser }) => {
    test.setTimeout(150_000);
    const stamp = Date.now();
    await page.setViewportSize({ width: 1400, height: 900 });
    await signIn(page, `cars-desk-web-${stamp}@example.com`, 'Web Tester');
    const { id } = (await (await page.request.post('/api/layouts', { data: { title: 'Cars, web and desktop', bbm: TIGHT_CORNER_BBM } })).json()) as { id: string };
    const deskEmail = `cars-desk-driver-${stamp}@example.com`;
    const desk = await browser.newContext();
    await signIn(desk, deskEmail, 'Desktop Driver');
    const deskPage = await desk.newPage();
    const invite = await page.request.post(`/api/layouts/${id}/invites`, { data: { email: deskEmail, role: 'editor' } });
    expect((await deskPage.request.post(`/api/invites/${((await invite.json()) as { token: string }).token}`)).ok()).toBe(true);
    const token = await desktopToken(deskPage, request);
    await desk.close();
    const driver = new Driver(DRIVER!, token);
    // The stub of 9V track: 96 studs from (456, 144) down, open at both ends.
    type N = { name: () => string; id: () => string; x: () => number; y: () => number; find: (f: (n: N) => boolean) => N[] };
    const webCars = () =>
      page.evaluate(() => {
        const st = (window as unknown as { Konva?: { stages: N[] } }).Konva?.stages[0];
        return st ? Object.fromEntries(st.find((n) => n.name() === 'car-hit').map((n) => [n.id(), n.y() / 8])) : {};
      });
    const onPage = (x: number, y: number) =>
      page.evaluate(([sx, sy]) => {
        type St = { getAbsoluteTransform: () => { point: (p: { x: number; y: number }) => { x: number; y: number } }; container: () => HTMLElement };
        const st = (window as unknown as { Konva: { stages: St[] } }).Konva.stages[0]!;
        const p = st.getAbsoluteTransform().point({ x: sx! * 8, y: sy! * 8 });
        const box = st.container().getBoundingClientRect();
        return { x: box.left + p.x, y: box.top + p.y };
      }, [x, y]);
    /** The desktop's cuts as their cars' numbers, as settled (a car is in the cut its own opsCut names). */
    const cuts = async () => {
      const d = (await driver.trains()) as unknown as { rollingStock: { id: string; number: string; opsCut?: string }[]; trains: { id: string; cut?: boolean; units: { stock: string }[] }[] };
      return d.trains
        .filter((t) => t.cut)
        .map((t) => d.rollingStock.filter((c) => c.opsCut === t.id).map((c) => c.number).sort().join(' '))
        .filter(Boolean)
        .sort();
    };
    const webDrag = async (car: string, dy: number) => {
      const y = (await webCars())[car]!;
      const a = await onPage(456, y);
      const b = await onPage(456, y + dy);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 6 });
      await page.mouse.up();
    };
    try {
      await driver.run(`open ${id}`);
      await driver.run('wait-synced');
      const ids: string[] = [];
      for (const number of ['101', '102', '103']) {
        await driver.run(`stock-add ${number} 20`);
        ids.push((await driver.trains())!.rollingStock.find((s) => s.number === number)!.id);
      }
      const placed = await driver.run(`cars-place ${ids.join(' ')} 456 154`).then(
        () => true,
        (e: unknown) => {
          if (/unknown|no such command|bad command/i.test(String(e))) return false;
          throw e;
        },
      );
      test.skip(!placed, 'this bld_sync_driver has no car commands yet (desktop main is older)');
      await page.goto(`/editor/${id}`);
      await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(1000);
      await page.keyboard.press('f');
      await expect.poll(async () => Object.keys(await webCars()).length, { timeout: 15_000 }).toBe(3);
      expect(await cuts()).toEqual(['101 102 103']);

      // The web drags an end car off: the desktop sees it; Undo brings it back there too.
      const all = Object.entries(await webCars()).sort((a, b) => a[1] - b[1]);
      const [last, lastY] = all.at(-1)!;
      const number = (await driver.trains())!.rollingStock.find((s) => s.id === last)!.number;
      await webDrag(last, 14);
      await expect.poll(cuts, { timeout: 10_000 }).toContain(number);
      await page.keyboard.press('Control+z');
      await expect.poll(cuts, { timeout: 10_000 }).toEqual(['101 102 103']);

      // The desktop drags it off, and loads it: the web shows both.
      await driver.run(`car-drag ${last} 456 ${lastY + 12}`);
      await driver.run(`car-load ${last} loaded`);
      await expect.poll(async () => Math.round((await webCars())[last]! - lastY), { timeout: 10_000 }).toBe(12);

      // Both move the same car at once: it stands in one place, the same one on both.
      await Promise.all([webDrag(last, 8), driver.run(`car-drag ${last} 456 ${lastY + 4}`).catch(() => undefined)]);
      await driver.run('wait-synced');
      await expect.poll(async () => (await cuts()).join(' ').split(' ').sort(), { timeout: 10_000 }).toEqual(['101', '102', '103']);
      await expect.poll(async () => Object.keys(await webCars()).length).toBe(3);

      // Back against the others, from the desktop: they are one cut again on the web.
      await driver.run(`car-drag ${last} 456 ${lastY - 10}`);
      await expect.poll(cuts, { timeout: 10_000 }).toEqual(['101 102 103']);
      await expect.poll(async () => Math.round((await webCars())[last]! - lastY), { timeout: 10_000 }).toBe(0);
    } finally {
      await driver.close();
    }
  });

  test('Live Ops: waybills and jobs made on the web and the desktop are the same on both, with the same switch lists, and two added at once both stay', async ({ page, request }) => {
    test.setTimeout(150_000);
    const stamp = Date.now();
    await page.setViewportSize({ width: 1400, height: 900 });
    await signIn(page, `ops-desk-web-${stamp}@example.com`, 'Web Tester');
    const place = (id: string, brick: string, capacity: number, ships: string[], accepts: string[]) => ({ id, name: id, kind: 'industry', spots: [{ id: 's1', name: 'Dock', track: { brick, from: 0, to: 1 }, capacity }], accepts, ships, tags: [], notes: '' });
    const car = (id: string, number: string) => ({ id, number, name: '', kind: 'car', type: 'Boxcar', trackKind: 'rail', length: 20, width: 6, bodyLength: 18, trucks: [{ at: 5, swivelMax: 30 }, { at: -5, swivelMax: 30 }], opsCut: `cut-${id}` });
    const cut = (id: string, brick: string) => ({ id: `cut-${id}`, name: '', cut: true, units: [{ stock: id, reversed: false }], position: { brick, from: 0, to: 1, s: 8, facing: 'to' }, over: {}, color: '#B40000', speed: 40, trackKind: 'rail' });
    const sidecar = JSON.stringify({ schemaVersion: 1, bbmHashSha256: '', layoutPlaces: [place('cannery', '141', 1, ['boxcar'], []), place('mill', '322', 2, [], ['boxcar'])], rollingStock: [car('c1', '101'), car('c2', '102')], trains: [cut('c1', '1372'), cut('c2', '1339')] });
    const { id } = (await (await page.request.post('/api/layouts', { data: { title: 'Ops, web and desktop', bbm: TIGHT_CORNER_BBM, sidecar } })).json()) as { id: string };
    const token = await desktopToken(page, request);
    const driver = new Driver(DRIVER!, token);
    type Ops = { waybills: { id: string; car: string; leg: number }[]; opsJobs: { id: string; name: string }[] };
    type Lists = { job: string; stops: { place: string; setOut: { car: string; spot: string }[]; pickUp: { car: string; to: string }[] }[] }[];
    const ops = async () => JSON.parse(await driver.run('ops')) as Ops;
    const lists = async () => JSON.parse(await driver.run('ops-lists')) as Lists;
    try {
      await driver.run(`open ${id}`);
      await driver.run('wait-synced');
      const has = await driver.run('ops').then(() => true, (e: unknown) => {
        if (/unknown|no such command|bad command/i.test(String(e))) return false;
        throw e;
      });
      test.skip(!has, 'this bld_sync_driver has no Live Ops commands yet (desktop main is older)');
      await page.goto(`/editor/${id}`);
      await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(1000);
      await mapMenu(page, 'Modules & sets', 'Live Ops');
      const panel = page.getByTestId('ops-panel');

      // The web writes 101's waybill; the desktop adds 102's and a job.
      await panel.locator('[data-car="c1"]').getByTestId('ops-car-waybill').click();
      await panel.getByTestId('ops-leg-to').first().selectOption('mill');
      await expect.poll(async () => (await ops()).waybills.map((w) => w.car), { timeout: 10_000 }).toEqual(['c1']);
      await driver.run('waybill-add c2 cannery loaded');
      const job = (await driver.run('job-add Turn cannery mill')).trim();
      await expect(panel.getByTestId('ops-cant')).toContainText('102: No job goes from mill to cannery.', { timeout: 10_000 });
      await panel.getByTestId('ops-tab-jobs').click();
      await panel.getByRole('button', { name: 'Turn', exact: true }).click();
      await expect(panel.getByTestId('ops-switch-list')).toContainText('Pick up 101 for mill');
      await expect.poll(async () => (await lists()).find((l) => l.job === job)?.stops, { timeout: 10_000 }).toEqual([
        { place: 'cannery', setOut: [], pickUp: [{ car: 'c1', to: 'mill' }] },
        { place: 'mill', setOut: [{ car: 'c1', spot: 's1' }], pickUp: [] },
      ]);

      // Both add a stop at once: both stay, and both apps list the same.
      await Promise.all([panel.getByTestId('ops-add-stop').selectOption('cannery'), driver.run(`job-stop ${job} mill`)]);
      await expect(panel.getByTestId('ops-stops').getByRole('listitem')).toHaveCount(4, { timeout: 10_000 });
      await expect.poll(async () => (await lists())[0]!.stops.map((s) => s.place).sort(), { timeout: 10_000 }).toEqual(['cannery', 'cannery', 'mill', 'mill']);

      // Both add a waybill at once.
      await panel.getByTestId('ops-tab-waybills').click();
      await Promise.all([panel.getByTestId('ops-new-waybill').click(), driver.run('waybill-add - mill empty')]);
      await expect.poll(async () => (await ops()).waybills.length, { timeout: 10_000 }).toBe(4);
      await panel.getByTestId('ops-back').click();
      await expect(panel.locator('[data-waybill]')).toHaveCount(4, { timeout: 10_000 });

      // Delivered on the desktop: finished on the web, and Undo on the web leaves it.
      await driver.run('waybill-turn c1');
      await expect(panel.locator('[data-waybill]').filter({ hasText: '101' })).toContainText('Finished', { timeout: 10_000 });
      await expect.poll(async () => (await driver.trains())!.rollingStock.map((s) => (s as { opsLoad?: string }).opsLoad ?? ''), { timeout: 10_000 }).toEqual(['', 'loaded']);
    } finally {
      await driver.close();
    }
  });

  test('trains from a model: an engine the web imports from a Studio file is the same engine on the desktop, picture and trucks, and the other way round', async ({ page, request }) => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    await page.setViewportSize({ width: 1400, height: 900 });
    await signIn(page, `model-desk-web-${stamp}@example.com`, 'Web Tester');
    const created = await page.request.post('/api/layouts', { data: { title: 'Model engine, web and desktop', bbm: TIGHT_CORNER_BBM } });
    const { id } = (await created.json()) as { id: string };
    // The same person on the desktop: their own imported part is in their parts there.
    // (and the server's parts, as the desktop app downloads them).
    const token = await desktopToken(page, request, 'layouts:read layouts:write parts:read');
    const driver = new Driver(DRIVER!, token);
    try {
      await driver.run(`open ${id}`);
      await driver.run('wait-synced');
      test.skip(!(await driver.run('features')).split(' ').includes('stockModels'), 'this bld_sync_driver has no model stock commands yet (desktop main is older)');
      await page.goto(`/editor/${id}`);
      await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(1000);
      await page.getByRole('button', { name: 'Panels', exact: true }).click();
      await page.getByRole('checkbox', { name: 'Trains', exact: true }).check();
      await page.keyboard.press('Escape');
      await page.getByTestId('trains-tab-stock').click();

      // The web imports a Studio file as an engine.
      await page.getByTestId('stock-import-input').setInputFiles({ name: 'Santa Fe engine.io', mimeType: 'application/octet-stream', buffer: Buffer.from(engineIo()) });
      const dialog = page.getByRole('dialog', { name: 'Import a model' });
      await expect(dialog.getByTestId('stock-setup')).toBeVisible({ timeout: 60000 });
      await expect(dialog.getByTestId('stock-front-at')).toHaveValue('9');
      await dialog.getByLabel('Road number').fill('SF 16');
      await dialog.getByTestId('import-make').click();
      await expect(dialog).toHaveCount(0, { timeout: 60000 });
      await expect(page.getByRole('list', { name: 'Rolling stock' })).toContainText('SF 16');

      // The desktop has the same engine: its trucks, its model, and the same picture from the server's parts.
      await expect.poll(async () => (await driver.trains())?.rollingStock.length ?? 0, { timeout: 15000 }).toBe(1);
      const engine = (await driver.trains())!.rollingStock[0]!;
      expect(engine.number).toBe('SF 16');
      expect(engine.kind).toBe('engine');
      expect(engine.length).toBe(30);
      expect(engine.trucks!.map((t) => t.at)).toEqual([9, -9]);
      expect(engine.look).toMatchObject({ mode: 'model' });
      expect(engine.look!.partKey).toMatch(/^custom:/);
      expect(engine.model).toMatchObject({ partKey: engine.look!.partKey, file: 'Santa Fe engine.io', format: 'studio' });
      const part = JSON.parse(await driver.run(`stock-part ${engine.id}`)) as { found: boolean; pxPerStud: number; width: number; height: number };
      expect(part.found).toBe(true);
      // 32 x 6 studs at the picture's own resolution.
      expect(part.width / part.pxPerStud).toBe(32);
      expect(part.height / part.pxPerStud).toBe(6);

      // The desktop adds a model engine with that part: the web lists it and draws it with the picture.
      const deskId = (await driver.run(`stock-add-model DESK ${engine.look!.partKey} 30 8 -8`)).trim();
      await expect(page.getByRole('list', { name: 'Rolling stock' })).toContainText('DESK', { timeout: 15000 });
      await page.getByLabel('Pick DESK for a new train').check();
      await page.getByTestId('train-from-ticked').click();
      await page.getByTestId('train-place').click();
      const st = await page.evaluate(([sx, sy]) => {
        type St = { getAbsoluteTransform: () => { point: (p: { x: number; y: number }) => { x: number; y: number } }; container: () => HTMLElement };
        const stage = (window as unknown as { Konva: { stages: St[] } }).Konva.stages[0]!;
        const pt = stage.getAbsoluteTransform().point({ x: sx! * 8, y: sy! * 8 });
        const box = stage.container().getBoundingClientRect();
        return { x: box.left + pt.x, y: box.top + pt.y };
      }, [140 - 28 * Math.SQRT1_2, 140 - 28 * Math.SQRT1_2]);
      await page.mouse.click(st.x, st.y);
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              type N = { name: () => string; getClassName: () => string; find: (f: (n: N) => boolean) => N[] };
              const stage = (window as unknown as { Konva: { stages: N[] } }).Konva.stages[0]!;
              return stage.find((n) => n.name() === 'train-unit').flatMap((g) => g.find((n) => n.getClassName() === 'Image')).length;
            }),
          { timeout: 15000 },
        )
        .toBe(1);
      expect((await driver.trains())!.rollingStock.map((s) => s.id)).toContain(deskId);
    } finally {
      await driver.close();
    }
  });
});
