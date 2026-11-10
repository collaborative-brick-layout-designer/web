// Static "About" page. No auth required so unauthenticated visitors hitting
// the public-share viewer can still read the project blurb / licence /
// issue-reporting info. We DO show the AppHeader when the user is signed
// in, but skip it (and the surrounding nav) when they aren't — same shape
// as the public layout viewer.

import { Link } from 'react-router-dom';
import { SignInLink } from './auth/signIn';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { AppHeader } from './AppHeader';
import { DESKTOP_URL, ISSUES_URL, LICENCE, REPO_URL } from './projectLinks';

const BLUEBRICK_PARTS_URL = 'https://github.com/Lswbanban/BlueBrickParts';
const ORIGINAL_BLUEBRICK_URL = 'http://bluebrick.lswproject.com/';

export function AboutPage() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });

  return (
    <div className="h-full overflow-y-auto p-8 text-ink">
      {me.data?.user ? (
        <AppHeader user={me.data.user} />
      ) : (
        <header className="flex items-center justify-between border-b border-line pb-4">
          <Link to="/" className="flex items-center gap-2 text-2xl font-semibold hover:underline">
            <img src="/logo.png" alt="" className="h-8 w-8 rounded-lg" />
            Collaborative Brick Layout Designer
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <SignInLink className="text-neutral-300 hover:underline">
              Sign in
            </SignInLink>
          </nav>
        </header>
      )}

      <main className="mx-auto mt-8 max-w-4xl space-y-8">
        <section>
          <h1 className="text-2xl font-semibold">About</h1>
          <p className="mt-3 text-neutral-300">
            The web version of Collaborative Brick Layout Designer. Its{' '}
            <a href={DESKTOP_URL} className="text-accent-text hover:underline">
              desktop app
            </a>{' '}
            is a Qt rebuild of the original{' '}
            <a href={ORIGINAL_BLUEBRICK_URL} className="text-accent-text hover:underline">
              BlueBrick
            </a>{' '}
            LEGO layout editor by Alban Nanty. This version runs in the
            browser, supports real-time multi-user editing via Yjs, and
            keeps byte-exact <code>.bbm</code> round-trip with the
            desktop save format.
          </p>
        </section>

        <section aria-labelledby="made-with-ai">
          <h2 id="made-with-ai" className="text-lg font-semibold">Made with AI</h2>
          <p className="mt-2 text-sm text-neutral-300">
            Much of this app was written with the help of AI (Anthropic&apos;s Claude), directed and
            reviewed by a person. It is tested, but it can still contain mistakes. If you find one,
            please report it (below).
          </p>
        </section>

        <section aria-labelledby="privacy">
          <h2 id="privacy" className="text-lg font-semibold">What the server counts</h2>
          <p className="mt-2 text-sm text-neutral-300">
            To keep the site healthy, the server keeps daily totals: how many people used it, with
            the web or the desktop app, on a phone or a computer, and how many requests, errors and
            refused requests it had. It also remembers when you were last signed in and when each
            layout was last opened. It does not record which pages you visit or your IP address.
            Daily totals are kept for about 13 months, and only site admins can see them. To spot
            misuse, it also counts each account’s and club’s requests, refused requests, uploads and
            share-link views per day; those counts are kept for 90 days.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">Reporting issues</h2>
          <p className="mt-2 text-sm text-neutral-300">
            Bug reports, feature requests, and "this is wrong, here's
            why" comments are very welcome. File them on the{' '}
            <a href={ISSUES_URL} className="text-accent-text hover:underline">
              GitHub issue tracker
            </a>
            . For security problems, please don't open a public issue —
            use GitHub's "Report a vulnerability" private form on the
            repository instead.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">Links</h2>
          <ul className="mt-2 space-y-1 text-sm">
            <li>
              <a href={REPO_URL} className="tap-target inline-flex items-center text-accent-text hover:underline">
                Source code (GitHub)
              </a>
            </li>
            <li>
              <a href={ISSUES_URL} className="tap-target inline-flex items-center text-accent-text hover:underline">
                Report an issue
              </a>
            </li>
            <li>
              <a href={DESKTOP_URL} className="tap-target inline-flex items-center text-accent-text hover:underline">
                The desktop app (Windows, Mac and Linux)
              </a>
            </li>
            <li>
              <a href={ORIGINAL_BLUEBRICK_URL} className="tap-target inline-flex items-center text-accent-text hover:underline">
                Original BlueBrick
              </a>
            </li>
            <li>
              <a href={BLUEBRICK_PARTS_URL} className="tap-target inline-flex items-center text-accent-text hover:underline">
                BlueBrickParts library
              </a>
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold">License</h2>
          <p className="mt-2 text-sm text-neutral-300">
            {LICENCE}. The bundled BlueBrickParts library is a
            git submodule of the upstream project and retains its
            original licence.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">Credits</h2>
          <ul className="mt-2 space-y-1 text-sm text-neutral-300">
            <li>
              <strong>Alban Nanty</strong> — original BlueBrick and the
              <code className="mx-1">.bbm</code> save format.
            </li>
            <li>
              <strong>Lswbanban</strong> and contributors — current
              BlueBrickParts maintenance.
            </li>
            <li>
              <strong>Yjs</strong> — CRDT backend for real-time
              collaboration.
            </li>
            <li>
              <strong>Konva / react-konva</strong> — canvas rendering.
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}
