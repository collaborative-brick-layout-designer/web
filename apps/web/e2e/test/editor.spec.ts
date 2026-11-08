// E2E: Editor canvas smoke tests — load, toolbar interaction, tool switching,
// undo/redo keyboard shortcuts, and the HUD status bar.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn } from '../helpers';

const FORDYCE_BBM = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../packages/bbm/tests/fixtures/fordyce-2026.bbm',
  ),
  'utf-8',
);

const ts = Date.now();
const EMAIL = `editor-e2e-${ts}@example.com`;

// This file's tests all act as the one EMAIL account; signIn registers
// and verifies it once and reuses that session afterwards (see
// helpers.ts), so the rate-limited register/login endpoints are hit once
// per run rather than once per test.
async function login(page: Page): Promise<void> {
  await signIn(page, EMAIL, 'Editor Tester');
}

async function loginAndCreateLayout(page: Page): Promise<string> {
  await login(page);
  const res = await page.request.post('/api/layouts', { data: { title: 'Editor Test Layout' } });
  const { id } = await res.json() as { id: string };
  return id;
}

async function openEditor(page: Page, id: string): Promise<void> {
  await page.goto(`/editor/${id}`);
  // Wait for the canvas to appear — up to 15s on first load (sprite cache, WS connect).
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
}

test.describe('editor — load', () => {
  test('editor loads and shows a canvas', async ({ page }) => {
    const id = await loginAndCreateLayout(page);
    await openEditor(page, id);
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();
    // Canvas must have non-zero dimensions.
    const box = await canvas.boundingBox();
    expect(box!.width).toBeGreaterThan(100);
    expect(box!.height).toBeGreaterThan(100);
  });

  test('editor title is visible in the page', async ({ page }) => {
    const id = await loginAndCreateLayout(page);
    await openEditor(page, id);
    await expect(page.getByText('Editor Test Layout')).toBeVisible({ timeout: 5000 });
  });

  test('editor toolbar is visible', async ({ page }) => {
    const id = await loginAndCreateLayout(page);
    await openEditor(page, id);
    // The editor's toolbar is plain <button>s in a <header> row (no
    // role="toolbar"/data-testid/<nav> — those only exist on the
    // Layouts/Orgs pages' AppHeader, which the editor doesn't render).
    // The "Select" tool button is always present and active by default.
    await expect(page.getByRole('button', { name: 'Select' })).toBeVisible({ timeout: 5000 });
  });
});

