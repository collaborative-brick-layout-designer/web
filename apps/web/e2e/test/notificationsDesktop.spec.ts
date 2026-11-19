// E2E: notifications with the desktop app (docs/notifications.md). The
// desktop side is `bld_sync_driver`, the desktop's own NotificationCenter
// (the bell's counts, live from the event stream) and its Accept through
// POST /api/notifications/:id/act, driven over stdin; the web side is the
// real server and the web app in a browser.
//
//   - Ada runs a club that takes requests to join; her desktop watches its bell;
//   - Gus asks to join on the web: the desktop's bell counts it from the
//     live hint alone (nothing asks the server meanwhile), and lists it with
//     Accept and Decline;
//   - the desktop accepts: Gus is in the club, Ada's Notifications page on the
//     web says "You let them in", and Gus's bell has the approval;
//   - answering again from the desktop is no error: it says it was already answered.
//
// CI runs it on main and nightly with the desktop's main driver
// (live-smoke.yml); by hand, against a web stack:
//
//   BLD_SYNC_DRIVER=<build>/src/app/bld_sync_driver \
//   BLD_SYNC_SERVER=http://127.0.0.1:3000 \
//   pnpm --filter @cld/web exec playwright test notificationsDesktop
//
// Needs BLD_SYNC_DRIVER (path to the built driver, desktop 2.1.10 or newer:
// the notif-* commands); skipped without it.

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { signIn } from '../helpers';

const DRIVER = process.env.BLD_SYNC_DRIVER;
const SERVER = process.env.BLD_SYNC_SERVER ?? 'http://127.0.0.1:3000';
const ts = Date.now();
const ADA = `n-desk-ada-${ts}@example.com`;
const GUS = `n-desk-gus-${ts}@example.com`;
const CLUB = `Bell Club ${ts % 100000}`;

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

  async json<T>(cmd: string): Promise<T> {
    const line = await this.say(cmd);
    if (!line.startsWith('ok')) throw new Error(`driver: "${cmd}" -> ${line}`);
    return JSON.parse(line.slice(2).trim()) as T;
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

interface Counts {
  unread: number;
  waiting: number;
  warnings: number;
  supported: boolean;
}
interface Item {
  id: string;
  type: string;
  title: string;
  read: boolean;
  outcome: string;
  actions: string[];
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

async function call(page: Page, method: 'post' | 'patch' | 'get', url: string, data?: object): Promise<Record<string, unknown>> {
  const res = await page.request[method](url, data ? { data } : {});
  expect(res.ok(), `${url}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

test('a request to join made on the web shows in the desktop bell live and is accepted there', async ({ page, browser, request }) => {
  test.skip(!DRIVER, 'BLD_SYNC_DRIVER (the desktop repo’s bld_sync_driver) is not set');
  test.setTimeout(180_000);

  await signIn(page, ADA, 'Ada Admin');
  const gus = await browser.newPage();
  await signIn(gus, GUS, 'Gus Guest');
  const club = await call(page, 'post', '/api/orgs', { name: CLUB });
  const slug = club.slug as string;
  await call(page, 'patch', `/api/orgs/${slug}`, { joinPolicy: 'request', listed: true });

  const driver = new Driver(DRIVER!, await desktopToken(page, request));
  try {
    // The desktop's bell, live.
    const start = await driver.json<Counts>('notif-watch');
    expect(start.supported).toBe(true);

    // Gus asks on the web: the desktop's count goes up from the live hint alone.
    await call(gus, 'post', `/api/orgs/${slug}/join`, { message: 'I bring a lot of track.' });
    const after = await driver.json<Counts>(`notif-wait-unread ${start.unread + 1} 20000`);
    expect(after.waiting).toBe(start.waiting + 1);
    const ask = (await driver.json<Item[]>('notif-list')).find((n) => n.type === 'club.join_request');
    expect(ask, 'the request is in the desktop’s list').toBeTruthy();
    expect(ask!.title).toContain('Gus Guest');
    expect(ask!.actions).toEqual(['accept', 'decline']);

    // Accepted from the desktop.
    expect(await driver.json(`notif-act ${ask!.id} accept`)).toMatchObject({ outcome: 'accepted', already: false });

    // Gus is in the club.
    const members = (await call(page, 'get', `/api/orgs/${slug}/members`)).members as Array<{ displayName: string }>;
    expect(members.map((m) => m.displayName)).toContain('Gus Guest');
    // The web says who answered, on Ada's page and in Gus's bell.
    await page.goto('/notifications');
    const item = page.getByTestId('notification-item').filter({ hasText: 'Gus Guest' });
    await expect(item.getByTestId('notification-outcome')).toHaveText('You let them in');
    await expect(item.getByRole('button', { name: 'Let them in' })).toHaveCount(0);
    await gus.goto('/');
    await gus.getByTestId('notification-bell').click();
    await expect(gus.getByTestId('notification-panel').getByTestId('notification-item').filter({ hasText: CLUB })).toBeVisible();

    // The desktop's list follows: answered, and answering again isn't an error.
    const done = (await driver.json<Item[]>('notif-list')).find((n) => n.id === ask!.id)!;
    expect(done).toMatchObject({ outcome: 'accepted', actions: [] });
    expect(await driver.json(`notif-act ${ask!.id} accept`)).toMatchObject({ outcome: 'accepted', already: true });
  } finally {
    await driver.close();
  }
});
