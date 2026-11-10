// Live collaboration smoke test (full review area 4, Idea 1): two browsers
// and the desktop (its headless `bld_sync_driver`: the desktop's own
// SyncSession, driven over stdin) on one layout. Presence, a move each way,
// a drop and reconnect on each side, a role change and a sign-out. Bugs 1,
// 2, 5 and 7 of the review would each have shown here.
//
// Needs BLD_SYNC_DRIVER (the built driver, see references/DESKTOP-SYNC-E2E.md);
// skipped without it. CI runs it on main and nightly (live-smoke.yml).

import { test, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn } from '../helpers';

const DRIVER = process.env.BLD_SYNC_DRIVER;
const SERVER = process.env.BLD_SYNC_SERVER ?? 'http://127.0.0.1:3000';
const TIGHT_CORNER = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures/tight-corner.bbm'), 'utf-8');
const ts = Date.now();

/** The desktop: one command line in, one reply line out. */
class Driver {
  private proc: ChildProcessWithoutNullStreams;
  private lines: string[] = [];
  private waiters: ((line: string) => void)[] = [];
  private stderr = '';

  constructor(path: string, token: string) {
    this.proc = spawn(path, [SERVER], { env: { ...process.env, BLD_SYNC_TOKEN: token, QT_QPA_PLATFORM: 'offscreen' } });
    createInterface({ input: this.proc.stdout }).on('line', (l) => {
      const w = this.waiters.shift();
      if (w) w(l);
      else this.lines.push(l);
    });
    this.proc.stderr.on('data', (d: Buffer) => (this.stderr += d.toString()));
  }

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

