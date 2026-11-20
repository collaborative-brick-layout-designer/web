// The track network of a map: its brick layers' bricks, with where their
// connections are (connectivity.ts connectionPoints, the same points links
// are made from).

import type { BbmMap } from '@cld/model';
import { connectionPoints } from '../connectivity.js';
import type { PartMetadata } from '../types.js';
import { TrackNetwork, type TrackBrickInput } from './network.js';
import type { TrackConn } from './partTrack.js';

const convCache = new WeakMap<PartMetadata, TrackConn[]>();

/** A part's connections as the track reads them. */
export function trackConns(meta: PartMetadata): TrackConn[] {
  let out = convCache.get(meta);
  if (!out) {
    out = meta.connections.map((c) => ({ type: c.type, x: c.x, y: c.y, angle: c.angle, plug: c.electricPlug }));
    convCache.set(meta, out);
  }
  return out;
}

/** The bricks of every brick layer, as the network reads them. */
export function trackBricks(map: BbmMap, lookup: (partNumber: string) => PartMetadata | undefined): TrackBrickInput[] {
  const out: TrackBrickInput[] = [];
  for (const layer of map.layers) {
    if (layer.type !== 'brick') continue;
    for (const b of layer.bricks) {
      const meta = lookup(b.partNumber);
      if (!meta || meta.connections.length === 0) continue;
      out.push({
        id: b.id,
        partKey: meta.key,
        conns: trackConns(meta),
        points: connectionPoints(b, meta),
        orientation: b.orientation,
        connexions: b.connexions,
      });
    }
  }
  return out;
}

/** The track network of `map`. */
export function trackNetworkOf(map: BbmMap, lookup: (partNumber: string) => PartMetadata | undefined): TrackNetwork {
  return new TrackNetwork(trackBricks(map, lookup));
}

/** Every brick id on the map's brick layers. */
export function brickIdsOf(map: BbmMap): Set<string> {
  const out = new Set<string>();
  for (const layer of map.layers) if (layer.type === 'brick') for (const b of layer.bricks) out.add(b.id);
  return out;
}

/** switchStates without the keys whose brick is no longer on the map (pruned by whoever writes next). */
export function withoutGoneSwitches(states: Readonly<Record<string, number>>, bricks: ReadonlySet<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, exit] of Object.entries(states)) {
    const at = key.lastIndexOf('/');
    if (at > 0 && bricks.has(key.slice(0, at))) out[key] = exit;
  }
  return out;
}
