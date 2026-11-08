// The help behind every "?" button, in plain words for club members.
// `short` is one sentence, shown on hover; `more` is two or three,
// shown on click. The words live in help-texts.json, which the desktop
// app has word for word (src/ui/help/help-texts.json; its tests compare
// the two), so there is one source and the apps can't drift apart.
// help-keys.txt next to this file is the key list, and helpTexts.test.ts
// keeps it in step.
//
// In the words people see, layers are "sheets" and the venue is the
// "room". Keys keep their own names and never change once shipped.

import shared from './help-texts.json';

export interface HelpEntry {
  /** The name of the thing, shown at the top of the popover. */
  title: string;
  /** One sentence, 140 characters at most. */
  short: string;
  /** Two or three short sentences. */
  more: string;
  /** An in-app help page (a path on this server, never a full address). */
  learnMoreUrl?: string;
}

export const HELP_TEXTS = shared.entries satisfies Record<string, HelpEntry>;

export type HelpKey = keyof typeof HELP_TEXTS;

export const HELP_KEYS = Object.keys(HELP_TEXTS) as HelpKey[];
