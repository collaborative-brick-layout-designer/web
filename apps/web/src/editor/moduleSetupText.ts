// What a module's table and power (@cld/modules setup.ts) read as: in the
// Modules panel, the Module library and the layout's summary for its
// coordinator. Heights are typed and shown in the length unit (inches,
// centimeters or studs: the account's length unit, Settings › Units). The desktop's ui/ModuleSetupText.cpp says the same.

import type { VenueLengthUnit } from '@cld/bbm';
import {
  MAX_HEIGHT_MM,
  outletsOf,
  type ModulePower,
  type ModuleTable,
  type PlugSide,
  type SetupSummary,
  type TableType,
} from '@cld/modules';
import { parseLength, STUDS_PER_INCH, STUDS_PER_MM } from '../venues/designer/units';

export const TABLE_TYPE_LABEL: Record<TableType, string> = {
  mils: 'MILS',
  baseplate: 'Plain baseplate',
  custom: 'Custom',
};

export const TABLE_TYPE_HINT: Record<TableType, string> = {
  mils: 'A MILS module: its own legs or table, to the MILS height.',
  baseplate: 'Loose baseplates laid on an ordinary table.',
  custom: 'Any other table or stand.',
};

export const PLUG_SIDE_LABEL: Record<PlugSide, string> = {
  front: 'At the front',
  back: 'At the back',
  left: 'On the left',
  right: 'On the right',
};

/**
 * A height in mm for what someone typed, or null. Inches by default in
 * feet and inches (`30 3/4`, `32"`, `2' 8"`), centimeters for a bare
 * number in metric (`78`, also `780 mm`, `0.78 m`), studs in studs.
 */
export function parseHeightMm(text: string, unit: VenueLengthUnit): number | null {
  const t = text.trim();
  if (!t) return null;
  const bare = /^\d+(?:\.\d+)?$/.test(t);
  const studs = unit === 'm' && bare ? parseLength(`${t}cm`, unit) : parseLength(t, unit);
  if (studs === null || !Number.isFinite(studs)) return null;
  const mm = Math.round((studs / STUDS_PER_MM) * 10) / 10;
  return mm > 0 && mm <= MAX_HEIGHT_MM ? mm : null;
}

const FRACTIONS = ['', '¼', '½', '¾'];

/** A height for display: 30¾″ (inches, to the quarter), 78.1 cm, or 97.6 studs. */
export function formatHeight(mm: number, unit: VenueLengthUnit): string {
  if (unit === 'm') return `${(Math.round(mm) / 10).toFixed(1)} cm`;
  const studs = mm * STUDS_PER_MM;
  if (unit === 'studs') return `${Math.round(studs * 10) / 10} studs`;
  const quarters = Math.round((studs / STUDS_PER_INCH) * 4);
  return `${Math.floor(quarters / 4)}${FRACTIONS[quarters % 4]}″`;
}

/** "MILS · 30¾″", "Custom · 32″ to the rails", "Plain baseplate". */
export function tableText(t: ModuleTable, unit: VenueLengthUnit): string {
  const label = TABLE_TYPE_LABEL[t.type];
  if (t.heightMm === undefined) return label;
  return `${label} · ${formatHeight(t.heightMm, unit)}${t.measuredTo === 'rail' ? ' to the rails' : ''}`;
}

/** "No power", "Power: 2 outlets, ~60 W, plug at the back". */
export function powerText(p: ModulePower): string {
  if (!p.needed) return 'No power';
  const n = outletsOf(p);
  const parts = [`${n} outlet${n === 1 ? '' : 's'}`];
  if (p.watts) parts.push(`~${p.watts} W`);
  if (p.plugSide) parts.push(`plug at the ${p.plugSide}`);
  return `Power: ${parts.join(', ')}`;
}

/** The summary's power line: "Power: 7 modules need 11 outlets, ~450 W". */
export function summaryPowerText(s: SetupSummary): string {
  const p = s.power;
  const notSet = p.notSet ? ` (not set for ${p.notSet})` : '';
  if (p.modules === 0) return p.noPower ? `Power: none needed${notSet}` : 'Power: not set for any module';
  const watts = p.watts ? `, ~${p.watts} W` : '';
  const mods = `${p.modules} module${p.modules === 1 ? '' : 's'}`;
  return `Power: ${mods} need${p.modules === 1 ? 's' : ''} ${p.outlets} outlet${p.outlets === 1 ? '' : 's'}${watts}${notSet}`;
}

/** The summary's table lines, one per type: "MILS: 4 — 30¾″ (2), 32″ to the rails (1)". */
export function summaryTableLines(s: SetupSummary, unit: VenueLengthUnit): string[] {
  const lines = s.tables.map((g) => {
    const heights = g.heights.map((h) => `${formatHeight(h.heightMm, unit)}${h.measuredTo === 'rail' ? ' to the rails' : ''} (${h.count})`);
    return `${TABLE_TYPE_LABEL[g.type]}: ${g.count}${heights.length ? ` — ${heights.join(', ')}` : ''}`;
  });
  if (s.tablesNotSet && s.tables.length) lines.push(`Table not set: ${s.tablesNotSet}`);
  return lines;
}
