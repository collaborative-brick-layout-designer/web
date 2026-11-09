import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, spriteUrlFor, type CustomPartSummary, type PartWire } from '../api';
import { ensureSetThumbnail, getSetThumbnailSync } from './render/setThumbnail';
import { indexParts } from './partIndex';
import type { BbmMap } from '@cld/model';
import { countUsage, effectiveLimit } from './budgetUsage';
import { useEditorStore } from './editorStore';
import { UploadPartDialog } from '../parts/UploadPartDialog';
import { CatalogPartsDialog } from '../catalog/CatalogPartsDialog';
import { IconSizeSlider, tileMinWidth, useListIconSize, useResizeGestures } from './listIconSize';
import { RenameDialog } from '../ui/RenameDialog';
import { confirmDelete, toastDeleted } from '../ui/ConfirmDialog';
import { SET_DELETE_WORDING } from '../ui/deleteWording';
import { renameSet } from '../parts/setActions';
import { HelpButton } from '../help/HelpButton';
import { hiddenPartNotice, partsInSet, useShowHiddenParts } from './hiddenParts';

interface PartContextMenu {
  part: PartWire;
  x: number;
  y: number;
}

const ALL_CATEGORIES = '__all__';


/**
 * The parts list. Memoized: it can hold thousands of pictures, and a click on
 * the map (which react-konva renders synchronously, inside the mouse event)
 * re-rendered all of them, long enough on a slow machine that a quick
 * double-click's second press came too late to count.
 */
