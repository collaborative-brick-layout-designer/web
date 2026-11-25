// The Places panel (Live Ops design 6): every industry, yard, staging and
// interchange of the layout and its modules, with the cars each spot holds
// and Show me; New place picks its track on the map. A place opens to its
// name, kind, spots, what it takes in and sends out, tags and notes. A
// shared module's places are its owner's: shown, not changed. On a phone
// it's a bottom sheet (EditorPage). The desktop's ui/PlacesPanel.cpp is the twin.

import { useEffect, useId, useState } from 'react';
import type * as Y from 'yjs';
import { CAR_TYPES, PLACE_KINDS, PLACE_LIMITS, sameCarType, YARD_ROLES, type Place, type PlaceSpot } from '@cld/bbm';
import { HelpButton } from '../help/HelpButton';
import { confirmDelete } from '../ui/ConfirmDialog';
import { useEditorStore } from './editorStore';
import { showSpot } from './fitChecks';
import {
  capacityText, KIND_HINT, KIND_LABEL, kindColor, kindLabel, newPlace, removePlace, ROLE_LABEL, savePlace, spotKey, spotProblem,
  type PlaceGroup, type PlaceOwner, type SpotNow,
} from './places';

interface Props {
  doc: Y.Doc;
  groups: readonly PlaceGroup[];
  spots: ReadonlyMap<string, SpotNow>;
  hasTrack: boolean;
  isViewer: boolean;
  /** Car types of the layout's stock, offered next to the usual ones. */
  carTypes?: readonly string[];
  /** On a phone: bigger controls, and picking on the map closes the sheet. */
  touch?: boolean;
  onPicking?: () => void;
}

const btn = 'rounded border border-border px-2 py-1 text-xs hover:bg-soft disabled:opacity-50';

export function PlacesPanel({ doc, groups, spots, hasTrack, isViewer, carTypes = [], touch = false, onPicking }: Props) {
  const open = useEditorStore((s) => s.placeOpen);
  const onlyModule = useEditorStore((s) => s.placesModule);
  const picking = useEditorStore((s) => s.placePick !== null);
  const { setPlaceOpen, setPlacesModule, setPlacePick } = useEditorStore.getState();

  const openGroup = open ? groups.find((g) => g.owner === open.owner) : undefined;
  const openPlace = openGroup?.places.find((p) => p.id === open?.id);
  // The module asked for went away (deleted here or by someone else): every place again.
  const asked = onlyModule !== null ? groups.find((g) => g.owner === onlyModule) : undefined;
  const shown = asked ? [asked] : groups;
  const total = groups.reduce((n, g) => n + g.places.length, 0);

  const pick = (p: Parameters<typeof setPlacePick>[0]) => {
    setPlacePick(p);
    onPicking?.();
  };

  if (open && openGroup && openPlace) {
    return (
      <PlaceEditor
        key={`${open.owner ?? ''}/${open.id}`}
        doc={doc}
        group={openGroup}
        place={openPlace}
        spots={spots}
        readOnly={isViewer || openGroup.locked}
        isViewer={isViewer}
        carTypes={carTypes}
        touch={touch}
        onPick={(spot) => pick({ owner: open.owner, place: open.id, spot })}
        onBack={() => setPlaceOpen(null)}
      />
    );
  }

  const addOffLayout = () => {
    const place = newPlace(groups, null);
    savePlace(doc, asked?.owner ?? null, place);
    setPlaceOpen({ owner: asked?.owner ?? null, id: place.id });
  };

  const full = (asked ?? groups[0])?.places.length ?? 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 text-sm" data-testid="places-panel">
      {asked && (
        <p className="flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate">
            Places on <b>{asked.name}</b>
          </span>
          <button type="button" className={btn} onClick={() => setPlacesModule(null)}>
            Show all
          </button>
        </p>
      )}
      {!isViewer && !asked?.locked && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="place-new"
            data-tour="places.new"
            disabled={picking || !hasTrack || full >= PLACE_LIMITS.places}
            onClick={() => pick({ owner: asked ? asked.owner : undefined, place: null, spot: null })}
            className="h-9 rounded-control bg-accent px-3 text-xs font-bold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
          >
            New place
          </button>
          <button type="button" data-testid="place-new-off" disabled={picking || full >= PLACE_LIMITS.places} onClick={addOffLayout} className={btn}>
            New place off the layout
          </button>
          <HelpButton helpKey="ops.places" />
        </div>
      )}
      {asked?.locked && <p className="text-xs text-muted">This module is shared with you, so its places are its owner’s.</p>}
      {total === 0 ? (
        <p className="text-muted">
          {isViewer
            ? 'No places on this layout yet.'
            : hasTrack
              ? 'No places yet. A place is where cars go: an industry, a yard, staging or an interchange. Press New place, then click the track where the cars stand.'
              : 'There’s no track on this layout yet. Add some from the Parts panel’s Track group, then name the places along it.'}
        </p>
      ) : asked && asked.places.length === 0 ? (
        <p className="text-muted">No places on this module yet.{!isViewer && !asked.locked ? ' Press New place, then click the module’s track where the cars stand.' : ''}</p>
      ) : (
        shown
          .filter((g) => g.places.length > 0)
          .map((g) => (
            <section key={g.owner ?? ''} aria-label={g.owner === null ? 'This layout' : g.name}>
              <h3 className="pb-1 text-xs font-semibold text-muted">
                {g.owner === null ? 'This layout' : g.name}
                {g.locked ? ' (shared with you)' : ''}
              </h3>
              <ul className="flex flex-col gap-1.5">
                {g.places.map((p) => (
                  <PlaceRow key={p.id} owner={g.owner} place={p} spots={spots} touch={touch} onOpen={() => setPlaceOpen({ owner: g.owner, id: p.id })} onShown={touch ? onPicking : undefined} />
                ))}
              </ul>
            </section>
          ))
      )}
    </div>
  );
}

