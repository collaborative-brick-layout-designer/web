// The editor's pop-up notice (editorStore.showNotice): a results message
// over the bottom of the map, so a download or a save is never silent.

import { useEditorStore } from './editorStore';

/** `lifted`: editing by touch, so it sits above the touch bar instead of over its buttons. */
export function NoticeToast({ lifted = false }: { lifted?: boolean } = {}) {
  const notice = useEditorStore((s) => s.notice);
  const dismiss = useEditorStore((s) => s.dismissNotice);
  return (
    <div
      role={notice?.kind === 'error' ? 'alert' : 'status'}
      aria-live={notice?.kind === 'error' ? 'assertive' : 'polite'}
      data-testid="notice-area"
      className={`notice-dock pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4 ${lifted ? 'bottom-36' : 'bottom-12'}`}
    >
      {notice && (
        <div
          key={notice.id}
          data-testid="notice"
          data-kind={notice.kind}
          className={`pointer-events-auto flex max-w-lg items-center gap-3 rounded-card border px-4 py-3 text-sm shadow-lg ${
            notice.kind === 'error' ? 'border-danger bg-panel text-ink' : 'border-line bg-panel text-ink'
          }`}
        >
          {notice.kind === 'busy' ? (
            <span aria-hidden className="size-4 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          ) : notice.kind === 'done' ? (
            <svg aria-hidden viewBox="0 0 20 20" className="size-5 shrink-0 text-ok" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M4 10.5l4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg aria-hidden viewBox="0 0 20 20" className="size-5 shrink-0 text-danger" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M10 5v6M10 14.5v.5" strokeLinecap="round" />
            </svg>
          )}
          <span>{notice.text}</span>
          {notice.action && (
            <button
              type="button"
              data-testid="notice-action"
              onClick={() => {
                notice.action?.run();
                dismiss();
              }}
              className="shrink-0 rounded-control bg-accent px-3 py-1 font-semibold text-accent-ink hover:bg-accent-hover"
            >
              {notice.action.label}
            </button>
          )}
          {notice.kind !== 'busy' && (
            <button type="button" onClick={dismiss} aria-label="Close" className="-mr-1 ml-1 rounded-control px-1.5 text-muted hover:bg-soft hover:text-ink">
              ×
            </button>
          )}
        </div>
      )}
    </div>
  );
}
