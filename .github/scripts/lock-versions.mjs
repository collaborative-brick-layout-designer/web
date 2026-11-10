// The packages a pnpm-lock.yaml resolves, one `name@version` per line, and
// the difference between two such lists as a Markdown table.
//
//   node lock-versions.mjs pnpm-lock.yaml            > versions.txt
//   node lock-versions.mjs --table before.txt after.txt   (Markdown rows)
//   node lock-versions.mjs --count before.txt after.txt   (how many changed)
//
// Used by .github/workflows/lockfile-refresh.yml for its pull request body.

import { readFileSync } from 'node:fs';

/** `name@version` for each entry under `packages:` (not the workspace's own). */
export function lockVersions(lockText) {
  const out = new Set();
  let inPackages = false;
  for (const line of lockText.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) inPackages = false;
    if (!inPackages) continue;
    // Two-space indented keys: `  '@scope/name@1.2.3':` or `  name@1.2.3:`
    const m = /^ {2}'?((?:@[^/@']+\/)?[^@/']+)@([^'(:]+)/.exec(line);
    if (m) out.add(`${m[1]}@${m[2]}`);
  }
  return [...out].sort();
}

/** name -> version, from a versions list (one `name@version` a line). */
function byName(text) {
  const map = new Map();
  for (const l of text.split('\n')) {
    const at = l.lastIndexOf('@');
    if (at <= 0) continue;
    const name = l.slice(0, at);
    const ver = l.slice(at + 1);
    // Several versions of one package: keep each, keyed with its version.
    map.set(map.has(name) ? `${name} (${ver})` : name, ver);
  }
  return map;
}

/** [name, before, after] for every package whose version differs. */
export function changes(beforeText, afterText) {
  const b = byName(beforeText);
  const a = byName(afterText);
  const rows = [];
  for (const [name, after] of a) {
    const before = b.get(name);
    if (before !== after) rows.push([name, before ?? '—', after]);
  }
  for (const [name, before] of b) if (!a.has(name)) rows.push([name, before, '—']);
  return rows.sort((x, y) => x[0].localeCompare(y[0]));
}

const [mode, ...files] = process.argv.slice(2);
if (mode === '--table' || mode === '--count') {
  const rows = changes(readFileSync(files[0], 'utf8'), readFileSync(files[1], 'utf8'));
  if (mode === '--count') console.log(rows.length);
  else for (const [name, before, after] of rows) console.log(`| \`${name}\` | ${before} | ${after} |`);
} else if (mode) {
  console.log(lockVersions(readFileSync(mode, 'utf8')).join('\n'));
}
