// Map > General Info dialog — port of MainWindowMapMenu.cpp:130-158.
// Edits Author / LUG / Event / Date / Comment.

import { useId, useState } from 'react';
import type * as Y from 'yjs';
import type { BbmMap } from '@cld/model';
import { setGeneralInfo } from './mutations';
import { useEscape } from './useEscape';

interface Props {
  map: BbmMap;
  doc: Y.Doc;
  onClose: () => void;
}

export function GeneralInfoDialog({ map, doc, onClose }: Props) {
  useEscape(onClose);
  const uid = useId();
  const [author, setAuthor] = useState(map.author);
  const [lug, setLug] = useState(map.lug);
  const [event, setEventValue] = useState(map.event);
  // One date box: the browser shows it the person's own way (a US club
  // reads month first) and offers a calendar.
  const [date, setDate] = useState(() => isoDate(map.date));
  const [comment, setComment] = useState(map.comment);

  function commit() {
    setGeneralInfo(doc, {
      author,
      lug,
      event,
      comment,
      date: fromIsoDate(date) ?? map.date,
    });
    onClose();
  }

  return (
    <div
      role="dialog" aria-label="General info"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-lg border border-line bg-panel p-5 shadow-xl"
      >
        <h2 className="text-base font-semibold">General info</h2>
        <div className="mt-4 grid grid-cols-[7rem_1fr] gap-2 text-sm">
          <label className="self-center" htmlFor={`${uid}-author`}>Author:</label>
          <input
            id={`${uid}-author`}
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            className="rounded-lg border border-border bg-soft px-2 py-1"
          />
          <label className="self-center" htmlFor={`${uid}-lug`}>Club (LUG):</label>
          <input
            id={`${uid}-lug`}
            value={lug}
            onChange={(e) => setLug(e.target.value)}
            className="rounded-lg border border-border bg-soft px-2 py-1"
          />
          <label className="self-center" htmlFor={`${uid}-event`}>Event:</label>
          <input
            id={`${uid}-event`}
            value={event}
            onChange={(e) => setEventValue(e.target.value)}
            className="rounded-lg border border-border bg-soft px-2 py-1"
          />
          <label className="self-center" htmlFor={`${uid}-date`}>Date:</label>
          <input
            id={`${uid}-date`}
            type="date"
            min="1900-01-01"
            max="2999-12-31"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="justify-self-start rounded-lg border border-border bg-soft px-2 py-1"
          />
          <label className="self-start" htmlFor={`${uid}-comment`}>Comment:</label>
          <textarea
            id={`${uid}-comment`}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={4}
            className="rounded-lg border border-border bg-soft px-2 py-1"
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1 text-sm hover:bg-soft"
          >
            Cancel
          </button>
          <button
            onClick={commit}
            className="rounded-lg bg-accent text-accent-ink px-3 py-1 text-sm hover:bg-accent-hover"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** The map's date as the date box's yyyy-mm-dd. */
export function isoDate(d: { day: number; month: number; year: number }): string {
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;
}

/** yyyy-mm-dd back to the map's date; null when the box is empty or not a date. */
export function fromIsoDate(s: string): { day: number; month: number; year: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { day, month, year };
}
