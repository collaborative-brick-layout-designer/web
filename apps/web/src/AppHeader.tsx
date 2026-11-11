// Shared site header used by every authenticated page (except the
// editor, which has its own dense per-document toolbar).
//
// Top-left: app title (links to Layouts home).
// Top-right: Home / Clubs / [Catalog] / About / [Notices], then one Menu ▾:
//            Help (tours, help topics), Account (profile, sign-in, devices,
//            sign out), Look, and Admin settings for admins and moderators
//            (see SettingsMenu.tsx). On a phone the page links move into it.
//
// All routes go through `<Link>` so React Router takes the
// hard-refresh out of the loop. Logout posts to /api/auth/logout and
// then sends the user to /login.

import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Me } from './api';
import { forgetNamePromptSkip } from './auth/NamePrompt';
import { SettingsMenu } from './SettingsMenu';

interface Props {
  user: Me;
}

export function AppHeader({ user }: Props) {
  // The Catalog link shows only while a public catalog is on.
  const catalog = useQuery({ queryKey: ['catalog-settings'], queryFn: api.catalog.settings, staleTime: 60_000 });
  // Only shown once there's something in it (a warning or a note).
  const notices = useQuery({ queryKey: ['notices'], queryFn: api.warnings.notices });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      qc.clear();
      // The next sign-in asks "What should we call you?" again, if it's still needed.
      forgetNamePromptSkip();
      navigate('/login', { replace: true });
    },
  });

  // Club admins see how many people are waiting to join their clubs.
  const waiting = useQuery({
    queryKey: ['join-request-count'],
    queryFn: api.orgs.joinRequestCount,
    staleTime: 60_000,
    retry: false,
  });
  const waitingCount = waiting.data?.count ?? 0;

  // Any of the four catalogs (a site may share only layouts or venues).
  const c = catalog.data;
  const showCatalog = !!(c?.modules || c?.parts || c?.layouts || c?.venues);
  const hasNotices = (notices.data?.notices?.length ?? 0) > 0;
  // On a phone the page links live in the menu.
  const pages = [
    { label: 'Home', to: '/' },
    {
      label: 'Clubs',
      to: '/orgs',
      ...(waitingCount > 0
        ? { badge: waitingCount, badgeLabel: `${waitingCount} ${waitingCount === 1 ? 'request' : 'requests'} to join` }
        : {}),
    },
    ...(showCatalog ? [{ label: 'Catalog', to: '/catalog' }] : []),
    { label: 'About', to: '/about' },
    ...(hasNotices ? [{ label: 'Notices', to: '/notices' }] : []),
  ];
  const linkBase = 'tap-target flex items-center rounded-control px-3 py-2 font-semibold hover:bg-soft hover:text-ink';
  // The page you're on is marked (aria-current="page" from NavLink).
  const link = ({ isActive }: { isActive: boolean }) => `${linkBase} ${isActive ? 'bg-soft text-ink' : 'text-muted'}`;
  return (
    <>
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 md:flex-nowrap rounded-section border border-line bg-panel px-4 py-3 theme-chrome">
      <Link to="/" className="tap-target flex min-w-0 flex-1 items-center gap-3 sm:max-w-[13rem] lg:max-w-none lg:flex-none">
        <img src="/logo.png" alt="" className="h-9 w-9 shrink-0 rounded-[9px]" />
        <span className="line-clamp-2 font-display text-base font-bold leading-tight text-ink lg:text-xl">Collaborative Brick Layout Designer</span>
      </Link>
      {/* One menu for everything that isn't a page: Help, Account, Look and
          Admin settings; on a phone the page links go in it too. */}
      <div className="flex shrink-0 items-center sm:order-last">
        <SettingsMenu user={user} onSignOut={() => logout.mutate()} signingOut={logout.isPending} pages={pages} />
      </div>
      <nav
        id="site-nav"
        aria-label="Site"
        className="hidden sm:ml-auto sm:flex sm:min-w-0 sm:flex-row sm:flex-wrap md:flex-nowrap sm:items-center sm:justify-end sm:gap-1 sm:text-sm"
      >
        <NavLink to="/" end className={link}>
          Home
        </NavLink>
        <NavLink to="/orgs" data-tour="clubs.page" className={(s) => `${link(s)} gap-2`}>
          Clubs
          {waitingCount > 0 && (
            <span
              className="rounded-full bg-accent px-1.5 text-xs font-bold text-accent-ink"
              aria-label={`${waitingCount} ${waitingCount === 1 ? 'request' : 'requests'} to join`}
            >
              {waitingCount}
            </span>
          )}
        </NavLink>
        {showCatalog && (
          <NavLink to="/catalog" className={link}>
            Catalog
          </NavLink>
        )}
        <NavLink to="/about" className={link}>
          About
        </NavLink>
        {(notices.data?.notices?.length ?? 0) > 0 && (
          <NavLink to="/notices" className={link}>
            Notices
          </NavLink>
        )}
      </nav>
    </header>
    {user.restricted && (
      <p role="status" data-testid="account-on-hold" className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-ink">
        Your account is on hold (read only) while a privacy request is looked at. You can still see and download your things, but not change them. Ask the site admin if you have questions.
      </p>
    )}
    </>
  );
}
