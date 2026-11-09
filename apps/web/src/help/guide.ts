// Getting started and the editor's keyboard shortcuts, in plain words,
// for the Help menu and the help page. The keys themselves live in EditorPage (canvas),
// Toolbar (tool letters) and useUndoManager; keep this list in step.

export interface Shortcut {
  keys: string;
  does: string;
}

export const SHORTCUT_GROUPS: { title: string; items: Shortcut[] }[] = [
  {
    title: 'Pieces',
    items: [
      { keys: 'R', does: 'Turn the selected pieces' },
      { keys: 'Shift+R', does: 'Turn them the other way' },
      { keys: 'Arrow keys', does: 'Nudge the selected pieces' },
      { keys: 'Delete', does: 'Remove the selected pieces' },
      { keys: 'Ctrl+D', does: 'Make a copy' },
      { keys: 'Ctrl+C / Ctrl+V', does: 'Copy and paste' },
      { keys: 'Ctrl+A', does: 'Select everything' },
      { keys: 'Ctrl+P', does: 'Select all the track joined to this piece' },
      { keys: 'Esc', does: 'Select nothing' },
    ],
  },
  {
    title: 'Tools',
    items: [
      { keys: 'V', does: 'Select' },
      { keys: 'B', does: 'Paint' },
      { keys: 'E', does: 'Erase' },
      { keys: 'T', does: 'Add text' },
      { keys: 'Ctrl+L', does: 'Add a label' },
      { keys: 'Ctrl+F', does: 'Find a part' },
    ],
  },
  {
    title: 'View and saving',
    items: [
      { keys: 'F', does: 'Fit everything in view' },
      { keys: 'Ctrl+= / Ctrl+-', does: 'Zoom in and out' },
      { keys: 'Ctrl+Z', does: 'Undo' },
      { keys: 'Ctrl+Shift+Z', does: 'Redo' },
      { keys: 'Ctrl+S', does: 'Save now (it also saves by itself)' },
      { keys: 'Alt+N', does: 'Start a new layout' },
      { keys: 'Ctrl+O', does: 'Open another layout' },
    ],
  },
];

export const SHORTCUT_NOTE = 'On a Mac, use ⌘ instead of Ctrl, and Option instead of Alt.';

/** First steps, shown under Help > Getting started. */
export const GETTING_STARTED: string[] = [
  'Drag a part from the Parts panel onto the map, or double-click it to add it in the middle. On an empty map, one click is enough.',
  'Ends of track snap together when they meet. Press R to turn the selected piece.',
  'Sheets keep things apart: track on one, buildings on another.',
  'The Venue tab holds the hall the layout has to fit in.',
  'Ctrl+Z undoes, Ctrl+Shift+Z redoes. Everything saves by itself.',
];