function PlaceRow({ owner, place, spots, touch, onOpen, onShown }: { owner: PlaceOwner; place: Place; spots: ReadonlyMap<string, SpotNow>; touch: boolean; onOpen: () => void; onShown?: (() => void) | undefined }) {
  const now = place.spots.map((s) => spots.get(spotKey(owner, place.id, s.id))).filter((s): s is SpotNow => !!s);
  const first = now.find((s) => s.at);
  const lost = now.filter((s) => s.spot.track && !s.at).length;
  const cars = now.length > 0 && now.every((s) => s.capacity !== null) ? now.reduce((n, s) => n + (s.capacity ?? 0), 0) : null;
  return (
    <li data-place={place.id} className="rounded-card border border-line bg-panel p-2">
      <div className="flex items-center gap-2">
        <span aria-hidden className="h-3 w-3 shrink-0 rounded-full" style={{ background: kindColor(place.kind) }} />
        <button type="button" onClick={onOpen} className={'min-w-0 flex-1 truncate text-left font-semibold hover:underline' + (touch ? ' min-h-11' : '')}>
          {place.name || '(no name)'}
        </button>
        {first?.at && (
          <button type="button" className={btn} onClick={() => { showSpot(first.at!.middle); onShown?.(); }}>
            Show me
          </button>
        )}
      </div>
      <p className="mt-0.5 text-xs text-muted">
        {kindLabel(place.kind)}
        {place.spots.length > 0 && ` · ${place.spots.length === 1 ? '1 spot' : `${place.spots.length} spots`}`}
        {cars !== null && <span data-testid="place-capacity"> · {capacityText(cars)}</span>}
        {lost > 0 && <span className="text-amber-700 dark:text-amber-300"> · {lost === 1 ? '1 spot has lost its track' : `${lost} spots have lost their track`}</span>}
      </p>
    </li>
  );
}

/** A text field saved when left (or on Enter): one undo step a change, and someone else's change shows at once. */
function TextField({ label, value, max, onSave, readOnly, multiline = false, testid, autoSelect = false }: { label: string; value: string; max: number; onSave: (v: string) => void; readOnly: boolean; multiline?: boolean; testid?: string; autoSelect?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const save = () => {
    const v = multiline ? draft : draft.trim();
    if (v !== value) onSave(v);
  };
  const cls = 'w-full rounded border border-border bg-bg px-2 py-1 text-sm read-only:opacity-70';
  return (
    <label className="flex flex-col gap-0.5 text-xs font-semibold">
      {label}
      {multiline ? (
        <textarea rows={2} value={draft} maxLength={max} readOnly={readOnly} data-testid={testid} onChange={(e) => setDraft(e.target.value)} onBlur={save} className={cls + ' font-normal'} />
      ) : (
        <input
          value={draft}
          maxLength={max}
          readOnly={readOnly}
          data-testid={testid}
          autoFocus={autoSelect}
          onFocus={(e) => autoSelect && e.target.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            else if (e.key === 'Escape') setDraft(value);
            if (e.key === 'Enter' || e.key === 'Escape') e.stopPropagation();
          }}
          className={cls + ' font-normal'}
        />
      )}
    </label>
  );
}

