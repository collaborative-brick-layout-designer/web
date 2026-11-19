// Fetch the desktop's import converter for the image (docs/model-import.md):
// compat/compat.json › importServer.pinned names a desktop release and the
// SHA-256 of its bld-import-server asset. The download must match it, or the
// image build stops. No pinned version: the image is built without it, and
// the site says import is off and why.
//   node docker/fetch-import-server.mjs <compat.json> <dest dir>
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

const [compatPath, dest] = process.argv.slice(2);
const { importServer } = JSON.parse(readFileSync(compatPath, 'utf8'));
const pinned = importServer?.pinned ?? {};
mkdirSync(dest, { recursive: true });
if (!pinned.version) {
  console.log('No import converter pinned in compat.json: building without it (import is off).');
  process.exit(0);
}
if (!/^[0-9a-f]{64}$/.test(pinned.sha256 ?? '')) {
  console.error(`compat.json pins converter ${pinned.version} without a SHA-256`);
  process.exit(1);
}
const url = importServer.releaseUrl.replace('{version}', pinned.version);
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) {
  console.error(`${url}: HTTP ${res.status}`);
  process.exit(1);
}
const bytes = Buffer.from(await res.arrayBuffer());
const sum = createHash('sha256').update(bytes).digest('hex');
if (sum !== pinned.sha256) {
  console.error(`${url}: SHA-256 ${sum}, compat.json pins ${pinned.sha256}`);
  process.exit(1);
}
writeFileSync('/tmp/bld-import-server.tar.gz', bytes);
execFileSync('tar', ['-xzf', '/tmp/bld-import-server.tar.gz', '-C', dest, '--strip-components=1', '--no-same-owner']);
rmSync('/tmp/bld-import-server.tar.gz');
console.log(`Import converter ${pinned.version} (${sum}) in ${dest}`);
