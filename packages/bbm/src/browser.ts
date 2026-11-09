// Browser-safe entrypoint — no `node:crypto` imports. The web app uses this
// to read/write `.bbm` XML in the editor (e.g. for paste-an-XML scratch
// support) without pulling in the sidecar hashing helpers, which need
// `node:crypto`. Sidecar reading + writing are server-side only in v1.

export { readBbm, type ReadResult } from './Reader.js';
export { writeBbm, type WriteOptions } from './Writer.js';
export { stripInvalidXmlChars, vanillaPostProcess } from './xml.js';
export { NEWER_SIDECAR_WARNING, sidecarWarnings } from './sidecar.js';
export { formatBool, formatInt, formatNumber, parseBool } from './format.js';
export { BBM_FORMAT_VERSION } from '@cld/model';
