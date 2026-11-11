// Live editing on a phone, with other people in the layout (found by
// running live editing on an emulated phone, which the full review
// couldn't cover):
//   - with two or more other people, their circles ran over the "Saved"
//     pill and its "?" in the phone's header (that row has no room left),
//     and a finger had no way to read who the initials are. They are now
//     one button beside the layout's name;
//   - after a dropped connection, both sides showed nobody for up to 15 s;
//   - the signed-out card's "Sign in" was 32 px tall;
//   - a phone on its side kept about 110 px of map while painting.
// SHOTS_DIR=<dir> also saves screenshots, light and dark.

import { test, expect, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { PASS, postAuth, signIn } from '../helpers';

const SHOTS = process.env.SHOTS_DIR;
const { defaultBrowserType: _a, ...iPhone14 } = devices['iPhone 14'];
const ts = Date.now();

const people = (page: Page) => page.getByRole('group', { name: 'People here now' }).locator(':scope > span');

async function open(page: Page, id: string): Promise<void> {
  await page.goto(`/editor/${id}`);
  await expect(page.getByTestId('save-status')).toHaveText(/Saved/, { timeout: 30000 });
}

/** A layout of `owner`'s that each of `others` can edit; returns its id. */
async function sharedLayout(owner: Page, tag: string, others: { ctx: BrowserContext; email: string }[]): Promise<string> {
  const res = await owner.request.post('/api/layouts', { data: { title: `Phone live ${tag}` } });
  const { id } = (await res.json()) as { id: string };
  for (const o of others) {
    const invite = await owner.request.post(`/api/layouts/${id}/invites`, { data: { email: o.email, role: 'editor' } });
    const { token } = (await invite.json()) as { token: string };
    expect((await o.ctx.request.post(`/api/invites/${token}`)).ok()).toBe(true);
  }
  return id;
}

async function desktopPerson(browser: Browser, tag: string, name: string): Promise<{ ctx: BrowserContext; email: string }> {
  const email = `phone-live-${tag}-${name.toLowerCase()}-${ts}@example.com`;
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await signIn(ctx, email, `${name} Builder`);
  return { ctx, email };
}

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}-light.png` });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/${name}-dark.png` });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
}

/** Whether the middle of `locator` is what a finger there would hit (nothing lies over it). */
const reachable = (page: Page, testIdOrLabel: { testId?: string; label?: string }) =>
  page.evaluate(({ testId, label }) => {
    const el = testId ? document.querySelector(`[data-testid="${testId}"]`) : document.querySelector(`[aria-label="${label}"]`);
    if (!el) return 'missing';
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top && (top === el || el.contains(top) || top.contains(el)) ? 'ok' : `covered by ${top?.getAttribute('data-testid') ?? top?.tagName}`;
  }, testIdOrLabel);

