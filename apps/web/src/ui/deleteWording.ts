// What each kind of deletion says, in one place so every list that can
// delete the same thing says the same words (and the desktop app's
// ConfirmDialog copies them: keep both in step).

import type { DeleteWording } from './ConfirmDialog';

/** What a delete that goes to Recently deleted says can be undone. */
export const TRASH_UNDO = 'It waits 30 days in Recently deleted on Home, where you can restore it.';

export const MODULE_DELETE_WORDING: DeleteWording = {
  removes: 'The module and its versions are deleted, and it leaves any collections it was in.',
  keeps: 'Layouts that already use it don’t change.',
  undoable: TRASH_UNDO,
};

export const VENUE_DELETE_WORDING: DeleteWording = {
  removes: 'The venue is deleted from the Venue library.',
  keeps: 'Layouts made from it keep their own copy of the venue.',
  undoable: TRASH_UNDO,
};

/** A layout (Home, and the desktop's Delete from server). */
export const LAYOUT_DELETE_WORDING: DeleteWording = {
  removes: 'The layout, its history and its share links are deleted for everyone who can open it.',
  keeps: 'The modules, parts and venues it uses aren’t deleted.',
  undoable: TRASH_UNDO,
};

export const CUSTOM_PART_DELETE_WORDING: DeleteWording = {
  removes: 'The part is deleted from your custom parts.',
  keeps: 'Layouts that use it show a placeholder in its place.',
};

export const SET_DELETE_WORDING: DeleteWording = {
  removes: 'The set is deleted from your custom parts, so it can’t be placed again.',
  keeps: 'Layouts that use it keep the parts it put down.',
};
