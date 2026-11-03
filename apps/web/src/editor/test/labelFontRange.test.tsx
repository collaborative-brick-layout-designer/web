// A label stored with a font size out of range (any writer may put any
// number there) opens and draws at the nearest end of the range, as on the
// desktop; what is stored is left as it is.

import { describe, expect, it, vi } from 'vitest';
import { act, createElement as h, Fragment, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { BbmMap } from '@cld/model';
import type { AnchoredLabel } from '@cld/bbm';

type Drawn = { type: string; props: Record<string, unknown> };
let drawn: Drawn[] = [];
vi.mock('react-konva', () => {
  const mk = (type: string) => (p: Record<string, unknown> & { children?: ReactNode }) => {
    drawn.push({ type, props: p });
    return h(Fragment, null, p.children);
  };
  return { Group: mk('Group'), Text: mk('Text'), Rect: mk('Rect') };
});

import { AnchoredLabels } from '../render/AnchoredLabels';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAP = { layers: [] } as unknown as BbmMap;
const label = (id: string, size: number): AnchoredLabel =>
  ({ id, text: id, font: { family: 'Arial', size, style: '' }, color: { known: true, argb: 0, name: 'Black' }, kind: 0, targetId: '', offset: { x: 0, y: 0 }, rot: 0, minZoom: 0 }) as AnchoredLabel;

describe('a label font out of range', () => {
  it('draws at the nearest end of the range, the stored size untouched', async () => {
    drawn = [];
    const labels = [label('huge', 1e9), label('tiny', -3), label('fine', 12)];
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(h(AnchoredLabels, { map: MAP, labels, zoom: 1 })));
    const sizeOf = (text: string) => drawn.find((d) => d.type === 'Text' && d.props.text === text)?.props.fontSize;
    expect(sizeOf('huge')).toBe((500 * 96) / 72);
    expect(sizeOf('tiny')).toBe(96 / 72);
    expect(sizeOf('fine')).toBe(16);
    expect(labels[0]!.font.size).toBe(1e9);
    await act(async () => root.unmount());
  });
});
