// Venue lists outside the editor (org page, layouts page) and starting a
// new layout from a saved venue. The API is a stubbed fetch.

import { autoConfirm } from '../../test/confirmHost';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { readSidecar, writeSidecar, type Venue } from '@cld/bbm';
import { orderVenuesForOwner, sidecarWithVenue } from '../venueStart';
import { VenueList } from '../VenueList';
import { LayoutsPage } from '../../layouts/LayoutsPage';

const HALL: Venue = {
  name: 'Grand Lobby',
  enabled: false,
  minWalkwayStuds: 30,
  bounds: { x: 0, y: 0, w: 100, h: 50 },
  edges: [{ kind: 2, doorWidthStuds: 0, label: 'to the Lobby', poly: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }],
  obstacles: [{ label: 'stairs', poly: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }] }],
};

describe('sidecarWithVenue', () => {
  it('makes a fresh sidecar holding the venue, switched on', () => {
    const sc = readSidecar(sidecarWithVenue(undefined, HALL));
    expect(sc.schemaVersion).toBe(1);
    expect(sc.venue).toEqual({ ...HALL, enabled: true });
  });

  it('keeps everything else in a picked sidecar and replaces its venue', () => {
    const picked = writeSidecar({
      schemaVersion: 1,
      bbmHashSha256: 'abc',
      anchoredLabels: [],
      venue: { ...HALL, name: 'Old hall' },
      extras: { desktopOnly: { keep: true } },
    });
    const sc = readSidecar(sidecarWithVenue(picked, HALL));
    expect(sc.bbmHashSha256).toBe('abc');
    expect(sc.anchoredLabels).toEqual([]);
    expect(sc.extras).toEqual({ desktopOnly: { keep: true } });
    expect(sc.venue?.name).toBe('Grand Lobby');
  });
});

describe('orderVenuesForOwner', () => {
  it("puts the chosen owner's venues first, each group by name", () => {
    const vs = [
      { id: '1', name: 'Zeta', ownerOrgId: null },
      { id: '2', name: 'Beta', ownerOrgId: 'o1' },
      { id: '3', name: 'Alpha', ownerOrgId: null },
      { id: '4', name: 'Alpha', ownerOrgId: 'o1' },
    ];
    expect(orderVenuesForOwner(vs, 'o1').map((v) => v.id)).toEqual(['4', '2', '3', '1']);
    expect(orderVenuesForOwner(vs, null).map((v) => v.id)).toEqual(['3', '1', '4', '2']);
  });
});

type Handler = (body: unknown) => { status?: number; body: unknown };
let routes: Record<string, Handler>;
let calls: { method: string; path: string; body: unknown }[];

