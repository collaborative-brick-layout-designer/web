import { useEffect, useState } from 'react';

const MOBILE_BREAKPOINT = 768;
/** A touch screen this short is a phone on its side, whatever its width. */
const PHONE_LANDSCAPE_MAX_HEIGHT = 500;
const SIDEBAR_PX = 260;
const TOOLBAR_PX = 48;

export interface ViewportInfo {
  width: number;
  height: number;
  isMobile: boolean;
  /** The window's width when measured (to tell a keyboard from a real resize). */
  innerWidth?: number;
}

/**
 * Track the editor canvas's available size and a mobile breakpoint.
 *
 * Below `MOBILE_BREAKPOINT` we drop the parts-panel sidebar so the
 * canvas gets the full window width. The editor uses `isMobile` to
 * open in View mode on small screens, with touch editing behind a
 * View / Edit switch (PLAN.md, "Touch editing").
 */
export function useViewportSize(): ViewportInfo {
  const [info, setInfo] = useState(() => measure());
  useEffect(() => {
    function onResize() {
      setInfo((prev) => measure(prev));
    }
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, []);
  return info;
}

function measure(prev?: ViewportInfo & { innerWidth?: number }): ViewportInfo {
  const innerWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const innerHeight = typeof window === 'undefined' ? 768 : window.innerHeight;
  let isMobile = isPhoneWindow();
  // The on-screen keyboard opening (or closing) only changes the height. While
  // someone is typing, keep the layout they started typing in: switching to the
  // phone layout would remove the very field they are typing into, and with it
  // the keyboard.
  if (prev && prev.innerWidth === innerWidth && typingInField()) isMobile = prev.isMobile;
  return {
    innerWidth,
    width: Math.max(100, innerWidth - (isMobile ? 0 : SIDEBAR_PX)),
    height: Math.max(100, innerHeight - TOOLBAR_PX),
    isMobile,
  };
}

export function coarsePointer(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/**
 * Phone-sized: narrower than the breakpoint, or a touch screen that is
 * short (a phone turned sideways, 915 x 412). A short desktop window with
 * a mouse keeps the full editor.
 */
export function isPhoneSize(width: number, height: number, coarse: boolean): boolean {
  return width < MOBILE_BREAKPOINT || (coarse && height < PHONE_LANDSCAPE_MAX_HEIGHT);
}

/**
 * The height to judge "a phone on its side" by. The on-screen keyboard makes
 * the window short but never the screen, so a short window on a tall screen
 * is a tablet (or a computer) with its keyboard open, not a phone: the window
 * only counts as short when the screen is short too. Without a screen size,
 * the window's height is used.
 */
export function shortSide(screenWidth: number | undefined, screenHeight: number | undefined, windowHeight: number): number {
  if (!screenWidth || !screenHeight) return windowHeight;
  return Math.max(windowHeight, Math.min(screenWidth, screenHeight));
}

/** Is this window showing the phone layout right now? Shared by the editor, tours and Settings. */
export function isPhoneWindow(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse = coarsePointer();
  const height = coarse ? shortSide(window.screen?.width, window.screen?.height, window.innerHeight) : window.innerHeight;
  return isPhoneSize(window.innerWidth, height, coarse);
}

/** Is a text field focused (so an on-screen keyboard may be open)? */
export function typingInField(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement;
  return el instanceof HTMLElement && el.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]), textarea, select, [contenteditable="true"]');
}
