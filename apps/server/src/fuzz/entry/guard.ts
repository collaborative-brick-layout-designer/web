// Jazzer.js entry for the "guard" target (scripts/fuzz.mjs bundles it).
import './quiet.js';
import { fuzzGuard } from '../guard.js';

export function fuzz(data: Buffer): void {
  fuzzGuard(new Uint8Array(data.buffer, data.byteOffset, data.length));
}
