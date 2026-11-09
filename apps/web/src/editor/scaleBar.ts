// Scale-bar step — port of the lower-left scale indicator in
// MapViewPaint.cpp:195-222. Picks the track-friendly stud count whose bar
// is closest to 120 px (between 40 and 320 px) and labels it in studs and
// mm / m (1 stud = 8 mm).

const NICE_STEPS = [1, 2, 5, 10, 16, 20, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096];

export interface ScaleBar {
  studs: number;
  px: number;
  primary: string;
  secondary: string;
}

/** The scale bar for a view showing `pxPerStud` screen pixels per stud. */
export function scaleBar(pxPerStud: number): ScaleBar | null {
  if (!(pxPerStud > 0)) return null;
  let studs = 32;
  let best = Infinity;
  for (const s of NICE_STEPS) {
    const w = s * pxPerStud;
    if (w < 40 || w > 320) continue;
    const dev = Math.abs(w - 120);
    if (dev < best) {
      best = dev;
      studs = s;
    }
  }
  const mm = studs * 8;
  return {
    studs,
    px: studs * pxPerStud,
    primary: `${studs} ${studs === 1 ? 'stud' : 'studs'}`,
    secondary: mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${mm} mm`,
  };
}

/** A size for the status bar: meters from 100 studs (1 stud = 8 mm), whole
 *  studs as they are, anything else to one place ("37.0 st", never
 *  "36.974999999999994 st"). */
export function studDisplay(studs: number): string {
  if (studs >= 100) return `${(studs * 0.008).toFixed(1)} m`;
  return Number.isInteger(studs) ? `${studs} st` : `${studs.toFixed(1)} st`;
}
