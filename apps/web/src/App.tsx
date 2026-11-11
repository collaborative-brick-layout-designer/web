
import { SignInFirst } from './auth/signIn';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { AppHeader } from './AppHeader';
import { LayoutsPage } from './layouts/LayoutsPage';
import { SiteFooter } from './privacy/SiteFooter';

export function App() {
  const { data, isLoading } = useQuery({ queryKey: ['me'], queryFn: api.me });
  if (isLoading) return <Loading />;
  if (!data?.user) return <SignInFirst />;

  return (
    <div className="theme-page h-full overflow-y-auto bg-bg p-4 text-ink sm:p-8">
      <AppHeader user={data.user} />
      <main className="mt-8">
        <LayoutsPage />
      </main>
      <SiteFooter />
    </div>
  );
}

function Loading() {
  return <div className="grid h-full place-items-center text-muted">Loading…</div>;
}
