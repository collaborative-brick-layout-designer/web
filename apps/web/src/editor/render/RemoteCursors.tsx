import { useMemo } from 'react';
import { presenceTextColor } from '../presenceColors';
import { Group, Line, Rect, Text } from 'react-konva';
import type { Awareness } from 'y-protocols/awareness';
import type { BbmMap, Brick } from '@cld/model';
import { useRemotePeers } from '../useAwareness';
import { studToPx } from './coords';
import { usePosedMap } from '../liveDragPose';

/**
 * Renders remote peers' cursors + their selection outlines onto the
 * canvas. Pure: re-renders when awareness ticks. The presence panel
 * (sidebar) lives in PresencePanel.tsx and shares the same hook.
 */
/** Between ids in `wanted` (not in any id). */
const SEP = '\u0000';

export function RemoteCursors({
  awareness,
  map: committedMap,
  zoom = 1,
}: {
  awareness: Awareness | null;
  map: BbmMap;
  /** The map's zoom: cursors and outlines keep their size on screen at any zoom, as on the desktop. */
  zoom?: number;
}) {
  const peers = useRemotePeers(awareness);
  // Index the bricks others have picked, once per map (not per peer
  // cursor move), so the per-peer selection lookup is O(selection-size).
  // Only those: indexing all 7,520 parts took about 18 ms of every change
  // at 4x slowed CPU, and nothing at all when nobody else has a pick.
  const wanted = peers.map(({ state }) => state.selection.brickIds.join(SEP)).filter((k) => k !== '').join(SEP);
  // The parts being dragged where they are now (liveDragPose.ts), so this
  // follows the drag every frame, not only the drop. Only when someone
  // else has picked one of them: nothing else here moves with a drag (it
  // drew again on every frame of a drag whenever others were here).
  const map = usePosedMap(committedMap, (pose) => wanted !== '' && wanted.split(SEP).some((id) => pose.ids.has(id)));
  const brickIndex = useMemo(() => {
    const index = new Map<string, Brick>();
    if (wanted === '') return index;
    const want = new Set(wanted.split(SEP));
    for (const layer of map.layers) {
      if (layer.type === 'brick') {
        for (const b of layer.bricks) if (want.has(b.id)) index.set(b.id, b);
      }
    }
    return index;
  }, [map, wanted]);
  if (!awareness || peers.length === 0) return null;
  // One screen pixel, in map pixels.
  const px = 1 / (zoom > 0 ? zoom : 1);

  return (
    <Group>
      {peers.map(({ clientId, state }) => (
        <Group key={clientId} listening={false}>
          {state.selection.brickIds.map((id) => {
            const brick = brickIndex.get(id);
            if (!brick) return null;
            // Outline the brick's display area in the peer's color
            // — semi-transparent so it doesn't drown out the local
            // selection's solid blue dashes.
            return (
              <Rect
                key={id}
                x={studToPx(brick.displayArea.x) - px}
                y={studToPx(brick.displayArea.y) - px}
                width={studToPx(brick.displayArea.width) + 2 * px}
                height={studToPx(brick.displayArea.height) + 2 * px}
                stroke={state.user.color}
                strokeWidth={2}
                strokeScaleEnabled={false}
                opacity={0.6}
                listening={false}
              />
            );
          })}
          {state.cursor && (() => {
            // Display names are now user-editable (up to 60 chars, see
            // PATCH /api/auth/me) — clamp the on-canvas label so a long
            // name doesn't draw a huge pill over the layout.
            const MAX_LABEL_CHARS = 20;
            const label = state.user.displayName.length > MAX_LABEL_CHARS
              ? state.user.displayName.slice(0, MAX_LABEL_CHARS - 1) + '…'
              : state.user.displayName;
            return (
              <Group name="remote-cursor" x={studToPx(state.cursor.x)} y={studToPx(state.cursor.y)} scaleX={px} scaleY={px}>
                {/* Arrow shape: pointer triangle. */}
                <Line
                  points={[0, 0, 0, 16, 4, 12, 9, 22, 11, 21, 7, 11, 12, 11]}
                  fill={state.user.color}
                  stroke="#000"
                  strokeWidth={0.5}
                  closed
                />
                {/* Name pill — drawn after the arrow so it overlaps. */}
                <Rect
                  x={14}
                  y={2}
                  width={label.length * 7 + 12}
                  height={16}
                  fill={state.user.color}
                  cornerRadius={3}
                />
                <Text
                  text={label}
                  x={20}
                  y={5}
                  fontSize={10}
                  fill={presenceTextColor(state.user.color)}
                  listening={false}
                />
              </Group>
            );
          })()}
        </Group>
      ))}
    </Group>
  );
}
