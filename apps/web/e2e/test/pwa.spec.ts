// The web app installs like an app: Chrome finds nothing missing in its
// manifest, and Settings shows how to install it.

import { devices, expect, test } from '@playwright/test';
import { signIn } from '../helpers';

// A Pixel 7, without its browser choice (the project picks Chromium).
const { defaultBrowserType: _browser, ...PHONE } = devices['Pixel 7']!;

test('a computer has no install section, and the switches keep their shape', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Help and tours' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('heading', { name: 'Install the app' })).toHaveCount(0);
  const track = await page.getByTestId('switch-track').first().boundingBox();
  expect(track).toMatchObject({ width: 56, height: 32 });
});

test.describe('on a phone', () => {
  test.use(PHONE);

  test('the switch stays a pill inside its 44 px tap target', async ({ page }) => {
    await page.goto('/settings');
    const sw = page.getByRole('switch', { name: 'Show help buttons' });
    await expect(sw).toBeVisible({ timeout: 15000 });
    const button = (await sw.boundingBox())!;
    const track = (await page.getByTestId('switch-track').first().boundingBox())!;
    expect(button.height).toBeGreaterThanOrEqual(44);
    expect(track).toMatchObject({ width: 56, height: 32 });
    // Centred in the button.
    expect(Math.abs(track.y + track.height / 2 - (button.y + button.height / 2))).toBeLessThan(1);
  });
});

test.describe('installing on a phone', () => {
  test.use(PHONE);

test('Chrome can install it, and Settings says how', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'installability is a Chrome check');
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Install the app' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('install-state')).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  // The manifest is fetched after load; give Chrome a moment to read it.
  await expect
    .poll(async () => {
      const manifest = (await cdp.send('Page.getAppManifest')) as { url: string; data?: string; errors: unknown[] };
      return manifest.data ? (JSON.parse(manifest.data) as { name: string }).name : null;
    })
    .toBe('Collaborative Brick Layout Designer');
  const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as {
    installabilityErrors: { errorId: string }[];
  };
  expect(installabilityErrors.map((e) => e.errorId)).toEqual([]);
});
});

test('the tab and the header show the new logo, sharp at every size', async ({ page }) => {
  await page.goto('/');
  // The favicon links, in order: the pixel-fitted SVG, then the ICO and PNG.
  const links = await page.locator('head link[rel="icon"], head link[rel="apple-touch-icon"]').evaluateAll((els) =>
    els.map((e) => ({ rel: e.getAttribute('rel'), href: e.getAttribute('href'), type: e.getAttribute('type'), sizes: e.getAttribute('sizes') })),
  );
  expect(links).toEqual([
    { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml', sizes: null },
    { rel: 'icon', href: '/favicon.ico', type: null, sizes: '16x16 32x32 48x48' },
    { rel: 'icon', href: '/favicon.png', type: 'image/png', sizes: '32x32' },
    { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', type: null, sizes: '180x180' },
  ]);
  for (const { href } of links) {
    const res = await page.request.get(href!);
    expect(res.ok(), href!).toBe(true);
  }
  expect((await page.request.get('/favicon.svg')).headers()['content-type']).toContain('image/svg+xml');
  // The logo beside the app's name loads.
  const logo = page.locator('img[src="/logo.png"]').first();
  await expect(logo).toBeVisible({ timeout: 15000 });
  expect(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(256);
});

test("the editor's Home button is the logo", async ({ page }) => {
  await signIn(page, `logo-editor-${Date.now()}@example.com`, 'Logo Editor');
  const layout = (await (await page.request.post('/api/layouts', { data: { title: 'Logo check' } })).json()) as { id: string };
  await page.goto(`/editor/${layout.id}`);
  const home = page.getByRole('link', { name: 'Home' });
  await expect(home).toBeVisible({ timeout: 15000 });
  const logo = home.locator('img[src="/logo.png"]');
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(256);
});
