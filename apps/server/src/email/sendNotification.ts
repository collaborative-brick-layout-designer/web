// A notification by email (notifications/delivery.ts): one right away, or
// a daily or weekly summary of several. Every one carries a one-click
// "Stop these emails" link (RFC 8058 List-Unsubscribe headers, a signed
// token, no sign-in) and a link to Settings › Notifications. Links are
// built from PUBLIC_URL, never a fixed host. Best effort: false when the
// site can't send email.

import { getTransporter } from './transporter.js';
import { siteUrl } from './sendNotice.js';
import { escapeHtml } from '../utils/validate.js';

export const SETTINGS_PATH = '/settings#notifications';

export interface NotificationEmailItem {
  title: string;
  body: string;
  link: string | null;
}

export async function sendNotificationEmail(args: {
  to: string;
  subject: string;
  /** Opening line ("You have 3 new notifications."), for a summary. */
  intro?: string;
  items: NotificationEmailItem[];
  /** Why they get it, in plain words. */
  why: string;
  /** Where "Stop these emails" goes (the /unsubscribe page with its token), or null. */
  unsubscribePath: string | null;
  /** The one-click address mail apps POST to (RFC 8058), with the same token. */
  oneClickPath: string | null;
  unsubscribeLabel: string;
}): Promise<boolean> {
  try {
    const resolved = await getTransporter();
    if (!resolved) return false;
    const { transporter, config } = resolved;
    const settings = siteUrl(SETTINGS_PATH);
    const stop = args.unsubscribePath ? siteUrl(args.unsubscribePath) : null;
    const text = [
      ...(args.intro ? [args.intro] : []),
      ...args.items.map((i) => [i.title, i.body, i.link ? siteUrl(i.link) : ''].filter(Boolean).join('\n')),
      args.why,
      ...(stop ? [`${args.unsubscribeLabel}: ${stop}`] : []),
      `Notification settings: ${settings}`,
    ].join('\n\n') + '\n';
    const html =
      (args.intro ? `<p>${escapeHtml(args.intro)}</p>` : '') +
      args.items
        .map(
          (i) =>
            `<p><strong>${escapeHtml(i.title)}</strong>${i.body ? `<br>${escapeHtml(i.body).replace(/\n/g, '<br>')}` : ''}` +
            (i.link ? `<br><a href="${escapeHtml(siteUrl(i.link))}">Open it</a>` : '') +
            '</p>',
        )
        .join('') +
      `<p style="color:#666;font-size:12px">${escapeHtml(args.why)}<br>` +
      (stop ? `<a href="${escapeHtml(stop)}">${escapeHtml(args.unsubscribeLabel)}</a> · ` : '') +
      `<a href="${escapeHtml(settings)}">Notification settings</a></p>`;
    const oneClick = args.oneClickPath ? siteUrl(args.oneClickPath) : null;
    const headers: Record<string, string> = oneClick ? { 'List-Unsubscribe': `<${oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {};
    await transporter.sendMail({ from: config.from, to: args.to, subject: args.subject, text, html, headers });
    return true;
  } catch {
    return false;
  }
}
