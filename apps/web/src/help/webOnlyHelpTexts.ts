// Help behind "?" buttons the desktop app has no screen for (site admin
// pages, the Profile page's password). Kept apart from helpTexts.ts, whose keys and words the desktop
// copies (help-keys.txt): these never go to the desktop. The same rules
// apply (helpTexts.test.ts): one sentence on hover, two or three on click.

import type { HelpEntry } from './helpTexts';

export const WEB_ONLY_HELP_TEXTS = {
  'account.password': {
    title: 'Your password',
    short: 'Changing your password signs you out of your other browsers and desktop apps, and keeps you signed in here.',
    more: 'You need your current password to change it. If you’ve forgotten it, sign out and choose “Forgot password?” on the sign-in page: we email you a link that works once, for an hour. Desktop apps ask you to sign in again; their work stays on the computer.',
  },
  'admin.signIn': {
    title: 'How long sign-ins last',
    short: 'A sign-in ends when it isn’t used for a while, or when it reaches its longest, whichever comes first.',
    more: 'Each visit, or each time the desktop app connects, starts the unused time over, so people who keep using the site stay signed in until the longest. A change here applies to everyone at their next visit; nobody is signed out when you save. The desktop app keeps its work on the computer and asks its owner to sign in again.',
  },
  'admin.readOnly': {
    title: 'Read-only accounts and clubs',
    short: 'A read-only account or club can open, download and delete its things, but can’t add or change anything.',
    more: 'Read-only always holds, even while “Enforce usage limits” is off, so it’s safe to use while you look into something. Open live editors drop to view-only at once. Lifting it gives everything back; nothing is deleted.',
  },
} as const satisfies Record<string, HelpEntry>;

export type WebOnlyHelpKey = keyof typeof WEB_ONLY_HELP_TEXTS;

export const WEB_ONLY_HELP_KEYS = Object.keys(WEB_ONLY_HELP_TEXTS) as WebOnlyHelpKey[];
