// The site admin pages (site admins), or Moderation (moderators). A list
// down the left groups the sections under small headings, with counts of
// what's waiting; on a phone it folds into one "Section" picker at the
// top. A moderator sees only Moderation, so no list at all.
//
// Each section is its own file under tabs/ (Moderation in Moderation.tsx,
// the dashboard in insights/). The section is in the address
// (/admin?tab=users, see adminTabs.ts), so links and back/forward work.
// Every change goes through `/api/admin/*` or `/api/moderation/*` and is
// audited server-side.

import { lazy, Suspense } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useCardTables } from '../ui/cardTables';
import { SignInFirst } from '../auth/signIn';
import { api } from '../api';
import { AppHeader } from '../AppHeader';
import { usePrivacyDue, useWaitingReviews } from '../SettingsMenu';
import { PrivacyDashboardCard, PrivacyRequestsTab } from '../privacy/PrivacyRequests';
import { ADMIN_GROUPS, ADMIN_NAV_LABELS, adminTabsFor, adminTabUrl, type AdminTab } from './adminTabs';
import { ModerationTab } from './Moderation';
import { Forbidden, Loading } from './tabs/shared';
import { HeavyUse } from './tabs/HeavyUse';
import { UsersTab } from './tabs/UsersTab';
import { OrgsTab } from './tabs/ClubsTab';
import { LayoutsTab } from './tabs/LayoutsTab';
import { GlobalPartsTab } from './tabs/PartsTab';
import { PartLibrariesTab, PartsSetupCard } from './tabs/LibrariesTab';
import { AuditTab } from './tabs/AuditTab';
import { SettingsTab } from './tabs/SettingsTab';

// The dashboard (graphs, breakdowns, health) is its own lazily loaded
// chunk: the charts never weigh on the rest of the admin page or the app.
const Dashboard = lazy(() => import('./insights/Dashboard'));

export function AdminPage() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const [params] = useSearchParams();
  const chosen = params.get('tab') as AdminTab | null;
  // Its tables become cards on a phone.
  const pageRef = useCardTables();
  const user = me.data?.user;
  const privacyDue = usePrivacyDue({ isGlobalAdmin: !!user?.isGlobalAdmin });
  const waiting = useWaitingReviews({ isGlobalAdmin: !!user?.isGlobalAdmin, isModerator: !!user?.isModerator });

  if (me.isLoading) return <Loading />;
  if (!user) return <SignInFirst />;
  const isAdmin = user.isGlobalAdmin;
  // Moderators see only Moderation; everything else stays the admins'.
  if (!isAdmin && !user.isModerator) return <Forbidden />;
  const tabs = adminTabsFor(user);
  const tab: AdminTab = chosen && tabs.includes(chosen) ? chosen : tabs[0]!;
  const badges: Partial<Record<AdminTab, { n: number; label: string }>> = {
    moderation: { n: waiting, label: `${waiting} waiting for review` },
    privacy: { n: privacyDue, label: `${privacyDue} due soon or overdue` },
  };

  return (
    <div ref={pageRef} className="cards-on-phone theme-page h-full overflow-y-auto bg-bg p-4 text-ink sm:p-8">
      <AppHeader user={user} />
      <div className="mt-6">
        <h1 className="text-base font-semibold">
          {isAdmin ? 'Site admin' : 'Moderation'}
          <span className="ml-2 rounded-lg bg-amber-900/40 px-2 py-0.5 text-xs text-amber-300">
            {isAdmin ? 'Only site admins see this' : 'Only moderators see this'}
          </span>
        </h1>
      </div>
      <div className={tabs.length > 1 ? 'mt-4 md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:gap-8' : 'mt-4'}>
        {tabs.length > 1 && <AdminNav tabs={tabs} tab={tab} badges={badges} />}
        <main className="mt-4 min-w-0 md:mt-0">
          {tabs.length > 1 && <h2 className="sr-only">{ADMIN_NAV_LABELS[tab]}</h2>}
          {tab === 'dashboard' && (
            <div className="space-y-6">
              <PartsSetupCard />
              <PrivacyDashboardCard />
              <Suspense fallback={<Loading />}>
                <Dashboard />
              </Suspense>
            </div>
          )}
          {tab === 'privacy' && <PrivacyRequestsTab />}
          {tab === 'heavy' && <HeavyUse />}
          {tab === 'users' && <UsersTab selfId={user.id} />}
          {tab === 'orgs' && <OrgsTab />}
          {tab === 'layouts' && <LayoutsTab />}
          {tab === 'parts' && <GlobalPartsTab />}
          {tab === 'libraries' && <PartLibrariesTab />}
          {tab === 'moderation' && <ModerationTab />}
          {tab === 'audit' && <AuditTab />}
          {tab === 'settings' && <SettingsTab />}
        </main>
      </div>
    </div>
  );
}

/**
 * The sections: a list down the left from tablet width, grouped under
 * small headings; on a phone one "Section" picker (the current one's
 * name always showing), so nothing scrolls sideways.
 */
function AdminNav({
  tabs,
  tab,
  badges,
}: {
  tabs: readonly AdminTab[];
  tab: AdminTab;
  badges: Partial<Record<AdminTab, { n: number; label: string }>>;
}) {
  const navigate = useNavigate();
  const groups = ADMIN_GROUPS.map((g) => ({ ...g, tabs: g.tabs.filter((t) => tabs.includes(t)) })).filter((g) => g.tabs.length > 0);
  const badge = (t: AdminTab) => {
    const b = badges[t];
    return b && b.n > 0 ? (
      <span className="ml-auto rounded-full bg-accent px-2 text-xs font-bold text-accent-ink" aria-label={b.label}>
        {b.n}
      </span>
    ) : null;
  };
  return (
    <>
      <label className="block md:hidden">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Section</span>
        <select
          value={tab}
          onChange={(e) => navigate(adminTabUrl(e.target.value as AdminTab))}
          aria-label="Section"
          className="min-h-11 w-full rounded-lg border border-border bg-panel px-3 text-base font-semibold"
        >
          {groups.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.tabs.map((t) => {
                const b = badges[t];
                return (
                  <option key={t} value={t}>
                    {ADMIN_NAV_LABELS[t]}
                    {b && b.n > 0 ? ` (${b.n})` : ''}
                  </option>
                );
              })}
            </optgroup>
          ))}
        </select>
      </label>
      <nav aria-label="Admin sections" className="hidden md:block">
        {/* On a short screen (a phone on its side) the list scrolls by itself:
            stuck to the top, its lower sections were out of reach. */}
        <div className="sticky top-4 max-h-[calc(100dvh-2rem)] space-y-4 overflow-y-auto overscroll-contain">
          {groups.map((g) => (
            <div key={g.label}>
              <h2 className="mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-muted">{g.label}</h2>
              <ul className="space-y-0.5">
                {g.tabs.map((t) => (
                  <li key={t}>
                    <Link
                      to={adminTabUrl(t)}
                      aria-current={tab === t ? 'page' : undefined}
                      className={`flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm ${tab === t ? 'bg-accent/15 font-semibold text-ink' : 'text-muted hover:bg-soft hover:text-ink'}`}
                    >
                      {ADMIN_NAV_LABELS[t]}
                      {badge(t)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </nav>
    </>
  );
}
