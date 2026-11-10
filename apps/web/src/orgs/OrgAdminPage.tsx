import { useState, type ChangeEvent, type FormEvent } from 'react';
import { ClubLogo } from './ClubLogo';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { SignInFirst } from '../auth/signIn';
import { useHashScroll } from '../ui/useHashScroll';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type OrgPartLibrary } from '../api';
import {
  ActivitySection,
  ClubWarningsSection,
  HandOverSection,
  InviteSection,
  JoinRequestsSection,
  JoinSettingsSection,
  LeaveClubButton,
  MembersSection,
  PendingInvitesSection,
  Section,
  SettingsSection,
  LogoSection,
} from './ClubManage';
import { CategoryPicker } from '../parts/CategoryPicker';
import { AppHeader } from '../AppHeader';
import { yourRolesSentence } from './clubRoles';
import { clubCan, runsClub } from './clubPermissions';
import { RolesSection } from './ClubRoles';
import { ClubReviewTab } from './ClubReview';
import { ClubGoneNotice, DeleteClubSection } from './DeleteClub';
import { confirmDelete, toastDeleted } from '../ui/ConfirmDialog';
import { PartPicture } from '../parts/PartPicture';
import { CUSTOM_PART_DELETE_WORDING } from '../ui/deleteWording';

export function OrgAdminPage() {
  const params = useParams<{ slug: string }>();
  if (!params.slug) return <Navigate to="/orgs" replace />;
  return <OrgAdmin slug={params.slug} />;
}

type Tab = 'people' | 'roles' | 'settings' | 'parts' | 'review' | 'activity';
const TAB_IDS: readonly Tab[] = ['people', 'roles', 'settings', 'parts', 'review', 'activity'];

