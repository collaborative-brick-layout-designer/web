// A server with no parts says so on the Admin dashboard, with one click to
// get the parts library; Part libraries only offers "Register on-disk
// library" when the server's parts folder really has parts.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartLibrary } from '../../../api';

const state: { libraries: PartLibrary[]; onDiskBaseParts: number } = { libraries: [], onDiskBaseParts: 0 };
const download = vi.fn(async () => {
  state.libraries = [lib('bluebrickparts-default', 1200)];
  return { id: 'x', slug: 'bluebrickparts-default', partCount: 1200 };
});

function lib(slug: string, partCount: number): PartLibrary {
  return { id: slug, name: slug, slug, sourceUrl: null, partCount, defaultEnabled: true, locked: slug === 'bluebrickparts', installedAt: 1, updatedAt: 1, diskPath: '/p' } as PartLibrary;
}

vi.mock('../../../api', () => ({
  api: {
    admin: {
      partLibraries: async () => ({ ...state }),
      downloadPartLibrary: (...a: unknown[]) => download(...(a as [])),
      installBaseLibrary: async () => ({}),
    },
  },
}));

import { PartLibrariesTab, PartsSetupCard, slugFromName } from '../LibrariesTab';

const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

describe('parts setup', () => {
  beforeEach(() => {
    cleanup();
    state.libraries = [];
    state.onDiskBaseParts = 0;
    download.mockClear();
  });

  it('warns on the dashboard when there are no parts and gets the library in one click', async () => {
    wrap(<PartsSetupCard />);
    expect(await screen.findByText(/0 libraries · 0 parts/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Get the parts library' }));
    await waitFor(() => expect(screen.getByText(/The parts library is installed/)).toBeTruthy());
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ slug: 'bluebrickparts-default' }));
  });

  it('counts a base library registered with 0 parts as no parts', async () => {
    state.libraries = [lib('bluebrickparts', 0)];
    wrap(<PartsSetupCard />);
    expect(await screen.findByText(/1 library · 0 parts/)).toBeTruthy();
  });

  it('says nothing once the server has parts', async () => {
    state.onDiskBaseParts = 900;
    const { container } = wrap(<PartsSetupCard />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
  });

  it('offers Register on-disk library only when the parts folder has parts', async () => {
    const { unmount } = wrap(<PartLibrariesTab />);
    expect(await screen.findByRole('button', { name: 'Get the parts library' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Register on-disk library' })).toBeNull();
    unmount();
    state.onDiskBaseParts = 900;
    wrap(<PartLibrariesTab />);
    expect(await screen.findByRole('button', { name: 'Register on-disk library' })).toBeTruthy();
  });
});

describe('Part libraries for a club admin who is not technical', () => {
  beforeEach(() => {
    cleanup();
    state.libraries = [];
    state.onDiskBaseParts = 0;
  });

  it('leads with one Get the parts library button and keeps the rest under Advanced', async () => {
    wrap(<PartLibrariesTab />);
    const card = await screen.findByTestId('parts-library-card');
    expect(card.querySelector('button')?.textContent).toBe('Get the parts library');
    const advanced = screen.getByTestId('libraries-advanced');
    expect(advanced.tagName).toBe('DETAILS');
    expect((advanced as HTMLDetailsElement).open).toBe(false);
    // The words a developer would use are only under Advanced, and it says clubs.
    for (const word of ['Slug', 'orgs', 'Custom URL', 'Manual install']) {
      expect(document.body.textContent).not.toContain(word);
    }
    expect(advanced.textContent).toContain('Install a pack from a zip');
  });

  it('fills the folder name from the pack name until someone edits it', async () => {
    wrap(<PartLibrariesTab />);
    const name = await screen.findByLabelText('Pack name');
    fireEvent.change(name, { target: { value: 'Town Extras 2!' } });
    const folder = screen.getByLabelText(/^Folder name/) as HTMLInputElement;
    expect(folder.value).toBe('town-extras-2');
    fireEvent.change(folder, { target: { value: 'my-town' } });
    fireEvent.change(name, { target: { value: 'Town Extras 3' } });
    expect(folder.value).toBe('my-town');
  });

  it('says the library is installed once it is', async () => {
    state.libraries = [lib('bluebrickparts-default', 1200)];
    wrap(<PartLibrariesTab />);
    const card = await screen.findByTestId('parts-library-card');
    await waitFor(() => expect(card.textContent).toContain('1,200 parts in 1 library'));
    expect(card.querySelector('button')).toBeNull();
  });
});

describe('slugFromName', () => {
  it('makes a folder name', () => {
    expect(slugFromName('  My Parts Pack ')).toBe('my-parts-pack');
    expect(slugFromName('Ünïcode & co')).toBe('n-code-co');
  });
});