  async x(id: string): Promise<number> {
    const bricks = JSON.parse(await this.run('dump')) as { id: string; x: number }[];
    return bricks.find((b) => b.id === id)!.x;
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

/** A brick's x on the server, from its .bbm export. */
async function serverX(request: APIRequestContext, layoutId: string, id: string): Promise<number> {
  const text = await (await request.get(`/api/layouts/${layoutId}/export.bbm`)).text();
  const m = new RegExp(`<Brick id="${id}">[\\s\\S]*?<X>([^<]*)</X>`).exec(text);
  return Number(m![1]);
}

/** Every brick's x on the server. */
async function serverXs(request: APIRequestContext, layoutId: string): Promise<Map<string, number>> {
  const text = await (await request.get(`/api/layouts/${layoutId}/export.bbm`)).text();
  return new Map([...text.matchAll(/<Brick id="([^"]+)">[\s\S]*?<X>([^<]*)<\/X>/g)].map((m) => [m[1]!, Number(m[2])]));
}

const moved = (a: Map<string, number>, b: Map<string, number>) => [...b].filter(([k, v]) => a.get(k) !== v).map(([k]) => k);

/** A brick's x as a browser draws it (its Konva group's pivot, px). */
function browserX(page: Page, id: string): Promise<number | null> {
  return page.evaluate((id) => {
    const st = (window as unknown as { Konva: { stages: { findOne: (s: string) => { x: () => number } | undefined }[] } }).Konva.stages[0];
    return st?.findOne(`.brick-${id}`)?.x() ?? null;
  }, id);
}

/** Click a brick in the browser until it alone is picked. */
async function pick(page: Page, candidates: string[]): Promise<string> {
  for (const id of candidates) {
    const at = await page.evaluate((id) => {
      type N = { getClientRect: () => { x: number; y: number; width: number; height: number } };
      const st = (window as unknown as { Konva: { stages: { findOne: (s: string) => N | undefined; container: () => HTMLElement }[] } }).Konva.stages[0]!;
      const n = st.findOne(`.brick-${id}`);
      if (!n) return null;
      const r = n.getClientRect();
      const c = st.container().getBoundingClientRect();
      return { x: c.x + r.x + r.width / 2, y: c.y + r.y + r.height / 2 };
    }, id);
    if (!at || at.x < 0 || at.y < 0) continue;
    await page.mouse.click(at.x, at.y);
    if ((await page.locator('footer').innerText()).includes('selected: 1')) return id;
  }
  throw new Error('no brick could be picked on its own');
}

/** A browser's live connection, which the test can take down and bring back. */
async function wifi(page: Page): Promise<{ down: () => Promise<void>; up: () => void }> {
  let isDown = false;
  const open = new Set<{ close: (o: { code: number }) => Promise<void> }>();
  await page.routeWebSocket(/\/ws\/layout\//, (ws) => {
    if (isDown) {
      void ws.close({ code: 1001 });
      return;
    }
    const server = ws.connectToServer();
    open.add(ws);
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
    ws.onClose(() => {
      open.delete(ws);
      void server.close();
    });
    server.onClose((code, reason) => void ws.close({ code, reason }));
  });
  return {
    down: async () => {
      isDown = true;
      for (const w of [...open]) await w.close({ code: 1001 });
    },
    up: () => {
      isDown = false;
    },
  };
}

async function desktopToken(page: Page): Promise<string> {
  const code = (await (await page.request.post('/api/auth/device/code', { data: { client_name: 'Live smoke', scope: 'layouts:read layouts:write' } })).json()) as {
    device_code: string;
    user_code: string;
  };
  expect((await page.request.post('/api/auth/device/approve', { data: { user_code: code.user_code } })).ok()).toBe(true);
  const tok = await page.request.post('/api/auth/device/token', { data: { device_code: code.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' } });
  expect(tok.ok()).toBe(true);
  return ((await tok.json()) as { access_token: string }).access_token;
}

const people = (page: Page) => page.getByRole('group', { name: 'People here now' }).locator(':scope > span');

test.describe('live collaboration smoke', () => {
  test.skip(!DRIVER, 'BLD_SYNC_DRIVER is not set: build bld_sync_driver in the desktop repo, see references/DESKTOP-SYNC-E2E.md');

  test('two browsers and the desktop: presence, moves each way, drops, a role change and a sign-out', async ({ browser }) => {
    test.setTimeout(240_000);
    const mk = async (who: string): Promise<{ ctx: BrowserContext; page: Page }> => {
      const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
      await signIn(ctx, `smoke-${who.toLowerCase()}-${ts}@example.com`, `${who} Smoke`);
      return { ctx, page: await ctx.newPage() };
    };
    const ann = await mk('Ann');
    const ben = await mk('Ben');
    const dee = await mk('Dee');
    const created = await ann.page.request.post('/api/layouts', { data: { title: 'Live smoke', bbm: TIGHT_CORNER } });
    const { id } = (await created.json()) as { id: string };
    for (const [p, email] of [[ben.page, `smoke-ben-${ts}@example.com`], [dee.page, `smoke-dee-${ts}@example.com`]] as const) {
      const inv = await ann.page.request.post(`/api/layouts/${id}/invites`, { data: { email, role: 'editor' } });
      const { token } = (await inv.json()) as { token: string };
      expect((await p.request.post(`/api/invites/${token}`)).ok()).toBe(true);
    }
    const deeId = ((await (await dee.page.request.get('/api/auth/me')).json()) as { user: { id: string } }).user.id;
    const bricks = [...TIGHT_CORNER.matchAll(/<Brick id="([^"]+)">[\s\S]*?<MyGroup(?: \/>|>([^<]*)<\/MyGroup>)/g)].filter((m) => !m[2]).map((m) => m[1]!);
    const benWifi = await wifi(ben.page);
    const driver = new Driver(DRIVER!, await desktopToken(dee.page));

    try {
      await test.step('presence: each browser lists the other and the desktop; the desktop sees both', async () => {
        for (const p of [ann.page, ben.page]) {
          await p.goto(`/editor/${id}`);
          await expect(p.getByTestId('save-status')).toHaveText(/Saved/, { timeout: 30000 });
          await p.keyboard.press('f');
        }
        await driver.run('name Dee Desktop');
        await driver.run(`open ${id}`);
        await driver.run('wait-synced');
        await driver.run('cursor 10 10');
        await expect(people(ann.page)).toHaveCount(2, { timeout: 15000 });
        await expect(people(ann.page).filter({ hasText: 'Dee Desktop' })).toHaveCount(1);
        await expect.poll(async () => {
          const peers = JSON.parse(await driver.run('peers')) as { user?: { displayName?: string } }[];
          return peers.map((p) => p.user?.displayName).filter(Boolean).sort();
        }, { timeout: 15000 }).toEqual(['Ann Smoke', 'Ben Smoke']);
      });

      let A = '';
      await test.step('a move each way: web to desktop, desktop to web', async () => {
        // Ann nudges whatever her click picked; which part that was, the server says.
        const before = await serverXs(ann.page.request, id);
        await pick(ann.page, bricks);
        await ann.page.keyboard.press('ArrowRight');
        await expect.poll(async () => moved(before, await serverXs(ann.page.request, id)).length, { timeout: 15000 }).toBe(1);
        A = moved(before, await serverXs(ann.page.request, id))[0]!;
        await expect.poll(() => driver.x(A), { timeout: 15000 }).toBe((await serverXs(ann.page.request, id)).get(A));
        const B = bricks.find((b) => b !== A)!;
        const benBefore = await browserX(ben.page, B);
        await driver.run(`move ${B} 8 0`);
        await expect.poll(() => browserX(ben.page, B), { timeout: 15000 }).not.toBe(benBefore);
        await expect.poll(() => browserX(ann.page, B), { timeout: 15000 }).toBe(await browserX(ben.page, B));
      });

      await test.step('a drop and reconnect: a browser and the desktop each edit offline, and it arrives', async () => {
        await benWifi.down();
        await expect(ben.page.getByTestId('save-status')).not.toHaveText(/Saved/, { timeout: 15000 });
        const offline = await serverXs(ann.page.request, id);
        await pick(ben.page, bricks.filter((b) => b !== A));
        await ben.page.keyboard.press('ArrowLeft');
        await ben.page.waitForTimeout(500);
        // Not on the server while Ben is offline...
        expect(moved(offline, await serverXs(ann.page.request, id))).toEqual([]);
        benWifi.up();
        await expect(ben.page.getByTestId('save-status')).toHaveText(/Saved/, { timeout: 45000 });
        // ...and there once he's back.
        await expect.poll(async () => moved(offline, await serverXs(ann.page.request, id)).length, { timeout: 15000 }).toBe(1);
        const C = moved(offline, await serverXs(ann.page.request, id))[0]!;

        const D = bricks.find((b) => b !== A && b !== C)!;
        const dServer = await serverX(ann.page.request, id, D);
        await driver.run('disconnect');
        await driver.run(`move ${D} 4 0`);
        await driver.run('reconnect');
        await driver.run('wait-synced');
        // Kept for review, or (nothing changed meanwhile) sent by themselves.
        if ((await driver.run('status')) !== 'Synced 0') await driver.run('resolve mine');
        await expect.poll(() => serverX(ann.page.request, id, D), { timeout: 15000 }).toBe(dServer + 4);
      });

      await test.step('a role change: lowered to view only, the desktop changes nothing on the server', async () => {
        expect((await ann.page.request.patch(`/api/layouts/${id}/collaborators/${deeId}`, { data: { role: 'viewer' } })).ok()).toBe(true);
        await ann.page.waitForTimeout(1500);
        const E = bricks.at(-1)!;
        const eServer = await serverX(ann.page.request, id, E);
        await driver.run(`move ${E} 4 0`);
        await ann.page.waitForTimeout(2000);
        expect(await serverX(ann.page.request, id, E)).toBe(eServer);
        expect((await ann.page.request.patch(`/api/layouts/${id}/collaborators/${deeId}`, { data: { role: 'editor' } })).ok()).toBe(true);
      });

      await test.step("a sign-out: the desktop's sign-in revoked on the website ends its connection", async () => {
        const tokens = (await (await dee.page.request.get('/api/tokens')).json()) as { tokens: { id: string; name: string }[] };
        const mine = tokens.tokens.find((t) => t.name === 'Live smoke')!;
        expect((await dee.page.request.delete(`/api/tokens/${mine.id}`)).ok()).toBe(true);
        await expect.poll(async () => (await driver.run('status')).split(' ')[0], { timeout: 20000 }).toBe('Offline');
        // The browsers carry on.
        await expect(ann.page.getByTestId('save-status')).toHaveText(/Saved/);
        await expect(people(ann.page)).toHaveCount(1, { timeout: 15000 });
      });
    } finally {
      await driver.close();
      for (const p of [ann, ben, dee]) await p.ctx.close();
    }
  });
});
