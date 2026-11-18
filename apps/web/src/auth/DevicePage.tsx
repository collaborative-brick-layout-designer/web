import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type ApiScope, type DeviceRequest } from '../api';
import { SwitchAccountButton } from './signIn';

/** What each scope lets the device do, in the user's terms. */
export const SCOPE_LABELS: Record<ApiScope, string> = {
  'layouts:read': 'See your layouts and modules, the catalog and your notifications',
  'layouts:write': 'Edit your layouts (live sync) and save modules',
  'layouts:create': 'Publish new layouts to your account or your clubs',
  'parts:read': 'Download the parts library and custom parts',
  'parts:write': 'Upload, change and delete your custom parts and sets',
  'venues:read': 'See your saved venues and download them',
  'venues:write': 'Save, rename and delete your venues',
  'account:prefs': 'Keep your look and help settings in step with this account',
};

/**
 * Desktop sign-in approval (the "verification URI" of the device-code
 * flow, see apps/server/src/routes/auth/device.ts). The desktop app
 * shows a code like BCDF-GHJK and sends the user here; they confirm the
 * code, see which app is asking and for what, and approve or deny. The
 * app's `verification_uri_complete` link pre-fills the code.
 */
export function DevicePage() {
  const [params] = useSearchParams();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const [code, setCode] = useState(params.get('user_code') ?? '');
  const [request, setRequest] = useState<DeviceRequest | null>(null);
  const [outcome, setOutcome] = useState<'approved' | 'denied' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lookup = useMutation({
    mutationFn: (c: string) => api.device.lookup(c),
    onSuccess: (r) => {
      setRequest(r);
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });
  const decide = useMutation({
    mutationFn: (approve: boolean) => (approve ? api.device.approve(code) : api.device.deny(code)),
    onSuccess: (_r, approve) => setOutcome(approve ? 'approved' : 'denied'),
    onError: (e: Error) => {
      setRequest(null);
      setError(e.message);
    },
  });

  // A pre-filled code (verification_uri_complete) is looked up straight
  // away; approving still takes an explicit click.
  const signedIn = !!me.data?.user;
  const prefilled = params.get('user_code');
  const { mutate: lookupMutate } = lookup;
  useEffect(() => {
    if (signedIn && prefilled) lookupMutate(prefilled);
  }, [signedIn, prefilled, lookupMutate]);

  if (me.isLoading) return <Centered>Loading…</Centered>;

  if (!signedIn) {
    const next = `/device${prefilled ? `?user_code=${encodeURIComponent(prefilled)}` : ''}`;
    return (
      <Centered>
        <h1 className="text-lg font-semibold">Connect a device</h1>
        <p className="text-sm text-muted">Sign in to approve the desktop app's request.</p>
        <Link
          to={`/login?next=${encodeURIComponent(next)}`}
          className="inline-flex min-h-11 items-center rounded-lg bg-accent px-4 py-2 text-sm text-accent-ink hover:bg-accent-hover"
        >
          Sign in
        </Link>
      </Centered>
    );
  }

  if (outcome === 'approved') {
    return (
      <Centered>
        <h1 className="text-lg font-semibold">Device connected</h1>
        <p className="text-sm text-muted">
          You can return to the app. Manage connected devices from your{' '}
          <Link to="/profile" className="text-accent-text hover:underline">profile</Link>.
        </p>
      </Centered>
    );
  }
  if (outcome === 'denied') {
    return (
      <Centered>
        <h1 className="text-lg font-semibold">Request denied</h1>
        <p className="text-sm text-muted">The device was not given access to your account.</p>
      </Centered>
    );
  }

  // The shared demo account can't sign the desktop app in (the server
  // says no): say so up front, with a way to switch accounts.
  if (me.data?.user?.isDemoAccount) {
    return (
      <Centered>
        <h1 className="text-lg font-semibold">Connect a device</h1>
        <p className="text-sm text-muted">The desktop app can’t sign in to the demo. Sign in with your own account to connect it.</p>
        <SwitchAccountButton label="Sign out of the demo" />
      </Centered>
    );
  }

  if (request) {
    return (
      <Centered>
        <h1 className="text-lg font-semibold">Allow {request.clientName}?</h1>
        <p className="text-sm text-muted">
          Signed in as <span className="text-ink">{me.data!.user!.email}</span>. Only approve
          if the app is showing the code <span className="font-mono text-ink">{code.toUpperCase()}</span>.
        </p>
        <SwitchAccountButton label="Use another account" />
        <div className="text-left">
          <p className="text-sm text-neutral-300">It will be able to:</p>
          <ul className="mt-1 list-disc pl-5 text-sm text-neutral-300">
            {request.scopes.map((s) => (
              <li key={s}>{SCOPE_LABELS[s] ?? s}</li>
            ))}
          </ul>
        </div>
        <div className="flex justify-center gap-3">
          <button
            onClick={() => decide.mutate(true)}
            disabled={decide.isPending}
            className="rounded-lg bg-accent text-accent-ink px-4 py-2 text-sm hover:bg-accent-hover disabled:opacity-50"
          >
            Approve
          </button>
          <button
            onClick={() => decide.mutate(false)}
            disabled={decide.isPending}
            className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-soft disabled:opacity-50"
          >
            Deny
          </button>
        </div>
      </Centered>
    );
  }

  return (
    <Centered>
      <h1 className="text-lg font-semibold">Connect a device</h1>
      <p className="text-sm text-muted">Enter the code shown in the desktop app.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) lookup.mutate(code.trim());
        }}
        className="space-y-3"
      >
        <input
          aria-label="Device code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="XXXX-XXXX"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          maxLength={12}
          className="w-full rounded-lg border border-border bg-soft px-3 py-2 text-center font-mono text-lg uppercase tracking-widest"
        />
        <button
          type="submit"
          disabled={lookup.isPending || !code.trim()}
          className="w-full rounded-lg bg-accent text-accent-ink px-4 py-2 text-sm hover:bg-accent-hover disabled:opacity-50"
        >
          Continue
        </button>
      </form>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </Centered>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-md space-y-4 rounded-lg border border-line bg-panel p-8 text-center">
        {children}
      </div>
    </div>
  );
}
