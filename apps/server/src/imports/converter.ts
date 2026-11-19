// The desktop's bld-import-server, run once per step in a locked-down
// child process (docs/model-import.md, "Sandbox"):
//   - the converter locks itself down before it reads anything: rlimits
//     (CPU, address space, file size, open files), no new privileges,
//     seccomp (no sockets, no programs, no new processes) and an empty
//     network namespace where the host allows one; we refuse a converter
//     whose --sandbox-check doesn't block sockets, exec and fork;
//   - here: an empty environment (only QT_QPA_PLATFORM, HOME and TMPDIR,
//     both the job's folder), the job's folder as its working directory,
//     a wall-clock timeout (SIGKILL), capped output, and the same uid as
//     the server (the image's non-root `node`).
// Nothing about the file is logged: not its name, not the converter's stderr.

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { env } from '../env.js';
import { CONVERTER_MINIMUM, compareVersions } from '../compat.js';

/** compat.json › importServer.minimum: the oldest converter this server works with. */
export function converterMinimum(): string {
  return CONVERTER_MINIMUM;
}

export type ConverterProblem = 'missing' | 'too_old' | 'broken' | 'unsandboxed';

export interface ConverterState {
  available: boolean;
  path: string;
  forcedBy: string | null;
  version: string | null;
  minimum: string;
  problem: ConverterProblem | null;
  /** What the lock-down blocks, from --sandbox-check. */
  sandbox: Record<string, unknown> | null;
}

let cached: { at: number; state: ConverterState } | null = null;
const CACHE_MS = 60_000;

/** Run the converter with no request (version, sandbox check). */
function quick(args: string[], timeoutMs = 20_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(env.importConverter, args, { env: { QT_QPA_PLATFORM: 'offscreen' }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => {
      if (out.length < 64 * 1024) out += b.toString('utf8');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, out: '' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

export async function converterState(fresh = false): Promise<ConverterState> {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.state;
  const minimum = converterMinimum();
  const base: ConverterState = {
    available: false,
    path: env.importConverter,
    forcedBy: process.env.IMPORT_CONVERTER ? 'IMPORT_CONVERTER' : null,
    version: null,
    minimum,
    problem: 'missing',
    sandbox: null,
  };
  let state: ConverterState;
  try {
    await access(env.importConverter, constants.X_OK);
    const v = await quick(['--version']);
    const version = /^bld-import-server\s+(\S+)/.exec(v.out.trim())?.[1] ?? null;
    if (v.code !== 0 || !version) state = { ...base, problem: 'broken' };
    else {
      const cmp = compareVersions(version, minimum);
      if (cmp === null || cmp < 0) state = { ...base, version, problem: 'too_old' };
      else {
        const check = await quick(['--sandbox-check']);
        let sandbox: Record<string, unknown> | null = null;
        try {
          sandbox = (JSON.parse(check.out) as { sandbox?: Record<string, unknown> }).sandbox ?? null;
        } catch {
          sandbox = null;
        }
        const locked = !!sandbox && sandbox.socketBlocked === true && sandbox.execBlocked === true && sandbox.forkBlocked === true && sandbox.rlimits === true;
        state = { ...base, version, sandbox, available: locked, problem: locked ? null : 'unsandboxed' };
      }
    }
  } catch {
    state = base;
  }
  cached = { at: Date.now(), state };
  return state;
}

export function forgetConverterState(): void {
  cached = null;
}

export interface RunLimits {
  timeoutSeconds: number;
  memoryMb: number;
}

export type RunOutcome =
  | { kind: 'done'; result: Record<string, unknown> }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'crashed' };

const MAX_STDOUT = 4 * 1024 * 1024;

/** One step: `requestPath` in `jobDir`. */
export function runConverter(requestPath: string, jobDir: string, limits: RunLimits, signal?: AbortSignal): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(
      env.importConverter,
      ['--cpu', String(limits.timeoutSeconds), '--memory-mb', String(limits.memoryMb), '--file-size-mb', '256', '--open-files', '256', requestPath],
      { cwd: jobDir, env: { QT_QPA_PLATFORM: 'offscreen', HOME: jobDir, TMPDIR: jobDir }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let ended: 'timeout' | 'cancelled' | null = null;
    child.stdout.on('data', (b: Buffer) => {
      if (out.length + b.length > MAX_STDOUT) {
        child.kill('SIGKILL');
        return;
      }
      out += b.toString('utf8');
    });
    // Read and dropped: it may name the file.
    child.stderr.on('data', () => undefined);
    const timer = setTimeout(() => {
      ended = 'timeout';
      child.kill('SIGKILL');
    }, limits.timeoutSeconds * 1000);
    const onAbort = () => {
      ended = 'cancelled';
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ kind: 'crashed' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (ended) return resolve({ kind: ended });
      try {
        const result = JSON.parse(out) as Record<string, unknown>;
        if (code === 0 || code === 1) return resolve({ kind: 'done', result });
      } catch {
        /* crashed */
      }
      resolve({ kind: 'crashed' });
    });
  });
}