/** Words as chips, with a box to add one (Enter, a comma, or leaving the box). */
function WordsField({ label, words, suggest, onSave, readOnly, testid }: { label: string; words: readonly string[]; suggest: readonly string[]; onSave: (v: string[]) => void; readOnly: boolean; testid: string }) {
  const [draft, setDraft] = useState('');
  const list = useId();
  const add = (text: string) => {
    const next = [...words];
    for (const w of text.split(',')) {
      const word = w.trim().slice(0, PLACE_LIMITS.word);
      if (word && next.length < PLACE_LIMITS.words && !next.some((x) => sameCarType(x, word))) next.push(word);
    }
    setDraft('');
    if (next.length !== words.length) onSave(next);
  };
  return (
    <div className="flex flex-col gap-0.5 text-xs" data-testid={testid}>
      <span className="font-semibold">{label}</span>
      <span className="flex flex-wrap items-center gap-1">
        {words.map((w) => (
          <span key={w} className="flex items-center gap-1 rounded-full bg-soft px-2 py-0.5">
            {w}
            {!readOnly && (
              <button type="button" aria-label={`Remove ${w}`} className="px-0.5 hover:text-red-700" onClick={() => onSave(words.filter((x) => x !== w))}>
                ×
              </button>
            )}
          </span>
        ))}
        {readOnly && words.length === 0 && <span className="text-muted">None</span>}
        {!readOnly && words.length < PLACE_LIMITS.words && (
          <>
            <input
              aria-label={`Add to ${label}`}
              list={suggest.length ? list : undefined}
              value={draft}
              maxLength={PLACE_LIMITS.word}
              placeholder="Add…"
              onChange={(e) => (e.target.value.includes(',') ? add(e.target.value) : setDraft(e.target.value))}
              onBlur={() => add(draft)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                e.stopPropagation();
                add(draft);
              }}
              className="w-28 rounded border border-border bg-bg px-1.5 py-0.5"
            />
            {suggest.length > 0 && (
              <datalist id={list}>
                {suggest.filter((s) => !words.some((w) => sameCarType(w, s))).map((s) => <option key={s} value={s} />)}
              </datalist>
            )}
          </>
        )}
      </span>
    </div>
  );
}

