// The welcome card and the guided tours, read from tours.json, the
// catalogue the desktop app keeps an identical copy of. A tour is a few
// short steps; each step points at a real control (its `target`) and the
// card says what it's for. Finished or skipped tours, and the dismissed
// welcome card, are remembered in the account's `toursSeen` setting.

import catalogue from './tours.json';

/** Which screens a tour is for: phones only, anything bigger, or both. */
export type TourDevices = 'phone' | 'large' | 'all';

export interface TourStep {
  /** What it points at: an element's `data-tour`, else the control a "?" with this help key explains. */
  target: string;
  title: string;
  text: string;
  /** Only in these apps; every app when left out. */
  apps?: ('web' | 'desktop')[];
  /** Only for someone in a club (it points at what only club members have). */
  needsClub?: boolean;
}

export interface Tour {
  id: string;
  title: string;
  devices: TourDevices;
  steps: TourStep[];
}

/** The tours with the steps for this app (some are desktop only, like its server status). */
export const TOURS: readonly Tour[] = (catalogue.tours as Tour[]).map((t) => ({
  ...t,
  steps: t.steps.filter((s) => !s.apps || s.apps.includes('web')),
}));
export const WELCOME = catalogue.welcome;
export const WELCOME_ID = catalogue.welcome.id;
export const TOUR_BUTTONS = catalogue.buttons;

export function getTour(id: string): Tour | undefined {
  return TOURS.find((t) => t.id === id);
}

/** The tour without the steps that need a club, for someone in none. */
export function forClubless(tour: Tour, inAClub: boolean): Tour {
  return inAClub ? tour : { ...tour, steps: tour.steps.filter((s) => !s.needsClub) };
}

/** The tours offered on this screen size. */
export function toursFor(phone: boolean): Tour[] {
  return TOURS.filter((t) => t.devices === 'all' || t.devices === (phone ? 'phone' : 'large'));
}

/** "2 of 5". */
export function stepCount(n: number, total: number): string {
  return TOUR_BUTTONS.of.replace('{n}', String(n)).replace('{total}', String(total));
}

/** `seen` with `id` added once. */
export function markSeen(seen: readonly string[], id: string): string[] {
  return seen.includes(id) ? [...seen] : [...seen, id];
}

/** The tour a phone gets instead of one made for bigger screens. */
export function forDevice(id: string, phone: boolean): string {
  if (phone && id === 'editor') return 'view';
  if (!phone && id === 'view') return 'editor';
  return id;
}
