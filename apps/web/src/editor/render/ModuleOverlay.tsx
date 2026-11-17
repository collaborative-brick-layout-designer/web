// Module name labels + frame outlines — port of SceneBuilderSidecar.cpp
// module rendering (view/moduleNames + view/moduleFrameThickness).
//
// Each sidecar module has a `members` array of brick IDs. We compute the
// AABB of all member bricks, draw a dashed outline around it (frame), and
// place the module name outside the frame, centred on a long side, sized
// as `moduleLabelPercent`% of the long axis and fitted to that side
// (moduleLabels.ts fitModuleName: two lines, then smaller, then cut short).
// A name cut short shows in full while its module is selected or the
// pointer is over it.

import Konva from 'konva';
import { useMemo } from 'react';
import { Group, Rect, Text } from 'react-konva';
import type { BbmMap } from '@cld/model';
import type { SidecarModule } from '@cld/bbm';
import { useEditorStore } from '../editorStore';
import { EXPORT_HIDE } from '../exportRender';
import { dragsAny, usePosedMap } from '../liveDragPose';
import { SELECTION } from './selectionStyle';
import { sharedPlaced } from '@cld/modules';
import { selectionHalo } from './BrickLayer';
import { studToPx } from './coords';
import { MAP_FONT_STACK } from './mapText';
import {
  MODULE_FRAME_DASH,
  MODULE_FRAME_PARTLY_HIDDEN_DASH,
  MODULE_FULL_NAME_BG,
  moduleHoverName,
  MODULE_NAME_STROKE,
  moduleFullNamePill,
  moduleLabelLayouts,
  moduleNameStrokePx,
  type ModuleLabelLayout,
} from './moduleLabels';

export { fitModuleName, moduleLabelFontPx, moduleLabelLayouts, moduleLabelBoundsStuds, type ModuleLabelLayout } from './moduleLabels';

interface Props {
  map: BbmMap;
  modules: SidecarModule[];
}

/** A shared module's frame: longer dashes than an ordinary module's. */
export const SHARED_FRAME_DASH = [14, 6, 2, 6];

/** The shared badge's size on the map (px): half the module's name, or a stud and a half when it shows no name. */
export function badgePx(l: Pick<ModuleLabelLayout, 'text'>): number {
  return Math.max(l.text ? l.text.fontPx * 0.5 : 0, 12);
}

/** The badge over a shared module's frame: "🔗 Alice", and "● v8 is ready" when a version waits; null for an ordinary module. */
export function sharedBadge(m: SidecarModule | undefined, updates: Record<string, number>): string | null {
  const s = sharedPlaced(m);
  if (!s) return null;
  const newer = updates[s.placedId];
  return `🔗 ${s.by ?? 'Shared'}${newer ? ` ● v${newer} is ready` : ''}`;
}

const widthCache = new Map<string, number>();

/** A bold name's width at a font size, measured as Konva draws it (cached: fitting a name measures it often). */
export function measureBold(text: string): (fontPx: number) => number {
  return (fontPx) => {
    const key = `${fontPx}|${text}`;
    let w = widthCache.get(key);
    if (w === undefined) {
      w = new Konva.Text({ text, fontSize: fontPx, fontStyle: 'bold', fontFamily: MAP_FONT_STACK }).width();
      if (widthCache.size > 5000) widthCache.clear();
      widthCache.set(key, w);
    }
    return w;
  };
}

/** Whether a scene point (px) is on a module's frame or name. */
function over(layout: ModuleLabelLayout, x: number, y: number): boolean {
  const b = layout.bounds;
  return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
}