beforeEach(() => {
  calls = [];
  routes = {
    'GET /api/auth/me': () => ({ body: { user: { id: 'u1', email: 'me@x.com', displayName: 'Me' } } }),
    'GET /api/venues': () => ({
      body: {
        venues: [
          { id: 'v-club', name: 'Grand Lobby', ownerOrgId: 'org1' },
          { id: 'v-mine', name: 'Garage', ownerOrgId: null },
        ],
      },
    }),
    'GET /api/orgs': () => ({ body: { orgs: [{ id: 'org1', name: 'Train Club', slug: 'club', createdAt: 0, myRole: 'member' }] } }),
    'GET /api/layouts': () => ({ body: { layouts: [] } }),
  };
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path: input, body });
    const h = routes[`${method} ${input}`];
    if (!h) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    const { status = 200, body: out } = h(body);
    return new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAt(ui: ReactNode, url = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/" element={ui} />
          <Route path="/editor/:id" element={<p>editor open</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const CLUB = { id: 'org1', name: 'Train Club', slug: 'club', createdAt: 0, myRole: 'member' as const };

describe('VenueList', () => {
  it("shows a club's venues under its filter, links Start layout to the new-layout dialog, and uploads to the club", async () => {
    routes['POST /api/venues'] = () => ({ status: 201, body: { id: 'v-new', name: 'Grand Lobby' } });
    renderAt(<VenueList filter="club" myUserId="u1" orgs={[CLUB]} />);

    const row = (await screen.findByText('Grand Lobby')).closest('li')!;
    expect(screen.queryByText('Garage')).toBeNull();
    expect(within(row).getByTestId('owner-chip').textContent).toBe('Train Club');
    expect(within(row).getByRole('link', { name: 'Start layout' }).getAttribute('href')).toBe('/?newLayoutVenue=v-club&owner=club');
    // Members can use the list; only admins rename or delete (in the row's ⋯ menu).
    fireEvent.click(within(row).getByRole('button', { name: 'More for Grand Lobby' }));
    expect(within(row).getByRole('menuitem', { name: 'Download' })).toBeTruthy();
    expect(within(row).queryByRole('menuitem', { name: 'Rename…' })).toBeNull();
    expect(within(row).queryByRole('menuitem', { name: 'Delete' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'More for Grand Lobby' }));

    // Upload asks where it goes first, starting at the club being shown.
    fireEvent.click(screen.getByRole('button', { name: 'Upload venue…' }));
    const dialog = screen.getByRole('dialog', { name: 'Upload a venue' });
    expect((within(dialog).getByLabelText('Save to') as HTMLSelectElement).value).toBe('club');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose file…' }));
    const file = new File([JSON.stringify({ schema: 'bld-venue/1', ...HALL })], 'lobby.bld-venue');
    fireEvent.change(screen.getByLabelText('Venue file'), { target: { files: [file] } });
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/venues')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!.body as { name: string; orgSlug: string; data: Venue };
    expect(post.orgSlug).toBe('club');
    expect(post.name).toBe('Grand Lobby');
    expect(post.data.obstacles).toEqual(HALL.obstacles);
  });

  it('opens the new-layout dialog when Start layout is clicked on the home page itself', async () => {
    renderAt(<LayoutsPage />);
    const row = (await screen.findByText('Garage')).closest('li')!;
    fireEvent.click(within(row).getByRole('link', { name: 'Start layout' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('lets the owner of personal venues rename and delete them', async () => {
    routes['PATCH /api/venues/v-mine'] = () => ({ body: { ok: true, id: 'v-mine', name: 'Shed' } });
    routes['DELETE /api/venues/v-mine'] = () => ({ body: { ok: true } });
    autoConfirm(true);
    renderAt(<VenueList filter="me" myUserId="u1" orgs={[]} />);

    const row = (await screen.findByText('Garage')).closest('li')!;
    expect(screen.queryByText('Grand Lobby')).toBeNull();
    expect(within(row).getByTestId('owner-chip').textContent).toBe('Me');
    expect(within(row).getByRole('link', { name: 'Start layout' }).getAttribute('href')).toBe('/?newLayoutVenue=v-mine');
    // Not in a club: nothing to move it to.
    const more = within(row).getByRole('button', { name: 'More for Garage' });
    fireEvent.click(more);
    expect(within(row).queryByRole('menuitem', { name: 'Move or copy…' })).toBeNull();
    fireEvent.click(within(row).getByRole('menuitem', { name: 'Rename…' }));
    const box = screen.getByRole('dialog', { name: 'Rename venue' });
    fireEvent.change(within(box).getByRole('textbox'), { target: { value: 'Shed' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename venue' })).toBeNull());
    fireEvent.click(more);
    fireEvent.click(within(row).getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`)).toEqual(['PATCH /api/venues/v-mine', 'DELETE /api/venues/v-mine']));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ name: 'Shed' });
  });

  it('shows mine and my clubs\' venues together under All, and copies a club venue to me', async () => {
    routes['POST /api/venues/v-club/copy'] = () => ({ status: 201, body: { id: 'v-copy', name: 'Grand Lobby' } });
    // In two clubs, so there is somewhere else to move it, but only a club admin may.
    renderAt(<VenueList filter="all" myUserId="u1" orgs={[CLUB, { ...CLUB, id: 'org2', name: 'Other Club', slug: 'other' }]} />);
    const club = (await screen.findByText('Grand Lobby')).closest('li')!;
    const mine = screen.getByText('Garage').closest('li')!;
    expect(within(club).getByTestId('owner-chip').textContent).toBe('Train Club');
    expect(within(mine).getByTestId('owner-chip').textContent).toBe('Me');

    fireEvent.click(within(club).getByRole('button', { name: 'More for Grand Lobby' }));
    fireEvent.click(within(club).getByRole('menuitem', { name: 'Move or copy…' }));
    const dialog = screen.getByRole('dialog');
    // A member can't move the club's room; copying to Me is the way.
    expect((within(dialog).getByRole('radio', { name: /Move to a club/ }) as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByLabelText('Copy to') as HTMLSelectElement).value).toBe('');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/venues/v-club/copy')).toBe(true));
    expect(calls.find((c) => c.path === '/api/venues/v-club/copy')!.body).toEqual({});
  });
});

describe('New layout from a venue', () => {
  it('opens preselected from a Start layout link and creates the layout with the venue in its sidecar', async () => {
    routes['GET /api/venues/v-club'] = () => ({ body: { id: 'v-club', name: 'Grand Lobby', data: HALL } });
    routes['POST /api/layouts'] = () => ({ status: 201, body: { id: 'lay1' } });
    renderAt(<LayoutsPage />, '/?newLayoutVenue=v-club&owner=club');

    const select = (await screen.findByLabelText('Start from a venue')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('v-club'));
    // The owner's org venues come first.
    expect([...select.options].map((o) => o.textContent)).toEqual(['No venue', 'Grand Lobby (Train Club)', 'Garage']);
    expect((screen.getByLabelText('Save to') as HTMLSelectElement).value).toBe('club');

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText('editor open');
    const body = calls.find((c) => c.method === 'POST' && c.path === '/api/layouts')!.body as { orgSlug: string; sidecar: string };
    expect(body.orgSlug).toBe('club');
    expect(readSidecar(body.sidecar).venue).toEqual({ ...HALL, enabled: true });
  });
});
