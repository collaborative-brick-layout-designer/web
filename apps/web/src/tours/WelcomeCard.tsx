// The first-visit welcome on the home page: what the app is for, and
// three ways in (start or open a layout, join a club, take the tour).
// Any of them, or "Not now", puts it away for good: it's remembered in
// the account's toursSeen, so it doesn't come back on another computer
// either. Settings › Show tours again brings it back.

import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { usePreferences } from '../theme/PrefsProvider';
import { useTours } from './TourProvider';
import { markSeen, WELCOME, WELCOME_ID } from './tours';

export function WelcomeCard({ name, onLayout }: { name: string | undefined; onLayout: () => void }) {
  const { prefs, setPrefs, ready } = usePreferences();
  const { startTour } = useTours();
  const navigate = useNavigate();
  // Already in a club (an invite brought them here): no "Join a club".
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: api.orgs.list });
  const inAClub = (orgs.data?.orgs?.length ?? 0) > 0;
  if (!ready || prefs.toursSeen.includes(WELCOME_ID)) return null;

  const done = () => setPrefs({ toursSeen: markSeen(prefs.toursSeen, WELCOME_ID) });
  const choose = (go: () => void) => () => {
    done();
    go();
  };
  // A new password account's name is its email until they change it; greet
  // them without the address.
  const first = name?.includes('@') ? undefined : name?.trim().split(/\s+/)[0];
  const tile =
    'tap-target flex flex-col gap-1 rounded-card border p-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
  return (
    <section
      aria-labelledby="welcome-title"
      data-testid="welcome"
      className="space-y-4 rounded-section border border-line bg-panel p-5 sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="welcome-title" className="font-display text-2xl font-bold">
            {first ? `Hi ${first}! ` : ''}
            {WELCOME.title}
          </h2>
          <p className="text-muted">{WELCOME.text}</p>
        </div>
        <button
          type="button"
          onClick={done}
          className="tap-target shrink-0 rounded-control px-3 py-1.5 text-sm font-semibold text-muted hover:bg-soft hover:text-ink"
        >
          {WELCOME.dismiss}
        </button>
      </div>
      <div className={`grid gap-3 ${inAClub ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}>
        <button type="button" onClick={choose(onLayout)} className={`${tile} border-2 border-accent bg-panel hover:bg-soft`}>
          <span className="font-display text-lg font-bold">{WELCOME.actions.layout.label}</span>
          <span className="text-sm text-muted">{WELCOME.actions.layout.text}</span>
        </button>
        {!inAClub && (
          <button type="button" onClick={choose(() => navigate('/orgs'))} className={`${tile} border-line bg-panel hover:bg-soft`}>
            <span className="font-display text-lg font-bold">{WELCOME.actions.club.label}</span>
            <span className="text-sm text-muted">{WELCOME.actions.club.text}</span>
          </button>
        )}
        <button
          type="button"
          onClick={choose(() => startTour('editor'))}
          className={`${tile} border-line bg-panel hover:bg-soft`}
        >
          <span className="font-display text-lg font-bold">{WELCOME.actions.tour.label}</span>
          <span className="text-sm text-muted">{WELCOME.actions.tour.text}</span>
        </button>
      </div>
    </section>
  );
}