function OrgAdmin({ slug }: { slug: string }) {
  // ?tab=settings#hand-over (the "Delete my account" guide links there).
  const [search] = useSearchParams();
  const asked = search.get('tab') as Tab | null;
  const [tab, setTab] = useState<Tab>(asked && TAB_IDS.includes(asked) ? asked : 'people');
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const detail = useQuery({ queryKey: ['org', slug], queryFn: () => api.orgs.get(slug) });
  const members = useQuery({ queryKey: ['org-members', slug], queryFn: () => api.orgs.members(slug) });
  const answersRequests = clubCan(detail.data, 'invite') || clubCan(detail.data, 'manage_members');
  const requests = useQuery({
    queryKey: ['org-join-requests', slug],
    queryFn: () => api.orgs.joinRequests(slug),
    enabled: answersRequests,
  });
  useHashScroll(!!detail.data && !!members.data);

  if (me.isLoading || detail.isLoading) {
    return <div className="grid h-screen place-items-center text-muted">Loading…</div>;
  }
  if (!me.data?.user) return <SignInFirst />;
  if (detail.isError) {
    return (
      <div className="grid h-screen place-items-center">
        <ClubGoneNotice
          slug={slug}
          fallback={
            <div className="rounded-lg border border-red-900 bg-red-950/30 p-4 text-sm">
              <p className="font-semibold text-danger">Club not found.</p>
              <Link to="/orgs" className="mt-2 inline-block text-accent-text hover:underline">← back</Link>
            </div>
          }
        />
      </div>
    );
  }

  const org = detail.data!;
  if (!runsClub(org)) return <Navigate to={`/orgs/${slug}`} replace />;
  // What shows is what my roles allow: people (invite, manage members),
  // roles (everyone who gets here sees them; admins change them), the
  // club's parts, activity; settings and the part-library switches are the admins'.
  const isClubAdmin = org.isAdmin ?? org.myRole === 'admin';
  const runsPeople = answersRequests;
  const roles = members.data?.roles;
  const myUserId = me.data.user.id;
  const memberList = members.data?.members ?? [];

  const requestList = requests.data?.requests ?? [];
  const waiting = requestList.length;
  const TABS: { id: Tab; label: string }[] = [
    ...(runsPeople ? [{ id: 'people' as const, label: waiting > 0 ? `People (${waiting} waiting)` : 'People' }] : []),
    ...(roles ? [{ id: 'roles' as const, label: 'Roles' }] : []),
    ...(isClubAdmin ? [{ id: 'settings' as const, label: 'Settings' }] : []),
    { id: 'parts', label: 'Parts' },
    ...(org.trusted && clubCan(org, 'send_catalog') ? [{ id: 'review' as const, label: 'Review' }] : []),
    ...(runsPeople ? [{ id: 'activity' as const, label: 'Activity' }] : []),
  ];
  const shownTab: Tab = TABS.some((t) => t.id === tab) ? tab : TABS[0]!.id;

  return (
    <div className="h-full overflow-y-auto bg-bg p-4 text-ink sm:p-8">
      <AppHeader user={me.data.user} />
      <main className="mx-auto mt-6 max-w-3xl space-y-5">
        <div>
          <p className="text-sm">
            <Link to={`/orgs/${slug}`} className="tap-target inline-flex items-center text-accent-text hover:underline">
              ← {org.name}
            </Link>
          </p>
          <h1 className="flex items-center gap-3 text-2xl font-semibold">
            <ClubLogo name={org.name} logoUrl={org.logoUrl} size={40} />
            Manage {org.name}
          </h1>
          <p className="text-sm text-muted" data-testid="your-roles">
            {yourRolesSentence(org)}
          </p>
        </div>

        <nav role="tablist" aria-label="Manage the club" className="flex flex-wrap gap-1 border-b border-line">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={shownTab === t.id}
              onClick={() => setTab(t.id)}
              className={`tap-target shrink-0 rounded-t px-4 py-2 text-sm font-semibold ${
                shownTab === t.id ? 'border-b-2 border-accent text-accent-text' : 'text-muted hover:text-ink'
              }`}
            >
              {t.label}
              {t.id === 'review' && (org.pendingReviews ?? 0) > 0 && (
                <span
                  data-testid="review-count"
                  className="ml-2 rounded-full bg-accent px-1.5 text-xs font-bold text-accent-ink"
                  aria-label={`${org.pendingReviews} waiting`}
                >
                  {org.pendingReviews}
                </span>
              )}
            </button>
          ))}
        </nav>

        {shownTab === 'people' && (
          <div className="space-y-5">
            {(waiting > 0 || (org.joinPolicy ?? 'invite') === 'request') && (
              <JoinRequestsSection slug={slug} requests={requestList} />
            )}
            {members.isLoading ? (
              <p className="text-sm text-muted">Loading…</p>
            ) : (
              <MembersSection slug={slug} myUserId={myUserId} myRole={org.myRole} members={memberList} roles={roles} org={org} />
            )}
            <InviteSection slug={slug} myRole={org.myRole} org={org} roles={roles} />
            <PendingInvitesSection slug={slug} myRole={org.myRole} invites={members.data?.invites ?? []} org={org} roles={roles} />
            <ClubWarningsSection slug={slug} />
          </div>
        )}
        {shownTab === 'roles' && <RolesSection slug={slug} isAdmin={isClubAdmin} />}
        {shownTab === 'settings' && isClubAdmin && (
          <div className="space-y-5">
            <SettingsSection key={`${org.slug}:${org.name}`} org={org} />
            <LogoSection org={org} />
            <JoinSettingsSection key={`join:${org.slug}`} org={org} />
            <HandOverSection slug={slug} myUserId={myUserId} members={memberList} roles={roles} />
            <Section title="Leave the club">
              <LeaveClubButton org={org} myUserId={myUserId} />
            </Section>
            <DeleteClubSection org={org} myUserId={myUserId} />
          </div>
        )}
        {shownTab === 'parts' && (
          <div className="space-y-5">
            {isClubAdmin && (
              <Section title="Part packs" hint="Which part packs the club’s members see in the parts panel.">
                <LibrariesTab slug={slug} />
              </Section>
            )}
            <Section title="Club parts" hint="Custom parts the club has added, shared with everyone in the club.">
              <OrgCustomPartsTab slug={slug} orgId={org.id} />
            </Section>
          </div>
        )}
        {shownTab === 'review' && org.trusted && <ClubReviewTab slug={slug} name={org.name} />}
        {shownTab === 'activity' && <ActivitySection slug={slug} members={memberList} />}
      </main>
    </div>
  );
}

