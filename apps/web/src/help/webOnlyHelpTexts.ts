// Help behind "?" buttons the desktop app has no screen for (site admin
// pages, the Profile page's password). Kept apart from helpTexts.ts, whose keys and words the desktop
// copies (help-keys.txt): these never go to the desktop. The same rules
// apply (helpTexts.test.ts): one sentence on hover, two or three on click.

import type { HelpEntry } from './helpTexts';

export const WEB_ONLY_HELP_TEXTS = {
  'admin.imports': {
    title: 'Model import',
    short: 'Lets people import LDraw, BrickLink Studio and LDD files, read on this server by the desktop app’s own importer.',
    more: 'The importer runs locked down: no network, its own folder, limits on time and memory, and the file is deleted once it’s read. Turn it off here, or with IMPORTS_ENABLED on the server. If the importer is missing or too old, this page says so.',
  },
  'admin.importLibraries': {
    title: 'Import libraries',
    short: 'The parts libraries the importer draws models with; without them, parts are left out of the picture and counted.',
    more: 'The LDraw library draws LDraw and Studio models; LDD’s brick database draws LDD models; the mapping links LDD bricks to LDraw parts; Studio’s library adds Studio-only parts. They are kept beside the database, never served to anyone and never in a backup or a data download.',
  },
  'admin.importLimits': {
    title: 'Import limits',
    short: 'How big a file can be, how often each person can import, and how much the server works on at once.',
    more: 'Each preview and each import counts toward the hourly limit. Imports beyond the ones running wait in line, and people see their place. An import that takes longer than the time limit is stopped and the person is told.',
  },
  'import.asPart': {
    title: 'A custom part from a model',
    short: 'Turn an LDraw, BrickLink Studio or LDD model into one custom part, read by the desktop app’s own importer.',
    more: 'Pick the model file, line it up with the studs in the preview, and save it to your parts or a club’s. It shows up in Custom parts and the Parts panel at once. In the editor you can also place it in the middle of your view.',
    learnMoreUrl: '/help#importing',
  },
  'import.zoom': {
    title: 'Zooming the preview',
    short: 'Zoom in to check the studs sit on the grid: scroll or pinch over the picture, or use − and +.',
    more: 'Drag the picture to look around. Fit shows the whole model again, and 100% shows one pixel of the picture for each pixel of your screen. The grid and the snap points stay sharp at every zoom, and the arrow keys move the model against the grid.',
    learnMoreUrl: '/help#importing',
  },
  'import.saveTo': {
    title: 'Where the part is saved',
    short: 'Save the new part to your own parts or to a club you add parts to.',
    more: 'Save to my parts only adds it to your parts, ready to place later. Save and place it here also puts it in the middle of your view, on the sheet you pick; Edit › Undo takes it back off the map, and the part stays saved.',
    learnMoreUrl: '/help#importing',
  },
  'catalog.sharedModules': {
    title: 'Shared modules in a published layout',
    short: 'A published layout carries the parts of the shared modules placed in it.',
    more: 'The copy in the catalog, and every copy people take from it, has those modules’ parts as they are now. In those copies the modules are marked “No longer shared” and get no updates from their owner. If the owner would rather not have the parts published, remove the module from the layout first.',
  },
  'account.confirmEmail': {
    title: 'Confirm your email',
    short: 'Confirming proves the address is yours, so invites and hand-overs sent to it can reach you here.',
    more: 'We email a link to your address. Open it while signed in to this account; anywhere else, the page asks you to sign in first. Confirming changes nothing else: you stay signed in everywhere, with the same password.',
  },
  'admin.emailProven': {
    title: 'Email confirmed',
    short: 'Whether this person has proven they own their address: opened a link sent to it, or signed in with a provider that vouches for it.',
    more: '“Verified” alone isn’t proof: accounts made while email checks were off are stored as verified. While this site can send email, invites and hand-overs sent to an address only reach an account whose address is confirmed; the person can confirm it from Home or their Profile. Without email set up, they work as before.',
  },
  'account.password': {
    title: 'Your password',
    short: 'Changing your password signs you out of your other browsers and desktop apps, and keeps you signed in here.',
    more: 'You need your current password to change it. If you’ve forgotten it, sign out and choose “Forgot password?” on the sign-in page: we email you a link that works once, for an hour. Desktop apps ask you to sign in again; their work stays on the computer.',
  },
  'account.devices': {
    title: 'Browsers and devices',
    short: 'Every browser and desktop app signed in to your account, so you can sign out any you don’t use or don’t know.',
    more: 'Signing a browser out ends its sign-in at once, and any layout it has open stops syncing. “Sign out of my other browsers” keeps you signed in here. Desktop apps keep their work on the computer and ask to sign in again.',
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
  'admin.inviteEmails': {
    title: 'Invite emails a day',
    short: 'How many invite and hand-over emails one person may send from this site in a day.',
    more: 'It keeps a throwaway account from sending lots of email in the site’s name, and brand-new accounts get the lower number for their first week. Past it, the invite is still made: the person sees a friendly note and copies the link to send it themselves. You can raise it for one person on their Use and limits page.',
  },
  'admin.demoSpaces': {
    title: 'Demo spaces',
    short: 'Each visitor who tries the demo gets a private space of their own, with their own copy of the samples.',
    more: 'A space and everything in it is deleted when its time is up (set below, 1 hour unless you change it), even if the visitor just closes the tab. The most at once keeps the demo from filling the server; past it, “Try the demo” says the demo is busy and to try again in a few minutes.',
  },
  'admin.demoStorage': {
    title: 'Space for each demo space',
    short: 'How much one visitor’s demo space may hold: their layouts, modules, venues and background pictures together.',
    more: 'Keep it small: anyone can open a demo space without an account. A visitor who fills theirs is told it is full and can delete something to free up space. It holds even when usage limits are switched off, and a demo space never gets more than “Space per person”.',
  },
  'admin.demoPerAddress': {
    title: 'Demo spaces from one network address',
    short: 'How many demo spaces can be open at once from the same address, so one visitor can’t take them all.',
    more: 'People on one Wi-Fi (a club night, a show) share an address, so allow enough for them; someone who presses “Try the demo” again in the same browser just goes back to the space they have. Past it, “Try the demo” says to try again when a space ends, and 0 means no cap. Behind a reverse proxy, set TRUST_PROXY, or every visitor looks like the same address.',
  },
  'admin.demoLifetime': {
    title: 'How long a demo space lasts',
    short: 'Each visitor gets this much time, counted from when they pressed “Try the demo”.',
    more: 'A visitor sees a friendly countdown, and a reminder to download their layout in the last 5 minutes. When time is up their space is deleted and they can start a new one. A change applies to spaces made from then on; putting the samples back never cuts a visit short.',
  },
} as const satisfies Record<string, HelpEntry>;

export type WebOnlyHelpKey = keyof typeof WEB_ONLY_HELP_TEXTS;

export const WEB_ONLY_HELP_KEYS = Object.keys(WEB_ONLY_HELP_TEXTS) as WebOnlyHelpKey[];
