// Budget usage against limits. Part ids are case-insensitive, like
// desktop Budget.cpp (it keys budgets by the upper-cased id). The limits
// keep the case they were entered or opened with, so a `.bbb` saves back
// unchanged; every lookup here folds case.

import type { BbmMap } from '@cld/model';
import type { PartWire } from '../api';
import { libraryItems, subpartOf } from './sets';

const fold = (part: string) => part.toLowerCase();

export interface BudgetRow {
  /** Part id as shown: the limit's own spelling, else the first placed brick's. */
  part: string;
  used: number;
  /** The limit, or undefined for no limit. */
  limit: number | undefined;
  /** Key of the limit in the limits map, when there is one. */
  limitKey: string | undefined;
}

/** Placed bricks per part, case folded: folded id → { first spelling, count }. */
export function countUsage(map: BbmMap | null | undefined): Map<string, { part: string; count: number }> {
  const usage = new Map<string, { part: string; count: number }>();
  if (!map) return usage;
  for (const layer of map.layers) {
    if (layer.type !== 'brick') continue;
    // As BlueBrick's budget: a set counts once (LibraryBrickList).
    for (const part of libraryItems(layer)) {
      const k = fold(part);
      const u = usage.get(k);
      if (u) u.count++;
      else usage.set(k, { part, count: 1 });
    }
  }
  return usage;
}

/** Folded id → [stored key, limit]. The first spelling wins if two differ only in case. */
function foldLimits(limits: ReadonlyMap<string, number>): Map<string, [string, number]> {
  const out = new Map<string, [string, number]>();
  for (const [key, limit] of limits) {
    const k = fold(key);
    if (!out.has(k)) out.set(k, [key, limit]);
  }
  return out;
}

/** The limit for `part`, matched case-insensitively. */
export function limitFor(limits: ReadonlyMap<string, number>, part: string): number | undefined {
  const direct = limits.get(part);
  if (direct !== undefined) return direct;
  return foldLimits(limits).get(fold(part))?.[1];
}

/** One row per part that is placed or has a limit, sorted by part id. */
export function budgetRows(map: BbmMap | null | undefined, limits: ReadonlyMap<string, number>): BudgetRow[] {
  const usage = countUsage(map);
  const folded = foldLimits(limits);
  const keys = new Set([...usage.keys(), ...folded.keys()]);
  return [...keys]
    .map((k) => {
      const lim = folded.get(k);
      return {
        part: lim?.[0] ?? usage.get(k)!.part,
        used: usage.get(k)?.count ?? 0,
        limit: lim?.[1],
        limitKey: lim?.[0],
      };
    })
    .sort((a, b) => (a.part < b.part ? -1 : a.part > b.part ? 1 : 0));
}

/** Number of parts placed more times than their limit allows. */
export function overBudgetCount(map: BbmMap | null | undefined, limits: ReadonlyMap<string, number>): number {
  if (limits.size === 0) return 0;
  return budgetRows(map, limits).filter((r) => r.limit !== undefined && r.used > r.limit).length;
}

/**
 * The limit that applies to `part`: its own, else unlimited (-1) or 0
 * depending on the "parts without a budget" preference (desktop
 * Budget::limit with defaultInfinite).
 */
export function effectiveLimit(limits: ReadonlyMap<string, number>, part: string, defaultInfinite: boolean): number {
  return limitFor(limits, part) ?? (defaultInfinite ? -1 : 0);
}

/** Leaf parts inside a set, counted per folded part id, nested sets expanded (desktop setLeafParts). */
export function setLeafParts(index: ReadonlyMap<string, PartWire>, part: string, outer: readonly PartWire[] = []): Map<string, number> {
  const out = new Map<string, number>();
  const meta = outer.length === 0 ? index.get(part.toLowerCase()) : outer[outer.length - 1];
  if (!meta || meta.kind !== 'group' || outer.length > 16) return out;
  const inside = outer.length === 0 ? [meta] : outer;
  for (const sp of meta.subparts) {
    const sub = subpartOf(index, sp.subKey, inside);
    if (sub && sub.kind === 'group') {
      for (const [k, n] of setLeafParts(index, sp.subKey, [...inside, sub])) out.set(k, (out.get(k) ?? 0) + n);
    } else {
      const k = fold(sp.subKey);
      out.set(k, (out.get(k) ?? 0) + 1);
    }
  }
  return out;
}

/**
 * Whether `quantity` more of `part` fit the budget (desktop
 * canAddToBudget): the part itself and, for a set, each of its leaf parts.
 * `usage` is `countUsage(map)`.
 */
export function canAddToBudget(
  limits: ReadonlyMap<string, number>,
  usage: ReadonlyMap<string, { count: number }>,
  part: string,
  quantity: number,
  defaultInfinite: boolean,
  index?: ReadonlyMap<string, PartWire>,
): boolean {
  const fits = (id: string, n: number) => {
    const limit = effectiveLimit(limits, id, defaultInfinite);
    return limit < 0 || (usage.get(fold(id))?.count ?? 0) + n <= limit;
  };
  if (!fits(part, quantity)) return false;
  if (index) for (const [leaf, n] of setLeafParts(index, part)) if (!fits(leaf, n)) return false;
  return true;
}

/**
 * Paste / duplicate under Use Budget Limitation (MapViewClipboard.cpp:84-95):
 * walking the bricks in order, keep each one that still fits and leave
 * the rest out. Returns which to keep and how many were refused.
 */
export function withinBudget<T>(
  limits: ReadonlyMap<string, number>,
  map: BbmMap | null | undefined,
  bricks: readonly T[],
  partOf: (brick: T) => string,
  defaultInfinite: boolean,
): { kept: T[]; refused: number } {
  const used = new Map([...countUsage(map)].map(([k, u]) => [k, u.count]));
  const kept: T[] = [];
  let refused = 0;
  for (const b of bricks) {
    const part = partOf(b);
    const k = fold(part);
    const limit = effectiveLimit(limits, part, defaultInfinite);
    if (limit >= 0 && (used.get(k) ?? 0) + 1 > limit) {
      refused++;
      continue;
    }
    used.set(k, (used.get(k) ?? 0) + 1);
    kept.push(b);
  }
  return { kept, refused };
}

/**
 * `next`, or `kept` when it has the same limit for each part: the budget is
 * read again on every change to the map (anyone's move), and a new Map each
 * time re-rendered the Parts list's every picture (about a thousand).
 */
export function sameBudgetOr<M extends ReadonlyMap<string, number>>(kept: M, next: M): M {
  if (kept === next || kept.size !== next.size) return next;
  for (const [part, limit] of next) if (kept.get(part) !== limit) return next;
  return kept;
}