function LibrariesTab({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const libs = useQuery({
    queryKey: ['org-part-libraries', slug],
    queryFn: () => api.orgLibraries.list(slug),
  });
  const toggle = useMutation({
    mutationFn: ({ libraryId, enabled }: { libraryId: string; enabled: boolean }) =>
      api.orgLibraries.set(slug, libraryId, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-part-libraries', slug] }),
  });
  const reset = useMutation({
    mutationFn: (libraryId: string) => api.orgLibraries.reset(slug, libraryId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-part-libraries', slug] }),
  });

  if (libs.isLoading) return <p className="text-sm text-muted">Loading…</p>;
  if (!libs.data || libs.data.libraries.length === 0) {
    return (
      <p className="text-sm text-muted">
        No part packs installed. Ask a site admin to install some.
      </p>
    );
  }

  return (
    <div className="overflow-auto rounded-lg border border-line">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th className="px-3 py-2">Library</th>
            <th className="px-3 py-2">Parts</th>
            <th className="px-3 py-2">Enabled</th>
            <th className="px-3 py-2">Override</th>
          </tr>
        </thead>
        <tbody>
          {libs.data.libraries.map((lib: OrgPartLibrary) => (
            <tr key={lib.id} className="border-b border-line hover:bg-panel/30">
              <td className="px-3 py-2">
                <span className="font-medium">{lib.name}</span>
                <span className="ml-2 font-mono text-xs text-muted">{lib.slug}</span>
                {lib.locked && (
                  <span className="ml-2 rounded-lg bg-soft px-1.5 py-0.5 text-[10px] text-muted" title="This library is always enabled and cannot be disabled">
                    locked
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-muted">{lib.partCount.toLocaleString()}</td>
              <td className="px-3 py-2">
                <input
                  type="checkbox"
                  checked={lib.enabled}
                  disabled={lib.locked}
                  onChange={(e) => !lib.locked && toggle.mutate({ libraryId: lib.id, enabled: e.target.checked })}
                  className="accent-accent disabled:opacity-40"
                  title={lib.locked ? 'This library is always enabled' : undefined}
                />
              </td>
              <td className="px-3 py-2">
                {lib.locked ? (
                  <span className="text-xs text-neutral-600">always on</span>
                ) : lib.explicitOverride ? (
                  <button
                    onClick={() => reset.mutate(lib.id)}
                    className="text-xs text-muted hover:underline"
                    title={`Revert to default (${lib.defaultEnabled ? 'enabled' : 'disabled'})`}
                  >
                    Reset to default
                  </button>
                ) : (
                  <span className="text-xs text-neutral-600">
                    default ({lib.defaultEnabled ? 'on' : 'off'})
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OrgCustomPartsTab({ slug, orgId }: { slug: string; orgId: string }) {
  const qc = useQueryClient();
  const [showUpload, setShowUpload] = useState(false);
  const all = useQuery({ queryKey: ['custom-parts'], queryFn: api.customParts.list });
  const parts = (all.data?.parts ?? []).filter((p) => p.ownerOrgId === orgId);

  const remove = useMutation({
    mutationFn: api.customParts.remove,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custom-parts'] });
      qc.invalidateQueries({ queryKey: ['parts-catalog'] });
    },
  });

  if (all.isLoading) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted">
          Parts owned by this club are visible to all members in the parts panel.{' '}
          <Link to={`/?owner=${encodeURIComponent(slug)}#parts`} className="font-semibold text-accent-text hover:underline">
            See them on the home page
          </Link>
        </p>
        <button
          onClick={() => setShowUpload(true)}
          className="rounded-lg border border-border px-3 py-1 text-sm hover:bg-soft"
        >
          Upload part
        </button>
      </div>
      {parts.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-4 text-sm text-muted">
          No custom parts yet.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 md:grid-cols-3">
          {parts.map((p) => (
            <li
              key={p.id}
              className="flex flex-col items-center rounded-lg border border-line p-2 text-xs"
            >
              <PartPicture part={p} className="h-16 w-16" />
              <p className="mt-1 line-clamp-1 font-mono">{p.partNumber}</p>
              <p className="line-clamp-1 text-muted">{p.displayName}</p>
              <button
                onClick={async () => {
                  if (await confirmDelete(p.partNumber, CUSTOM_PART_DELETE_WORDING))
                    remove.mutate(p.id, { onSuccess: () => toastDeleted(p.partNumber) });
                }}
                className="mt-1 text-[10px] text-danger hover:underline"
              >
                delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {showUpload && (
        <OrgUploadPartDialog
          slug={slug}
          onClose={() => { setShowUpload(false); qc.invalidateQueries({ queryKey: ['custom-parts'] }); }}
        />
      )}
    </div>
  );
}

function OrgUploadPartDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const catalog = useQuery({ queryKey: ['parts-catalog'], queryFn: api.parts.catalog, staleTime: 5 * 60 * 1000 });
  const [partNumber, setPartNumber] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [category, setCategory] = useState('Custom');
  const [xmlText, setXmlText] = useState('');
  const [spriteFile, setSpriteFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const existingCategories = Array.from(
    new Set((catalog.data?.parts ?? []).map((p) => p.category || 'Custom').filter(Boolean))
  ).sort();

  const create = useMutation({
    mutationFn: api.customParts.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custom-parts'] });
      qc.invalidateQueries({ queryKey: ['parts-catalog'] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  async function pickXml(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setXmlText(await file.text());
    if (!partNumber) setPartNumber(file.name.replace(/\.xml$/i, ''));
  }

  function pickSprite(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSpriteFile(file);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!xmlText) return setError('XML payload required');
    if (!spriteFile) return setError('Sprite required');
    const mime: 'image/gif' | 'image/png' =
      spriteFile.type === 'image/png' ? 'image/png' : 'image/gif';
    const xmlBase64 = btoa(xmlText);
    const buf = await spriteFile.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
    const spriteBase64 = btoa(binary);
    create.mutate({
      partNumber: partNumber.trim(),
      displayName: displayName.trim(),
      category: category.trim() || 'Custom',
      xmlBase64,
      spriteBase64,
      spriteMime: mime,
      orgSlug: slug,
    });
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md space-y-3 rounded-lg border border-line bg-panel p-6 text-sm"
      >
        <h3 className="text-lg font-semibold">Upload a club part</h3>

        <label className="block">
          <span className="mb-1 block text-muted">Part number</span>
          <input
            value={partNumber}
            onChange={(e) => setPartNumber(e.target.value)}
            required
            className="w-full rounded-lg border border-border bg-soft px-3 py-2"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-muted">Display name</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            className="w-full rounded-lg border border-border bg-soft px-3 py-2"
          />
        </label>

        <CategoryPicker
          categories={existingCategories}
          value={category}
          onChange={setCategory}
        />

        <label className="block">
          <span className="mb-1 block text-muted">Part XML</span>
          <input type="file" accept=".xml,application/xml,text/xml" onChange={pickXml} required />
        </label>

        <label className="block">
          <span className="mb-1 block text-muted">Sprite (gif or png)</span>
          <input type="file" accept="image/gif,image/png" onChange={pickSprite} required />
        </label>

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 hover:bg-soft"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded-lg bg-accent text-accent-ink px-4 py-2 hover:bg-accent-hover disabled:opacity-50"
          >
            Upload
          </button>
        </div>
      </form>
    </div>
  );
}
