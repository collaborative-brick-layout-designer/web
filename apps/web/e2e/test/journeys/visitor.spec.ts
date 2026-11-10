// Journey — a visitor who isn't signed in, sent links by a builder.
//
//   1. A shared layout link opens read only, with a Home button: Home is
//      the sign-in page, which offers the public catalog to someone just
//      looking.
//   2. The catalog opens without an account; with nothing shared yet it
//      says so in plain words.
//   3. A link to a private layout says it's private and offers Sign in,
//      which comes back to the layout afterwards.

import { test, expect } from '@playwright/test';
import { signIn } from '../../helpers';
import { makeGlobalAdmin, siteSettingsAtDefaults } from '../../dbHelpers';
import { watch4xx } from '../../quietNetwork';

siteSettingsAtDefaults();

const ts = Date.now();
const ADMIN = `j-visitor-admin-${ts}@example.com`;
const BUILDER = `j-visitor-builder-${ts}@example.com`;

test('a visitor follows a shared link, finds the catalog, and is asked to sign in for a private layout', async ({ page: builder, browser }) => {
  test.setTimeout(120_000);
  await signIn(builder, ADMIN, 'Visitor Admin');
  makeGlobalAdmin(ADMIN);
  const before = (await (await builder.request.get('/api/admin/settings')).json()) as { moduleCatalogEnabled: boolean; catalogAnonymousBrowse: boolean };
  expect((await builder.request.patch('/api/admin/settings', { data: { moduleCatalogEnabled: true, catalogAnonymousBrowse: true } })).ok()).toBe(true);
  try {
    await builder.context().clearCookies();
    await signIn(builder, BUILDER, 'Bea');
    const shared = (await (await builder.request.post('/api/layouts', { data: { title: `Harbour ${ts}` } })).json()) as { id: string };
    const priv = (await (await builder.request.post('/api/layouts', { data: { title: `Secret yard ${ts}` } })).json()) as { id: string };
    const { token } = (await (await builder.request.post(`/api/layouts/${shared.id}/public-share`, { data: {} })).json()) as { token: string };

    const visitor = await (await browser.newContext()).newPage();
    // A visitor's normal use draws no 4xx (a WAF bans bursts of them).
    const net = watch4xx(visitor);
    // ── 1. The shared link, then Home. ──
    await visitor.goto(`/p/${token}`);
    await expect(visitor.getByText(`Harbour ${ts}`)).toBeVisible();
    await visitor.getByRole('link', { name: 'Home' }).click();
    await expect(visitor.getByRole('heading', { name: 'Sign in to Collaborative Brick Layout Designer' })).toBeVisible();

    // ── 2. Just looking: the catalog. ──
    await visitor.getByRole('link', { name: 'Browse the catalog' }).click();
    await expect(visitor).toHaveURL(/\/catalog/);
    await expect(visitor.getByRole('heading', { name: 'Catalog' })).toBeVisible();

    net.expectQuiet();
    // ── 3. A private layout: Sign in, and back to it. ──
    await visitor.goto(`/editor/${priv.id}`);
    await expect(visitor.getByText('Sign in to open this layout')).toBeVisible({ timeout: 15_000 });
    await visitor.getByRole('link', { name: 'Sign in' }).click();
    await expect(visitor).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(`/editor/${priv.id}`).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    await builder.context().clearCookies();
    await signIn(builder, ADMIN, 'Visitor Admin');
    await builder.request.patch('/api/admin/settings', { data: { moduleCatalogEnabled: before.moduleCatalogEnabled, catalogAnonymousBrowse: before.catalogAnonymousBrowse } });
  }
});
