// "Budget reached" box shown when "Stop at the budget limits" refuses a part —
// port of MapView::reportBudgetRefusal (MapView.cpp:1675-1690), with its
// "don't show again" check box (`general/warnBudgetLimitation`).

import { useState } from 'react';
import { useEditorStore } from './editorStore';
import { useEscape } from './useEscape';

export const BUDGET_REFUSED_STATUS = 'Budget reached: part not added';

export function BudgetReachedDialog({ onClose }: { onClose: () => void }) {
  useEscape(onClose);
  const setWarn = useEditorStore((s) => s.setWarnBudgetLimitation);
  const [dontShow, setDontShow] = useState(false);
  const close = () => {
    if (dontShow) setWarn(false);
    onClose();
  };
  return (
    <div role="dialog" aria-modal="true" aria-label="Budget reached" className="fixed inset-0 z-50 grid place-items-center bg-black/60" onClick={close}>
      <div onClick={(e) => e.stopPropagation()} className="w-lg rounded-lg border border-line bg-panel p-5 shadow-xl">
        <h2 className="text-base font-semibold text-danger">Budget reached</h2>
        <p className="mt-3 text-sm text-neutral-300">
          This part wasn’t added: the layout already has as many as its budget allows. To add it, raise its limit in
          Budget › Edit budget…, or turn off Budget › Stop at the budget limits.
        </p>
        <label className="mt-4 flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
          Don't show this message again
        </label>
        <div className="mt-4 flex justify-end">
          <button autoFocus onClick={close} className="rounded-lg bg-accent text-accent-ink px-3 py-1 text-sm hover:bg-accent-hover">
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
