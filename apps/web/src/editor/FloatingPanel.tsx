// FloatingPanel — a free-floating panel window rendered into document.body
// via a React portal. Matches Qt's QDockWidget in "floating" mode.
//
// Draggable by the title bar; resizable by the bottom-right corner handle.
// Position and size are persisted via `setFloatPos` from `dockLayout.ts`.

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DockZone, FloatPos } from './dockLayout';
import { PANEL_HELP } from './PanelHost';
import { HelpButton } from '../help/HelpButton';

const MIN_W = 180;
const MIN_H = 120;

interface Props {
  panelId: string;
  title: string;
  pos: FloatPos;
  onMove: (panelId: string, zone: DockZone) => void;
  onPosChange: (panelId: string, pos: Partial<FloatPos>) => void;
  children: React.ReactNode;
}

export function FloatingPanel({ panelId, title, pos, onMove, onPosChange, children }: Props) {
  const frameRef = useRef<HTMLDivElement>(null);

  // ── Title-bar drag ──────────────────────────────────────────────────────
  function onTitleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX - pos.x;
    const startY = e.clientY - pos.y;

    function onMove_(ev: MouseEvent) {
      onPosChange(panelId, { x: ev.clientX - startX, y: ev.clientY - startY });
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove_);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove_);
    window.addEventListener('mouseup', onUp);
  }

  // ── Bottom-right resize handle ──────────────────────────────────────────
  function onResizeMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = pos.width;
    const startH = pos.height;

    function onMove_(ev: MouseEvent) {
      onPosChange(panelId, {
        width: Math.max(MIN_W, startW + ev.clientX - startX),
        height: Math.max(MIN_H, startH + ev.clientY - startY),
      });
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove_);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove_);
    window.addEventListener('mouseup', onUp);
  }

  const moveTargets: { zone: DockZone; label: string }[] = [
    { zone: 'left', label: 'Dock to left' },
    { zone: 'right', label: 'Dock to right' },
    { zone: 'hidden', label: 'Hide panel' },
  ];

  const panel = (
    <div
      ref={frameRef}
      data-panel={panelId}
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: pos.width,
        height: pos.height,
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        minWidth: MIN_W,
        minHeight: MIN_H,
      }}
      className="rounded-lg border border-border bg-panel shadow-2xl"
    >
      {/* Title bar */}
      <header
        onMouseDown={onTitleMouseDown}
        className="theme-chrome flex cursor-move select-none items-center justify-between border-b border-line bg-panel px-2 py-1 text-xs text-muted"
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate font-semibold uppercase tracking-wider">{title}</span>
          {PANEL_HELP[panelId] && <HelpButton helpKey={PANEL_HELP[panelId]} target={`[data-panel="${panelId}"]`} />}
        </span>
        <div className="relative flex gap-1">
          <FloatMenu targets={moveTargets} onSelect={(z) => onMove(panelId, z)} />
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => onMove(panelId, 'hidden')}
            className="rounded-lg px-1 py-0.5 text-[10px] leading-none hover:bg-soft"
            title="Close"
          >
            ✕
          </button>
        </div>
      </header>

      {/* Panel body */}
      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>

      {/* Resize handle — bottom-right corner */}
      <div
        onMouseDown={onResizeMouseDown}
        className="absolute bottom-0 right-0 h-3 w-3 cursor-se-resize"
        style={{
          backgroundImage:
            'radial-gradient(circle, #555 1px, transparent 1px)',
          backgroundSize: '4px 4px',
          backgroundPosition: '1px 1px',
        }}
      />
    </div>
  );

  return createPortal(panel, document.body);
}

function FloatMenu({
  targets,
  onSelect,
}: {
  targets: { zone: DockZone; label: string }[];
  onSelect: (zone: DockZone) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg px-1.5 py-0.5 text-[10px] hover:bg-soft"
        title="Dock or hide"
      >
        ⋯
      </button>
      {open && (
        <ul
          className="absolute right-0 top-full z-20 mt-1 w-36 rounded-lg border border-border bg-panel text-xs shadow-sm"
          onClick={() => setOpen(false)}
        >
          {targets.map((t) => (
            <li key={t.zone}>
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => onSelect(t.zone)}
                className="block w-full px-2 py-1 text-left hover:bg-soft"
              >
                {t.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

