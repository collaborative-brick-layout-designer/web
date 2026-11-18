// @vitest-environment jsdom
// Partner clubs on the club's page, and a club's module in the Share
// dialog (docs/shared-modules.md, section 11): the words; Accept and
// Decline for requests and module offers; Take back; End partnership (asked
// first, saying what happens; Admins only); a plain member sees partners
// only; the Share dialog's partner clubs, "Another club…" search and pasted
// link, and offers waiting or declined.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { api, type ClubPartners, type ModuleShares } from '../../api';
import { ClubPartnersSection, askAgainText, clubLabel, endPartnershipText, modulesBothWays } from '../ClubPartners';
import { ModuleClubShares, offerWords, viaWords } from '../../modules/ModuleClubShares';
import { fromClubOf } from '../../editor/ModuleLibraryPanel';
import { clubBadgeLabel } from '../../AppHeader';
import { autoConfirm } from '../../test/confirmHost';

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const LUG = { id: 'o2', name: 'Riverside LUG', slug: 'riverside-lug', logoUrl: null };

describe('the words', () => {
  it('names a club, or its address before it accepts', () => {
    expect(clubLabel({ name: 'Riverside LUG', slug: 'riverside-lug' })).toBe('Riverside LUG');
    expect(clubLabel({ name: null, slug: 'secret' })).toBe('the club at /orgs/secret');
  });
  it('counts modules each way', () => {
    expect(modulesBothWays({ modulesIn: 2, modulesOut: 1 })).toBe('2 modules from them · 1 module to them');
    expect(modulesBothWays({ modulesIn: 0, modulesOut: 0 })).toBeNull();
  });
  it('says what ending a partnership does', () => {
    const t = endPartnershipText('Riverside LUG', { modulesIn: 1, modulesOut: 2 });
    expect(t.title).toBe('End the partnership with Riverside LUG?');
    expect(t.removes).toContain('The 3 modules your clubs shared through it stop, both ways');
    expect(t.removes).toContain('Riverside LUG is told.');
    expect(t.keeps).toContain('marked “No longer shared”');
    expect(t.keeps).toContain('Modules shared one off and accepted stay shared.');
    expect(endPartnershipText('X', { modulesIn: 0, modulesOut: 0 }).removes).toBe('No modules are shared through it now. X is told.');
  });
  it('says when a declined request can go again', () => {
    expect(askAgainText(null)).toBeNull();
    expect(askAgainText(1000, 2000)).toBeNull();
    expect(askAgainText(5000, 2000)).toMatch(/^You can ask again from /);
  });
  it('the Clubs badge, the share lines and the library’s Clubs tab', () => {
    expect(clubBadgeLabel(2, 0)).toBe('2 requests to join');
    expect(clubBadgeLabel(1, 1)).toBe('1 request to join, 1 partner request or module offer');
    expect(viaWords('partner')).toBe('(partner club)');
    expect(viaWords('offer')).toBe('(club, accepted)');
    expect(viaWords(null)).toBe('(club)');
    expect(offerWords({ id: 'f', club: { orgId: null, name: null, slug: 's', logoUrl: null }, state: 'pending', createdAt: 0, askAgainAt: null })).toBe('the club at /orgs/s · waiting for them to accept');
    expect(offerWords({ id: 'f', club: { orgId: 'o', name: 'LUG', slug: 's', logoUrl: null }, state: 'declined', createdAt: 0, askAgainAt: 5000 }, 1000)).toContain('declined (you can offer it again in a day)');
    const club = [{ id: 'o2', name: 'Riverside LUG', slug: 'riverside-lug' }];
    expect(fromClubOf({ owner: { kind: 'org', id: 'o1', name: 'Train Club', slug: 'train' }, sharedVia: { direct: false, clubs: club } })).toBe('Train Club');
    expect(fromClubOf({ owner: { kind: 'user', id: 'u', name: 'Alice', slug: null }, sharedVia: { direct: false, clubs: club } })).toBeNull();
    expect(fromClubOf({ owner: { kind: 'org', id: 'o1', name: 'Train Club', slug: 'train' }, sharedVia: { direct: true, clubs: [] } })).toBeNull();
    // A club's own module (no sharedVia) isn't another club's.
    expect(fromClubOf({ owner: { kind: 'org', id: 'o2', name: 'Riverside LUG', slug: 'riverside-lug' } })).toBeNull();
  });
});

