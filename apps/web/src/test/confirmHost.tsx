// The app's confirmation dialog in unit tests: setup.ts mounts its host
// for every test (as main.tsx does in the app), and `autoConfirm` answers
// the next questions the way a person would, by clicking in the dialog.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { closeConfirm, ConfirmDialogHost } from '../ui/ConfirmDialog';

let root: Root | null = null;
let el: HTMLElement | null = null;

export function mountConfirmHost(): void {
  el = document.createElement('div');
  el.dataset.confirmHost = '';
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(<ConfirmDialogHost />));
}

export function unmountConfirmHost(): void {
  stopAuto?.();
  act(() => closeConfirm());
  act(() => root?.unmount());
  el?.remove();
  root = null;
  el = null;
}

/** The open dialog, if any. */
export function confirmDialog(): HTMLElement | null {
  return document.querySelector('[data-testid="confirm-dialog"]');
}

/** One answer: true = the confirm button, false = Cancel, a string = that reason, then confirm. */
export type Answer = boolean | string;

let stopAuto: (() => void) | null = null;

/**
 * Answer every question from now on with `answers` in turn (the last one
 * repeats). Types the name first when the dialog asks for it. Returns the
 * titles of the questions asked.
 */
export function autoConfirm(...answers: Answer[]): { titles: string[]; texts: string[] } {
  stopAuto?.();
  const titles: string[] = [];
  const texts: string[] = [];
  let i = 0;
  let seen: Element | null = null;
  const tick = () => {
    const d = confirmDialog();
    if (!d || d === seen) return;
    seen = d;
    titles.push(d.querySelector('h2')?.textContent ?? '');
    texts.push(d.textContent ?? '');
    const a = answers[Math.min(i++, answers.length - 1)] ?? true;
    const buttons = Array.from(d.querySelectorAll('button'));
    if (a === false) {
      // Cancel is the first button, whatever it says ("Stay", "Go back").
      fireEvent.click(buttons[0]!);
      return;
    }
    const typed = d.querySelector<HTMLInputElement>('input');
    if (typed) fireEvent.change(typed, { target: { value: d.querySelector('label strong')?.textContent ?? '' } });
    const reason = d.querySelector<HTMLTextAreaElement>('textarea');
    if (reason && typeof a === 'string') fireEvent.change(reason, { target: { value: a } });
    fireEvent.click(buttons[buttons.length - 1]!);
  };
  const obs = new MutationObserver(() => queueMicrotask(tick));
  obs.observe(document.body, { childList: true, subtree: true });
  stopAuto = () => {
    obs.disconnect();
    stopAuto = null;
  };
  return { titles, texts };
}
