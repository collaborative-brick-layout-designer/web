// @vitest-environment jsdom
// Guided tours and the welcome card: the shared catalogue's rules (the
// desktop app keeps an identical copy of tours.json), every step pointing
// at something the web UI tags, and the tour card itself: Back / Next /
// Skip, Esc, the focus trap, the outline round the real control, going to
// the right page first, and remembering finished tours in toursSeen.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useState, type ReactNode } from 'react';
import catalogueText from '../tours.json?raw';
import { forDevice, getTour, markSeen, stepCount, TOURS, toursFor, WELCOME, WELCOME_ID } from '../tours';
import { findTourTarget, TourProvider, useTours } from '../TourProvider';
import { WelcomeCard } from '../WelcomeCard';
import { HelpMenu } from '../../editor/EditorChrome';
import { HelpButton } from '../../help/HelpButton';
import { SettingsContent } from '../../settings/SettingsPage';
import { PrefsContext, type PrefsContextValue } from '../../theme/PrefsProvider';
import { DEFAULT_PREFERENCES, type Preferences } from '../../theme/theme';
import { LAST_LAYOUT_KEY } from '../../layouts/reopenLast';

const SOURCES = import.meta.glob(['../../**/*.{ts,tsx}', '!../../**/*.test.{ts,tsx}', '!../tours.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Steps that show their card in the middle on purpose: there's nothing on screen to point at. */
const CENTRED = new Set(['clubs.join']);

describe('the tour catalogue', () => {
  it('has the welcome card and the four tours, with ids the server accepts', () => {
    expect(WELCOME_ID).toBe('welcome');
    expect(TOURS.map((t) => t.id)).toEqual(['editor', 'rooms', 'clubs', 'view']);
    for (const id of [WELCOME_ID, ...TOURS.map((t) => t.id)]) expect(id).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
  });

  it('keeps tours short: 4 to 7 steps, short titles, a sentence or two each', () => {
    for (const t of TOURS) {
      expect(t.steps.length, t.id).toBeGreaterThanOrEqual(4);
      expect(t.steps.length, t.id).toBeLessThanOrEqual(7);
      for (const s of t.steps) {
        expect(s.title.length, s.title).toBeLessThanOrEqual(32);
        expect(s.text.length, s.text).toBeLessThanOrEqual(120);
        expect(s.text.split(/(?<=\.)\s+/).length, s.text).toBeLessThanOrEqual(2);
      }
    }
    // The phone tour is the shorter one.
    expect(getTour('view')!.steps.length).toBeLessThan(getTour('editor')!.steps.length);
  });

  it('uses plain words and no emoji', () => {
    expect(catalogueText).not.toMatch(/\p{Extended_Pictographic}/u);
    // Sheets and venues, as the rest of the app calls them.
    const words = [WELCOME.title, WELCOME.text, ...Object.values(WELCOME.actions).flatMap((a) => [a.label, a.text]),
      ...TOURS.flatMap((t) => [t.title, ...t.steps.flatMap((s) => [s.title, s.text])])].join(' ');
    expect(words).not.toMatch(/\b(layer|room)s?\b/i);
    expect(getTour('rooms')!.title).toBe('Venues');
  });

  it('leaves out the steps for the desktop only', () => {
    const raw = JSON.parse(catalogueText) as { tours: { id: string; steps: { target: string; apps?: string[] }[] }[] };
    const desktopOnly = raw.tours.flatMap((t) => t.steps.filter((s) => s.apps && !s.apps.includes('web')).map((s) => s.target));
    expect(desktopOnly).toContain('servers.status');
    for (const t of TOURS) for (const s of t.steps) expect(desktopOnly, s.target).not.toContain(s.target);
    expect(getTour('clubs')!.steps.map((s) => s.target)).toEqual(['owners.filter', 'publish.owner', 'clubs.page', 'clubs.join']);
  });

  it('names where the desktop copy lives, so the two stay identical', () => {
    const about = (JSON.parse(catalogueText) as { _about: string })._about;
    expect(about).toContain('apps/web/src/tours/tours.json');
    expect(about).toContain('src/ui/tours/tours.json');
  });

  it('points every step at something the web UI tags', () => {
    const all = Object.values(SOURCES).join('\n');
    for (const t of TOURS) {
      for (const s of t.steps) {
        if (CENTRED.has(s.target)) continue;
        const tagged = all.includes(`data-tour="${s.target}"`) || all.includes(`helpKey="${s.target}"`) || all.includes(`'${s.target}'`);
        expect(tagged, `${t.id}: ${s.target}`).toBe(true);
      }
    }
  });

  it('offers phones the View tour instead of the editor tour', () => {
    expect(toursFor(true).map((t) => t.id)).toEqual(['rooms', 'clubs', 'view']);
    expect(toursFor(false).map((t) => t.id)).toEqual(['editor', 'rooms', 'clubs']);
    expect(forDevice('editor', true)).toBe('view');
    expect(forDevice('view', false)).toBe('editor');
    expect(forDevice('clubs', true)).toBe('clubs');
    expect(stepCount(2, 5)).toBe('2 of 5');
    expect(markSeen(['a'], 'a')).toEqual(['a']);
    expect(markSeen(['a'], 'b')).toEqual(['a', 'b']);
  });
});

// ---- the card ---------------------------------------------------------

let prefsSet: Partial<Preferences>[];
let fetchCalls: string[];

function Prefs({ children, seen = [] }: { children: ReactNode; seen?: string[] }) {
  const [prefs, setState] = useState<Preferences>({ ...DEFAULT_PREFERENCES, toursSeen: seen });
  const value: PrefsContextValue = {
    prefs,
    mode: 'light',
    setPrefs: (c) => {
      prefsSet.push(c);
      setState((p) => ({ ...p, ...c }));
    },
    syncedToAccount: true,
    updatedAt: null,
    ready: true,
  };
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname}</p>;
}

function Start({ id }: { id: string }) {
  const { startTour } = useTours();
  return <button onClick={() => startTour(id)}>start {id}</button>;
}

/** A page with the editor's tagged controls. */
function FakeEditor() {
  return (
    <div>
      <section data-tour="panel.parts">Parts</section>
      <section data-tour="panel.sheets">Sheets</section>
      <main data-tour="map">map</main>
      <span data-tour="topbar.saveStatus">Saved</span>
      <button data-tour="share.picture">Share picture</button>
      <HelpMenu />
      <Start id="editor" />
      <Start id="rooms" />
      <Start id="clubs" />
    </div>
  );
}

function renderApp(url: string, seen: string[] = [], home: ReactNode = <Start id="editor" />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Prefs seen={seen}>
        <MemoryRouter initialEntries={[url]}>
          <TourProvider>
            <Routes>
              <Route path="/" element={home} />
              <Route path="/editor/:id" element={<FakeEditor />} />
              <Route path="/venues/new" element={<nav data-tour="room.tools">tools</nav>} />
              <Route path="/orgs" element={<p>clubs</p>} />
            </Routes>
            <Where />
          </TourProvider>
        </MemoryRouter>
      </Prefs>
    </QueryClientProvider>,
  );
}

