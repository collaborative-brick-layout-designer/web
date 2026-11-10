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
import { signIn } from '../helpers';

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
async function desktopToken(page: Page, request: APIRequestContext): Promise<string> {
  const code = (await (
    await request.post('/api/auth/device/code', {
      data: { client_name: 'Sync driver', scope: 'layouts:read layouts:write' },
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

        // Back online the edits wait for review; nothing reaches the server.
        await driver.run('reconnect');
        await driver.run('wait-synced');
        await page.waitForTimeout(1000);
        expect(listed(await serverPoses(page.request, id))).toEqual(webOnly);
        expect(await driver.run('status')).toBe('Synced 3');
        expect(listed(await driver.poses('shared'))).toEqual(webOnly);

        const keys = JSON.parse(await driver.run('resolve mine')) as string[];
        expect(keys.filter((k) => k.startsWith('brick:')).map((k) => k.split(':')[2]).sort()).toEqual([A, B, C].sort());
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
});
