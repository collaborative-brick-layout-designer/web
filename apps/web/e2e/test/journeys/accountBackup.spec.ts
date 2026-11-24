// Journey — a member backs up their things and brings them back.
//
//   Profile → Download a backup (one zip of their own layouts, modules,
//   venues and engines and cars; not their club's) → a layout and a venue
//   are deleted → Restore from a backup → the list says what comes back:
//   the deleted ones ticked, what they still have left out, a name they
//   already use renamed "… (restored)" → Restore → the things are back as
//   new copies, and nothing they had was changed.

import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { signIn } from '../../helpers';

const ts = Date.now();
const EMAIL = `j-backup-${ts}@example.com`;
const ROOM = { name: 'Hall', enabled: true, edges: [], obstacles: [], minWalkwayStuds: 0 };

test('a member downloads a backup of their things and restores what they lost', async ({ page }, info) => {
  test.setTimeout(180_000);
  await signIn(page, EMAIL, `Backer ${ts}`);
  const post = async (url: string, data: unknown) => {
    const res = await page.request.post(url, { data });
    expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
    return (await res.json()) as { id: string };
  };
  const yard = await post('/api/layouts', { title: `Yard ${ts}` });
  await post('/api/layouts', { title: `Harbor ${ts}` });
  await post('/api/modules', { title: `Corner ${ts}` });
  const hall = await post('/api/venues', { name: `Hall ${ts}`, data: ROOM });
  await post('/api/rolling-stock', { record: { number: '4014', name: `Big Boy ${ts}`, length: 36 } });

  // ── Download. ──
  await page.goto('/profile');
  const section = page.locator('section#backup');
  await expect(section.getByRole('heading', { name: /Back up your things/ })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), section.getByRole('button', { name: 'Download a backup' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^my-brick-layouts-backup-\d{4}-\d{2}-\d{2}\.zip$/);
  const saved = info.outputPath('backup.zip');
  await download.saveAs(saved);
  expect(readFileSync(saved).subarray(0, 2).toString('latin1')).toBe('PK');
  await expect(section.getByText(/Saved my-brick-layouts-backup-.* with 5 things in it/)).toBeVisible();

  // ── Things go missing; one is replaced by another of the same name. ──
  expect((await page.request.delete(`/api/layouts/${yard.id}`)).ok()).toBe(true);
  expect((await page.request.delete(`/api/venues/${hall.id}`)).ok()).toBe(true);
  await post('/api/venues', { name: `Hall ${ts}`, data: ROOM });

  // ── Restore: the list says what happens to each. ──
  await section.locator('input[type=file]').setInputFiles(saved);
  const plan = section.getByRole('region', { name: 'What to restore' });
  await expect(plan).toBeVisible();
  await expect(plan.getByLabel(`Restore Yard ${ts}`)).toBeChecked();
  await expect(plan.getByLabel(`Restore Harbor ${ts}`)).not.toBeChecked();
  await expect(plan.getByText('You still have this one').first()).toBeVisible();
  await expect(plan.getByLabel(`Restore Hall ${ts}`)).toBeChecked();
  await expect(plan.getByText(`so it comes back as “Hall ${ts} (restored)”`)).toBeVisible();
  await plan.getByRole('button', { name: 'Restore 2 things' }).click();
  await expect(section.getByText('Restored 2 things.')).toBeVisible({ timeout: 60_000 });

  // ── Back as new copies; nothing else changed. ──
  const layouts = ((await (await page.request.get('/api/layouts?owner=me')).json()) as { layouts: { id: string; title: string }[] }).layouts;
  expect(layouts.filter((l) => l.title === `Yard ${ts}`)).toHaveLength(1);
  expect(layouts.find((l) => l.title === `Yard ${ts}`)!.id).not.toBe(yard.id);
  expect(layouts.filter((l) => l.title === `Harbor ${ts}`)).toHaveLength(1);
  const venues = ((await (await page.request.get('/api/venues?owner=me')).json()) as { venues: { name: string }[] }).venues.map((v) => v.name).sort();
  expect(venues).toEqual([`Hall ${ts}`, `Hall ${ts} (restored)`]);

  // The restored layout opens.
  const restored = layouts.find((l) => l.title === `Yard ${ts}`)!;
  await page.goto(`/editor/${restored.id}`);
  await expect(page.getByText(`Yard ${ts}`).first()).toBeVisible({ timeout: 30_000 });
});
