// The fit checks as a list (trains design 3.5, 6.2): each one a sentence,
// marked as a problem (red) or a warning (amber), with Show me, which brings
// the spot into view on the map. Nothing is blocked: they're there to read.
// The desktop's ui/FitChecksList.cpp is the twin.

import type { FitCheck } from '@cld/parts-catalog/browser';
import { useLengthUnit } from '../theme/PrefsProvider';
import { HelpButton } from '../help/HelpButton';
import { checkText, showSpot, type namesOf } from './fitChecks';

interface Props {
  checks: readonly FitCheck[];
  names: ReturnType<typeof namesOf>;
  /** Said when there are none. */
  allClear: string;
  title?: string;
}

export function FitChecksList({ checks, names, allClear, title = 'Checks' }: Props) {
  const unit = useLengthUnit();
  return (
    <section aria-label={title} data-testid="fit-checks" className="flex flex-col gap-1 rounded-card border border-line bg-panel p-2">
      <div className="flex items-center gap-1 text-xs font-semibold">
        {title}
        {checks.length > 0 && (
          <span data-testid="fit-checks-count" className="rounded-full bg-amber-100 px-1.5 text-[11px] text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            {checks.length}
          </span>
        )}
        <HelpButton helpKey="trains.checks" />
      </div>
      {checks.length === 0 ? (
        <p className="text-xs text-muted" data-testid="fit-checks-clear">
          {allClear}
        </p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label={`${title}: what to look at`}>
          {checks.map((c) => (
            <li key={c.key} data-check={c.kind} className="flex items-start gap-2 text-xs">
              <span
                aria-label={c.severity === 'error' ? 'Problem' : 'Warning'}
                className={`mt-1 h-2 w-2 shrink-0 rounded-full ${c.severity === 'error' ? 'bg-red-600' : 'bg-amber-500'}`}
              />
              <span className="min-w-0 flex-1">{checkText(c, names, unit)}</span>
              <button type="button" className="shrink-0 rounded px-1.5 py-0.5 font-semibold text-accent hover:bg-soft" onClick={() => showSpot(c.at)}>
                Show me
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
