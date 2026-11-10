// The privacy clean-up says in the server log that it ran: one line at
// start-up, and one after each hourly run that removed something.

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginAs, resetDb } from '../test/helpers.js';
import { attachUser } from '../auth/cookie.js';
import { passwordRoutes } from '../routes/auth/password.js';
import { privacyTickSummary, type PrivacyTickResult } from '../privacy/tick.js';
import { runPrivacyTick } from './index.js';

const none: PrivacyTickResult['retention'] = {
  sessions: 0,
  apiTokens: 0,
  deviceCodes: 0,
  emailVerifications: 0,
  invites: 0,
  transfers: 0,
  auditScrubbed: 0,
  erasures: 0,
  requests: 0,
  pictures: 0,
};
const result = (r: Partial<PrivacyTickResult>, retention: Partial<PrivacyTickResult['retention']> = {}): PrivacyTickResult => ({
  exportsPurged: 0,
  accountsErased: 0,
  clubsErased: 0,
  trashErased: 0,
  ...r,
  retention: { ...none, ...retention },
});

describe('privacyTickSummary', () => {
  it('is null when nothing was removed', () => {
    expect(privacyTickSummary(result({}))).toBeNull();
  });

  it('names what was removed, then always downloads, accounts and clubs', () => {
    expect(privacyTickSummary(result({}, { sessions: 2, invites: 1 }))).toBe(
      '[privacy] clean-up: 2 sessions, 1 invite, 0 exports, 0 accounts, 0 clubs',
    );
    expect(privacyTickSummary(result({ exportsPurged: 1, accountsErased: 2, clubsErased: 1 }))).toBe(
      '[privacy] clean-up: 1 export, 2 accounts, 1 club',
    );
  });
});

describe('runPrivacyTick', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetDb();
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  it('logs nothing when there is nothing to remove', async () => {
    await runPrivacyTick();
    expect(log).not.toHaveBeenCalled();
  });

  it('logs one line when it removed old sign-ins', async () => {
    const app = Fastify();
    await app.register(cookie);
    app.addHook('preHandler', attachUser);
    await app.register(passwordRoutes);
    await loginAs(app, 'ann@example.com');
    await app.close();
    // Years later every sign-in has long run out.
    await runPrivacyTick(new Date(Date.now() + 5 * 365 * 86_400_000));
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toMatch(/^\[privacy\] clean-up: .*1 session\b.*0 exports, 0 accounts, 0 clubs$/);
  });
});
