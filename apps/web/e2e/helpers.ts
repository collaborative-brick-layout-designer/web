// Shared auth helpers for the e2e specs.
//
// /api/auth/password/register, /login and /resend-verification are
// rate-limited per IP (10/min, 10/min, 5/min) — a real, intentional
// anti-abuse control that the suite must live with rather than weaken.
// Every spec runs from 127.0.0.1, so the whole suite shares one budget.
// Two things keep it inside that budget reliably:
//
//   1. Each account is registered + verified exactly once per run, from a
//      throwaway API context; verifying logs the account in, and that
//      session cookie is cached and simply added to whichever browser
//      context later needs to act as that user. No /login round-trip per
//      test, and no register call for an account that already exists.
//   2. When a 429 does happen (e.g. a second run started within a minute
//      of the first), wait out the server's own `retry-after` and extend
//      the current test's timeout by that wait, so a legitimate back-off
//      never turns into a spurious 30s test timeout.

import {
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Cookie,
  type Page,
  type Response,
  expect,
  request as playwrightRequest,
  test,
} from '@playwright/test';
import { accountState, getVerificationToken } from './dbHelpers';

export const PASS = 'correct horse battery';

const MAX_RATE_LIMIT_RETRIES = 4;

/** Wait out a 429's `retry-after`, extending the running test's timeout by the same amount. */
async function backOff(res: APIResponse | Response): Promise<void> {
  const retryAfterSec = Number(res.headers()['retry-after'] ?? '5') || 5;
  const waitMs = (retryAfterSec + 1) * 1000;
  test.info().setTimeout(test.info().timeout + waitMs);
  await new Promise((r) => setTimeout(r, waitMs));
}

/** POST to a rate-limited auth endpoint, retrying on 429. */
export async function postAuth(
  request: APIRequestContext,
  path: string,
  data: Record<string, string>,
): Promise<APIResponse> {
  for (let attempt = 0; ; attempt++) {
    const res = await request.post(path, { data });
    if (res.status() !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) return res;
    await backOff(res);
  }
}

/**
 * Drive a UI form that POSTs to a rate-limited auth endpoint: run
 * `submit`, and if the resulting request to `path` comes back 429, wait
 * and submit again. Returns the final (non-429) response.
 */
export async function submitAuthForm(
  page: Page,
  path: string,
  submit: () => Promise<void>,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const resP = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === path,
    );
    await submit();
    const res = await resP;
    if (res.status() !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) return res;
    await backOff(res);
  }
}

const sessions = new Map<string, Cookie[]>();

/**
 * Make sure `email` exists and is verified, and return a session cookie
 * for it. Idempotent and cached for the rest of the run, so it's safe to
 * call from every test / beforeEach.
 */
/** The name test accounts get unless a spec picks one: never the email (names are shown to others). */
export const nameOf = (email: string): string => email.split('@')[0]!;

export async function ensureUser(email: string, displayName = nameOf(email)): Promise<Cookie[]> {
  const cached = sessions.get(email);
  if (cached) return cached;

  const { baseURL } = test.info().project.use;
  const api = await playwrightRequest.newContext(baseURL ? { baseURL } : {});
  try {
    if (accountState(email) === 'verified') {
      // Registered by something outside this cache (e.g. a UI flow) — just log in.
      const login = await postAuth(api, '/api/auth/password/login', { email, password: PASS });
      expect(login.ok(), `login ${email}: ${login.status()} ${await login.text()}`).toBe(true);
    } else {
      const reg = await postAuth(api, '/api/auth/password/register', {
        email,
        password: PASS,
        displayName,
      });
      expect(reg.ok(), `register ${email}: ${reg.status()} ${await reg.text()}`).toBe(true);
      // Same request context as the sign-up, so the link keeps PASS.
      const token = await getVerificationToken(email);
      const verify = await api.post(`/api/auth/password/verify-email/${token}`);
      expect(verify.ok(), `verify ${email}: ${verify.status()}`).toBe(true);
    }
    const { cookies } = await api.storageState();
    expect(cookies.length, `no session cookie for ${email}`).toBeGreaterThan(0);
    sessions.set(email, cookies);
    return cookies;
  } finally {
    await api.dispose();
  }
}

/** Sign `target` (a page's context, or a context) in as `email`, registering it first if needed. */
export async function signIn(
  target: Page | BrowserContext,
  email: string,
  displayName = nameOf(email),
): Promise<void> {
  const cookies = await ensureUser(email, displayName);
  const ctx = 'context' in target ? target.context() : target;
  await ctx.addCookies(cookies);
}

/**
 * Open an entry of the header's Menu ▾ (Help, Account, Look), e.g.
 * `fromSettingsMenu(page, 'Your data')`. Its groups start folded, so this
 * unfolds them first. Admin pages have one menu entry ("Site admin", or
 * "Moderation" for moderators): for `/^Moderation/` or `/^Privacy requests/`
 * this picks it, then the tab, the way a person would.
 */
/**
 * Open a section of the admin pages the way a person would: the list
 * down the side, or the "Section" picker on a phone. `key` is the
 * section's address key (users, orgs, moderation, privacy, settings…).
 */
