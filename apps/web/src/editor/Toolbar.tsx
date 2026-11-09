import { useEffect, type ReactNode } from 'react';
import { useEditorStore, type Tool } from './editorStore';
import { isEditableTarget } from './keyboardGuard';

// Shortcut letters intentionally avoid `R` (which the canvas uses for
// "rotate selection ±90°", matching desktop MainWindowMenus.cpp:418/423)
// and `X` (commonly cut-on-other-platforms). Desktop has no equivalent
// 1-key tool switcher at all — these are a web-port convenience.
// Labels are plain words for club members; the tooltip keeps the
// shortcut.
const TOOLS: { id: Tool; label: string; hint: string; shortcut: string | null; icon: ReactNode }[] = [
  { id: 'select', label: 'Select', hint: 'Select and move pieces', shortcut: 'V', icon: <path d="M5 3l14 8-6 2-2 6z" /> },
  { id: 'paint', label: 'Paint', hint: 'Paint the ground a color', shortcut: 'B', icon: <><path d="M4 20c0-3 2-5 5-5l6-6 3 3-6 6c0 3-2 5-5 5H4z" /><path d="M14 5l2-2 5 5-2 2" /></> },
  { id: 'erase', label: 'Erase', hint: 'Erase painted ground', shortcut: 'E', icon: <><path d="M16 3l5 5-11 11H5l-2-2z" /><path d="M9 21h12" /></> },
  { id: 'rulerLinear', label: 'Measure', hint: 'Measure a straight distance', shortcut: null, icon: <><path d="M3 17L17 3l4 4L7 21z" /><path d="M8 12l2 2M11 9l2 2M14 6l2 2" /></> },
  { id: 'rulerCircular', label: 'Circle', hint: 'Measure with a circle', shortcut: null, icon: <><circle cx="12" cy="12" r="8" /><path d="M12 12h8" /></> },
  { id: 'venueOutline', label: 'Venue', hint: 'Draw the venue walls', shortcut: null, icon: <path d="M4 20V8l8-5 8 5v12z" /> },
  { id: 'venueObstacle', label: 'Obstacle', hint: 'Mark something in the venue to avoid', shortcut: null, icon: <><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M5 5l14 14" /></> },
  { id: 'rotate', label: 'Turn', hint: 'Click a piece to turn it (Shift+click turns it back)', shortcut: null, icon: <><path d="M20 12a8 8 0 11-3-6.2" /><path d="M20 4v5h-5" /></> },
  { id: 'delete', label: 'Delete', hint: 'Click pieces to remove them', shortcut: null, icon: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /> },
];

/** The tool's name as the rail shows it ("Measure", not "rulerLinear"). */
export function toolLabel(tool: Tool): string {
  return TOOLS.find((t) => t.id === tool)?.label ?? tool;
}

/** `noVenue`: the module editor (a module has no venue). */
export function Toolbar({ noVenue = false }: { noVenue?: boolean } = {}) {
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);

  // Keyboard shortcuts. Lowercase to match e.key for letter keys.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't capture when typing in an input / operating a form control.
      if (isEditableTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = TOOLS.find(
        (x) => x.shortcut !== null && x.shortcut.toLowerCase() === e.key.toLowerCase(),
      );
      if (t) {
        e.preventDefault();
        setTool(t.id);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTool]);

  // A labelled rail down the left edge (the mockup's tool rail).
  return (
    <nav aria-label="Build tools" className="flex flex-col items-center gap-1">
      {TOOLS.filter((t) => !noVenue || !t.id.startsWith('venue')).map((t) => {
        const on = tool === t.id;
        return (
          <button
            key={t.id}
            onClick={() => setTool(t.id)}
            title={t.shortcut ? `${t.hint} (${t.shortcut})` : t.hint}
            aria-pressed={on}
            data-tool={t.id}
            className={
              'flex h-[54px] w-[60px] flex-col items-center justify-center gap-0.5 rounded-card text-[11px] font-bold transition-colors ' +
              (on ? 'bg-accent-soft text-accent-text' : 'text-muted hover:bg-soft hover:text-ink')
            }
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {t.icon}
            </svg>
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}
