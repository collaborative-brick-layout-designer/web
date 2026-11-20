// The centreline through a part moved to @cld/parts-catalog (track/
// circuitPath.ts), where the track network uses it too; the electric
// overlay keeps importing it from here.
export {
  CIRCUIT_CUTTER_GAP,
  CIRCUIT_CUTTER_PEN,
  CIRCUIT_PEN_WIDTH,
  CIRCUIT_RAIL_OFFSET,
  CIRCUIT_SHORTCUT_SIZE,
  circuitPath,
  offsetPath,
  offsetPathBetween,
  pointAt,
  type CircuitPathPoint,
  type Pt,
} from '@cld/parts-catalog/browser';