function PlaceEditor({ doc, group, place, spots, readOnly, isViewer, carTypes, touch, onPick, onBack }: {
  doc: Y.Doc;
  group: PlaceGroup;
  place: Place;
  spots: ReadonlyMap<string, SpotNow>;
  readOnly: boolean;
  isViewer: boolean;
  carTypes: readonly string[];
  touch: boolean;
  onPick: (spot: string | null) => void;
  onBack: () => void;
}) {
  const fresh = useEditorStore((s) => s.placeFresh === place.id);
  const save = (change: Partial<Place>) => savePlace(doc, group.owner, { ...place, ...change });
  const saveSpot = (id: string, change: (s: PlaceSpot) => PlaceSpot) => save({ spots: place.spots.map((s) => (s.id === id ? change(s) : s)) });
  const suggest = [...CAR_TYPES, ...carTypes.filter((t) => t.trim() && !CAR_TYPES.some((c) => sameCarType(c, t)))];
  const kinds = (PLACE_KINDS as readonly string[]).includes(place.kind) ? PLACE_KINDS : [...PLACE_KINDS, place.kind];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-2 text-sm" data-testid="place-editor">
      <div className="flex items-center gap-2">
        <button type="button" className={btn + (touch ? ' min-h-11' : '')} onClick={onBack} data-testid="place-back">
          ← All places
        </button>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{group.owner === null ? 'On this layout' : `On ${group.name}`}</span>
      </div>
      {group.locked && !isViewer && <p className="rounded-md bg-soft px-2 py-1 text-xs">This module is shared with you, so its places are its owner’s.</p>}
      <TextField label="Name" value={place.name} max={PLACE_LIMITS.name} readOnly={readOnly} testid="place-name" autoSelect={fresh && !readOnly} onSave={(name) => name && save({ name })} />
      <label className="flex flex-col gap-0.5 text-xs font-semibold">
        Kind
        <select value={place.kind} disabled={readOnly} data-testid="place-kind" onChange={(e) => save({ kind: e.target.value })} className="rounded border border-border bg-bg px-2 py-1 text-sm font-normal">
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k] ?? k}
            </option>
          ))}
        </select>
        {KIND_HINT[place.kind] && <span className="font-normal text-muted">{KIND_HINT[place.kind]}</span>}
      </label>

      <section aria-label="Spots" className="flex flex-col gap-1.5">
        <h4 className="flex items-center gap-1 text-xs font-semibold">
          Spots <HelpButton helpKey="ops.spot" />
        </h4>
        {place.spots.length === 0 && <p className="text-xs text-muted">No spots: cars that go here leave the layout.</p>}
        <ul className="flex flex-col gap-1.5">
          {place.spots.map((s) => {
            const now = spots.get(spotKey(group.owner, place.id, s.id));
            const problem = now ? spotProblem(now) : null;
            const auto = s.capacity === undefined;
            return (
              <li key={s.id} data-spot={s.id} className="flex flex-col gap-1 rounded-card border border-line p-2">
                <TextField label="Spot" value={s.name} max={PLACE_LIMITS.name} readOnly={readOnly} testid="spot-name" onSave={(name) => saveSpot(s.id, (x) => ({ ...x, name }))} />
                <div className="flex flex-wrap items-end gap-2">
                  <CapacityField spot={s} readOnly={readOnly} onSave={(capacity) => saveSpot(s.id, ({ capacity: _was, ...x }) => (capacity === null ? x : { ...x, capacity }) as PlaceSpot)} />
                  {place.kind === 'yard' && (
                    <label className="flex flex-col gap-0.5 text-xs font-semibold">
                      Used for
                      <select
                        value={s.role ?? ''}
                        disabled={readOnly}
                        onChange={(e) => saveSpot(s.id, ({ role: _was, ...x }) => (e.target.value ? { ...x, role: e.target.value } : x) as PlaceSpot)}
                        className="rounded border border-border bg-bg px-1 py-1 font-normal"
                      >
                        <option value="">Anything</option>
                        {YARD_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                        {s.role && !(YARD_ROLES as readonly string[]).includes(s.role) && <option value={s.role}>{s.role}</option>}
                      </select>
                    </label>
                  )}
                </div>
                <p className="text-xs text-muted" data-testid="spot-capacity">
                  {problem ? <span className="text-amber-700 dark:text-amber-300">{problem}</span> : now && now.capacity !== null ? `${capacityText(now.capacity)}${auto ? ' (from the track’s length)' : ''}` : 'This is a switch: say how many cars it holds, or pick track beside it.'}
                </p>
                <div className="flex flex-wrap gap-1">
                  {now?.at && (
                    <button type="button" className={btn} onClick={() => showSpot(now.at!.middle)}>
                      Show me
                    </button>
                  )}
                  {!readOnly && (
                    <>
                      <button type="button" className={btn} data-testid="spot-pick" onClick={() => onPick(s.id)}>
                        Pick its track
                      </button>
                      <button type="button" className={btn} aria-label={`Remove ${s.name || 'this spot'}`} onClick={() => save({ spots: place.spots.filter((x) => x.id !== s.id) })}>
                        Remove
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {!readOnly && place.spots.length < PLACE_LIMITS.spots && (
          <button type="button" data-testid="spot-add" className={btn + ' self-start'} onClick={() => onPick(null)}>
            Add a spot
          </button>
        )}
      </section>

      <WordsField label="Takes in" testid="place-accepts" words={place.accepts} suggest={suggest} readOnly={readOnly} onSave={(accepts) => save({ accepts })} />
      <WordsField label="Sends out" testid="place-ships" words={place.ships} suggest={suggest} readOnly={readOnly} onSave={(ships) => save({ ships })} />
      <WordsField label="Tags" testid="place-tags" words={place.tags} suggest={[]} readOnly={readOnly} onSave={(tags) => save({ tags })} />
      <TextField label="Notes" value={place.notes} max={PLACE_LIMITS.notes} readOnly={readOnly} multiline testid="place-notes" onSave={(notes) => save({ notes })} />
      {!readOnly && (
        <button
          type="button"
          data-testid="place-delete"
          className={btn + ' self-start text-red-700 dark:text-red-300'}
          onClick={() => {
            void confirmDelete(place.name || 'this place', { removes: 'The place and its spots.', keeps: 'The track stays.', undoable: true }).then((ok) => {
              if (!ok) return;
              removePlace(doc, group.owner, place.id);
              onBack();
            });
          }}
        >
          Delete this place
        </button>
      )}
    </div>
  );
}

function CapacityField({ spot, readOnly, onSave }: { spot: PlaceSpot; readOnly: boolean; onSave: (v: number | null) => void }) {
  const [draft, setDraft] = useState(spot.capacity?.toString() ?? '');
  useEffect(() => setDraft(spot.capacity?.toString() ?? ''), [spot.capacity]);
  const save = () => {
    const t = draft.trim();
    const n = t === '' ? null : Number(t);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > PLACE_LIMITS.capacity)) {
      setDraft(spot.capacity?.toString() ?? '');
      return;
    }
    if (n !== (spot.capacity ?? null)) onSave(n);
  };
  return (
    <label className="flex flex-col gap-0.5 text-xs font-semibold">
      Cars it holds
      <input
        type="number"
        min={1}
        max={PLACE_LIMITS.capacity}
        inputMode="numeric"
        placeholder="From the track"
        value={draft}
        readOnly={readOnly}
        data-testid="spot-cars"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && save()}
        className="w-32 rounded border border-border bg-bg px-2 py-1 font-normal"
      />
    </label>
  );
}
