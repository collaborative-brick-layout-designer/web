// Lengths in the Venue Designer: typed in feet and inches the way people
// write them on a sketch (12'6", 40′ 4″, 129, 6 1/2"), or metric, or studs;
// shown back in the chosen unit. Venues store studs (1 stud = 8 mm).
// The desktop's venue/Units.cpp is the twin of this file.

import type { VenueLengthUnit } from '@cld/bbm';

export const STUDS_PER_INCH = 38.09814081 / 12;
export const STUDS_PER_MM = 1 / 8;

/** The unit lengths are typed and shown in; a venue remembers its own (`lengthUnit`, read with `venueLengthUnit`). */
export type LengthUnit = VenueLengthUnit;

const num = String.raw`(\d+(?:\.\d+)?)`;
const frac = String.raw`(?:\s+(\d+)\/(\d+))?`;

/**
 * Studs for a typed length, or null when it isn't one. Feet and inches:
 * `12'6"`, `12' 6 1/2"`, `12ft 6in`, `12.5'`, `6"`. Metric: `3.2m`,
 * `320cm`, `3200mm`. Studs: `80 studs`, `80st`. A bare number is inches
 * in feet-and-inches mode (sketches are measured in inches), metres in
 * metric mode, studs in stud mode.
 */
export function parseLength(text: string, unit: LengthUnit = 'ftin'): number | null {
  const t = text.trim().toLowerCase().replace(/[′’]/g, "'").replace(/[″”]/g, '"').replace(/\s+/g, ' ');
  if (!t) return null;

  const metric = new RegExp(`^${num}\\s*(mm|cm|m)$`).exec(t);
  if (metric) {
    const mm = parseFloat(metric[1]!) * (metric[2] === 'm' ? 1000 : metric[2] === 'cm' ? 10 : 1);
    return mm * STUDS_PER_MM;
  }
  const studs = new RegExp(`^${num}\\s*(studs?|st)$`).exec(t);
  if (studs) return parseFloat(studs[1]!);

  // feet [inches] with ' / ft / feet and " / in / inch(es)
  const ftin = new RegExp(`^(?:${num}\\s*(?:'|ft|feet|foot))?\\s*(?:${num}${frac}\\s*(?:"|in|inch|inches))?$`).exec(t);
  if (ftin && (ftin[1] !== undefined || ftin[2] !== undefined)) {
    const feet = ftin[1] ? parseFloat(ftin[1]) : 0;
    let inches = ftin[2] ? parseFloat(ftin[2]) : 0;
    if (ftin[3] && ftin[4]) {
      const d = parseInt(ftin[4], 10);
      if (d === 0) return null;
      inches += parseInt(ftin[3], 10) / d;
    }
    return (feet * 12 + inches) * STUDS_PER_INCH;
  }
  // feet then a bare inch count: 12' 6, 12'6 1/2
  const feetBare = new RegExp(`^${num}\\s*'\\s*${num}${frac}$`).exec(t);
  if (feetBare) {
    let inches = parseFloat(feetBare[2]!);
    if (feetBare[3] && feetBare[4]) {
      const d = parseInt(feetBare[4], 10);
      if (d === 0) return null;
      inches += parseInt(feetBare[3], 10) / d;
    }
    return (parseFloat(feetBare[1]!) * 12 + inches) * STUDS_PER_INCH;
  }
  const bare = new RegExp(`^${num}${frac}$`).exec(t);
  if (bare) {
    let v = parseFloat(bare[1]!);
    if (bare[2] && bare[3]) {
      const d = parseInt(bare[3], 10);
      if (d === 0) return null;
      v += parseInt(bare[2], 10) / d;
    }
    if (unit === 'm') return v * 1000 * STUDS_PER_MM;
    if (unit === 'studs') return v;
    return v * STUDS_PER_INCH;
  }
  return null;
}

const FRACTIONS = ['', '¼', '½', '¾'];

/** A length for display: 12′ 6½″ (to the quarter inch), 3.81 m, or 145 studs. */
export function formatLength(studs: number, unit: LengthUnit = 'ftin'): string {
  if (unit === 'm') return `${((studs / STUDS_PER_MM) / 1000).toFixed(2)} m`;
  if (unit === 'studs') return `${Math.round(studs * 10) / 10} studs`;
  const quarters = Math.round((Math.abs(studs) / STUDS_PER_INCH) * 4);
  const sign = studs < 0 && quarters > 0 ? '−' : '';
  const feet = Math.floor(quarters / 48);
  const rest = quarters - feet * 48;
  const inches = Math.floor(rest / 4);
  const q = FRACTIONS[rest % 4]!;
  if (feet === 0) return `${sign}${inches}${q}″`;
  return `${sign}${feet}′ ${inches}${q}″`;
}

/** A floor area (square studs) in the chosen unit: "1,234 sq ft", "114.6 m²", "12,000 square studs". */
export function formatArea(squareStuds: number, unit: LengthUnit = 'ftin'): string {
  if (unit === 'm') {
    const m2 = squareStuds / (STUDS_PER_MM * STUDS_PER_MM) / 1_000_000;
    return `${(Math.round(m2 * 10) / 10).toLocaleString()} m²`;
  }
  if (unit === 'studs') return `${Math.round(squareStuds).toLocaleString()} square studs`;
  const ft = 12 * STUDS_PER_INCH;
  return `${Math.round(squareStuds / (ft * ft)).toLocaleString()} sq ft`;
}

/** Degrees clockwise from east, as shown next to the cursor (0–359). */
export function formatAngle(deg: number): string {
  return `${((Math.round(deg) % 360) + 360) % 360}°`;
}