// jsdom has no layout: give every element a box, so tagged controls count as on screen.
const boxes = new Map<string, DOMRect>();
beforeEach(() => {
  prefsSet = [];
  fetchCalls = [];
  localStorage.clear();
  window.innerWidth = 1280;
  window.innerHeight = 800;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const tag = this.getAttribute('data-tour') ?? '';
    return boxes.get(tag) ?? new DOMRect(100, 100, 120, 40);
  });
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${input}`;
    fetchCalls.push(key);
    const body =
      key === 'GET /api/layouts' ? { layouts: [{ id: 'L1', title: 'First' }] } : key === 'POST /api/layouts' ? { id: 'NEW' } : {};
    return new Response(JSON.stringify(body), { status: key === 'POST /api/layouts' ? 201 : 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  boxes.clear();
});

const tourEl = () => screen.getByTestId('tour');

describe('a tour', () => {
  it('steps through with Next and Back, outlining each control', async () => {
    renderApp('/editor/L1');
    fireEvent.click(screen.getByText('start editor'));
    const steps = getTour('editor')!.steps;
    expect(await screen.findByRole('dialog', { name: steps[0]!.title })).toBeTruthy();
    expect(screen.getByText(`The editor · 1 of ${steps.length}`)).toBeTruthy();
    expect(screen.getByText(steps[0]!.text)).toBeTruthy();
    // The outline sits round the parts panel.
    boxes.set('panel.sheets', new DOMRect(300, 200, 50, 60));
    const hole = await screen.findByTestId('tour-highlight');
    expect(hole.style.left).toBe('94px');
    expect(hole.style.width).toBe('132px');
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('dialog', { name: steps[1]!.title })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('tour-highlight').style.left).toBe('294px'));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('dialog', { name: steps[0]!.title })).toBeTruthy();
  });

  it('follows the control when the page moves it after the step starts', async () => {
    renderApp('/editor/L1');
    fireEvent.click(screen.getByText('start editor'));
    await waitFor(() => expect(screen.getByTestId('tour-highlight').style.height).toBe('52px'));
    // The parts panel shrinks once the sheets panel loads under it.
    boxes.set('panel.parts', new DOMRect(100, 100, 120, 300));
    await waitFor(() => expect(screen.getByTestId('tour-highlight').style.height).toBe('312px'), { timeout: 1000 });
  });

  it('Done on the last step closes it and remembers it', async () => {
    renderApp('/editor/L1');
    fireEvent.click(screen.getByText('start editor'));
    const steps = getTour('editor')!.steps;
    for (let i = 0; i < steps.length - 1; i++) {
      await screen.findByRole('dialog', { name: steps[i]!.title });
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    }
    await screen.findByRole('dialog', { name: steps.at(-1)!.title });
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('tour')).toBeNull();
    expect(prefsSet.at(-1)).toEqual({ toursSeen: ['editor'] });
  });

  it('Skip and Esc close it, remember it, and give the focus back', async () => {
    renderApp('/editor/L1', ['welcome']);
    const start = screen.getByText('start editor');
    start.focus();
    fireEvent.click(start);
    await screen.findByTestId('tour');
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(screen.queryByTestId('tour')).toBeNull();
    expect(prefsSet.at(-1)).toEqual({ toursSeen: ['welcome', 'editor'] });
    expect(document.activeElement).toBe(start);

    fireEvent.click(start);
    await screen.findByTestId('tour');
    const keyed = vi.fn();
    window.addEventListener('keydown', keyed);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Next' }), { key: 'Escape' });
    window.removeEventListener('keydown', keyed);
    expect(screen.queryByTestId('tour')).toBeNull();
    // The page underneath never saw the key.
    expect(keyed).not.toHaveBeenCalled();
  });

  it('keeps Tab inside the card, starting on Next', async () => {
    renderApp('/editor/L1');
    fireEvent.click(screen.getByText('start editor'));
    await screen.findByTestId('tour');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy());
    const next = screen.getByRole('button', { name: 'Next' });
    await waitFor(() => expect(document.activeElement).toBe(next));
    const dialog = tourEl().querySelector('[role="dialog"]')!;
    const buttons = within(dialog as HTMLElement).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Skip', 'Back', 'Next']);
    fireEvent.keyDown(next, { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0]!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(next);
  });

  it('shows the card in the middle when the control is not on screen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderApp('/editor/L1');
    fireEvent.click(screen.getByText('start clubs'));
    // Clubs happens on the home page.
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.getByRole('dialog', { name: getTour('clubs')!.steps[0]!.title })).toBeTruthy();
    expect(screen.queryByTestId('tour-highlight')).toBeNull();
    vi.useRealTimers();
  });

  it('goes to the room designer for the Rooms tour', async () => {
    renderApp('/editor/L1');
    fireEvent.click(screen.getByText('start rooms'));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/venues/new'));
    expect(await screen.findByRole('dialog', { name: getTour('rooms')!.steps[0]!.title })).toBeTruthy();
    expect(await screen.findByTestId('tour-highlight')).toBeTruthy();
  });

  it('opens a layout for the editor tour: the last one, else the first, else a new one', async () => {
    localStorage.setItem(LAST_LAYOUT_KEY, 'L1');
    renderApp('/');
    fireEvent.click(screen.getByText('start editor'));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/editor/L1'));
    expect(await screen.findByRole('dialog', { name: getTour('editor')!.steps[0]!.title })).toBeTruthy();
    cleanup();

    localStorage.setItem(LAST_LAYOUT_KEY, 'GONE');
    renderApp('/');
    fireEvent.click(screen.getByText('start editor'));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/editor/L1'));
    cleanup();

    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      fetchCalls.push(`${init?.method ?? 'GET'} ${input}`);
      const post = init?.method === 'POST';
      return new Response(JSON.stringify(post ? { id: 'NEW' } : { layouts: [] }), { status: post ? 201 : 200, headers: { 'content-type': 'application/json' } });
    });
    renderApp('/');
    fireEvent.click(screen.getByText('start editor'));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/editor/NEW'));
    expect(fetchCalls).toContain('POST /api/layouts');
  });

  it('phones get the View tour when they ask for the editor tour', async () => {
    window.innerWidth = 390;
    renderApp('/editor/L1');
    fireEvent.click(screen.getByText('start editor'));
    expect(await screen.findByText(`${getTour('view')!.title} · 1 of ${getTour('view')!.steps.length}`)).toBeTruthy();
  });

  it('finds a control by the help button that explains it', () => {
    render(
      <Prefs>
        <div id="box">
          <span id="pill">Saved</span>
          <HelpButton helpKey="topbar.saveStatus" />
        </div>
        <section data-panel="x" />
        <div id="elsewhere">
          <HelpButton helpKey="panel.views" target='[data-panel="x"]' />
        </div>
      </Prefs>,
    );
    expect(findTourTarget('topbar.saveStatus')?.id).toBe('pill');
    expect(findTourTarget('panel.views')?.getAttribute('data-panel')).toBe('x');
    expect(findTourTarget('nothing')).toBeNull();
  });
});

describe('starting a tour', () => {
  it('from the Help menu', async () => {
    renderApp('/editor/L1');
    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tour: The editor' }));
    expect(await screen.findByRole('dialog', { name: getTour('editor')!.steps[0]!.title })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tour: Looking at a layout' })).toBeNull();
  });

  it('from Settings, where Show tours again also forgets the seen ones', async () => {
    const onClose = vi.fn();
    renderApp('/', ['welcome', 'editor'], <SettingsContent onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show tours again' }));
    expect(prefsSet.at(-1)).toEqual({ toursSeen: [] });
    fireEvent.click(within(screen.getByRole('group', { name: 'Take a tour' })).getByRole('button', { name: 'Clubs' }));
    expect(onClose).toHaveBeenCalled();
    expect(await screen.findByRole('dialog', { name: getTour('clubs')!.steps[0]!.title })).toBeTruthy();
  });
});

describe('the welcome card', () => {
  const home = (onLayout = vi.fn()) => <WelcomeCard name="Sam Builder" onLayout={onLayout} />;

  it('greets a new user, and Not now puts it away for good', () => {
    renderApp('/', [], home());
    expect(screen.getByRole('heading', { name: `Hi Sam! ${WELCOME.title}` })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: WELCOME.dismiss }));
    expect(screen.queryByTestId('welcome')).toBeNull();
    expect(prefsSet.at(-1)).toEqual({ toursSeen: ['welcome'] });
  });

  it('shows its three choices as the same card, only the suggested one marked', () => {
    renderApp('/', [], home());
    const tile = (label: string) => screen.getByRole('button', { name: new RegExp(label) }).className;
    for (const label of [WELCOME.actions.layout.label, WELCOME.actions.club.label, WELCOME.actions.tour.label]) {
      expect(tile(label)).toContain('bg-panel');
    }
    expect(tile(WELCOME.actions.layout.label)).toContain('border-accent');
    expect(tile(WELCOME.actions.tour.label)).not.toContain('border-accent');
  });

  it('is not shown once seen, or before the settings load', () => {
    renderApp('/', ['welcome'], home());
    expect(screen.queryByTestId('welcome')).toBeNull();
    cleanup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PrefsContext.Provider value={{ prefs: DEFAULT_PREFERENCES, mode: 'light', setPrefs: () => {}, syncedToAccount: true, updatedAt: null, ready: false }}>
          <MemoryRouter>{home()}</MemoryRouter>
        </PrefsContext.Provider>
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId('welcome')).toBeNull();
  });

  it('someone already in a club isn’t offered "Join a club"', async () => {
    vi.stubGlobal('fetch', async (input: string) =>
      new Response(JSON.stringify(input === '/api/orgs' ? { orgs: [{ id: 'o1', slug: 'ark', name: 'ArkLUG', createdAt: 1, myRole: 'member' }] } : {}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    renderApp('/', [], home());
    expect(screen.getByRole('button', { name: new RegExp(WELCOME.actions.layout.label) })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: new RegExp(WELCOME.actions.club.label) })).toBeNull());
  });

  it('each way in goes somewhere and puts the card away', async () => {
    const onLayout = vi.fn();
    renderApp('/', [], home(onLayout));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(WELCOME.actions.layout.label) }));
    expect(onLayout).toHaveBeenCalled();
    expect(screen.queryByTestId('welcome')).toBeNull();
    cleanup();

    renderApp('/', [], home());
    fireEvent.click(screen.getByRole('button', { name: new RegExp(WELCOME.actions.club.label) }));
    expect(screen.getByTestId('where').textContent).toBe('/orgs');
    cleanup();

    renderApp('/', [], home());
    fireEvent.click(screen.getByRole('button', { name: new RegExp(WELCOME.actions.tour.label) }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/editor/L1'));
    expect(await screen.findByRole('dialog', { name: getTour('editor')!.steps[0]!.title })).toBeTruthy();
    expect(prefsSet[0]).toEqual({ toursSeen: ['welcome'] });
  });
});

