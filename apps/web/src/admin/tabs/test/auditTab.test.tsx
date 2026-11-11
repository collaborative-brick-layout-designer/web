// Admin › Audit log says in words when the live editor refused (or let
// through but flagged) an update that would mix another layout in.

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../api', () => ({
  api: {
    admin: {
      auditLog: async () => ({
        total: 3,
        limit: 50,
        offset: 0,
        events: [
          {
            id: 1,
            layoutId: 'layout-b',
            resourceKind: null,
            resourceId: null,
            userId: 'u1',
            userName: 'Aaron',
            eventType: 'layout_merge_refused',
            payload: { foreignLayers: 7, unseenClients: 3, client: 'BrickLayoutDesigner/1.2.0 (desktop)' },
            createdAt: Date.now(),
          },
          {
            id: 2,
            layoutId: 'layout-c',
            resourceKind: null,
            resourceId: null,
            userId: 'u1',
            userName: 'Aaron',
            eventType: 'layout_merge_suspected',
            payload: { foreignLayers: 0, unseenClients: 5 },
            createdAt: Date.now(),
          },
          {
            id: 3,
            layoutId: 'layout-d',
            resourceKind: null,
            resourceId: null,
            userId: 'u1',
            userName: 'Aaron',
            eventType: 'layout_update_refused',
            payload: { kind: 'unreadable', why: 'a string has a NUL character in it', client: 'Mozilla/5.0' },
            createdAt: Date.now(),
          },
        ],
      }),
    },
  },
}));

const { AuditTab } = await import('../AuditTab');

describe('AuditTab', () => {
  it('describes merge refusals and flags in plain words', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AuditTab />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText(
        'Refused a live update that would have mixed another layout into this one: it brought 7 layers from elsewhere (from BrickLayoutDesigner/1.2.0 (desktop)). Nothing was changed, and that connection was closed.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/came from 5 editors this layout had never seen at once/)).toBeTruthy();
    expect(
      screen.getByText(
        "Refused a live update the apps can't read (a string has a NUL character in it) (from Mozilla/5.0). Nothing was changed, and that connection was closed.",
      ),
    ).toBeTruthy();
  });
});

describe('Admin › Audit log: erased from Recently deleted', () => {
  it('says what was erased early, in words', async () => {
    const { auditSentence } = await import('../AuditTab');
    expect(
      auditSentence({ id: 9, layoutId: null, resourceKind: 'module', resourceId: 'm1', userId: 'u1', userName: 'Ada', eventType: 'delete_forever', payload: { title: 'Station' }, createdAt: 1 } as never),
    ).toBe('Erased the module “Station” from Recently deleted, before its 30 days were up.');
  });
});
