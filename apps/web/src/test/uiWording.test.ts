// One vocabulary in both apps (docs/glossary.md): the words people see say
// "sheet", "turn", "club" and "web address", never "layer", "rotate", "org"
// or "slug". This reads every .tsx and .ts file under src/ and checks the
// text people see: JSX text, and the title / aria-label / placeholder /
// label / alt / hint attributes and object fields. Code (identifiers, URLs
// such as /orgs/…, comments) isn't text people see, so it isn't checked.
// The desktop app's UiWordingTest checks its tr() strings the same way.

import { describe, expect, it } from 'vitest';

const FILES = import.meta.glob(['../**/*.tsx', '../**/*.ts', '!../**/test/**', '!../**/*.test.ts', '!../**/*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const BANNED = /\b(orgs?|layers?|rotat\w*|slug)\b/i;

/** Text people see, with where it is. */
function shownText(source: string, jsx: boolean): string[] {
  const out: string[] = [];
  // Comments aren't shown.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  // JSX text between tags.
  if (jsx) for (const m of code.matchAll(/>([^<>{}`;=]*[A-Za-z][^<>{}`;=]*)</g)) out.push(m[1]!.trim());
  // Attributes and fields that are shown.
  const quoted = String.raw`(?:'([^'\n]*)'|"([^"\n]*)"|\x60([^\x60$\n]*)\x60)`;
  const re = new RegExp(String.raw`\b(?:title|aria-label|placeholder|label|alt|hint|short|more)\s*[=:]\s*\{?\s*` + quoted, 'g');
  for (const m of code.matchAll(re)) out.push((m[1] ?? m[2] ?? m[3] ?? '').trim());
  return out.filter((t) => t.length > 0);
}

describe('the words people see', () => {
  it('reads the source files', () => {
    expect(Object.keys(FILES).length).toBeGreaterThan(100);
  });

  it('say sheet, turn, club and web address, not layer, rotate, org or slug', () => {
    const bad: string[] = [];
    for (const [file, source] of Object.entries(FILES)) {
      for (const text of shownText(source, file.endsWith('.tsx'))) if (BANNED.test(text)) bad.push(`${file}: "${text}"`);
    }
    expect(bad, 'See docs/glossary.md').toEqual([]);
  });
});
