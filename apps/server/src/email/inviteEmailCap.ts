// The daily cap on invite and hand-over emails one person sends (Admin ›
// Limits: "Invite emails per person a day", lower in an account's first
// week). Past it the invite is still made; the email is skipped and the
// reply carries a friendly note so the person copies the link and sends
// it themselves. Counted always, capped only while limits are enforced,
// like every other limit.

import type { User } from '../db/schema.js';
import { limitsEnforced, plural, userLimits } from '../limits/limits.js';
import { usage } from '../metrics/usage.js';
import { sendInviteEmail } from './sendInvite.js';

type InviteArgs = Parameters<typeof sendInviteEmail>[0];

export interface InviteMailResult {
  /** The email went out. */
  emailDelivered: boolean;
  /** Skipped because the sender reached today's cap. */
  emailCapped?: true;
  /** Ready to show the sender when the email was skipped for the cap. */
  emailNote?: string;
}

/**
 * Send one invite or hand-over email from `sender`, unless they've sent
 * their most for today. Never throws: a failed send is `emailDelivered:
 * false`, and the caller still returns the link.
 */
export async function sendInviteEmailCapped(sender: Pick<User, 'id' | 'emailVerified' | 'createdAt'>, args: InviteArgs): Promise<InviteMailResult> {
  const now = Date.now();
  const sent = usage.today('user', sender.id, 'invite_emails', now);
  if (await limitsEnforced(now)) {
    const max = (await userLimits(sender, now)).inviteEmailsPerDay.value;
    if (sent >= max) {
      return {
        emailDelivered: false,
        emailCapped: true,
        emailNote: `You’ve sent ${plural(max, 'invite email')} today, the most for one day, so this one wasn’t emailed. Your invite is ready: copy the link and send it yourself.`,
      };
    }
  }
  // Counted before the send, so invites sent at the same moment can't all slip past the cap.
  usage.count('user', sender.id, 'invite_emails', 1, now);
  let delivered = false;
  try {
    delivered = await sendInviteEmail(args);
  } catch {
    // delivered stays false; the sender has the link.
  }
  if (!delivered) usage.count('user', sender.id, 'invite_emails', -1, now);
  return { emailDelivered: delivered };
}
