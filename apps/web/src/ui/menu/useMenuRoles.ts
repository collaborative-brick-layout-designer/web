// The small right-click and ⋯ menus drawn by hand (Sheets, Parts, Modules):
// while one is open its box is a menu for screen readers, its buttons are
// menu items, the first one has the focus, ↑ ↓ Home End move between them
// and Esc closes it, like the shared Menu (Menu.tsx).

import { useEffect, useRef, type RefObject } from 'react';

export function useMenuRoles(ref: RefObject<HTMLElement | null>, open: boolean, label: string, onClose: () => void): void {
  // The latest onClose, so a new function each render doesn't reopen the menu's focus.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const box = ref.current;
    if (!open || !box) return;
    const before = document.activeElement as HTMLElement | null;
    box.setAttribute('role', 'menu');
    box.setAttribute('aria-label', label);
    const items = () => Array.from(box.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    for (const b of box.querySelectorAll('button')) if (!b.getAttribute('role')) b.setAttribute('role', 'menuitem');
    for (const hr of box.querySelectorAll('hr')) hr.setAttribute('role', 'separator');
    items()[0]?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      const go = (i: number) => {
        e.preventDefault();
        list[(i + list.length) % list.length]?.focus();
      };
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      } else if (e.key === 'ArrowDown') go(at + 1);
      else if (e.key === 'ArrowUp') go(at - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(list.length - 1);
      else if (e.key === 'Tab') close.current();
    };
    box.addEventListener('keydown', onKey);
    return () => {
      box.removeEventListener('keydown', onKey);
      if (before && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, [ref, open, label]);
}
