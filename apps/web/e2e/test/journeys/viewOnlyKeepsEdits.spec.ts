// Journey — your role goes down to view only while you have edits the
// server hasn't got, and nothing is lost.
//
//   Ada's club layout; Ben, a member, edits it (one part, saved) → Ben goes
//   offline and places a second part → Ada makes Ben a Viewer → Ben comes
//   back online: the server takes nothing from a viewer, so his second
//   part never reaches it → his editor turns view only, shows the
//   server's copy, and a card keeps his own copy to save as a new layout
//   or download. Saving it makes his own layout with both parts.

import { test, expect, type Page } from '@playwright/test';
import { signIn } from '../../helpers';

const ts = Date.now();
const ADA = `j-viewonly-ada-${ts}@example.com`;
const BEN = `j-viewonly-ben-${ts}@example.com`;
const PART = 'ts_narrowgauge_straight.8';

async function post(page: Page, url: string, data: object, method: 'post' | 'patch' = 'post'): Promise<Record<string, string>> {
  const res = await page.request[method](url, { data });
  expect(res.ok(), `${url}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as Record<string, string>;
}

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}

async function onServer(page: Page, id: string): Promise<number> {
  const r = await page.request.get(`/api/layouts/${id}/export.bbm`);
  expect(r.ok()).toBe(true);
  return ((await r.text()).match(new RegExp(PART.replace('.', '\\.'), 'gi')) ?? []).length;
}

async function placePart(page: Page): Promise<void> {
  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
}

test('edits the server didn’t take after your role went down to view only are kept', async ({ page, browser }) => {
  test.setTimeout(240_000);
  await signIn(page, ADA, 'Ada Admin');
  const benContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const ben = await benContext.newPage();
  await signIn(ben, BEN, 'Ben Builder');
  const benId = ((await (await ben.request.get('/api/auth/me')).json()) as { user: { id: string } }).user.id;
  const club = await post(page, '/api/orgs', { name: `View Only Club ${ts}` });
  const invite = await post(page, `/api/orgs/${club.slug}/invites`, { email: BEN, role: 'member' });
  await post(ben, `/api/org-invites/${invite.token}`, {});
  const layout = await post(page, '/api/layouts', { title: `Yard ${ts}`, orgSlug: club.slug! });

  // Ben edits: one part, on the server.
  await ben.goto(`/editor/${layout.id}`);
  await expect(ben.getByText('Saved', { exact: true })).toBeVisible({ timeout: 20000 });
  await placePart(ben);
  await expect.poll(() => onServer(page, layout.id!), { timeout: 15000 }).toBe(1);

  // Offline, a second part waits on his computer…
  await ben.waitForLoadState('networkidle');
  await benContext.setOffline(true);
  await expect(ben.getByText(/^(Reconnecting…|Offline)$/)).toBeVisible({ timeout: 45000 });
  await placePart(ben);
  await expect.poll(() => brickCount(ben)).toBe(2);

  // …while Ada makes him a Viewer.
  const roles = (await (await page.request.get(`/api/orgs/${club.slug}/roles`)).json()) as { roles: { id: string; key: string | null }[] };
  await post(page, `/api/orgs/${club.slug}/members/${benId}`, { roleIds: [roles.roles.find((r) => r.key === 'viewer')!.id] }, 'patch');

  // Back online: view only, the server's copy on screen, and his own kept.
  await benContext.setOffline(false);
  await expect(ben.getByTestId('view-only')).toBeVisible({ timeout: 45000 });
  const card = ben.getByTestId('refused-copy');
  await expect(card).toBeVisible({ timeout: 30000 });
  await expect(card).toContainText('view only');
  await expect.poll(() => brickCount(ben), { timeout: 15000 }).toBe(1);
  expect(await onServer(page, layout.id!)).toBe(1);

  // Saved as his own layout: both parts.
  await card.getByRole('button', { name: 'Save my copy as a new layout' }).click();
  // The new layout's page, not the one already open (whose address matches too).
  await expect(ben).toHaveURL(new RegExp(`/editor/(?!${layout.id}$)[0-9a-f-]{36}$`), { timeout: 15000 });
  const copyId = ben.url().split('/').at(-1)!;
  expect(copyId).not.toBe(layout.id);
  await expect.poll(() => onServer(ben, copyId), { timeout: 15000 }).toBe(2);
  await benContext.close();
});
