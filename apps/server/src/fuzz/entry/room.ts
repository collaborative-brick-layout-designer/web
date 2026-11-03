// Jazzer.js entry for the "room" target (scripts/fuzz.mjs bundles it).
import './quiet.js';
import '../env.js';
import { fuzzRoom } from '../room.js';

export function fuzz(data: Buffer): void {
  fuzzRoom(new Uint8Array(data.buffer, data.byteOffset, data.length));
}
