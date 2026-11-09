// Journey: one module open in two tabs (or by two people) never loses a save.
//
//   Ada opens her module twice. Tab A adds a part and saves: tab B, with
//   nothing unsaved, shows it at once. Then both add a part; A saves, and B
//   is told "Someone saved this module" with Load theirs and Save mine as a
//   new version. B carries on and saves anyway: the save is held back, not
//   written over A's, and B chooses Save mine. Load theirs, from A, brings
//   B's version in.
//
// SHOTS=<dir> saves light and dark pictures of each step.

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { signIn } from '../../helpers';

const ts = Date.now();
const ADA = `j-modconflict-${ts}@example.com`;
const PART = 'ts_narrowgauge_straight.8';
const SHOTS = process.env.SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
  }
}

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}

async function addPart(page: Page): Promise<void> {
  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
}

async function openModule(page: Page, id: string): Promise<void> {
  await page.goto(`/modules/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
}

test('two tabs on one module: a save is never written over the other', async ({ page, context }) => {
  test.setTimeout(180_000);
  await signIn(page, ADA, 'Ada Modules');
  const res = await page.request.post('/api/modules', { data: { title: `Siding ${ts}` } });
  const { id } = (await res.json()) as { id: string };
  const a = page;
  const b = await context.newPage();
  await openModule(a, id);
  await openModule(b, id);

  // A saves; B has nothing unsaved, so it simply shows A's part.
  await addPart(a);
  await expect.poll(() => brickCount(a)).toBe(1);
  await a.getByRole('button', { name: 'Save module' }).click();
  await expect(a.getByTestId('save-status')).toHaveText('Saved');
  await expect.poll(() => brickCount(b), { timeout: 20000 }).toBe(1);
  await expect(b.getByTestId('module-changed')).toHaveCount(0);

  // Both add a part; A saves first. B is told, with its own part still there.
  await addPart(b);
  await expect.poll(() => brickCount(b)).toBe(2);
  await addPart(a);
  await addPart(a);
  await expect.poll(() => brickCount(a)).toBe(3);
  await a.getByRole('button', { name: 'Save module' }).click();
  await expect(a.getByTestId('save-status')).toHaveText('Saved');
  const card = b.getByTestId('module-changed');
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card).toContainText('Someone saved this module');
  await shot(b, 'module-changed');

  // B carries on and saves anyway: held back, nothing of A's lost.
  await card.getByRole('button', { name: 'Not now' }).click();
  await b.getByRole('button', { name: 'Save module' }).click();
  await expect(card).toContainText('your save was held back');
  await shot(b, 'module-save-held');
  const saved = async () => {
    const r = await page.request.get(`/api/modules/${id}`);
    return ((await r.json()) as { module: { docVersion: number } }).module.docVersion;
  };
  const before = await saved();
  // B keeps its own: saved as a new version.
  await card.getByRole('button', { name: 'Save mine as a new version' }).click();
  await expect(card).toHaveCount(0);
  await expect(b.getByTestId('save-status')).toHaveText('Saved');
  await expect.poll(saved).toBe(before + 1);

  // A had nothing unsaved: it shows B's version (2 parts) by itself.
  await expect.poll(() => brickCount(a), { timeout: 20000 }).toBe(2);

  // Load theirs: A edits, B saves, A takes B's.
  await addPart(a);
  await expect.poll(() => brickCount(a)).toBe(3);
  await addPart(b);
  await expect.poll(() => brickCount(b)).toBe(3);
  await b.getByRole('button', { name: 'Save module' }).click();
  await expect(b.getByTestId('save-status')).toHaveText('Saved');
  await expect(a.getByTestId('module-changed')).toBeVisible({ timeout: 20000 });
  await a.getByTestId('module-changed').getByRole('button', { name: 'Load theirs' }).click();
  await expect(a.getByTestId('module-changed')).toHaveCount(0);
  await expect(a.getByTestId('save-status')).toHaveText('Saved');
  await expect.poll(() => brickCount(a)).toBe(3);
  await b.close();
});
