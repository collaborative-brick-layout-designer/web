// Settings > Color > Any LEGO color: every solid LEGO color, found by its
// LEGO or BrickLink name or number, as a list of swatches. Picking one
// themes the app at once (theme.ts works out readable shades of it).

import { useMemo, useState } from 'react';
import { LEGO_COLORS, legoColor, type LegoColor } from '@cld/model';
import { HelpButton } from '../help/HelpButton';

/** Lower case, "grey" spelled "gray", no punctuation: so "med. st grey" finds "Medium Stone Grey". */
function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/grey/g, 'gray')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Does `c` match every word of the search (by either name, or either number)? */
export function matchesLegoColor(c: LegoColor, query: string): boolean {
  const q = fold(query);
  if (!q) return true;
  const hay = ` ${fold(c.lego)} ${fold(c.bl)} `;
  return q.split(' ').every((word) =>
    /^\d+$/.test(word) ? String(c.id) === word || (c.blId > 0 && String(c.blId) === word) : hay.includes(word),
  );
}

function blText(c: LegoColor): string {
  if (!c.bl) return 'No BrickLink match';
  return c.blId > 0 ? `BrickLink: ${c.bl} (${c.blId})` : `BrickLink: ${c.bl}`;
}

export function LegoColorPicker({ value, onPick }: { value: number | null | undefined; onPick: (id: number) => void }) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => LEGO_COLORS.filter((c) => matchesLegoColor(c, query)), [query]);
  const chosen = legoColor(value);
  return (
    <div className="flex flex-col gap-3 rounded-bubble border border-line bg-soft p-3" data-testid="lego-color-picker">
      <div className="flex items-center gap-2">
        <span id="lego-color-label" className="text-[15px] font-semibold text-ink">
          Any LEGO color
        </span>
        <HelpButton helpKey="settings.legoColor" target='[data-testid="lego-color-picker"]' />
        {chosen && (
          <span className="ml-auto truncate text-sm text-muted" data-testid="lego-color-chosen">
            Now: {chosen.lego}
          </span>
        )}
      </div>
      <label className="flex flex-col gap-1 text-sm text-muted">
        Search by LEGO or BrickLink name or number
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="For example Bright Red, Dark Blue or 21"
          className="min-h-11 rounded-control border border-border bg-panel px-3 text-[15px] text-ink placeholder:text-muted"
        />
      </label>
      {shown.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted" role="status">
          No LEGO color matches “{query}”. Try a name like Bright Red, or a number like 21.
          <button type="button" onClick={() => setQuery('')} className="tap-target rounded-control border border-border bg-panel px-3 py-1 font-semibold text-ink hover:bg-line">
            Show all colors
          </button>
        </div>
      ) : (
        <>
          <span className="sr-only" role="status">
            {shown.length === LEGO_COLORS.length ? `${shown.length} colors` : `${shown.length} of ${LEGO_COLORS.length} colors`}
          </span>
          <div
            role="radiogroup"
            aria-labelledby="lego-color-label"
            className="grid max-h-80 grid-cols-1 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-2"
          >
            {shown.map((c) => {
              const on = value === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={`${c.lego} (LEGO ${c.id}), ${blText(c)}`}
                  onClick={() => onPick(c.id)}
                  className={`flex min-h-11 items-center gap-3 rounded-control bg-panel px-2 py-1.5 text-left ${on ? 'border-2 border-accent' : 'border border-line hover:border-muted'}`}
                >
                  <span aria-hidden className="h-8 w-8 shrink-0 rounded-lg border border-black/15" style={{ background: c.hex }} />
                  <span className="flex min-w-0 flex-col leading-tight">
                    <span className={`truncate text-sm ${on ? 'font-bold' : 'font-semibold'} text-ink`}>
                      {c.lego} <span className="font-normal text-muted">· {c.id}</span>
                    </span>
                    <span className="truncate text-xs text-muted">
                      {blText(c)}
                      {c.kind === 'pearl' ? ' · pearl, shown flat' : ''}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