export const PartsPanel = memo(function PartsPanel({
  onPlacePart,
  budgetLimits,
  map,
  canUploadPart = false,
  mapEmpty = false,
}: {
  onPlacePart: (part: PartWire) => void;
  /** Nothing on the map yet: one click on a part adds it (later, a click picks and a double-click adds). */
  mapEmpty?: boolean;
  /** Offer "Upload part…" (signed in, not a demo account). */
  canUploadPart?: boolean;
  /** The layout's budget; without limits there is no budget to show or filter by. */
  budgetLimits?: ReadonlyMap<string, number>;
  map?: BbmMap | null;
}) {
  // Budget → Show Only Budgeted Parts / Show Budget Numbers
  // (PartsBrowser.cpp refreshBudget / applyFilter).
  const showOnlyBudgeted = useEditorStore((s) => s.showOnlyBudgetedParts);
  const showNumbers = useEditorStore((s) => s.showBudgetNumbers);
  const defaultInfinite = useEditorStore((s) => s.budgetDefaultInfinite);
  const hasBudget = (budgetLimits?.size ?? 0) > 0;
  const [selectedTile, setSelectedTile] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [fromCatalog, setFromCatalog] = useState(false);
  const catalogSettings = useQuery({ queryKey: ['catalog-settings'], queryFn: api.catalog.settings, staleTime: 60_000 });
  const usage = useMemo(() => (hasBudget && showNumbers ? countUsage(map) : null), [hasBudget, showNumbers, map]);
  const [ctxMenu, setCtxMenu] = useState<PartContextMenu | null>(null);
  const [renaming, setRenaming] = useState<CustomPartSummary | null>(null);
  const qc = useQueryClient();
  // Your custom parts, with your role on each: a set you made can be renamed or deleted here.
  const mine = useQuery({ queryKey: ['custom-parts'], queryFn: api.customParts.list, enabled: canUploadPart });
  const ownSet = (p: PartWire): CustomPartSummary | undefined =>
    p.source === 'custom' && p.kind === 'group' && p.noSprite
      ? mine.data?.parts.find((c) => c.id === p.customPartId && (c.role === 'owner' || c.role === 'editor'))
      : undefined;
  const changedParts = () =>
    Promise.all([qc.invalidateQueries({ queryKey: ['custom-parts'] }), qc.invalidateQueries({ queryKey: ['parts-catalog'] })]);
  const menuRef = useRef<HTMLDivElement>(null);
  // Picture size: the slider, Ctrl/⌘ + wheel or a pinch over the list.
  const [iconSize, setIconSize] = useListIconSize();
  const listRef = useRef<HTMLDivElement>(null);
  useResizeGestures(listRef, iconSize, setIconSize);

  useEffect(() => {
    if (!ctxMenu) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [ctxMenu]);

  const { data, isLoading } = useQuery({
    queryKey: ['parts-catalog'],
    queryFn: api.parts.catalog,
    staleTime: 60 * 1000,
    refetchOnWindowFocus: true,
  });
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  // Parts only used inside sets (<NotListedInLibrary>) are left out unless
  // asked for, or their set is opened with "Show its parts".
  const [showHidden, setShowHidden] = useShowHiddenParts();
  const [openSet, setOpenSet] = useState<PartWire | null>(null);
  // Use as Model on a map part: find it here, pick it and show it.
  const modelPart = useEditorStore((s) => s.modelPart);
  useEffect(() => {
    if (!modelPart) return;
    const hit = data?.parts.find((p) => p.key.toLowerCase() === modelPart.key.toLowerCase());
    setCategory(ALL_CATEGORIES);
    setFilter(hit?.key ?? modelPart.key);
    setSelectedTile(hit?.key ?? null);
    if (hit) {
      requestAnimationFrame(() =>
        document.querySelector(`[data-part-key="${CSS.escape(hit.key)}"]`)?.scrollIntoView({ block: 'nearest' }),
      );
    }
    // Only a new request re-runs it, not the catalog reloading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelPart]);

  // Index by lowercase key + bare partNumber so the set-thumbnail
  // compositor can resolve each subpart's metadata.
  const partsByKey = useMemo(() => {
    return indexParts(data?.parts);
  }, [data]);

  // Categories come straight from the wire's `category` field — derived
  // server-side from the parent folder of the XML, matching desktop's
  // PartsBrowser::categoryForPath (PartsBrowser.cpp:198-202).
  const categories = useMemo(() => {
    if (!data) return [];
    const set = new Set<string>();
    for (const p of data.parts) set.add(p.category || 'Other');
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [data]);

  const inOpenSet = useMemo(() => (openSet ? partsInSet(partsByKey, openSet) : null), [openSet, partsByKey]);
  const hiddenCount = useMemo(() => data?.parts.filter((p) => p.notListed).length ?? 0, [data]);

  const visible = useMemo(() => {
    if (!data) return [];
    const needle = filter.trim().toLowerCase();
    const scored: { score: number; part: PartWire }[] = [];
    for (const p of data.parts) {
      if (inOpenSet) {
        if (!inOpenSet.has(p.key)) continue;
      } else {
        if (category !== ALL_CATEGORIES && (p.category || 'Other') !== category) {
          continue;
        }
        // (A part picked with Use as Model shows, hidden or not.)
        if (p.notListed && !showHidden && p.key !== selectedTile) continue;
      }
      // Same fuzzy hay as desktop (PartsBrowser.cpp:242):
      //   "<key> <description>" lowercased.
      // A custom part's key is "custom:<id>": its number is what people know it by, as on desktop.
      const hay = (p.source === 'custom' ? `${p.partNumber} ${p.key} ${p.description}` : `${p.key} ${p.description}`).toLowerCase();
      const score = fuzzyScore(needle, hay);
      if (score <= 0) continue;
      // A part is budgeted when its limit is above 0 (BudgetSession::isBudgeted).
      if (hasBudget && showOnlyBudgeted && effectiveLimit(budgetLimits!, p.key, defaultInfinite) <= 0) continue;
      scored.push({ score, part: p });
    }
    if (needle.length === 0) {
      // Empty filter → alphabetical by key, like desktop's
      // grid_->sortItems(Qt::AscendingOrder) (PartsBrowser.cpp:353).
      scored.sort((a, b) => a.part.key.localeCompare(b.part.key));
    } else {
      // Stable sort by descending score, alphabetical tie-break by key
      // (PartsBrowser.cpp:336-341).
      scored.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return a.part.key.localeCompare(b.part.key);
      });
    }
    return scored.map((s) => s.part);
  }, [data, filter, category, hasBudget, showOnlyBudgeted, budgetLimits, defaultInfinite, inOpenSet, showHidden, selectedTile]);

  /** Place a part from the list: never one that is only used inside sets. */
  // A click that added the part (empty map): the double-click it may be
  // the start of doesn't add a second one.
  const clickPlaced = useRef<{ key: string; at: number } | null>(null);
  function place(p: PartWire) {
    if (p.notListed) {
      useEditorStore.getState().showNotice(hiddenPartNotice(p), 'error', 7000);
      return;
    }
    onPlacePart(p);
  }

  return (
    <aside className="relative flex h-full min-h-0 w-full flex-col bg-panel text-sm">
      <div className="space-y-2 border-b border-line p-2">
        <div className="flex items-center gap-2">
          <select
            aria-label="Category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-border bg-soft px-2 py-1 text-xs"
          >
            <option value={ALL_CATEGORIES}>All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <IconSizeSlider value={iconSize} onChange={setIconSize} label="Part picture size" className="w-28 shrink-0" />
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search parts (name or number)"
          aria-label="Search parts (name or number)"
          className="w-full rounded-lg border border-border bg-soft px-2 py-1 text-xs"
        />
        {openSet && (
          <div data-testid="open-set" className="flex items-center gap-2 rounded-lg bg-soft px-2 py-1 text-xs">
            <span className="min-w-0 flex-1 truncate">
              Parts in the set “{openSet.description || openSet.partNumber}”
            </span>
            <button type="button" onClick={() => setOpenSet(null)} className="font-semibold text-accent-text hover:underline">
              Back to all parts
            </button>
          </div>
        )}
        {/* One row, so a small panel still has space for the list. */}
        {(canUploadPart || (hiddenCount > 0 && !openSet)) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {canUploadPart && (
              <button
                type="button"
                onClick={() => setUploading(true)}
                className="text-xs font-semibold text-accent-text hover:underline"
              >
                Upload part…
              </button>
            )}
            {canUploadPart && catalogSettings.data?.parts && (
              <button type="button" onClick={() => setFromCatalog(true)} className="text-xs font-semibold text-accent-text hover:underline">
                From the catalog…
              </button>
            )}
            {hiddenCount > 0 && !openSet && (
              <label className="flex items-center gap-1 text-xs text-muted">
                <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
                <span>Show hidden parts ({hiddenCount})</span>
                <HelpButton helpKey="part.hidden" />
              </label>
            )}
          </div>
        )}
      </div>
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto touch-pan-y">
        {isLoading && <p className="p-3 text-xs text-muted">Loading catalog…</p>}
        {!isLoading && visible.length === 0 && (
          <p className="p-3 text-xs text-muted">No parts match this filter.</p>
        )}
        {/*
          Auto-fill the column count based on panel width — mirrors
          desktop's PartsBrowser, which uses QListView::IconMode +
          QListView::Adjust (PartsBrowser.cpp:115-117) so resizing the
          dock reflows the thumbnail grid. Each cell is a little wider
          than the picture size (space for the caption); the grid grows to
          as many full columns as the available width allows.
        */}
        <ul
          className="grid gap-1 p-2"
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileMinWidth(iconSize)}px, 1fr))` }}
        >
          {visible.map((p) => {
            // Caption + tooltip rules ported from PartsBrowser.cpp:215-228:
            //   caption: short description, else the part key
            //   tooltip: "<description>\n(<key>)", else just the key
            // Truncate captions at 27 chars + ellipsis so multi-line
            // wrapping doesn't make tiles tower over each other.
            const desc = p.description ?? '';
            const captionShort = desc.length > 28 ? desc.slice(0, 27) + '…' : desc;
            const caption = captionShort || p.key;
            const tooltip = (desc ? `${desc}\n(${p.key})` : p.key) + (p.designer ? `\nDesigned by ${p.designer.name}` : '');
            const used = usage?.get(p.key.toLowerCase())?.count ?? 0;
            const limit = usage ? effectiveLimit(budgetLimits!, p.key, defaultInfinite) : -1;
            const over = usage !== null && limit >= 0 && used > limit;
            return (
              <li key={p.key}>
                <button
                  // Like desktop's parts browser (QListWidget::itemActivated,
                  // PartsBrowser.cpp:145): a click picks the tile, a
                  // double-click or Enter adds the part to the map.
                  aria-pressed={selectedTile === p.key}
                  data-part-key={p.key}
                  data-hidden-part={p.notListed ? 'true' : undefined}
                  onClick={() => {
                    setSelectedTile(p.key);
                    if (mapEmpty && !p.notListed) {
                      clickPlaced.current = { key: p.key, at: performance.now() };
                      place(p);
                    }
                  }}
                  onDoubleClick={() => {
                    const c = clickPlaced.current;
                    if (c && c.key === p.key && performance.now() - c.at < 600) return;
                    place(p);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      place(p);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtxMenu({ part: p, x: e.clientX, y: e.clientY });
                  }}
                  draggable={!p.notListed}
                  onDragStart={(e) => {
                    if (p.notListed) return;
                    if (e.dataTransfer) {
                      e.dataTransfer.effectAllowed = 'copy';
                      e.dataTransfer.setData('application/x-cld-part', p.key);
                      e.dataTransfer.setData('text/plain', p.key);
                    }
                  }}
                  title={p.notListed ? `${tooltip}\nOnly used inside a set: place its set instead.` : tooltip}
                  className={`flex w-full flex-col items-center rounded-lg p-1 text-[10px] ${over ? 'bg-red-900/70 hover:bg-red-800/70' : 'bg-panel hover:bg-soft'} ${selectedTile === p.key ? 'ring-2 ring-accent' : ''} ${p.notListed ? 'opacity-60' : ''}`}
                >
                  <PartThumbnail part={p} partsByKey={partsByKey} px={iconSize} />
                  <span className="mt-1 line-clamp-2 text-center leading-tight">
                    {caption}
                  </span>
                  {p.notListed && <span className="text-[9px] italic text-muted">Only in sets</span>}
                  {usage && (
                    <span data-testid="budget-numbers" className={over ? 'font-semibold text-red-300' : 'text-muted'}>
                      {used}/{limit >= 0 ? limit : '?'}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {uploading && <UploadPartDialog onClose={() => setUploading(false)} />}
      {fromCatalog && <CatalogPartsDialog onClose={() => setFromCatalog(false)} />}
      {ctxMenu && (
        <PartContextMenuPopup
          ref={menuRef}
          menu={ctxMenu}
          onAddToMap={() => { place(ctxMenu.part); setCtxMenu(null); }}
          onShowSetParts={() => {
            setOpenSet(ctxMenu.part);
            setCtxMenu(null);
          }}
          onCopyPartNumber={() => {
            void navigator.clipboard.writeText(ctxMenu.part.partNumber);
            setCtxMenu(null);
          }}
          ownSet={ownSet(ctxMenu.part)}
          onRenameSet={(set) => {
            setRenaming(set);
            setCtxMenu(null);
          }}
          onDeleteSet={async (set) => {
            setCtxMenu(null);
            const name = set.displayName || set.partNumber;
            if (!(await confirmDelete(name, SET_DELETE_WORDING))) return;
            try {
              await api.customParts.remove(set.id);
              await changedParts();
              toastDeleted(name);
            } catch (e) {
              useEditorStore.getState().showNotice(`Could not delete the set: ${(e as Error).message}`, 'error', 7000);
            }
          }}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {renaming && (
        <RenameDialog
          heading="Rename set"
          current={renaming.displayName || renaming.partNumber}
          onSave={async (name) => {
            await renameSet(renaming, name);
            await changedParts();
          }}
          onClose={() => setRenaming(null)}
        />
      )}
    </aside>
  );
});

function PartContextMenuPopup({
  menu,
  onAddToMap,
  onShowSetParts,
  onCopyPartNumber,
  ownSet,
  onRenameSet,
  onDeleteSet,
  onClose,
  ref,
}: {
  menu: PartContextMenu;
  onAddToMap: () => void;
  /** A set: show the parts in it, hidden ones too. */
  onShowSetParts: () => void;
  onCopyPartNumber: () => void;
  /** A set you made (or may edit): it can be renamed, and by its owner deleted. */
  ownSet: CustomPartSummary | undefined;
  onRenameSet: (set: CustomPartSummary) => void;
  onDeleteSet: (set: CustomPartSummary) => void;
  onClose: () => void;
  ref: React.Ref<HTMLDivElement>;
}) {
  const itemCls = 'block w-full px-3 py-1 text-left text-xs hover:bg-neutral-700 whitespace-nowrap';
  return (
    <div
      ref={ref}
      style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 9999 }}
      className="min-w-[160px] rounded-lg border border-border bg-panel py-1 shadow-lg"
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        className={itemCls + ' disabled:cursor-default disabled:opacity-40'}
        onClick={onAddToMap}
        disabled={!!menu.part.notListed}
        title={menu.part.notListed ? 'Only used inside a set: place its set instead.' : undefined}
      >
        Add to map
      </button>
      {menu.part.kind === 'group' && menu.part.subparts.length > 0 && (
        <button className={itemCls} onClick={onShowSetParts}>
          Show its parts
        </button>
      )}
      <button className={itemCls} onClick={onCopyPartNumber}>
        Copy part number
      </button>
      {ownSet && (
        <>
          <hr className="my-1 border-border" />
          <button className={itemCls} onClick={() => onRenameSet(ownSet)}>
            Rename set…
          </button>
          {ownSet.role === 'owner' && (
            <button className={itemCls + ' text-danger'} onClick={() => onDeleteSet(ownSet)}>
              Delete set…
            </button>
          )}
        </>
      )}
      <hr className="my-1 border-border" />
      <button className={itemCls + ' text-muted'} onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}

/**
 * Subsequence-based fuzzy match — direct port of desktop's
 * PartsBrowser::fuzzyScore (PartsBrowser.cpp:62-94). Every char of
 * `needle` must appear in `hay` in order. Returns 0 = no match.
 *
 * Scoring (matches desktop exactly):
 *   - +10 per matched char, +5 extra per consecutive run
 *   - +15 if the first hit is at position 0
 *   - −min(firstHit, 10) penalty for skipping over leading text
 *   - −min(spread, 10) penalty for spread-out matches
 *   - empty needle → 1 (everything visible, matches desktop)
 */
/**
 * Renders the thumbnail for a part tile (48×48 unless sized). For leaf parts this is
 * just the catalog sprite. For groups (`.set` parts) we either:
 *   - use the pre-rendered `.set.gif` if BlueBrickParts shipped one, or
 *   - synthesise a composite via `ensureSetThumbnail` from the
 *     subparts' images, matching the original BlueBrick C# behaviour
 *     at BrickLibrary.cs:1554-1672.
 *
 * Synthesis is async (subpart sprites must load); we re-render once
 * the data URL becomes available.
 */
export function PartThumbnail({
  part,
  partsByKey,
  imgCls = 'h-12 w-12',
  px,
}: {
  part: PartWire;
  partsByKey: Map<string, PartWire>;
  imgCls?: string;
  /** Exact size in CSS px (the Parts list's slider); overrides the size in `imgCls`. */
  px?: number;
}) {
  const directUrl = spriteUrlFor(part);
  const [synthUrl, setSynthUrl] = useState<string | null>(() =>
    !directUrl && part.kind === 'group' ? getSetThumbnailSync(part.key) : null,
  );

  useEffect(() => {
    if (directUrl) return;
    if (part.kind !== 'group') return;
    if (synthUrl) return;
    let cancelled = false;
    void ensureSetThumbnail(part, partsByKey).then((u) => {
      if (!cancelled) setSynthUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [directUrl, part, partsByKey, synthUrl]);

  const url = directUrl || synthUrl;
  const cls = px === undefined ? imgCls : '';
  const box = px === undefined ? undefined : { width: px, height: px };
  if (url) {
    // The full sprite, never a downsized copy. One much smaller than the
    // box (an 8 px/stud BlueBrick GIF shown big) is scaled up in crisp
    // pixels rather than blurred.
    const natural = part.spriteSize ? Math.max(part.spriteSize.w, part.spriteSize.h) : 0;
    const crisp = px !== undefined && natural > 0 && natural * 1.5 < px * (globalThis.devicePixelRatio || 1);
    return (
      <img
        src={url}
        alt=""
        className={`${cls} object-contain`}
        style={crisp ? { ...box, imageRendering: 'pixelated' } : box}
        data-crisp={crisp || undefined}
        loading="lazy"
        decoding="async"
      />
    );
  }
  return <div className={`${cls} rounded-lg bg-soft`} style={box} />;
}

export function fuzzyScore(needle: string, hay: string): number {
  if (needle.length === 0) return 1;
  let hi = 0;
  let score = 0;
  let consecutive = 0;
  let firstHit = -1;
  let lastHit = -1;
  for (let n = 0; n < needle.length; n++) {
    const nc = needle[n];
    let matched = false;
    while (hi < hay.length) {
      if (hay[hi] === nc) {
        if (firstHit < 0) firstHit = hi;
        consecutive = lastHit === hi - 1 ? consecutive + 1 : 0;
        lastHit = hi;
        score += 10 + consecutive * 5;
        if (hi === 0) score += 15;
        hi += 1;
        matched = true;
        break;
      }
      hi += 1;
    }
    if (!matched) return 0;
  }
  const spread = lastHit - firstHit - (needle.length - 1);
  if (firstHit > 0) score -= Math.min(firstHit, 10);
  score -= Math.min(spread, 10);
  return Math.max(score, 1);
}
