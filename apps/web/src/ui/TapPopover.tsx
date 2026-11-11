// A small box of words under a button, for things a mouse shows on hover
// (a `title`) and a finger can't reach: who is here, why a layout is view
// only. Portalled to <body> and kept on the screen; a tap outside or Esc
// closes it and focus goes back to the button.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

const EDGE = 8;
const GAP = 8;

interface Props {
  /** The button it belongs to. */
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Read out as the box's name. */
  label: string;
  testId?: string;
  children: ReactNode;
}

export function TapPopover({ anchor, onClose, label, testId, children }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' });

  useLayoutEffect(() => {
    const update = () => {
      const a = anchor.current?.getBoundingClientRect();
      const box = boxRef.current?.getBoundingClientRect();
      if (!a || !box) return;
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const left = Math.max(EDGE, Math.min(a.left + a.width / 2 - box.width / 2, vw - box.width - EDGE));
      setStyle({ position: 'fixed', left, top: a.bottom + GAP });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [anchor, children]);

  useEffect(() => {
    boxRef.current?.focus();
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (boxRef.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
      anchor.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={boxRef}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      {...(testId ? { 'data-testid': testId } : {})}
      // Over the map: a tap here is never a gesture on it.
      data-no-gesture
      style={style}
      className="z-50 w-max max-w-[min(20rem,calc(100vw-1rem))] rounded-card border border-line bg-panel p-3 text-sm text-ink shadow-pop outline-none"
    >
      {children}
    </div>,
    document.body,
  );
}
