// The website places a server's custom part as "custom:<id>" (its catalog
// key, which can't collide with a bundled part). A file made for BlueBrick
// or the desktop app names it by its part number instead.
import { inArray } from 'drizzle-orm';
import type { BbmMap } from '@cld/model';
import { db, schema } from '../db/index.js';
import { resolveResourceRole } from '../access/resolveResourceRole.js';

/**
 * Whose parts a file may be named with: a person (parts they own or that
 * are shared with them) and/or a club (its parts). Global parts always.
 * Any other "custom:<id>" stays as it is.
 */
export interface PartViewer {
  userId?: string | null;
  orgId?: string | null;
}

const PREFIX = 'custom:';

function customId(partNumber: string | undefined | null): string | null {
  return partNumber && partNumber.toLowerCase().startsWith(PREFIX) ? partNumber.slice(PREFIX.length).toLowerCase() : null;
}

/**
 * The map with every "custom:<id>" brick and group named by that part's
 * number, for the parts `viewer` may see. Leaves `map` as it is.
 */
/** The part numbers of the custom parts `ids` names that `viewer` may see, by lower-case id. */
async function customNumbers(ids: Set<string>, viewer: PartViewer): Promise<Map<string, string>> {
  if (ids.size === 0) return new Map();
  const rows = await db
    .select({
      id: schema.customParts.id,
      partNumber: schema.customParts.partNumber,
      isGlobal: schema.customParts.isGlobal,
      ownerUserId: schema.customParts.ownerUserId,
      ownerOrgId: schema.customParts.ownerOrgId,
    })
    .from(schema.customParts)
    .where(inArray(schema.customParts.id, [...ids]))
    .all();
  const seen: typeof rows = [];
  for (const r of rows) {
    if (
      r.isGlobal ||
      (viewer.userId && r.ownerUserId === viewer.userId) ||
      (viewer.orgId && r.ownerOrgId === viewer.orgId) ||
      (viewer.userId && (await resolveResourceRole(viewer.userId, 'custom_part', r.id)).role !== null)
    ) {
      seen.push(r);
    }
  }
  return new Map(seen.map((r) => [r.id.toLowerCase(), r.partNumber]));
}

export async function withCustomPartNumbers(map: BbmMap, viewer: PartViewer): Promise<BbmMap> {
  const ids = new Set<string>();
  for (const layer of map.layers) {
    if (layer.type !== 'brick') continue;
    for (const b of layer.bricks) {
      const id = customId(b.partNumber);
      if (id) ids.add(id);
    }
    for (const g of layer.groups) {
      const id = customId(g.partNumber);
      if (id) ids.add(id);
    }
  }
  if (ids.size === 0) return map;
  const numbers = await customNumbers(ids, viewer);
  const named = (p: string) => {
    const id = customId(p);
    return (id && numbers.get(id)) || p;
  };
  return {
    ...map,
    layers: map.layers.map((layer) =>
      layer.type !== 'brick'
        ? layer
        : {
            ...layer,
            bricks: layer.bricks.map((b) => (customId(b.partNumber) ? { ...b, partNumber: named(b.partNumber) } : b)),
            groups: layer.groups.map((g) => (g.partNumber && customId(g.partNumber) ? { ...g, partNumber: named(g.partNumber) } : g)),
          },
    ),
  };
}

/**
 * The sidecar's engines and cars drawn with a server custom part (an
 * imported model's, trains design Phase 6) named by that part's number in
 * their look and model, as the map's parts are, for the parts `viewer` may
 * see. Changes `sidecar` (the JSON as written) in place.
 */
export async function stockWithCustomPartNumbers(sidecar: Record<string, unknown>, viewer: PartViewer): Promise<void> {
  const stock = Array.isArray(sidecar.rollingStock) ? (sidecar.rollingStock as Record<string, unknown>[]) : [];
  const holders = stock.flatMap((s) => [s?.look, s?.model]).filter((h): h is Record<string, unknown> => !!h && typeof h === 'object');
  const ids = new Set<string>();
  for (const h of holders) {
    const id = typeof h.partKey === 'string' ? customId(h.partKey) : null;
    if (id) ids.add(id);
  }
  const numbers = await customNumbers(ids, viewer);
  for (const h of holders) {
    const id = typeof h.partKey === 'string' ? customId(h.partKey) : null;
    const n = id ? numbers.get(id) : undefined;
    if (n) h.partKey = n;
  }
}
