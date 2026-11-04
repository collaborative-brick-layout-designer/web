// Help behind "?" buttons the desktop app has no screen for (site admin
// pages). Kept apart from helpTexts.ts, whose keys and words the desktop
// copies (help-keys.txt): these never go to the desktop. The same rules
// apply (helpTexts.test.ts): one sentence on hover, two or three on click.

import type { HelpEntry } from './helpTexts';

export const WEB_ONLY_HELP_TEXTS = {
  'admin.signIn': {
    title: 'How long sign-ins last',
    short: 'A sign-in ends when it isn’t used for a while, or when it reaches its longest, whichever comes first.',
    more: 'Each visit, or each time the desktop app connects, starts the unused time over, so people who keep using the site stay signed in until the longest. A change here applies to everyone at their next visit; nobody is signed out when you save. The desktop app keeps its work on the computer and asks its owner to sign in again.',
  },
} as const satisfies Record<string, HelpEntry>;

export type WebOnlyHelpKey = keyof typeof WEB_ONLY_HELP_TEXTS;

export const WEB_ONLY_HELP_KEYS = Object.keys(WEB_ONLY_HELP_TEXTS) as WebOnlyHelpKey[];
