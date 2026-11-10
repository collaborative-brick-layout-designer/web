// E2E: desktop sign-in via the device-code flow. Plays the desktop app
// with plain API calls (no cookies) — request a code, poll for the token
// — while the signed-in user approves on /device in the browser. The
// token then opens the realtime WebSocket with an Authorization header,
// as the desktop client will, and must get the document (sync step 2).
// Finally the user revokes the device from their profile, which closes
// that socket with 1008.

import { test, expect, type APIRequestContext } from '@playwright/test';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { signIn, confirmInDialog } from '../helpers';

const EMAIL = `device-${Date.now()}@example.com`;
const MESSAGE_SYNC = 0;

interface CodeResponse {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  interval: number;
}

async function pollForToken(request: APIRequestContext, code: CodeResponse): Promise<Record<string, unknown>> {
  for (let i = 0; i < 20; i++) {
    const res = await request.post('/api/auth/device/token', {
      data: { device_code: code.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (res.ok()) return body;
    expect(['authorization_pending', 'slow_down']).toContain(body.error);
    const interval = typeof body.interval === 'number' ? body.interval : code.interval;
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
  throw new Error('device token never issued');
}

/** Open the layout socket with a Bearer token and resolve with the server's sync step 2 payload. */
function syncOverBearer(url: string, token: string): Promise<{ ws: WebSocket; update: Uint8Array; closed: Promise<number> }> {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no sync step 2 within 10s')), 10_000);
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
    ws.on('open', () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(enc, new Y.Doc());
      ws.send(encoding.toUint8Array(enc));
    });
    ws.on('message', (data: Buffer) => {
      const dec = decoding.createDecoder(new Uint8Array(data));
      if (decoding.readVarUint(dec) !== MESSAGE_SYNC) return;
      if (decoding.readVarUint(dec) !== syncProtocol.messageYjsSyncStep2) return;
      clearTimeout(timer);
      resolve({ ws, update: decoding.readVarUint8Array(dec), closed });
    });
  });
}

test.describe('desktop sign-in (device code)', () => {
  test('approve on /device, poll a token, sync over the WebSocket, then revoke', async ({ page, request, baseURL }) => {
    test.setTimeout(60_000);
    await signIn(page, EMAIL);
    const created = await page.request.post('/api/layouts', { data: { title: 'Device Sync Layout' } });
    expect(created.ok()).toBe(true);
    const { id } = (await created.json()) as { id: string };

    // --- the "desktop app": ask for a code (no cookies on `request`) ----
    const codeRes = await request.post('/api/auth/device/code', {
      data: { client_name: 'Playwright Desktop', scope: 'layouts:read layouts:write' },
    });
    expect(codeRes.ok()).toBe(true);
    const code = (await codeRes.json()) as CodeResponse;
    expect(code.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect((await request.post('/api/auth/device/token', { data: { device_code: code.device_code } })).status()).toBe(400);

    // --- the user approves in the browser ------------------------------
    const complete = new URL(code.verification_uri_complete);
    await page.goto(`${complete.pathname}${complete.search}`);
    await expect(page.getByRole('heading', { name: 'Allow Playwright Desktop?' })).toBeVisible();
    await expect(page.getByText(code.user_code)).toBeVisible();
    await expect(page.getByText('Edit your layouts (live sync)')).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('heading', { name: 'Device connected' })).toBeVisible();

    // --- the app's poll now yields a token -----------------------------
    const tok = await pollForToken(request, code);
    expect(tok.token_type).toBe('Bearer');
    const accessToken = tok.access_token as string;
    expect(accessToken.startsWith('bld_pat_')).toBe(true);

    const list = await request.get('/api/layouts', { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(list.ok()).toBe(true);
    expect(((await list.json()) as { layouts: { id: string }[] }).layouts.map((l) => l.id)).toContain(id);

    // --- live sync with the Bearer header, as the desktop client will ---
    const wsUrl = `${new URL(baseURL!).origin.replace(/^http/, 'ws')}/ws/layout/${id}`;
    const { update, closed } = await syncOverBearer(wsUrl, accessToken);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    expect(doc.getMap('meta').get('schemaVersion')).toBe(1);

    // --- the device shows on the profile and can be revoked ------------
    await page.goto('/profile');
    await expect(page.getByText('Playwright Desktop')).toBeVisible();
    await page.getByRole('button', { name: 'Revoke Playwright Desktop' }).click();
    await confirmInDialog(page);
    await expect(page.getByText('No desktop apps signed in.')).toBeVisible();
    expect(await Promise.race([closed, new Promise((r) => setTimeout(() => r('open'), 5000))])).toBe(1008);
  });
});
