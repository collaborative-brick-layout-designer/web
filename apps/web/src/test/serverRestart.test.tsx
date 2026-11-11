// A save that meets a restarting server (502, 503, 504 or no answer) waits
// and tries again with a calm note; a 4xx is never retried; only after
// about 30 seconds does it fail, with a real message.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { api, ModuleChangedError } from '../api';
import { RESTART_BACKOFF_MS, sendThroughRestart } from '../serverRestart';
import { ServerRestartNote } from '../ui/ServerRestartNote';

const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('saving while the server restarts', () => {
  it('has backoff of 1, 2, 4, 8 and 15 seconds, about 30 in all', () => {
    expect(RESTART_BACKOFF_MS).toEqual([1000, 2000, 4000, 8000, 15000]);
  });

  for (const status of [502, 503, 504]) {
    it(`retries a module save after a ${status} and it lands, with no error`, async () => {
      fetchMock.mockResolvedValueOnce(json(status)).mockResolvedValueOnce(json(200, { updatedAt: 5, docVersion: 3 }));
      const saved = api.modules.saveSnapshot('m1', new Uint8Array([1]), undefined, 2);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(saved).resolves.toMatchObject({ docVersion: 3 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  }

  it('retries a thumbnail PUT, a settings PATCH and a network failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(json(200, { ok: true, thumbnailAt: 1 }));
    const thumb = api.modules.setThumbnail('m1', { mime: 'image/png', data: 'AAAA' });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(thumb).resolves.toMatchObject({ ok: true });
    fetchMock.mockResolvedValueOnce(json(502)).mockResolvedValueOnce(json(200, { ok: true, id: 'v1', name: 'Hall' }));
    const venue = api.venues.rename('v1', 'Hall');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(venue).resolves.toMatchObject({ ok: true });
  });

  it('never retries a 4xx, such as 409 module_changed', async () => {
    fetchMock.mockResolvedValue(json(409, { error: 'module_changed', docVersion: 9 }));
    await expect(api.modules.saveSnapshot('m1', new Uint8Array([1]), undefined, 2)).rejects.toBeInstanceOf(ModuleChangedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(json(403, { error: 'forbidden' }));
    await expect(api.venues.rename('v1', 'x')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a create (POST)', async () => {
    fetchMock.mockResolvedValue(json(502));
    await expect(api.modules.create({ title: 'x' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows a calm note while it waits, then nothing', async () => {
    render(<ServerRestartNote />);
    expect(screen.queryByTestId('server-restart-note')).toBeNull();
    fetchMock.mockResolvedValueOnce(json(502)).mockResolvedValueOnce(json(200, { ok: true, thumbnailAt: 1 }));
    const thumb = api.modules.setThumbnail('m1', { mime: 'image/png', data: 'AAAA' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByTestId('server-restart-note').textContent).toBe('Saving… the server is restarting, trying again.');
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await thumb;
    expect(screen.queryByTestId('server-restart-note')).toBeNull();
  });

  it('gives up after about 30 seconds with a real message', async () => {
    fetchMock.mockResolvedValue(json(502));
    const saved = api.modules.saveSnapshot('m1', new Uint8Array([1]));
    const failed = expect(saved).rejects.toThrow(/restarting and didn’t come back in time\. Please try again/);
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(fetchMock).toHaveBeenCalledTimes(RESTART_BACKOFF_MS.length + 1);
  });

  it('gives up on a network failure after the last wait', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const sent = sendThroughRestart(() => fetch('/x'));
    const failed = expect(sent).rejects.toBeInstanceOf(TypeError);
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
  });
});