export async function adminSection(page: Page, key: string, opts: { tap?: boolean } = {}): Promise<void> {
  const pick = page.getByRole('combobox', { name: 'Section' });
  const link = page.getByRole('navigation', { name: 'Admin sections' }).locator(`a[href="/admin?tab=${key}"]`);
  const modOnly = page.getByRole('tab', { name: /^To review/ });
  await expect.poll(async () => (await pick.isVisible()) || (await link.isVisible()) || (key === 'moderation' && (await modOnly.isVisible()))).toBe(true);
  // A moderator's page is Moderation alone: nothing to pick.
  if (!(await pick.isVisible()) && !(await link.isVisible())) return;
  if (await pick.isVisible()) await pick.selectOption(key);
  else if ((await link.getAttribute('aria-current')) !== 'page') await (opts.tap ? link.tap() : link.click());
  await expect(page).toHaveURL(new RegExp(`tab=${key}`));
}

export async function fromSettingsMenu(page: Page, entry: string | RegExp, opts: { tap?: boolean } = {}): Promise<void> {
  const press = (l: import('@playwright/test').Locator) => (opts.tap ? l.tap() : l.click());
  const label = typeof entry === 'string' ? entry : entry.source.replace(/^\^/, '');
  const adminTab = ['Moderation', 'Privacy requests'].find((t) => label.startsWith(t));
  const menuButton = page.getByRole('banner').getByRole('button', { name: /^Menu/ });
  const menu = page.getByRole('menu', { name: 'Menu' });
  if (adminTab) {
    // One "Site admin" (or "Moderation") entry in the menu, then the section.
    // A moderator lands on Moderation (no side list).
    await press(menuButton);
    await press(menu.getByRole('menuitem', { name: /^(Site admin|Moderation)/ }));
    const tabKey = adminTab === 'Moderation' ? 'moderation' : 'privacy';
    // Either the sections (an admin) or Moderation itself (a moderator).
    const sections = async () =>
      (await page.getByRole('navigation', { name: 'Admin sections' }).isVisible()) || (await page.getByRole('combobox', { name: 'Section' }).isVisible());
    await expect.poll(async () => (await sections()) || (await page.getByRole('tab', { name: /^To review/ }).isVisible())).toBe(true);
    if (!(await sections())) return;
    await adminSection(page, tabKey, opts);
    return;
  }
  await press(menuButton);
  // Unfold one at a time: each tap re-renders the list.
  const folded = menu.getByRole('button', { expanded: false });
  while ((await folded.count()) > 0) await press(folded.first());
  await press(menu.getByRole('menuitem', { name: entry }));
}

/**
 * Answer the app's confirmation dialog (ui/ConfirmDialog.tsx) with its
 * confirm button: types the name first when it asks, and fills the reason
 * box when given one.
 */
export async function confirmInDialog(page: Page, opts: { reason?: string } = {}): Promise<void> {
  const d = page.getByTestId('confirm-dialog');
  await d.waitFor();
  if (await d.locator('input').count()) await d.locator('input').fill((await d.locator('label strong').textContent()) ?? '');
  if (opts.reason !== undefined) await d.locator('textarea').fill(opts.reason);
  await d.getByRole('button').last().click();
  await d.waitFor({ state: 'detached' });
}

/**
 * Map ▸ … ▸ entry: opens the editor's Map menu and clicks down `path`
 * (submenus, then the entry). Works with a mouse and on a touch screen,
 * where the menu is a bottom sheet and each submenu a page of it.
 */
export async function mapMenu(page: Page, ...path: string[]): Promise<void> {
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  for (const label of path) {
    const menu = page.getByRole('menu').last();
    await menu
      .getByRole('menuitem', { name: label, exact: true })
      .or(menu.getByRole('menuitemcheckbox', { name: label, exact: true }))
      .click();
  }
}

/**
 * Map ▸ Modules & sets ▸ Make a module…: names the picked parts' module
 * (in this layout only), or with `alsoSave` saves it to your Module library too.
 */
export async function makeModule(page: Page, name: string, opts: { alsoSave?: boolean } = {}): Promise<void> {
  await mapMenu(page, 'Modules & sets', 'Make a module…');
  const dialog = page.getByRole('dialog', { name: 'Make a module' });
  await dialog.getByLabel('Module name').fill(name);
  if (opts.alsoSave) await dialog.getByTestId('make-module-also-save').check();
  await dialog.getByRole('button', { name: opts.alsoSave ? 'Make and save' : 'Make module' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 15000 });
}

/**
 * Waits until the open layout's map has every part picture it asked for
 * (MapLoadingCard's `part-pictures` marker), and the parts that got one have
 * been drawn with it. Use it before counting draws: a picture arriving draws
 * its part again. (The loading card's being hidden isn't enough: it is also
 * hidden before the map has mounted, as on a cold server, where the
 * pictures then arrive mid-test.) Only for layouts with parts.
 */
export async function partPicturesReady(page: Page, timeout = 60000): Promise<void> {
  await expect(page.getByTestId('part-pictures')).toHaveAttribute('data-state', 'ready', { timeout });
  await expect(page.getByTestId('loading-card')).toBeHidden();
  // The parts re-render with their pictures, then the layer draws on a frame.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
}
