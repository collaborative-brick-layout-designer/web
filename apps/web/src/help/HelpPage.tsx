// /help: a short help page the "Learn more" links in help popovers point
// at. One screen per topic at most, plain words, no sign-in needed.

import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { GETTING_STARTED, SHORTCUT_GROUPS, SHORTCUT_NOTE } from './guide';

const TOPICS: { id: string; title: string; body: string[] }[] = [
  {
    id: 'sheets',
    title: 'Sheets',
    body: [
      'Sheets are like see-through pages stacked on the map. Put track on one, buildings on another, and scenery on a third.',
      'Hide a sheet to see what is under it, or lock it so nothing on it moves by accident. New parts always go on the sheet that is picked.',
    ],
  },
  {
    id: 'room',
    title: 'The venue',
    body: [
      'The venue is the hall your layout goes in: its walls, doors, columns and power points. Draw it once, save it to your club, and anyone can use it.',
      'With a venue under the layout, the status bar tells you if everything fits and leaves space to walk around.',
    ],
  },
  {
    id: 'sharing',
    title: 'Working together',
    body: [
      'Press Share to invite people by email. Editors can change the layout; viewers can only look.',
      'Everyone sees each other’s changes as they happen, and the circles at the top show who is here right now.',
    ],
  },
  {
    id: 'catalog',
    title: 'Sharing to the catalog',
    body: [
      'The catalog holds modules and parts people shared for everyone. To share one of yours, open its ⋯ menu on Home and choose Share to the public catalog. A moderator checks it first, unless the site lets things in straight away.',
      'Anyone can add a catalog item to their own modules or parts. It’s a copy: change it as you like.',
    ],
  },
  {
    id: 'collections',
    title: 'Collections',
    body: [
      'A collection is a set of modules and parts that go well together, like “Starter town” or a club’s show standards. Add one item, or Add all to copy everything at once; what you already have is skipped.',
      'Make one with New collection, or use “Add to a collection…” on any module or part. Private collections are only for you, or only for your club’s members, and are never checked. A public one is in the catalog: a moderator checks its title, description and cover first, and each of your own modules and parts in it is checked on its own before it shows.',
    ],
  },
  {
    id: 'opening',
    title: 'Opening a file',
    body: [
      'Choose Open a file… on Home or in the editor’s Map menu, or drop a file anywhere on the page. The website opens this app’s layout files (.bld-layout), BlueBrick maps (.bbm), TrackDesigner (.tdl) and 4DBrix (.ncp). After opening, it says how many parts came in and lists any that aren’t in the parts library.',
      'LDraw (.ldr, .mpd), BrickLink Studio (.io) and LEGO Digital Designer (.lxf) models are imported in the desktop app, which matches their parts or turns a model into a custom part. Then choose File › Save to Server… there, and it shows up here.',
    ],
  },
  {
    id: 'files',
    title: 'Saving a copy',
    body: [
      'Everything saves by itself on the server. To keep your own copy, download the layout file: it holds everything and opens in this app and the desktop app.',
      'Download a BlueBrick map (.bbm) only for people who use the old BlueBrick program. It leaves out the venue, labels, modules and background picture.',
    ],
  },
];

/** The page's sections, which "Learn more" links can point at. */
export const HELP_SECTIONS = ['getting-started', ...TOPICS.map((t) => t.id), 'shortcuts'];

export function HelpPage() {
  const { hash } = useLocation();
  // Jump to the topic a "Learn more" link asked for once the page is drawn.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);

  const card = 'scroll-mt-6 rounded-section border border-line bg-panel p-6';
  const h2 = 'mb-3 font-display text-xl font-bold';
  return (
    <div className="theme-page h-full overflow-y-auto bg-bg px-4 py-8 text-ink sm:px-16 sm:py-12">
      <div className="mx-auto flex max-w-3xl flex-col gap-5">
        <Link to="/" className="tap-target inline-flex items-center self-start text-sm font-semibold text-muted hover:text-ink">
          ← Home
        </Link>
        <h1 className="font-display text-3xl font-bold">Help</h1>

        <section id="getting-started" className={card}>
          <h2 className={h2}>Getting started</h2>
          <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-snug">
            {GETTING_STARTED.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </section>

        {TOPICS.map((t) => (
          <section key={t.id} id={t.id} className={card}>
            <h2 className={h2}>{t.title}</h2>
            {t.body.map((p) => (
              <p key={p} className="mb-2 text-[15px] leading-snug last:mb-0">
                {p}
              </p>
            ))}
          </section>
        ))}

        <section id="shortcuts" className={card}>
          <h2 className={h2}>Keyboard shortcuts</h2>
          <ShortcutList />
        </section>
      </div>
    </div>
  );
}

export function ShortcutList() {
  return (
    <div className="flex flex-col gap-3">
      {SHORTCUT_GROUPS.map((g) => (
        <div key={g.title}>
          <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">{g.title}</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
            {g.items.map((s) => (
              <div key={s.keys} className="contents">
                <dt>
                  <kbd className="whitespace-nowrap rounded-md border border-border bg-soft px-1.5 py-0.5 font-sans text-[12px] font-semibold">{s.keys}</kbd>
                </dt>
                <dd>{s.does}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      <p className="text-xs text-muted">{SHORTCUT_NOTE}</p>
    </div>
  );
}