for (const size of [
  { name: 'iPhone 14', use: iPhone14 },
  { name: '360 px phone', use: { ...iPhone14, viewport: { width: 360, height: 740 }, screen: { width: 360, height: 740 } } },
]) {
  test(`on a ${size.name}, four other people fit the header and a tap lists them by name`, async ({ browser }) => {
    test.setTimeout(120_000);
    const tag = size.name.replace(/\W+/g, '').toLowerCase();
    const phoneCtx = await browser.newContext(size.use);
    await signIn(phoneCtx, `phone-live-${tag}-owner-${ts}@example.com`, 'Pat Phone');
    const phone = await phoneCtx.newPage();
    const others = [];
    for (const name of ['Alice', 'Bob', 'Carol', 'Dan']) others.push(await desktopPerson(browser, tag, name));
    const id = await sharedLayout(phone, tag, others);
    await open(phone, id);

    // Two other people: one circle with "+1", and nothing is covered.
    const pages: Page[] = [];
    for (const o of others.slice(0, 2)) {
      const p = await o.ctx.newPage();
      await open(p, id);
      pages.push(p);
    }
    await expect(phone.getByTestId('people-more')).toContainText('+1', { timeout: 15000 });
    await expect(people(phone)).toHaveCount(1);
    const clear = async () => {
      for (const what of [{ testId: 'save-status' }, { label: 'Help: Saving' }, { label: 'Share picture' }, { testId: 'mode-switch' }, { testId: 'people-here' }])
        expect(await reachable(phone, what), JSON.stringify(what)).toBe('ok');
      // Nothing in the header runs into its neighbor or off the side.
      const header = phone.getByTestId('editor-header');
      expect(await header.evaluate((el) => Array.from(el.children).every((row) => row.scrollWidth <= row.clientWidth + 1))).toBe(true);
      expect(await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
      const button = (await phone.getByTestId('people-here').boundingBox())!;
      const sw = (await phone.getByTestId('mode-switch').boundingBox())!;
      const name = (await header.getByRole('button', { name: /Phone live/ }).boundingBox())!;
      expect(name.x + name.width).toBeLessThanOrEqual(button.x + 1);
      expect(button.x + button.width).toBeLessThanOrEqual(sw.x + 1);
      // A finger-sized button.
      expect(button.height).toBeGreaterThanOrEqual(43.5);
      expect(button.width).toBeGreaterThanOrEqual(43.5);
    };
    await clear();
    await shoot(phone, `phone-people-two-${tag}`);

    // Four: still one button wide.
    for (const o of others.slice(2)) {
      const p = await o.ctx.newPage();
      await open(p, id);
      pages.push(p);
    }
    await expect(phone.getByTestId('people-more')).toContainText('+3', { timeout: 15000 });
    await expect(people(phone)).toHaveCount(1);
    await clear();
    await shoot(phone, `phone-people-four-${tag}`);

    // A tap lists everyone, by name.
    await phone.getByTestId('people-here').tap();
    const list = phone.getByRole('dialog', { name: 'Who is here' });
    await expect(list).toBeVisible();
    await expect(list).toContainText('4 other people are here');
    for (const name of ['Alice', 'Bob', 'Carol', 'Dan']) await expect(list).toContainText(`${name} Builder`);
    const box = (await list.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(size.use.viewport.width);
    await shoot(phone, `phone-people-list-${tag}`);
    // A tap on the map closes it.
    await phone.getByTestId('canvas-area').tap({ position: { x: 40, y: 440 } });
    await expect(list).toHaveCount(0);

    for (const o of others) await o.ctx.close();
    await phoneCtx.close();
  });
}

test('after a dropped connection on a phone, both sides see each other again at once', async ({ browser }) => {
  test.setTimeout(120_000);
  const phoneCtx = await browser.newContext(iPhone14);
  await signIn(phoneCtx, `phone-live-drop-owner-${ts}@example.com`, 'Pat Phone');
  const phone = await phoneCtx.newPage();
  const alice = await desktopPerson(browser, 'drop', 'Alice');
  const id = await sharedLayout(phone, 'drop', [alice]);

  // The phone's live connection, which the test can take down (the train goes into a tunnel).
  let down = false;
  const live = new Set<{ close: (o: { code: number }) => Promise<void> }>();
  await phone.routeWebSocket(/\/ws\/layout\//, (ws) => {
    if (down) {
      void ws.close({ code: 1001 });
      return;
    }
    const server = ws.connectToServer();
    live.add(ws);
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
    ws.onClose(() => {
      live.delete(ws);
      void server.close();
    });
    server.onClose((code, reason) => void ws.close({ code, reason }));
  });
  await open(phone, id);
  const a = await alice.ctx.newPage();
  await open(a, id);
  await expect(people(phone)).toHaveCount(1, { timeout: 15000 });
  await expect(people(a)).toHaveCount(1, { timeout: 15000 });

  down = true;
  for (const w of [...live]) await w.close({ code: 1001 });
  await expect(phone.getByTestId('save-status')).not.toHaveText(/Saved/, { timeout: 15000 });
  await expect(people(phone)).toHaveCount(0);
  await expect(people(a)).toHaveCount(0, { timeout: 15000 });

  // Back. Nobody touches anything: each shows for the other well inside the
  // 15 s it used to take (the wait for y-protocols to re-send a presence).
  down = false;
  await expect(phone.getByTestId('save-status')).toHaveText(/Saved/, { timeout: 30000 });
  await expect(people(phone)).toHaveCount(1, { timeout: 4000 });
  await expect(people(a)).toHaveCount(1, { timeout: 4000 });
  await expect(people(a).first()).toHaveAttribute('title', /Pat Phone/);

  await alice.ctx.close();
  await phoneCtx.close();
});

test('signed out on a phone, "Sign in" is big enough for a finger', async ({ browser }) => {
  test.setTimeout(120_000);
  const email = `phone-live-signedout-${ts}@example.com`;
  const phoneCtx = await browser.newContext(iPhone14);
  await signIn(phoneCtx, email, 'Pat Phone');
  const phone = await phoneCtx.newPage();
  const res = await phone.request.post('/api/layouts', { data: { title: 'Phone signed out' } });
  const { id } = (await res.json()) as { id: string };
  await open(phone, id);
  // Signed out of every other browser from a second one; the phone's connection then drops and comes back refused.
  const other = await browser.newContext();
  expect((await postAuth(other.request, '/api/auth/password/login', { email, password: PASS })).ok()).toBe(true);
  expect((await other.request.post('/api/auth/sessions/sign-out-others')).ok()).toBe(true);
  await phoneCtx.setOffline(true);
  await phone.waitForTimeout(500);
  await phoneCtx.setOffline(false);
  await phone.evaluate(() => window.dispatchEvent(new Event('online')));
  const card = phone.getByTestId('signed-out');
  await expect(card).toBeVisible({ timeout: 45000 });
  const link = (await card.getByRole('link', { name: /Sign in/ }).boundingBox())!;
  expect(link.height).toBeGreaterThanOrEqual(43.5);
  await shoot(phone, 'phone-signed-out');
  await other.close();
  await phoneCtx.close();
});

test('a phone on its side keeps room for the map while painting', async ({ browser }) => {
  const phoneCtx = await browser.newContext({ ...iPhone14, viewport: { width: 844, height: 390 }, screen: { width: 844, height: 390 } });
  await signIn(phoneCtx, `phone-live-paint-${ts}@example.com`, 'Pat Phone');
  const phone = await phoneCtx.newPage();
  const res = await phone.request.post('/api/layouts', { data: { title: 'Phone paint' } });
  const { id } = (await res.json()) as { id: string };
  await open(phone, id);
  await phone.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).tap();
  await phone.getByTestId('touch-tools').tap();
  await phone.getByTestId('touch-tool-paint').tap();
  const bar = phone.getByTestId('touch-draw-bar');
  await expect(bar).toBeVisible();
  // Every control still there and finger-sized, on the screen.
  await expect(bar.getByRole('radio', { name: 'Green' })).toBeVisible();
  await expect(bar.getByRole('radio', { name: 'Erase' })).toBeVisible();
  const done = (await bar.getByRole('button', { name: 'Done' }).boundingBox())!;
  expect(done.x + done.width).toBeLessThanOrEqual(844);
  expect(done.height).toBeGreaterThanOrEqual(43.5);
  // The map shows above the bar: it used to keep about 110 px of the 390.
  const area = (await phone.getByTestId('canvas-area').boundingBox())!;
  const barBox = (await bar.boundingBox())!;
  expect(barBox.y - area.y).toBeGreaterThanOrEqual(150);
  await shoot(phone, 'phone-landscape-paint');
  await phoneCtx.close();
});
