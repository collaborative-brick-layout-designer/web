// The help catalogue: every key the UI uses has an entry, the texts stay
// short (one sentence on hover, two or three on click), and the key list
// the desktop app copies (help-keys.txt) matches the catalogue.

import { describe, expect, it } from 'vitest';
import { HELP_KEYS, HELP_TEXTS, type HelpEntry } from '../helpTexts';
import { WEB_ONLY_HELP_KEYS, WEB_ONLY_HELP_TEXTS } from '../webOnlyHelpTexts';
import keyListFile from '../help-keys.txt?raw';
import { HELP_SECTIONS } from '../HelpPage';

// Every source file except tests and the catalogue itself.
const SOURCES = import.meta.glob(['../../**/*.{ts,tsx}', '!../../**/*.test.{ts,tsx}', '!../helpTexts.ts', '!../webOnlyHelpTexts.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const sentences = (text: string) => text.split(/(?<=[.!?”])\s+(?=[A-Z“"])/).filter((s) => s.trim().length > 0);

/** Help keys the UI names: helpKey="…", and the panel map's 'panel.…' values. */
function keysUsedInUi(): Map<string, string> {
  const used = new Map<string, string>();
  const namespaces = [...new Set([...HELP_KEYS, ...WEB_ONLY_HELP_KEYS].map((k) => k.split('.')[0]))].join('|');
  const inJsx = /helpKey="([^"]+)"/g;
  const quoted = new RegExp(`['"]((?:${namespaces})\\.[A-Za-z]+)['"]`, 'g');
  for (const [file, text] of Object.entries(SOURCES)) {
    for (const m of text.matchAll(inJsx)) used.set(m[1]!, file);
    for (const m of text.matchAll(quoted)) used.set(m[1]!, file);
  }
  return used;
}

/** Every entry, shared and web-only. */
const ALL: [string, HelpEntry][] = [...Object.entries(HELP_TEXTS), ...Object.entries(WEB_ONLY_HELP_TEXTS)];

describe('help catalogue', () => {
  it('has an entry for every key the UI uses', () => {
    const used = keysUsedInUi();
    // Panels, top bar, toolbar, status bar, dialogs, Settings, Share, the room designer...
    expect(used.size).toBeGreaterThanOrEqual(40);
    const missing = [...used].filter(([key]) => !(key in HELP_TEXTS) && !(key in WEB_ONLY_HELP_TEXTS)).map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });

  it('keeps the hover text to one sentence of 140 characters at most', () => {
    for (const [key, { short }] of ALL) {
      expect(short.length, key).toBeLessThanOrEqual(140);
      expect(sentences(short), key).toHaveLength(1);
    }
  });

  it('keeps the click text to two or three sentences, and gives every entry a title', () => {
    for (const [key, entry] of ALL) {
      expect(entry.title.length, key).toBeGreaterThan(0);
      const n = sentences(entry.more).length;
      expect(n, `${key}: ${entry.more}`).toBeGreaterThanOrEqual(2);
      expect(n, `${key}: ${entry.more}`).toBeLessThanOrEqual(3);
    }
  });

  it('only links "Learn more" to pages in the app, never another server', () => {
    for (const [key, entry] of ALL) {
      if (!entry.learnMoreUrl) continue;
      expect(entry.learnMoreUrl, key).toMatch(/^\/help(#[a-z-]+)?$/);
      const section = entry.learnMoreUrl.split('#')[1];
      if (section) expect(HELP_SECTIONS, key).toContain(section);
    }
  });

  it('matches the key list the desktop app copies (help-keys.txt)', () => {
    const listed = keyListFile
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    expect(listed).toEqual(HELP_KEYS);
  });

  it('keeps the web-only entries (admin pages) out of the list the desktop copies', () => {
    for (const key of WEB_ONLY_HELP_KEYS) expect(HELP_KEYS as readonly string[], key).not.toContain(key);
  });
});

describe('one source for both apps', () => {
  it('reads every shared entry from help-texts.json, the file the desktop app has word for word', async () => {
    const json = (await import('../help-texts.json')).default as { _about: string; entries: Record<string, HelpEntry> };
    expect(json._about).toContain('src/ui/help/help-texts.json');
    expect(HELP_TEXTS).toEqual(json.entries);
    expect(Object.keys(json.entries)).toEqual(HELP_KEYS);
  });
});