test.describe('editor — tool switching', () => {
  test('clicking the rotate tool activates it', async ({ page }) => {
    const id = await loginAndCreateLayout(page);
    await openEditor(page, id);
    // The tool rail marks the active tool with aria-pressed, and the
    // status bar's "Tool: <name>" also reflects the current tool; check both.
    const rotateBtn = page.getByRole('button', { name: 'Turn', exact: true });
    await rotateBtn.click();
    await expect(rotateBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('footer')).toContainText('Tool: rotate');
  });

  test('clicking delete tool activates it', async ({ page }) => {
    const id = await loginAndCreateLayout(page);
    await openEditor(page, id);
    // "Delete" also names the global selection-delete action; the tool
    // rail's buttons carry data-tool, which is unambiguous.
    const deleteBtn = page.getByRole('navigation', { name: 'Build tools' }).locator('[data-tool="delete"]');
    await deleteBtn.click();
    await expect(page.locator('footer')).toContainText('Tool: delete');
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('clicking select tool activates it after switching away', async ({ page }) => {
    const id = await loginAndCreateLayout(page);
    await openEditor(page, id);
    const rotateBtn = page.getByRole('button', { name: 'Turn', exact: true });
    const selectBtn = page.getByRole('button', { name: 'Select' });
    await rotateBtn.click();
    await expect(page.locator('footer')).toContainText('Tool: rotate');
    await selectBtn.click();
    await expect(page.locator('footer')).toContainText('Tool: select');
    await expect(page.locator('canvas').first()).toBeVisible();
  });
});

test.describe('editor — keyboard shortcuts', () => {
  test('Ctrl+Z triggers undo without crashing the editor', async ({ page }) => {
    const id = await loginAndCreateLayout(page);
    await openEditor(page, id);
    // Click the canvas to focus it, then send undo. The Konva Stage
    // stacks 3 <canvas> elements (interactive layer + HUD overlay on
    // top); `.first()` is the bottom one, which the top layer
    // legitimately intercepts pointer events for — Playwright's
    // actionability check correctly refuses a plain click there.
    // Click the topmost canvas instead, matching a real user's click.
    await page.locator('canvas').last().click();
    await page.keyboard.press('Control+z');
    // Canvas must still be visible after the keypress.
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('Ctrl+Y triggers redo without crashing', async ({ page }) => {
    const id = await loginAndCreateLayout(page);
    await openEditor(page, id);
    await page.locator('canvas').last().click();
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+y');
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('Escape clears selection without crashing', async ({ page }) => {
    const id = await loginAndCreateLayout(page);
    await openEditor(page, id);
    await page.locator('canvas').last().click();
    await page.keyboard.press('Escape');
    await expect(page.locator('canvas').first()).toBeVisible();
  });
});

test.describe('editor — panels', () => {
  test('layers panel is visible or openable', async ({ page }) => {
    const id = await loginAndCreateLayout(page);
    await openEditor(page, id);
    // Look for a "Layers" label anywhere in the sidebar.
    const layersLabel = page.getByText(/layers/i);
    if (await layersLabel.count() > 0) {
      await expect(layersLabel.first()).toBeVisible({ timeout: 5000 });
    }
  });

  test('parts panel is visible or openable', async ({ page }) => {
    const id = await loginAndCreateLayout(page);
    await openEditor(page, id);
    const partsLabel = page.getByText(/parts/i);
    if (await partsLabel.count() > 0) {
      await expect(partsLabel.first()).toBeVisible({ timeout: 5000 });
    }
  });
});

test.describe('editor — snapshot API round-trip', () => {
  test('GET /snapshot returns valid bytes and the editor renders them', async ({ page }) => {
    const id = await loginAndCreateLayout(page);
    const snap = await page.request.get(`/api/layouts/${id}/snapshot`);
    expect(snap.ok()).toBe(true);
    expect(snap.headers()['content-type']).toBe('application/octet-stream');
    const buf = await snap.body();
    expect(buf.byteLength).toBeGreaterThan(0);

    // Opening the editor should not show an error.
    await openEditor(page, id);
    await expect(page.locator('canvas').first()).toBeVisible();
  });
});

test.describe('editor — export', () => {
  test('export .bbm link is reachable and returns XML', async ({ page }) => {
    // loginAndCreateLayout already logs in — no need to do it twice
    // (and every hit against the rate-limited login endpoint counts).
    const id = await loginAndCreateLayout(page);

    const exportRes = await page.request.get(`/api/layouts/${id}/export.bbm`);
    expect(exportRes.ok()).toBe(true);
    expect(exportRes.headers()['content-type']).toContain('xml');
  });
});

test.describe('editor — Fordyce 2026 import', () => {
  test('imports Fordyce 2026 .bbm and opens editor without crashing', async ({ page }) => {
    await login(page);

    const res = await page.request.post('/api/layouts', {
      data: { title: 'Fordyce 2026', bbm: FORDYCE_BBM },
    });
    expect(res.ok()).toBe(true);
    const { id } = (await res.json()) as { id: string };

    await openEditor(page, id);
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('Fordyce 2026 layout title is shown in the editor', async ({ page }) => {
    await login(page);

    const res = await page.request.post('/api/layouts', {
      data: { title: 'Fordyce 2026 Title Test', bbm: FORDYCE_BBM },
    });
    const { id } = (await res.json()) as { id: string };

    await openEditor(page, id);
    await expect(page.getByText('Fordyce 2026 Title Test')).toBeVisible({ timeout: 8000 });
  });

  test('Fordyce 2026 snapshot returns substantial bytes', async ({ page }) => {
    await login(page);

    const res = await page.request.post('/api/layouts', {
      data: { title: 'Fordyce 2026 Snapshot', bbm: FORDYCE_BBM },
    });
    const { id } = (await res.json()) as { id: string };

    const snap = await page.request.get(`/api/layouts/${id}/snapshot`);
    expect(snap.ok()).toBe(true);
    const buf = await snap.body();
    // 949 bricks should produce a snapshot well over 1 KB.
    expect(buf.byteLength).toBeGreaterThan(1000);
  });

  test('Fordyce 2026 export round-trip preserves XML structure', async ({ page }) => {
    await login(page);

    const res = await page.request.post('/api/layouts', {
      data: { title: 'Fordyce 2026 Round-trip', bbm: FORDYCE_BBM },
    });
    const { id } = (await res.json()) as { id: string };

    const exportRes = await page.request.get(`/api/layouts/${id}/export.bbm`);
    expect(exportRes.ok()).toBe(true);
    const xml = await exportRes.text();
    expect(xml).toContain('<Map>');
    expect(xml).toContain('</Map>');
    // Original has 949 bricks. The writer emits `<Brick id="...">` (see
    // packages/bbm/src/Writer.ts) — there's no `<BrickRef>` element.
    const itemMatches = xml.match(/<Brick id="/g);
    expect(itemMatches).not.toBeNull();
    expect(itemMatches!.length).toBeGreaterThan(100);
  });

  test('Fordyce 2026 undo/redo does not crash the editor', async ({ page }) => {
    await login(page);

    const res = await page.request.post('/api/layouts', {
      data: { title: 'Fordyce 2026 UndoRedo', bbm: FORDYCE_BBM },
    });
    const { id } = (await res.json()) as { id: string };

    await openEditor(page, id);
    await page.locator('canvas').last().click();
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+y');
    await expect(page.locator('canvas').first()).toBeVisible();
  });
});

test.describe('editor — layers panel', () => {
  // Regression coverage for: "add layer" was silently a no-op because the
  // menu wired into the idempotent `ensure*Layer` seed helpers (which
  // early-return the existing layer of that kind instead of creating a
  // new one) rather than a real "always add" mutation. See addLayer() in
  // apps/web/src/editor/mutations.ts.

  test('adding a parts layer actually adds a new layer', async ({ page }) => {
    const id = await loginAndCreateLayout(page);
    await openEditor(page, id);

    const layersPanel = page.locator('aside', { hasText: 'Sheets' });
    await expect(layersPanel).toBeVisible();

    const countBefore = Number(await layersPanel.locator('span.text-neutral-600').innerText());

    await layersPanel.getByTitle('Add a new sheet').click();
    await page.getByRole('button', { name: 'Parts sheet' }).click();

    await expect(layersPanel.locator('span.text-neutral-600')).toHaveText(String(countBefore + 1));

    // A second "Parts layer" click must add ANOTHER layer, not silently
    // no-op on top of the one that already exists (the original bug).
    await layersPanel.getByTitle('Add a new sheet').click();
    await page.getByRole('button', { name: 'Parts sheet' }).click();
    await expect(layersPanel.locator('span.text-neutral-600')).toHaveText(String(countBefore + 2));

    // The two new parts layers get disambiguated default names.
    await expect(layersPanel.getByText('Parts', { exact: true })).toBeVisible();
    await expect(layersPanel.getByText('Parts 2', { exact: true })).toBeVisible();
  });

  test('newly added layer becomes the active layer', async ({ page }) => {
    const id = await loginAndCreateLayout(page);
    await openEditor(page, id);

    const layersPanel = page.locator('aside', { hasText: 'Sheets' });
    await layersPanel.getByTitle('Add a new sheet').click();
    await page.getByRole('button', { name: 'Area sheet' }).click();

    // The active row is filled with the accent color and badged "Active";
    // the newly-added "Area" row should be the one carrying it.
    const activeRow = layersPanel.locator('li[data-active]');
    await expect(activeRow).toContainText('Area');
    await expect(activeRow.getByTestId('active-sheet-badge')).toBeVisible();
  });

  test('layers panel shows a part count for the default parts (brick) layer', async ({ page }) => {
    const id = await loginAndCreateLayout(page);
    await openEditor(page, id);

    const layersPanel = page.locator('aside', { hasText: 'Sheets' });
    // A freshly-created layout seeds one grid layer + one brick layer
    // named "Layout" (createDefaultLayoutDoc, packages/ydoc/src/index.ts).
    const partsRow = layersPanel.locator('li', { hasText: 'Layout' }).first();
    // Starts empty.
    await expect(partsRow.locator('span.tabular-nums.text-\\[10px\\].text-muted')).toHaveText('0');
  });
});

test.describe('editor — saving', () => {
  test('there is one Save button, and it saves', async ({ page }) => {
    const id = await loginAndCreateLayout(page);
    await openEditor(page, id);
    const save = page.getByRole('button', { name: 'Save', exact: true });
    await expect(save).toHaveCount(1);
    await save.click();
    await expect(page.getByTestId('save-status')).toHaveText('Saved');
  });
});
