// Shared nodemailer transporter, built from the resolved SMTP config
// (platform_settings DB override, falling back to env.smtp — see
// auth/platformSettings.ts's mergeSmtpConfig). Both sendInvite.ts and
// sendVerification.ts go through here instead of each keeping their
// own module-scoped cache, so a config change made via the admin
// settings UI takes effect on the next send instead of silently
// continuing to use whatever was live when the process booted.

import { getPlatformSettings, mergeSmtpConfig, type ResolvedSmtpConfig } from '../auth/platformSettings.js';
import { MAIL_PASSWORD_UNREADABLE } from '../secrets/secretBox.js';

interface NodemailerTransport {
  sendMail: (opts: unknown) => Promise<unknown>;
}

let unreadableSaidAt = 0;
let cached: { config: ResolvedSmtpConfig; transporter: NodemailerTransport } | null = null;

/**
 * Returns null when no SMTP is configured (DB or env), or when the saved
 * password can't be read (see below). Otherwise
 * returns a transporter for the currently-resolved config, rebuilding
 * it if the config has changed since the last call — comparing every
 * field rather than trusting a single "generation" counter keeps this
 * correct even if invalidateTransporter() is never called (e.g. a
 * multi-process deployment where only one process handled the PATCH).
 */
export async function getTransporter(): Promise<{ transporter: NodemailerTransport; config: ResolvedSmtpConfig } | null> {
  const settings = await getPlatformSettings();
  const config = mergeSmtpConfig(settings);
  if (!config) {
    cached = null;
    return null;
  }
  if (config.passUnreadable) {
    // The saved password can't be opened with this server's key: send
    // nothing (callers do what they do with no SMTP: links to copy, or in
    // the log) and say why, at most once a minute.
    cached = null;
    if (Date.now() - unreadableSaidAt > 60_000) {
      unreadableSaidAt = Date.now();
      console.warn(`[email] not sent: ${MAIL_PASSWORD_UNREADABLE} (Admin › Settings › SMTP server)`);
    }
    return null;
  }
  if (cached && configsEqual(cached.config, config)) {
    return cached;
  }
  const nodemailer = await import('nodemailer');
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
  }) as unknown as NodemailerTransport;
  cached = { config, transporter };
  return cached;
}

function configsEqual(a: ResolvedSmtpConfig, b: ResolvedSmtpConfig): boolean {
  return a.host === b.host && a.port === b.port && a.user === b.user && a.pass === b.pass && a.from === b.from;
}

/**
 * Whether this site can send email now: SMTP is set up (Admin › Settings
 * or the environment) and its saved password can be read. Says nothing
 * about whether the server answers.
 */
export async function emailConfigured(): Promise<boolean> {
  const config = mergeSmtpConfig(await getPlatformSettings());
  return !!config && !config.passUnreadable;
}

/** Force the next getTransporter() call to rebuild, regardless of config comparison. Called after a settings PATCH in the same process. */
export function invalidateTransporter(): void {
  cached = null;
}