describe('Partner clubs on the club’s page', () => {
  const runner = (over: Partial<ClubPartners> = {}): ClubPartners => ({
    canManage: true,
    canEnd: true,
    partners: [],
    requestsIn: [],
    requestsOut: [],
    offersIn: [],
    ...over,
  });

  it('Admins and Managers accept a request and a module offer, and the list follows', async () => {
    let state = runner({
      requestsIn: [{ id: 'r1', club: { ...LUG }, createdAt: 0 }],
      offersIn: [{ id: 'f1', module: { id: 'm1', title: 'Water mill', latestVersion: 3 }, from: { ...LUG }, partner: false, createdAt: 0 }],
    });
    vi.spyOn(api.orgs, 'partners').mockImplementation(async () => state);
    const answer = vi.spyOn(api.orgs, 'answerPartnerRequest').mockImplementation(async () => {
      state = { ...state, requestsIn: [], partners: [{ ...LUG, since: 0, modulesIn: 0, modulesOut: 0 }] };
      return { ok: true, status: 'partners' };
    });
    const offer = vi.spyOn(api.orgs, 'answerModuleOffer').mockImplementation(async () => {
      state = { ...state, offersIn: [], partners: [{ ...LUG, since: 0, modulesIn: 1, modulesOut: 0 }] };
      return { ok: true, status: 'shared', moduleId: 'm1' };
    });
    wrap(<ClubPartnersSection slug="train-club" name="Train Club" />);
    expect((await screen.findByTestId('partners-waiting')).textContent).toBe('2 waiting');
    expect(screen.getByTestId('module-offers-in').textContent).toContain('Riverside LUG wants to share “Water mill” with you');
    expect(screen.getByTestId('partner-requests-in').textContent).toContain('Riverside LUG wants to be partners with Train Club');
    fireEvent.click(screen.getAllByRole('button', { name: 'Accept' })[1]!);
    await waitFor(() => expect(answer).toHaveBeenCalledWith('train-club', 'r1', 'accept'));
    expect((await screen.findByRole('status')).textContent).toBe('Riverside LUG and Train Club are partners now.');
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(offer).toHaveBeenCalledWith('train-club', 'f1', 'accept'));
    expect((await screen.findByRole('status')).textContent).toContain('“Water mill” is shared with Train Club');
    expect((await screen.findByTestId('partner-list')).textContent).toContain('1 module from them');
    expect(screen.queryByTestId('partners-waiting')).toBeNull();
  });

  it('a request sent waits and can be taken back; a declined one says when it can go again', async () => {
    let state = runner({
      requestsOut: [
        { id: 'r1', club: { id: null, name: null, slug: 'secret', logoUrl: null }, state: 'pending', createdAt: 0, decidedAt: null, askAgainAt: null },
        { id: 'r2', club: { ...LUG }, state: 'declined', createdAt: 0, decidedAt: 0, askAgainAt: Date.now() + 3_600_000 },
      ],
    });
    vi.spyOn(api.orgs, 'partners').mockImplementation(async () => state);
    const back = vi.spyOn(api.orgs, 'withdrawPartnerRequest').mockImplementation(async () => {
      state = { ...state, requestsOut: state.requestsOut!.slice(1) };
    });
    wrap(<ClubPartnersSection slug="train-club" name="Train Club" />);
    const out = await screen.findByTestId('partner-requests-out');
    expect(out.textContent).toContain('the club at /orgs/secret');
    expect(out.textContent).toContain('Waiting for them to accept.');
    expect(out.textContent).toContain('Declined. You can ask again from');
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Take back' }));
    await waitFor(() => expect(back).toHaveBeenCalledWith('train-club', 'r1'));
    await waitFor(() => expect(screen.getByTestId('partner-requests-out').textContent).not.toContain('secret'));
  });

  it('asks a club found in the list, or by a pasted link', async () => {
    vi.spyOn(api.orgs, 'partners').mockResolvedValue(runner());
    vi.spyOn(api.orgs, 'directory').mockResolvedValue({ clubs: [{ ...LUG, description: '', memberCount: 4, listed: true, myStatus: null }] } as never);
    const ask = vi.spyOn(api.orgs, 'askPartner').mockResolvedValue({ status: 'requested', id: 'r9', club: { ...LUG } });
    wrap(<ClubPartnersSection slug="train-club" name="Train Club" />);
    fireEvent.change(await screen.findByTestId('partner-search'), { target: { value: 'river' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(ask).toHaveBeenCalledWith('train-club', 'riverside-lug'));
    expect((await screen.findByRole('status')).textContent).toBe('Asked Riverside LUG. Their Admins or Managers must accept it.');
    fireEvent.change(screen.getByTestId('partner-search'), { target: { value: 'https://example.org/orgs/secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask this club' }));
    await waitFor(() => expect(ask).toHaveBeenLastCalledWith('train-club', 'https://example.org/orgs/secret'));
  });

  it('Admins end a partnership after a box that says what happens; Managers can’t; members only see the partners', async () => {
    const partner = { ...LUG, since: 0, modulesIn: 1, modulesOut: 1 };
    const spy = vi.spyOn(api.orgs, 'partners').mockResolvedValue(runner({ partners: [partner] }));
    const end = vi.spyOn(api.orgs, 'endPartnership').mockResolvedValue({ ok: true, stopped: 2 });
    const asked = autoConfirm(true);
    wrap(<ClubPartnersSection slug="train-club" name="Train Club" />);
    fireEvent.click(await screen.findByRole('button', { name: 'End partnership' }));
    await waitFor(() => expect(end).toHaveBeenCalledWith('train-club', 'o2'));
    expect(asked.titles).toEqual(['End the partnership with Riverside LUG?']);
    expect((await screen.findByRole('status')).textContent).toBe('The partnership with Riverside LUG ended. 2 modules stopped.');
    cleanup();
    spy.mockResolvedValue(runner({ partners: [partner], canEnd: false }));
    wrap(<ClubPartnersSection slug="train-club" name="Train Club" />);
    expect(await screen.findByText('Only the club’s Admins can end it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'End partnership' })).toBeNull();
    cleanup();
    spy.mockResolvedValue({ canManage: false, canEnd: false, partners: [partner] });
    wrap(<ClubPartnersSection slug="train-club" name="Train Club" />);
    expect((await screen.findByTestId('partner-list')).textContent).toContain('Riverside LUG');
    expect(screen.queryByTestId('partner-search')).toBeNull();
    expect(screen.getByText('The club’s Admins and Managers ask other clubs to be partners and answer their requests.')).toBeTruthy();
  });
});

describe('a club’s module in the Share dialog', () => {
  const shares = (over: Partial<ModuleShares> = {}): ModuleShares => ({
    latestVersion: 2,
    canShareWithClubs: false,
    canShareWithOtherClubs: true,
    club: { id: 'o1', name: 'Train Club', slug: 'train-club' },
    partners: [{ orgId: 'o2', name: 'Riverside LUG', slug: 'riverside-lug', logoUrl: null }],
    offers: [],
    people: [],
    invites: [],
    clubs: [],
    myClubs: [],
    usedIn: { layouts: 0, clubs: [], people: [], others: 0 },
    ...over,
  });

  it('shares with a partner at once, and offers to another club, which must accept', async () => {
    let state = shares();
    vi.spyOn(api.modules, 'shares').mockImplementation(async () => state);
    vi.spyOn(api.modules, 'clubTargets').mockResolvedValue({ clubs: [{ orgId: 'o3', name: 'Hill Club', slug: 'hill-club', logoUrl: null, partner: false, shared: false, offer: null }] });
    const share = vi.spyOn(api.modules, 'shareWithClub').mockImplementation(async (_id, slug) => {
      if (slug === 'riverside-lug') {
        state = { ...state, clubs: [{ orgId: 'o2', name: 'Riverside LUG', slug, createdAt: 0, via: 'partner' }] };
        return { ok: true, status: 'shared', orgId: 'o2', name: 'Riverside LUG', slug };
      }
      state = { ...state, offers: [{ id: 'f1', club: { orgId: 'o3', name: 'Hill Club', slug, logoUrl: null }, state: 'pending', createdAt: 0, askAgainAt: null }] };
      return { ok: true, status: 'offered', orgId: 'o3', name: 'Hill Club', slug, offerId: 'f1' };
    });
    const back = vi.spyOn(api.modules, 'withdrawClubOffer').mockImplementation(async () => {
      state = { ...state, offers: [] };
    });
    wrap(<ModuleClubShares moduleId="m1" title="Harbor crane" />);
    expect((await screen.findByTestId('club-to-club')).textContent).toContain('Partner clubs get it straight away. Any other club must accept it first.');
    fireEvent.change(screen.getByTestId('partner-club-pick'), { target: { value: 'riverside-lug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(share).toHaveBeenCalledWith('m1', 'riverside-lug'));
    expect((await screen.findByTestId('module-clubs')).textContent).toContain('Riverside LUG (partner club) · can place it');
    expect(await screen.findByText('It’s shared with every partner club.')).toBeTruthy();
    fireEvent.change(screen.getByTestId('other-club-search'), { target: { value: 'hill' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Offer' }));
    await waitFor(() => expect(share).toHaveBeenCalledWith('m1', 'hill-club'));
    expect((await screen.findByRole('status')).textContent).toBe('Offered “Harbor crane” to Hill Club. It’s shared once their Admins or Managers accept it.');
    expect((await screen.findByTestId('module-offers')).textContent).toContain('Hill Club · waiting for them to accept');
    fireEvent.click(screen.getByRole('button', { name: 'Take back' }));
    await waitFor(() => expect(back).toHaveBeenCalledWith('m1', 'f1'));
    await waitFor(() => expect(screen.queryByTestId('module-offers')).toBeNull());
  });

  it('with no partner clubs, it says so and links to asking one; a pasted link is offered', async () => {
    vi.spyOn(api.modules, 'shares').mockResolvedValue(shares({ partners: [] }));
    const share = vi.spyOn(api.modules, 'shareWithClub').mockResolvedValue({ ok: true, status: 'offered', orgId: null, name: null, slug: 'secret', offerId: 'f2' });
    wrap(<ModuleClubShares moduleId="m1" title="Harbor crane" />);
    const none = await screen.findByTestId('no-partners');
    expect(none.textContent).toContain('Train Club has no partner clubs yet.');
    expect(screen.getByRole('link', { name: 'Ask a club to be partners' }).getAttribute('href')).toBe('/orgs/train-club?tab=partners');
    fireEvent.change(screen.getByTestId('other-club-search'), { target: { value: 'https://example.org/orgs/secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Offer it to this club' }));
    await waitFor(() => expect(share).toHaveBeenCalledWith('m1', 'https://example.org/orgs/secret'));
    expect((await screen.findByRole('status')).textContent).toContain('Offered “Harbor crane” to the club at /orgs/secret.');
  });
});