export function ModuleOverlay({ map: committed, modules }: Props) {
  const showModuleNames = useEditorStore((s) => s.showModuleNames);
  const frameThickness = useEditorStore((s) => s.moduleFrameThickness);
  const labelPercent = useEditorStore((s) => s.moduleLabelPercent);
  const selection = useEditorStore((s) => s.selection);
  const editingId = useEditorStore((s) => s.editingModuleId);
  const tint = useEditorStore((s) => s.selectionTint);
  const snapActive = useEditorStore((s) => s.liveSnap !== null);
  // Shared (read-only) modules carry a link badge (docs/shared-modules.md): the badge says it, not a color.
  // (Sized on the map, like the names, so a zoom never renders this in React.)
  const sharedUpdates = useEditorStore((s) => s.sharedModuleUpdates);
  // The parts being dragged where they are now (liveDragPose.ts): outlines
  // and names move and turn with them, every frame.
  const map = usePosedMap(committed, (pose) => modules.some((m) => dragsAny(pose, m.members)));

  // Where the names go, worked out on the layout as it is; while parts are
  // dragged, each name keeps that place round its module (no jumping sides).
  const settled = useMemo(() => moduleLabelLayouts(committed, modules, labelPercent, measureBold), [committed, modules, labelPercent]);
  const layouts = useMemo(() => {
    if (map === committed) return settled;
    // Its colors stay too, until the drop.
    const before = new Map(settled.map((l) => [l.id, l]));
    const keep = new Map(settled.flatMap((l) => (l.slot ? [[l.id, l.slot] as const] : [])));
    return moduleLabelLayouts(map, modules, labelPercent, measureBold, keep).map((l) => {
      const was = before.get(l.id);
      return was ? { ...l, frameStroke: was.frameStroke, nameFill: was.nameFill } : l;
    });
  }, [map, committed, settled, modules, labelPercent]);
  // Names hover adds to: shortened, or with parts on a hidden sheet.
  const cut = useMemo(() => layouts.filter((l) => moduleHoverName(l) !== null), [layouts]);
  // The shortened name under the pointer (only watched while there is one).
  const hovered = useEditorStore((s) => {
    if (cut.length === 0 || s.hudMouseStudX === null || s.hudMouseStudY === null) return null;
    const x = studToPx(s.hudMouseStudX);
    const y = studToPx(s.hudMouseStudY);
    return cut.find((l) => over(l, x, y))?.id ?? null;
  });
  const selected = useMemo(() => new Set(selection), [selection]);

  if (modules.length === 0) return null;
  const byId = new Map(modules.map((m) => [m.id, m]));
  // A whole module picked (not the one being edited) is highlighted as one
  // piece, its outline in the selection's look (its parts aren't, one by one).
  const wholeSelected = (id: string) => {
    if (id === editingId) return false;
    const members = byId.get(id)?.members ?? [];
    return members.length > 0 && members.every((m) => selected.has(m));
  };
  const showsFull = (l: ModuleLabelLayout) => {
    if (moduleHoverName(l) === null) return false;
    if (l.id === hovered) return true;
    const members = byId.get(l.id)?.members ?? [];
    return members.length > 0 && members.every((id) => selected.has(id));
  };

  // Names and frames share one toggle, like desktop view/moduleNames; a
  // picked module is highlighted either way.
  return (
    <Group listening={false}>
      {layouts.map((l) => (showModuleNames || wholeSelected(l.id)) && (
        <Group key={l.id} name={`module-label-${l.id}`}>
          {wholeSelected(l.id) && <ModuleHighlight frame={l.frame} tint={tint} snapActive={snapActive} />}
          {showModuleNames && <Rect
            {...l.frame}
            name="module-frame"
            stroke={l.frameStroke}
            strokeWidth={frameThickness}
            strokeScaleEnabled={false}
            dash={l.partlyHidden ? MODULE_FRAME_PARTLY_HIDDEN_DASH : sharedBadge(byId.get(l.id), sharedUpdates) ? SHARED_FRAME_DASH : MODULE_FRAME_DASH}
            fillEnabled={false}
            perfectDrawEnabled={false}
          />}
          {showModuleNames && sharedBadge(byId.get(l.id), sharedUpdates) && (
            <Text
              name="module-shared-badge"
              x={l.frame.x}
              y={l.frame.y - badgePx(l) * 1.3}
              text={sharedBadge(byId.get(l.id), sharedUpdates)!}
              fontSize={badgePx(l)}
              fontStyle="bold"
              fontFamily={MAP_FONT_STACK}
              fill={l.nameFill}
              stroke={MODULE_NAME_STROKE}
              strokeWidth={moduleNameStrokePx(badgePx(l))}
              fillAfterStrokeEnabled
              perfectDrawEnabled={false}
            />
          )}
          {showModuleNames && l.text && (
            <Group x={l.text.x} y={l.text.y} rotation={l.text.rotation} name="module-name">
              {l.text.lines.map((line, i) => (
                <Text
                  key={i}
                  y={i * l.text!.fontPx}
                  width={l.text!.width}
                  align="center"
                  wrap="none"
                  text={line}
                  fontSize={l.text!.fontPx}
                  fontStyle="bold"
                  fontFamily={MAP_FONT_STACK}
                  fill={l.nameFill}
                  stroke={MODULE_NAME_STROKE}
                  strokeWidth={moduleNameStrokePx(l.text!.fontPx)}
                  fillAfterStrokeEnabled
                  perfectDrawEnabled={false}
                />
              ))}
              {showsFull(l) && <FullName layout={l} />}
            </Group>
          )}
        </Group>
      ))}
    </Group>
  );
}

/**
 * A picked module: the selection's double outline (black, then the tint)
 * and see-through fill round its frame, as a picked part has
 * (selectionStyle.ts); green while a connection snap holds.
 */
function ModuleHighlight({ frame, tint, snapActive }: { frame: ModuleLabelLayout['frame']; tint: string; snapActive: boolean }) {
  const halo = selectionHalo(tint, snapActive);
  return (
    <Group name={`module-selected ${EXPORT_HIDE}`}>
      <Rect {...frame} stroke={SELECTION.partOuter} strokeWidth={SELECTION.partOuterWidth} strokeScaleEnabled={false} perfectDrawEnabled={false} />
      <Rect {...frame} stroke={halo.stroke} strokeWidth={SELECTION.partInnerWidth} fill={halo.fill} strokeScaleEnabled={false} perfectDrawEnabled={false} />
    </Group>
  );
}

/** The whole name in a dark pill over the shortened one. */
function FullName({ layout }: { layout: ModuleLabelLayout }) {
  const text = layout.text!;
  const name = moduleHoverName(layout) ?? layout.name;
  const pill = moduleFullNamePill(text, name, measureBold);
  return (
    <Group name={`module-full-name ${EXPORT_HIDE}`}>
      <Rect
        x={pill.x}
        y={pill.y}
        width={pill.width}
        height={pill.height}
        cornerRadius={pill.height / 2}
        fill={MODULE_FULL_NAME_BG}
        perfectDrawEnabled={false}
      />
      <Text
        x={pill.textX}
        y={pill.textY}
        text={name}
        wrap="none"
        fontSize={text.fontPx}
        fontStyle="bold"
        fontFamily={MAP_FONT_STACK}
        fill={layout.nameFill}
        perfectDrawEnabled={false}
      />
    </Group>
  );
}
